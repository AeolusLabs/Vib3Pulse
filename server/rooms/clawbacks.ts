// Spraying (phase 5, task 5.6, rule B10): chargebacks on sprays and the clawbacks they create.
//
//  - A dispute on a spray reference (Paystack charge.dispute.create / .remind, signature already checked by the webhook
//    route): under the reference's advisory lock, ONE transaction moves the spray delivered -> disputed (conditional), writes
//    the `chargeback` ledger row (once per reference) and one host_clawbacks row per beneficiary (the host's share, and the
//    stage guest's share when there was one), idempotent through the unique (spray_id, beneficiary_id). Nothing is deleted.
//    A second event for the same reference finds the spray already disputed and changes nothing.
//  - applyClawbacks(beneficiaryId, availableKobo) is called by settlement (settlement.ts, queueDuePayout) INSIDE the payout
//    transaction that holds the payout row lock: open clawbacks of that person are locked FOR UPDATE, applied oldest first
//    as whole rows while they fit, and marked recovered in the same transaction. The payout is the available amount minus
//    what was applied (never below 0). There is no partial-amount column, so a row larger than what is left stays open
//    for the next payout (owner question in the lane report).
//  - written_off only by an admin (finance roles), with a reason, audited in the admin activity log.
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, storage } from "../storage";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { sprayReferenceForLog } from "../payments/sprayReference";
import { requireRole } from "../services/adminSecurity";
import { BUSY, withAdvisoryLock } from "./refunds";
import { LOCK_SPRAY, sprayClock } from "./spray";

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

export type DisputeOutcome = "disputed" | "already" | "not_delivered" | "unknown";

/**
 * A chargeback on a spray. Idempotent. Throws when the reference is busy (the webhook answers 500 and Paystack retries).
 * The payload is never trusted for amounts: the clawbacks are the stored host and guest shares of the row.
 */
export async function handleSprayDispute(reference: string): Promise<DisputeOutcome> {
  const r = await withAdvisoryLock(LOCK_SPRAY, reference, (c) => disputeLocked(c, reference), 8000);
  if (r === BUSY) throw new Error("spray reference is busy; retry the dispute webhook");
  return r;
}

async function disputeLocked(c: PoolClient, reference: string): Promise<DisputeOutcome> {
  const nowMs = sprayClock.now();
  const row = (await c.query(
    `select id, status, room_id, host_id, payer_id, recipient_id, amount_kobo, platform_kobo, host_kobo, guest_kobo, provider
       from spray_payments where provider_ref = $1`,
    [reference],
  )).rows[0] as {
    id: string; status: string; room_id: string; host_id: string; payer_id: string; recipient_id: string; amount_kobo: number;
    platform_kobo: number; host_kobo: number; guest_kobo: number | null; provider: string;
  } | undefined;
  if (!row) { console.log(`[rooms:spray] dispute ref=${sprayReferenceForLog(reference)} ignored: no spray`); return "unknown"; }
  if (row.status === "disputed") return "already";
  if (row.status !== "delivered") {
    // Never delivered (still in flight, reversed or failed): nothing reached anyone through us, so there is nothing to claw
    // back. A person checks it in Paystack (a dispute on a refunded payment, for example).
    console.error(`[rooms:spray] ALERT dispute ref=${sprayReferenceForLog(reference)} on a spray in status ${row.status}; nothing clawed back, check it in Paystack`);
    return "not_delivered";
  }
  try {
    await c.query("BEGIN");
    const won = await c.query(
      `update spray_payments set status = 'disputed', reason = 'DISPUTED' where id = $1 and status = 'delivered' returning id`,
      [row.id],
    );
    if (!won.rowCount) { await c.query("ROLLBACK"); return "already"; }
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
      `insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo, status, created_at)
       values ($1, $2, $3::uuid, $4::int, 'open', $5::timestamp)
       on conflict (spray_id, beneficiary_id) do nothing`,
      [row.host_id, beneficiary, row.id, amount, iso(nowMs)],
    );
    if (hostKobo > 0) await claw(row.host_id, hostKobo);
    // A stage guest spray: the guest's share is owed back by the guest (the recipient), never by the host.
    if (guestKobo > 0 && row.recipient_id !== row.host_id) await claw(row.recipient_id, guestKobo);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  console.error(`[rooms:spray] ALERT chargeback on spray ${row.id} (room ${row.room_id}); clawbacks opened`);
  return "disputed";
}

