// Spraying (phase 5, task 5.6, rule B10): chargebacks on sprays and the clawbacks they create.
//
//  - A dispute on a spray reference (Paystack charge.dispute.create / .remind, signature already checked by the webhook
//    route), under the reference's advisory lock:
//      * ALWAYS a payment_issues row (reason 'dispute', one open row per reference) so a person answers Paystack before its
//        deadline (Paystack accepts an unanswered dispute for the customer).
//      * delivered, paid, created, pending or failed: ONE transaction moves the spray to 'disputed' (conditional on the
//        status read), writes the `chargeback` ledger row (once per reference) and one host_clawbacks row per beneficiary
//        (origin 'dispute': the host's share, and the stage guest's share when there was one), idempotent through the unique
//        (spray_id, beneficiary_id). A disputed spray is never delivered afterwards (finalize answers "already"), and a
//        failed one is never refunded again as a late payment (the dispute is the payer's refund). The split went to the
//        subaccounts at charge time, so money was taken from the platform whatever the spray's status.
//      * reversing or reversed: the payer has (or is getting) a full refund. The issue tells the person to contest the
//        dispute with the refund as evidence; the reversal already wrote its clawbacks (origin 'reversal').
//    A second event for the same reference changes nothing.
//  - A dispute resolved (charge.dispute.resolve): the open 'dispute' issue is closed and the outcome is handled
//    ("declined" = the merchant won, "merchant-accepted" = the payer won; ON THE G3 CHECKLIST: confirm Paystack's words):
//      * on a REFUNDED spray (reversing / reversed): the payer won = a 'dispute_resolved' issue (paid back twice); the
//        merchant won = nothing to do (never "refund the payer by hand": they were refunded).
//      * on a DISPUTED spray, once only (the chargeback ledger row flips from 'disputed' to chargeback_won / _lost):
//        merchant won + delivered = the dispute clawbacks are settled and a REPAY issue is opened for whatever payouts had
//        already taken (open or fully recovered rows alike); merchant won + never delivered = an issue to refund the payer;
//        payer won = clawbacks stay open. An unknown word opens an issue and flips nothing.
//      * review r5: the dispute rows are locked FOR UPDATE before recovered_kobo is summed (I1); a resolve that flips nothing
//        but disagrees with the ledger opens an OUTCOME_CHANGED issue, and the 'dispute' issue is closed only when the
//        event decided something (I2); an outcome issue first closes an older open dispute_resolved issue so it always
//        lands, and owedBack is in the issue and the log line (I3); LOST_AFTER_REFUND is raised once per reference (m2).
//    Reversal clawbacks are never touched by a dispute outcome.
//  - applyClawbacks(beneficiaryId, availableKobo) is called by settlement (settlement.ts, queueDuePayout) INSIDE the payout
//    transaction that holds the payout row lock: open clawbacks of that person are locked FOR UPDATE and applied oldest
//    first, partially when needed (recovered_kobo), each row 'recovered' only once recovered_kobo equals amount_kobo, in
//    the same transaction. The payout is the available amount minus what was applied (never below 0).
//  - written_off only by an admin (finance roles): written_off_by is the admin's id (admin_users), with a reason, audited
//    in the admin activity log.
import { disputeBatchLocked, resolveBatchDisputeLocked } from "./teamSpray";
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, storage } from "../storage";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { sprayReferenceForLog } from "../payments/sprayReference";
import { requireRole } from "../services/adminSecurity";
import { BUSY, openPaymentIssue, withAdvisoryLock } from "./refunds";
import { LOCK_SPRAY, sprayClock } from "./spray";
import { capLockKey } from "./sprayLimits";
import { recordSprayEvent, withSpraySource } from "./sprayEvents";