export interface ClawbackApplication { appliedKobo: number; remainingOpen: number; recoveredIds: string[] }

/**
 * Applies the open clawbacks a person owes against `availableKobo` they are about to be paid. Pass the caller's
 * transaction client (settlement's payout transaction) so the rows are locked and marked recovered in that same commit.
 * Whole rows, oldest first, skipping a row that does not fit. Never applies more than is available.
 */
export async function applyClawbacks(
  beneficiaryId: string, availableKobo: number, opts: { client?: Queryable; now?: Date } = {},
): Promise<ClawbackApplication> {
  const q: Queryable = opts.client ?? pool;
  const now = opts.now ?? new Date(sprayClock.now());
  const out: ClawbackApplication = { appliedKobo: 0, remainingOpen: 0, recoveredIds: [] };
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
    `select id, amount_kobo from host_clawbacks where beneficiary_id = $1 and status = 'open' order by created_at, id for update`,
    [beneficiaryId],
  )).rows as { id: string; amount_kobo: number }[];
  let left = availableKobo;
  for (const r of open) {
    const amount = Number(r.amount_kobo);
    if (Number.isSafeInteger(amount) && amount > 0 && amount <= left) {
      left -= amount;
      out.appliedKobo += amount;
      out.recoveredIds.push(r.id);
    } else {
      out.remainingOpen++;
    }
  }
  if (out.recoveredIds.length) {
    const marked = await q.query(
      `update host_clawbacks set status = 'recovered', recovered_at = $2::timestamp where id = any($1::uuid[]) and status = 'open' returning id`,
      [out.recoveredIds, now.toISOString()],
    );
    // Locked FOR UPDATE above, so every row is still open; if not, apply nothing (fail closed: the host is paid in full later
    // only after a person looks, never twice deducted).
    if ((marked.rowCount ?? 0) !== out.recoveredIds.length) throw new Error("clawbacks changed while they were being applied");
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
        `select k.id, k.host_id, k.beneficiary_id, k.spray_id, k.amount_kobo, k.status, k.written_off_reason,
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
          amountKobo: Number(k.amount_kobo), status: k.status, writtenOffReason: k.written_off_reason ?? null,
          createdAt: ms(k.created_ms), recoveredAt: ms(k.recovered_ms),
        })),
      });
    } catch (e) {
      console.error("[ADMIN] room clawbacks failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load clawbacks" });
    }
  });

  // Write off one open clawback. Admin ids live in admin_users, while host_clawbacks.written_off_by references users, so the
  // admin is recorded in the audit row (and the reason on the clawback); written_off_by stays null (see the lane report).
  app.post("/api/admin/room-clawbacks/:id/write-off", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const parsed = writeOffBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" });
    const id = String(req.params.id ?? "");
    if (!isUuid(id)) return res.status(404).json({ message: "Clawback not found", code: "NOT_FOUND" });
    try {
      const reason = sanitizeMoneyError(parsed.data.reason).slice(0, 300);
      const r = await pool.query(
        `update host_clawbacks set status = 'written_off', written_off_reason = $2 where id = $1::uuid and status = 'open'
          returning id, amount_kobo, beneficiary_id`,
        [id, reason],
      );
      if (!r.rowCount) return res.status(409).json({ message: "This clawback is not open.", code: "NOT_OPEN" });
      await storage.logAdminActivity({
        adminId: req.session.adminId!,
        action: "room_clawback.write_off",
        targetType: "room_clawback",
        targetId: id,
        details: JSON.stringify({ amountKobo: Number(r.rows[0].amount_kobo), beneficiaryId: r.rows[0].beneficiary_id }).slice(0, 1000),
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