type Queryable = { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
const iso = (ms: number) => new Date(ms).toISOString();
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** The transaction reference of a Paystack dispute payload (it sits under data.transaction), or null. */
export function disputeReference(data: unknown): string | null {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const tx = d.transaction && typeof d.transaction === "object" ? d.transaction : null;
  const ref = [tx?.reference, d.transaction_reference, d.reference].find((v) => typeof v === "string" && v.length > 0 && v.length <= 200);
  return (ref as string | undefined) ?? null;
}

/** Paystack's resolution word on a resolved dispute, lower case, or "" when there is none. */
export function disputeResolution(data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const r = typeof d.resolution === "string" ? d.resolution : "";
  return r.trim().toLowerCase().slice(0, 40);
}

export type DisputeOutcome = "disputed" | "already" | "refunded" | "unknown";

type DisputeRow = {
  id: string; status: string; room_id: string; host_id: string; payer_id: string; recipient_id: string; amount_kobo: number;
  platform_kobo: number; host_kobo: number; guest_kobo: number | null; provider: string; delivered: boolean;
};

async function loadRow(c: PoolClient, reference: string): Promise<DisputeRow | undefined> {
  return (await c.query(
    `select id, status, room_id, host_id, payer_id, recipient_id, amount_kobo, platform_kobo, host_kobo, guest_kobo, provider,
            (delivered_at is not null) as delivered
       from spray_payments where provider_ref = $1`,
    [reference],
  )).rows[0] as DisputeRow | undefined;
}

/**
 * A chargeback on a spray. Idempotent. Throws when the reference is busy (the webhook answers 500 and Paystack retries).
 * The payload is never trusted for amounts: the clawbacks are the stored host and guest shares of the row.
 */
export async function handleSprayDispute(reference: string): Promise<DisputeOutcome> {
  const r = await withSpraySource("callback", () => withAdvisoryLock(LOCK_SPRAY, reference, (c) => disputeLocked(c, reference), 8000));
  if (r === BUSY) throw new Error("spray reference is busy; retry the dispute webhook");
  return r;
}

/** Statuses a dispute moves to 'disputed' (money was taken: the split reached the subaccounts at charge time). */
const DISPUTABLE = ["delivered", "paid", "created", "pending", "failed"] as const;

async function disputeLocked(c: PoolClient, reference: string): Promise<DisputeOutcome> {
  const nowMs = sprayClock.now();
  const row = await loadRow(c, reference);
  if (!row) {
    const batch = await disputeBatchLocked(c, reference); // a team spray's one charge (teamSpray.ts); null = not a batch either
    if (batch) return batch;
    console.log(`[rooms:spray] dispute ref=${sprayReferenceForLog(reference)} ignored: no spray`);
    return "unknown";
  }
  const issue = (error: string) => openPaymentIssue(c, { ticketId: null, providerRef: reference, provider: row.provider, reason: "dispute", error, now: new Date(nowMs) });

  if (row.status === "reversing" || row.status === "reversed") {
    await issue("SPRAY_DISPUTE_AFTER_REFUND: the payer was refunded in full (or the refund is in progress); contest the dispute in Paystack with the refund as evidence");
    console.error(`[rooms:spray] ALERT dispute ref=${sprayReferenceForLog(reference)} on a refunded spray; answer it in Paystack`);
    return "refunded";
  }
  if (row.status === "disputed") {
    await issue("SPRAY_DISPUTE: respond in Paystack before the deadline");
    return "already";
  }
  if (!(DISPUTABLE as readonly string[]).includes(row.status)) return "unknown";

  const delivered = row.status === "delivered";
  try {
    await c.query("BEGIN");
    // Review r4 m1: clawbacks are written under the 'spray-recv' locks (id order), like toReversing and the reservation's
    // receive-ban check.
    for (const id of Array.from(new Set([row.host_id, row.recipient_id])).sort()) {
      await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [capLockKey(id)]);
    }
    const won = await c.query(
      `update spray_payments set status = 'disputed', reason = 'DISPUTED' where id = $1 and status = $2 returning id`,
      [row.id, row.status],
    );
    if (!won.rowCount) { await c.query("ROLLBACK"); return "already"; }
    await recordSprayEvent({ sprayId: row.id, roomId: row.room_id, from: row.status, to: "disputed", detail: "DISPUTED" }, c);
    // Review r4 m3: a spray that was still holding the payer's room-limit reservation (created, pending, paid) gives it
    // back: it will never be delivered. (failed already released it; delivered spent it for real.)
    if (row.status === "created" || row.status === "pending" || row.status === "paid") {
      await c.query(
        `update room_spend set spent_kobo = greatest(spent_kobo - $3::int, 0) where room_id = $1 and user_id = $2`,
        [row.room_id, row.payer_id, Number(row.amount_kobo)],
      );
    }
    const hostKobo = Number(row.host_kobo);
    const guestKobo = row.guest_kobo === null ? 0 : Number(row.guest_kobo);
    await c.query(
      `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                         gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
       select 'chargeback', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'disputed', $9::timestamp
        where not exists (select 1 from payment_transactions where type = 'chargeback' and provider_payment_id = $2::text)`,
      [row.provider, reference, row.payer_id, row.host_id, row.id, Number(row.amount_kobo), Number(row.platform_kobo), hostKobo + guestKobo, iso(nowMs)],
    );
    const claw = (beneficiary: string, amount: number) => c.query(
      `insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo, origin, status, created_at)
       values ($1, $2, $3::uuid, $4::int, 'dispute', 'open', $5::timestamp)
       on conflict (spray_id, beneficiary_id) do nothing`,
      [row.host_id, beneficiary, row.id, amount, iso(nowMs)],
    );
    if (hostKobo > 0) await claw(row.host_id, hostKobo);
    // A stage guest spray: the guest's share is owed back by the guest (the recipient), never by the host.
    if (guestKobo > 0 && row.recipient_id !== row.host_id) await claw(row.recipient_id, guestKobo);
    await openPaymentIssue(c, {
      ticketId: null, providerRef: reference, provider: row.provider, reason: "dispute", now: new Date(nowMs),
      error: delivered
        ? "SPRAY_DISPUTE: a delivered spray was disputed; respond in Paystack before the deadline (clawbacks opened)"
        : `SPRAY_DISPUTE_UNDELIVERED: the spray was never delivered (it was ${row.status}); respond in Paystack before the deadline (clawbacks opened, delivery blocked)`,
    });
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  console.error(`[rooms:spray] ALERT chargeback on spray ${row.id} (room ${row.room_id}, was ${row.status}); clawbacks opened`);
  return "disputed";
}

export type DisputeResolveOutcome = "settled" | "kept_open" | "needs_person" | "already" | "unknown";

/** charge.dispute.resolve on a spray reference. Idempotent. Throws when the reference is busy (500, Paystack retries). */
export async function handleSprayDisputeResolved(reference: string, data: unknown): Promise<DisputeResolveOutcome> {
  const resolution = disputeResolution(data);
  const r = await withAdvisoryLock(LOCK_SPRAY, reference, (c) => resolveLocked(c, reference, resolution), 8000);
  if (r === BUSY) throw new Error("spray reference is busy; retry the dispute webhook");
  return r;
}

async function resolveLocked(c: PoolClient, reference: string, resolution: string): Promise<DisputeResolveOutcome> {
  const nowMs = sprayClock.now();
  const row = await loadRow(c, reference);
  if (!row) return (await resolveBatchDisputeLocked(c, reference, resolution)) ?? "unknown";
  const now = new Date(nowMs);
  const issue = (error: string) => openPaymentIssue(c, { ticketId: null, providerRef: reference, provider: row.provider, reason: "dispute_resolved", error, now });
  // Review r5 I3: an OUTCOME issue (REPAY, LOST_AFTER_REFUND, WON_UNDELIVERED) must always land. openPaymentIssue keeps one
  // open row per (reference, reason), so any older open dispute_resolved issue (for example an UNKNOWN one) is closed
  // first; it is superseded by the outcome now known.
  const outcomeIssue = async (error: string) => {
    await c.query(
      `update payment_issues set resolved_at = $2::timestamp where provider_payment_id = $1 and reason = 'dispute_resolved' and resolved_at is null`,
      [reference, iso(nowMs)],
    );
    await issue(error);
  };
  // Review r5 I2: an issue that must never be swallowed by the de-duplication, and must not hide an open outcome issue
  // either: a new row when possible, else appended to the open one.
  const noteIssue = async (error: string) => {
    if (await issue(error)) return;
    await c.query(
      `update payment_issues set error_message = left(coalesce(error_message, '') || ' | ' || $3::text, 2000)
        where provider_payment_id = $1 and reason = 'dispute_resolved' and resolved_at is null and created_at <= $2::timestamp
          and position($3::text in coalesce(error_message, '')) = 0`,
      [reference, iso(nowMs), error],
    );
  };
  const merchantWon = resolution === "declined";
  const customerWon = resolution === "merchant-accepted" || resolution === "accepted";
  let outcome: DisputeResolveOutcome;
  /** Something was actually decided (review r5 I2): only then is the 'dispute' issue closed. */
  let acted = false;
  let owedBack = 0;
  try {
    await c.query("BEGIN");
    if (row.status === "reversing" || row.status === "reversed") {
      // Review r4 N1 / N2: the payer was already refunded in full (by us). Never "refund the payer by hand".
      if (customerWon) {
        // Review r5 m2: once per reference, even after a person closed the first one (no duplicate chase of the payer).
        const seen = await c.query(
          `select 1 from payment_issues where provider_payment_id = $1 and reason = 'dispute_resolved' and error_message like 'SPRAY_DISPUTE_LOST_AFTER_REFUND%' limit 1`,
          [reference],
        );
        if (seen.rowCount) {
          outcome = "already";
        } else {
          await outcomeIssue("SPRAY_DISPUTE_LOST_AFTER_REFUND: the payer won a chargeback on a spray we had already refunded in full (or were refunding); they may be paid back twice. Check whether our refund went out, then recover it through Paystack or from the payer");
          outcome = "needs_person";
        }
        acted = true;
      } else if (merchantWon) {
        outcome = "settled"; // no money moves: the refund stands, the reversal clawbacks are untouched
        acted = true;
      } else {
        await noteIssue("SPRAY_DISPUTE_RESOLVED_UNKNOWN: a dispute on a refunded spray was resolved with an outcome we do not recognise; check it in Paystack (no money action taken)");
        outcome = "needs_person";
      }
    } else if (row.status === "disputed") {
      if (!merchantWon && !customerWon) {
        // Not acted on and not marked done, so a later event with a known word can still settle it.
        await noteIssue("SPRAY_DISPUTE_RESOLVED_UNKNOWN: the dispute was resolved with an outcome we do not recognise; check it in Paystack (clawbacks stay open)");
        outcome = "needs_person";
      } else {
        // Review r4 N3: idempotent on the chargeback ledger row (flipped once, by code only), NOT on whether open clawbacks
        // remain: a payout may already have recovered them all, and the host must then be repaid.
        const target = merchantWon ? "chargeback_won" : "chargeback_lost";
        const flip = await c.query(
          `update payment_transactions set status = $2 where type = 'chargeback' and provider_payment_id = $1 and status = 'disputed' returning id`,
          [reference, target],
        );
        if (!flip.rowCount) {
          // Review r5 I2: nothing flipped. The same outcome again is a harmless repeat; a DIFFERENT outcome (a second
          // dispute cycle, pre-arbitration, or two resolve events disagreeing) must reach a person.
          const cur = (await c.query(
            `select status from payment_transactions where type = 'chargeback' and provider_payment_id = $1 limit 1`,
            [reference],
          )).rows[0] as { status: string } | undefined;
          if (cur && cur.status !== target) {
            await noteIssue(`SPRAY_DISPUTE_OUTCOME_CHANGED: the chargeback was ${cur.status}, the provider now says ${target}; check it in Paystack (clawbacks were not changed)`);
            outcome = "needs_person";
          } else if (!cur) {
            await noteIssue("SPRAY_DISPUTE_RESOLVED_NO_LEDGER: a dispute was resolved but the chargeback ledger row is missing; check it in Paystack (nothing changed)");
            outcome = "needs_person";
          } else {
            outcome = "already";
          }
        } else if (customerWon) {
          outcome = "kept_open"; // the chargeback stands: the clawbacks are the record of what is owed
          acted = true;
        } else if (row.delivered) {
          // Won on a delivered spray: the money came back through the dispute, so the dispute clawbacks are settled, and
          // whatever payouts had already taken for them is repaid. Review r5 I1: EVERY dispute row of the spray is locked
          // FOR UPDATE before anything is summed, so a payout applying a clawback at this moment either commits first (and
          // is counted) or waits and then finds the rows settled. (No aggregate with FOR UPDATE: rows, summed here.)
          const rows = (await c.query(
            `select id, status, recovered_kobo from host_clawbacks where spray_id = $1::uuid and origin = 'dispute' order by id for update`,
            [row.id],
          )).rows as { id: string; status: string; recovered_kobo: number }[];
          owedBack = rows.reduce((n, r) => n + (Number.isSafeInteger(Number(r.recovered_kobo)) ? Number(r.recovered_kobo) : 0), 0);
          // Settled rows read recovered_kobo = amount_kobo (the table's rule for 'recovered'); what payouts really took is
          // in the REPAY issue and the log line below (review r4 m4, schema frozen).
          await c.query(
            `update host_clawbacks set status = 'recovered', recovered_at = $2::timestamp, recovered_kobo = amount_kobo
              where spray_id = $1::uuid and origin = 'dispute' and status = 'open'`,
            [row.id, iso(nowMs)],
          );
          if (owedBack > 0) {
            await outcomeIssue(`SPRAY_DISPUTE_WON_REPAY: the dispute was won, but ${owedBack} kobo had already been recovered from payouts for it; repay the beneficiaries by hand`);
            outcome = "needs_person";
          } else {
            outcome = "settled";
          }
          acted = true;
        } else {
          // Won on a spray that was never delivered AND never refunded (disputed straight from created / pending / paid /
          // failed): the payer paid for nothing.
          await outcomeIssue("SPRAY_DISPUTE_WON_UNDELIVERED: the dispute was won, but the spray was never delivered or refunded; refund the payer by hand or record why not (clawbacks stay open)");
          outcome = "needs_person";
          acted = true;
        }
      }
    } else {
      await noteIssue(`SPRAY_DISPUTE_RESOLVED_UNEXPECTED: a dispute was resolved on a spray in status ${row.status}; check it in Paystack`);
      outcome = "needs_person";
    }
    // Review r5 I2: the dispute issue is closed only when this event actually decided something.
    if (acted) {
      await c.query(
        `update payment_issues set resolved_at = $2::timestamp where provider_payment_id = $1 and reason = 'dispute' and resolved_at is null`,
        [reference, iso(nowMs)],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  console.error(`[rooms:spray] ALERT dispute resolved ref=${sprayReferenceForLog(reference)} outcome=${outcome} resolution=${resolution || "?"} owed_back_kobo=${owedBack}`);
  return outcome;
}

export interface ClawbackApplication {
  appliedKobo: number;
  /** Rows still open after this (including rows only partly recovered now). */
  remainingOpen: number;
  /** Rows recovered in full by this call. */
  recoveredIds: string[];
  /** Rows partly recovered by this call (still open, recovered_kobo raised). */
  partialIds: string[];
}

/**
 * Applies the open clawbacks a person owes against `availableKobo` they are about to be paid. Pass the caller's
 * transaction client (settlement's payout transaction) so the rows are locked and updated in that same commit.
 * Oldest first; a row larger than what is left is recovered PARTLY (recovered_kobo), 'recovered' only when it reaches
 * amount_kobo. Never applies more than is available.
 */
export async function applyClawbacks(
  beneficiaryId: string, availableKobo: number, opts: { client?: Queryable; now?: Date } = {},
): Promise<ClawbackApplication> {
  const q: Queryable = opts.client ?? pool;
  const now = opts.now ?? new Date(sprayClock.now());
  const out: ClawbackApplication = { appliedKobo: 0, remainingOpen: 0, recoveredIds: [], partialIds: [] };
  // Before the spray migration is applied there is nothing to apply. Checked without an error: a failing statement would
  // abort settlement's transaction and stop ticket payouts.
  const exists = (await q.query(`select to_regclass('public.host_clawbacks') is not null as ok`)).rows[0];
  if (exists?.ok !== true) return out;
  if (!Number.isSafeInteger(availableKobo) || availableKobo <= 0) {
    const n = (await q.query(`select count(*)::int as n from host_clawbacks where beneficiary_id = $1 and status = 'open'`, [beneficiaryId])).rows[0];
    out.remainingOpen = Number(n?.n ?? 0);
    return out;
  }
  const open = (await q.query(
    `select id, amount_kobo, recovered_kobo from host_clawbacks where beneficiary_id = $1 and status = 'open' order by created_at, id for update`,
    [beneficiaryId],
  )).rows as { id: string; amount_kobo: number; recovered_kobo: number }[];
  let left = availableKobo;
  for (const r of open) {
    const amount = Number(r.amount_kobo);
    const before = Number(r.recovered_kobo);
    const owed = amount - before;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(before) || owed <= 0 || left <= 0) { out.remainingOpen++; continue; }
    const take = Math.min(owed, left);
    const full = before + take === amount;
    // Locked FOR UPDATE above, so the row is still open with the same recovered_kobo; if not, apply nothing (fail closed:
    // never deducted twice).
    const upd = await q.query(
      `update host_clawbacks
          set recovered_kobo = $2::int,
              status = case when $3::boolean then 'recovered' else 'open' end,
              recovered_at = case when $3::boolean then $4::timestamp else recovered_at end
        where id = $1::uuid and status = 'open' and recovered_kobo = $5::int
        returning id`,
      [r.id, before + take, full, now.toISOString(), before],
    );
    if ((upd.rowCount ?? 0) !== 1) throw new Error("clawbacks changed while they were being applied");
    left -= take;
    out.appliedKobo += take;
    if (full) out.recoveredIds.push(r.id);
    else { out.partialIds.push(r.id); out.remainingOpen++; }
  }
  return out;
}

// ---------------------------------------------------------------- admin (finance roles)
const FINANCE = ["super_admin", "finance_manager"] as const;
const writeOffBody = z.object({ reason: z.string().trim().min(3).max(300) });

/** Registered by admin-routes.ts after the admin session middleware (one line there). */
export function registerSprayClawbackAdminRoutes(app: Express): void {
  app.get("/api/admin/room-clawbacks", requireRole(...FINANCE), async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === "string" && ["open", "recovered", "written_off"].includes(req.query.status) ? req.query.status : null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = (await pool.query(
        `select k.id, k.host_id, k.beneficiary_id, k.spray_id, k.amount_kobo, k.recovered_kobo, k.origin, k.status,
                k.written_off_reason, k.written_off_by,
                round(extract(epoch from k.created_at) * 1000)::float8 as created_ms,
                round(extract(epoch from k.recovered_at) * 1000)::float8 as recovered_ms,
                s.room_id, s.tier
           from host_clawbacks k join spray_payments s on s.id = k.spray_id
          where ($1::text is null or k.status = $1::text)
          order by (k.status = 'open') desc, k.created_at asc
          limit $2 offset $3`,
        [status, limit, offset],
      )).rows as any[];
      const ms = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v)).toISOString());
      res.json({
        clawbacks: rows.map((k) => ({
          id: k.id, hostId: k.host_id, beneficiaryId: k.beneficiary_id, sprayId: k.spray_id, roomId: k.room_id, tier: k.tier,
          amountKobo: Number(k.amount_kobo), recoveredKobo: Number(k.recovered_kobo ?? 0), origin: k.origin, status: k.status,
          writtenOffReason: k.written_off_reason ?? null, writtenOffBy: k.written_off_by ?? null,
          createdAt: ms(k.created_ms), recoveredAt: ms(k.recovered_ms),
        })),
      });
    } catch (e) {
      console.error("[ADMIN] room clawbacks failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load clawbacks" });
    }
  });

  // Write off one open clawback (what is still owed of it). written_off_by is the admin (admin_users), plus the reason on the
  // row and the audit row.
  app.post("/api/admin/room-clawbacks/:id/write-off", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const parsed = writeOffBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" });
    const id = String(req.params.id ?? "");
    if (!isUuid(id)) return res.status(404).json({ message: "Clawback not found", code: "NOT_FOUND" });
    const adminId = req.session.adminId;
    if (typeof adminId !== "string" || !adminId) return res.status(401).json({ message: "Admin session required" });
    try {
      const reason = sanitizeMoneyError(parsed.data.reason).slice(0, 300);
      const r = await pool.query(
        `update host_clawbacks set status = 'written_off', written_off_reason = $2, written_off_by = $3
          where id = $1::uuid and status = 'open'
          returning id, amount_kobo, recovered_kobo, beneficiary_id`,
        [id, reason, adminId],
      );
      if (!r.rowCount) return res.status(409).json({ message: "This clawback is not open.", code: "NOT_OPEN" });
      await storage.logAdminActivity({
        adminId,
        action: "room_clawback.write_off",
        targetType: "room_clawback",
        targetId: id,
        details: JSON.stringify({
          amountKobo: Number(r.rows[0].amount_kobo), recoveredKobo: Number(r.rows[0].recovered_kobo ?? 0), beneficiaryId: r.rows[0].beneficiary_id,
        }).slice(0, 1000),
        reason,
        ipAddress: req.ip,
      }).catch((e) => console.error(`[ADMIN] ALERT clawback ${id} written off but the audit row failed:`, sanitizeMoneyError(e)));
      res.json({ id, status: "written_off" });
    } catch (e) {
      console.error("[ADMIN] clawback write-off failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "That did not work. Check the clawback before trying again." });
    }
  });
}
