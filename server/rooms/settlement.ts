// Paying the host of a ticketed room (phase 4, task 4.6), and the finance levers on it.
//
// MONEY RULES (read before changing anything here)
//  - A payout exists only for a room that really went live (started_at set) and ended with paid tickets. A room that never
//    started never pays out: its tickets are refunded (refunds.ts).
//  - A room that must not pay its host (minors' room, moderation not approved, closed for a host review, a host who may no
//    longer host it) never gets a payout: every paid ticket is refunded (host_cancelled) instead. Checked when the payout
//    is scheduled AND again when it is queued (moderation can change during the 48 h hold).
//  - held -> queued happens in ONE transaction holding the payout row lock (refundTicket takes the same lock), and the amount
//    is recomputed right there as sum(host_kobo) of the paid tickets. From queued on, refunds are refused (not_allowed),
//    so the amount sent can never include a refunded ticket. Amounts only ever come from stored host_kobo.
//  - Paying runs under a per-payout advisory lock (one process at a time) and always asks Paystack first whether a transfer
//    with the payout's reference exists. Only when Paystack SAYS "none" is a transfer started, with that same reference
//    (Paystack's idempotency key). An outage while asking means: do nothing, try next pass.
//  - The reference is `room-payout-<roomId>`; only an admin requeue after a CONCLUSIVE failure moves it to a new
//    generation `room-payout-<roomId>-r<n>` (never while an earlier transfer could still go through).
//  - queued -> paid / failed are conditional UPDATEs (WHERE status = 'queued'); paid + its ledger row commit together.
//  - Bank details come only from the host's verified Paystack subaccount (organizer_payment_accounts), resolved inside the
//    payment layer. They are never stored, logged or put in last_error.
//  - An admin hold is release_at = 9999-12-31 (PAYOUT_HOLD_SENTINEL) with last_error 'ADMIN_HOLD: <reason>'; no new status.
//
// Failure windows (all safe):
//  - crash after queued, before the transfer call: next pass verifies (none) and starts it with the same reference.
//  - transfer accepted but our process died (or the response was lost) before 'paid': next pass verifies and finds it.
//  - Paystack answers with an error (insufficient balance, bad account...): attempts + 1, last_error, stays queued; the 5th
//    failure marks 'failed' and opens a payout_failed issue for finance (admins check Paystack for the reference before any
//    action; the requeue lever re-checks it). A final transfer status (failed / reversed / abandoned / rejected / blocked)
//    marks 'failed' at once: the same reference is never re-sent automatically after Paystack itself gave up.
//  - Paystack unreachable (network, any 5xx even with a JSON body, an unclear "not found"): last_error PROVIDER_UNAVAILABLE,
//    attempts unchanged, stays queued (an outage never burns the 5 attempts); the admin list flags payouts still queued
//    24 h after release.
//  - no verified payout account: last_error NO_PAYOUT_ACCOUNT, stays queued, payout_failed issue opened (one per payout).
//  - the bank of the payout account cannot be matched: counted as an attempt ONCE, alerted, then tried at most hourly.
//  - a transfer that succeeded and is later REVERSED (webhook transfer.reversed, re-verified): payout -> failed, a
//    reversal ledger row, a payout_failed alert (host unpaid). An admin decides (requeue makes a new reference).
import type { PoolClient } from "pg";
import { pool } from "../storage";
import { createTransfer, createTransferRecipient, verifyTransfer } from "../payments";
import { ageFromDob, minAgeForLimit, type AgeLimit } from "@shared/age";
import {
  afterFailedAttempt, classifyTransferStatus, isAdminHold, payoutBlockReason, payoutGeneration, payoutReference, payoutReleaseAt,
  sanitizeMoneyError, ADMIN_HOLD_NOTE, BANK_UNRESOLVED_RETRY_MS, MONEY_JOB_EVERY_MS, PAYOUT_HOLD_SENTINEL_ISO,
  type PayoutBlock,
} from "@shared/roomRefunds";
import { BUSY, LOCK_PAYOUT, iso, isUuid, moneyClock, openPaymentIssue, refundAllForRoom, withAdvisoryLock, type RoomRefundTally } from "./refunds";
import { notifyPayoutPaid } from "./notify";
import { LOCK_ACCOUNT_CHANGE, PAYABLE_ACCOUNT_SQL, payableSubaccountOf } from "./payouts";

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";

/**
 * Inside an open transaction: takes the SHARED transaction advisory lock on (LOCK_ACCOUNT_CHANGE, hostId), which conflicts
 * only with a payout account change in progress (payouts.ts holds it exclusively). false = a change is running: do not
 * queue now. The lock is released at COMMIT / ROLLBACK.
 */
async function accountChangeIdle(c: Queryable, hostId: string): Promise<boolean> {
  const r = (await c.query("select pg_try_advisory_xact_lock_shared($1::int, hashtext($2::text)) as ok", [LOCK_ACCOUNT_CHANGE, hostId])).rows[0] as { ok: boolean } | undefined;
  return r?.ok === true;
}
type Queryable = { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export interface PayoutRow {
  id: string; room_id: string; host_id: string; amount_kobo: number; status: string; transfer_ref: string | null; attempts: number;
}

/** Why this room must not pay its host now (reads the room and the host's CURRENT birthdate), or null. */
export async function payoutBlockFor(q: Queryable, roomId: string, opts: { hostReview?: boolean } = {}): Promise<PayoutBlock | null> {
  const r = (await q.query(
    `select r.minors_room, r.moderation_status, r.age_limit, u.date_of_birth::text as dob
       from rooms r left join users u on u.id = r.host_id where r.id = $1`,
    [roomId],
  )).rows[0] as { minors_room: boolean; moderation_status: string | null; age_limit: string; dob: string | null } | undefined;
  if (!r) return null;
  return payoutBlockReason({
    minorsRoom: r.minors_room === true,
    moderationStatus: r.moderation_status,
    hostReview: opts.hostReview === true,
    hostAge: ageFromDob(r.dob),
    minAge: minAgeForLimit((r.age_limit ?? "all") as AgeLimit),
  });
}

/** A room that must not pay out: every paid ticket back to its buyer (host_cancelled), the held payout removed. */
async function refundInsteadOfPayout(roomId: string, block: PayoutBlock): Promise<RoomRefundTally | null> {
  console.error(`[rooms] room ${roomId} will not pay its host (${block}); refunding every ticket`);
  return refundAllForRoom(roomId, "host_cancelled")
    .catch((e) => { console.error("[rooms] refunds instead of payout failed:", roomId, sanitizeMoneyError(e)); return null; });
}

/**
 * Called when a ticketed room ENDS (hook in roomSocket.endRoom) and by the settlement job as a safety net.
 * Creates (or, while still held, updates) the payout: release_at = ended_at + 48 h, amount = sum(host_kobo) of paid tickets.
 * No-op for rooms that never started, have not ended, or have no paid tickets. A room that must not pay its host
 * (payoutBlockFor; hostReview = it was closed by endForHostReview) gets NO payout: its tickets are refunded instead.
 * An admin hold (release_at at the sentinel) is kept. Returns the row, or null.
 */
export async function scheduleRoomPayout(roomId: string, opts: { hostReview?: boolean } = {}): Promise<PayoutRow | null> {
  const room = (await pool.query(
    `select id, host_id, status, (started_at is not null) as started, round(extract(epoch from ended_at) * 1000)::float8 as ended_ms
       from rooms where id = $1`,
    [roomId],
  )).rows[0] as { id: string; host_id: string; status: string; started: boolean; ended_ms: number | null } | undefined;
  if (!room || room.status !== "ended" || !room.started || room.ended_ms === null) return null;
  const block = await payoutBlockFor(pool, roomId, opts);
  if (block) { await refundInsteadOfPayout(roomId, block); return null; }
  const releaseAt = new Date(payoutReleaseAt(Number(room.ended_ms)));
  const r = await pool.query(
    `insert into room_payouts (room_id, host_id, amount_kobo, status, release_at)
     select $1::varchar, $2::varchar, coalesce(sum(t.host_kobo), 0), 'held', $3::timestamp
       from room_tickets t where t.room_id = $1::varchar and t.status = 'paid'
     having count(*) > 0
     on conflict (room_id) do update set amount_kobo = excluded.amount_kobo,
            release_at = case when room_payouts.release_at >= $4::timestamp then room_payouts.release_at else excluded.release_at end
       where room_payouts.status = 'held'
     returning id, room_id, host_id, amount_kobo, status, transfer_ref, attempts`,
    [room.id, room.host_id, iso(releaseAt), PAYOUT_HOLD_SENTINEL_ISO],
  );
  return (r.rows[0] as PayoutRow | undefined) ?? null;
}

/**
 * Everything that follows a room ending, in one place (the hook in endRoom calls only this). A room that went live gets
 * its payout scheduled (or, when it must not pay out, refunds); a room ended before it ever started (host ended or
 * cancelled it, admin, safety rule) refunds every ticket in the background (the refund job sweeps anything this misses).
 * hostReview: closed by endForHostReview (the host's account is being reviewed): never paid out. Never throws.
 */
export async function afterRoomEnded(roomId: string, opts: { hostReview?: boolean } = {}): Promise<void> {
  try {
    const room = (await pool.query(`select status, (started_at is not null) as started from rooms where id = $1`, [roomId])).rows[0] as
      { status: string; started: boolean } | undefined;
    if (!room || room.status !== "ended") return;
    if (room.started) {
      // A room that must not pay out refunds in the background (a host review can close many rooms; the room end must
      // not wait on provider calls). The settlement safety net re-checks the block, so nothing is paid meanwhile.
      const block = await payoutBlockFor(pool, roomId, opts);
      if (block) { void refundInsteadOfPayout(roomId, block); return; }
      await scheduleRoomPayout(roomId, opts);
      return;
    }
    void refundAllForRoom(roomId, "host_cancelled").catch((e) => console.error("[rooms] refunds after end failed:", roomId, sanitizeMoneyError(e)));
  } catch (e) {
    if (!isMissingTable(e)) console.error("[rooms] after-end money step failed:", roomId, sanitizeMoneyError(e));
  }
}

/** held -> queued (or removed when nothing is left to pay), under the payout row lock. Returns the new status, or null. */
async function queueDuePayout(payoutId: string, now: Date): Promise<"queued" | "removed" | "refunding" | "clawed_back" | "waiting_account" | null> {
  const c = await pool.connect();
  let blocked: { roomId: string; block: PayoutBlock } | null = null;
  let unpayable: { roomId: string } | null = null;
  try {
    await c.query("BEGIN");
    const p = (await c.query(
      `select p.id, p.room_id, p.host_id, p.status, round(extract(epoch from p.release_at) * 1000)::float8 as release_ms,
              (r.started_at is not null) as started
         from room_payouts p join rooms r on r.id = p.room_id
        where p.id = $1 for update of p`,
      [payoutId],
    )).rows[0] as { id: string; room_id: string; host_id: string; status: string; release_ms: number | null; started: boolean } | undefined;
    if (!p || p.status !== "held" || p.release_ms === null || isAdminHold(Number(p.release_ms)) || Number(p.release_ms) > now.getTime()) {
      await c.query("ROLLBACK"); return null;
    }
    // Fix round I3: never queue while the host's payout account is being changed (payouts.ts holds the exclusive lock on
    // this key for the change). The shared lock is held to COMMIT, so a change that starts now waits and then sees 'queued'.
    if (!(await accountChangeIdle(c, p.host_id))) { await c.query("ROLLBACK"); return null; } // next pass
    const block = await payoutBlockFor(c, p.room_id);
    if (block) {
      // Moderation (or the host's status) changed during the hold: never pay; refund after this lock is released.
      await c.query("ROLLBACK");
      blocked = { roomId: p.room_id, block };
    } else {
      const sum = (await c.query(
        `select coalesce(sum(host_kobo), 0)::bigint as amount, count(*)::int as n from room_tickets where room_id = $1 and status = 'paid'`,
        [p.room_id],
      )).rows[0] as { amount: string; n: number };
      if (!p.started || sum.n === 0 || Number(sum.amount) <= 0) {
        // Never pay a room that did not start, nor an empty payout. (Tickets of a room that never started are refunded by the job.)
        await c.query(`delete from room_payouts where id = $1 and status = 'held'`, [p.id]);
        await c.query("COMMIT");
        return "removed";
      }
      // Review r3 N1 (a): a payout is queued ONLY when it can be paid now (a name-checked payable account). Otherwise it
      // stays held (nothing is applied, nothing changes) and a payout_failed NO_PAYOUT_ACCOUNT issue is opened; the next
      // pass queues it once the host has saved a payable account. So 'queued' always means "being sent", and the account
      // change's 409 keeps its meaning.
      if (!(await payableSubaccountOf(p.host_id, c))) {
        await c.query("ROLLBACK");
        unpayable = { roomId: p.room_id };
        return "waiting_account";
      }
      // Spraying (phase 5, rule B10): open clawbacks this host owes (chargebacks on sprays) come off this payout, in this
      // transaction, under the payout row lock. The host is paid max(0, amount - applied); the applied rows are recovered.
      // Lazy import: clawbacks.ts reaches the room modules (cycle); call time only.
      const { applyClawbacks } = await import("./clawbacks");
      const gross = Number(sum.amount);
      const cb = await applyClawbacks(p.host_id, gross, { client: c, now });
      const net = Math.max(0, gross - cb.appliedKobo);
      if (net <= 0) {
        // Everything went to clawbacks: nothing to send. Closed as paid with 0 and a note, so it is never sent and never
        // looks unpaid (the recovered clawbacks are the record of where the money went).
        await c.query(
          `update room_payouts set status = 'paid', amount_kobo = 0, transfer_ref = $2, paid_at = $3::timestamp, last_error = 'CLAWED_BACK'
            where id = $1 and status = 'held'`,
          [p.id, payoutReference(p.room_id), iso(now)],
        );
        await c.query("COMMIT");
        console.error(`[rooms] payout ${p.id} (room ${p.room_id}) fully used to recover ${cb.recoveredIds.length} spray clawback(s)`);
        return "clawed_back";
      }
      await c.query(
        `update room_payouts set status = 'queued', amount_kobo = $2, transfer_ref = $3, last_error = $4 where id = $1 and status = 'held'`,
        [p.id, net, payoutReference(p.room_id), cb.appliedKobo > 0 ? `CLAWBACK_APPLIED: ${cb.appliedKobo}` : null],
      );
      await c.query("COMMIT");
      return "queued";
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    if (unpayable) {
      await openPaymentIssue(pool, {
        ticketId: null, providerRef: payoutReference(unpayable.roomId), provider: "paystack", reason: "payout_failed",
        error: "NO_PAYOUT_ACCOUNT: due, kept held until the host saves a payable (name-checked) account", now,
      }).catch(() => {});
    }
  }
  if (!blocked) return null; // unreachable: every other path returned above
  await refundInsteadOfPayout(blocked.roomId, blocked.block);
  return "refunding";
}

export type PayOutcome = "paid" | "wait" | "no_account" | "attempt_failed" | "failed" | "skip";

/** Paystack answered with an error (counts as an attempt) vs. could not be reached / gave no clear answer (does not). */
function isProviderAnswer(e: unknown): boolean {
  const m = e instanceof Error ? e.message : "";
  return m.startsWith("Paystack error") || /^(PAYOUT_|BAD_)/.test(m);
}

/** The payout's current transfer reference (generation 1 or an admin requeue's), or null when the stored one is not this room's. */
const refOf = (p: { room_id: string; transfer_ref: string | null }) => (payoutGeneration(p.room_id, p.transfer_ref) ? p.transfer_ref : null);

/** queued -> paid and its ledger row, in ONE transaction (the caller holds the payout's advisory lock, no transaction open). */
async function markPaid(c: PoolClient, p: PayoutRow & { title: string }, now: Date, from: "queued" | "failed" = "queued"): Promise<PayOutcome> {
  const ref = refOf(p) ?? payoutReference(p.room_id);
  try {
    await c.query("BEGIN");
    const won = await c.query(
      `update room_payouts set status = 'paid', paid_at = $2::timestamp, last_error = null where id = $1 and status = $3 returning id`,
      [p.id, iso(now), from],
    );
    if (!won.rowCount) { await c.query("ROLLBACK"); return "skip"; }
    await c.query(`update payment_issues set resolved_at = $2::timestamp where provider_payment_id like $1 and reason = 'payout_failed' and resolved_at is null`,
      [`${payoutReference(p.room_id)}%`, iso(now)]);
    await c.query(
      `insert into payment_transactions (type, provider, provider_payment_id, currency, organizer_id, gross_amount, platform_fee_amount,
                                         net_to_organizer_amount, status, created_at)
       select 'room_payout', 'paystack', $1::text, 'NGN', $2::varchar, $3::int, 0, $3::int, 'succeeded', $4::timestamp
        where not exists (select 1 from payment_transactions where type = 'room_payout' and provider_payment_id = $1::text and status = 'succeeded')`,
      [ref, p.host_id, Number(p.amount_kobo), iso(now)],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    // The transfer went through; only our bookkeeping failed. Still queued: the next pass verifies (success) and marks it again.
    console.error(`[rooms] payout ${p.id}: transfer succeeded but marking it paid failed, will retry:`, sanitizeMoneyError(e));
    return "wait";
  }
  // Only the call that won queued/failed -> paid gets here, and only from a transfer status Paystack reported as paid, so
  // "sent" is never claimed from an estimate. Fire-and-forget: notify never rejects.
  void notifyPayoutPaid(p.host_id, p.room_id, Number(p.amount_kobo));
  return "paid";
}

async function markFailed(c: PoolClient, p: PayoutRow, error: string, now: Date, attempts?: number): Promise<PayOutcome> {
  const won = await c.query(
    `update room_payouts set status = 'failed', last_error = $2, attempts = coalesce($3, attempts) where id = $1 and status = 'queued' returning id`,
    [p.id, error, attempts ?? null],
  );
  if (!won.rowCount) return "skip";
  const ref = refOf(p) ?? payoutReference(p.room_id);
  await openPaymentIssue(c, { ticketId: null, providerRef: ref, provider: "paystack", reason: "payout_failed", error, now }).catch(() => {});
  console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}) failed: ${error}. Check Paystack for reference ${ref} before any manual payment.`);
  return "failed";
}

async function failAttempt(c: PoolClient, p: PayoutRow, error: string, now: Date): Promise<PayOutcome> {
  const { attempts, giveUp } = afterFailedAttempt(Number(p.attempts));
  if (giveUp) return markFailed(c, p, error, now, attempts);
  await c.query(`update room_payouts set attempts = $2, last_error = $3 where id = $1 and status = 'queued'`, [p.id, attempts, error]);
  return "attempt_failed";
}

const setNote = (c: PoolClient, id: string, note: string) =>
  c.query(`update room_payouts set last_error = $2 where id = $1 and status = 'queued'`, [id, note]);

async function applyTransferStatus(c: PoolClient, p: PayoutRow & { title: string }, status: string, now: Date): Promise<PayOutcome> {
  switch (classifyTransferStatus(status)) {
    case "paid": return markPaid(c, p, now);
    case "wait": await setNote(c, p.id, "TRANSFER_PENDING"); return "wait";
    case "needs_otp":
      await setNote(c, p.id, "TRANSFER_NEEDS_OTP");
      await openPaymentIssue(c, { ticketId: null, providerRef: refOf(p) ?? payoutReference(p.room_id), provider: "paystack", reason: "payout_failed", error: "TRANSFER_NEEDS_OTP", now }).catch(() => {});
      return "wait";
    case "final_failure": return markFailed(c, p, `TRANSFER_${String(status).toUpperCase().replace(/[^A-Z_]/g, "")}`, now);
  }
}

/** Last time (this process) a payout whose bank could not be matched was tried. In memory on purpose: at most hourly. */
const bankUnresolvedTriedAt = new Map<string, number>();

const PAYOUT_SELECT = `
  select p.id, p.room_id, p.host_id, p.amount_kobo, p.status, p.transfer_ref, p.attempts, p.last_error, r.title
    from room_payouts p join rooms r on r.id = p.room_id where p.id = $1`;

/** One queued payout, under its advisory lock. */
async function payQueued(c: PoolClient, payoutId: string, now: Date): Promise<PayOutcome> {
  const p = (await c.query(PAYOUT_SELECT, [payoutId])).rows[0] as (PayoutRow & { title: string; last_error: string | null }) | undefined;
  if (!p || p.status !== "queued") return "skip";
  const ref = refOf(p);
  if (!ref) return markFailed(c, p, "REFERENCE_MISMATCH", now);
  const amount = Number(p.amount_kobo);
  if (!Number.isInteger(amount) || amount <= 0) return markFailed(c, p, "BAD_AMOUNT", now);

  // 1) Did a transfer with this reference already start? (An answer we cannot be sure of means: touch nothing.)
  let existing: { status: string } | null;
  try { existing = await verifyTransfer(ref); }
  catch (e) {
    if (isProviderAnswer(e)) return failAttempt(c, p, sanitizeMoneyError(e), now);
    await setNote(c, p.id, "PROVIDER_UNAVAILABLE"); return "wait";
  }
  if (existing) return applyTransferStatus(c, p, existing.status, now);

  // 2) The recipient, only from the host's NAME-CHECKED payable account (payouts.ts PAYABLE_ACCOUNT_SQL, fix round C1). An
  //    account replaced through organiser onboarding (a new, unchecked code) is not payable: the payout waits.
  const acctCode = await payableSubaccountOf(p.host_id, c);
  const acct = acctCode ? { paystack_subaccount_code: acctCode } : undefined;
  if (!acct) {
    await setNote(c, p.id, "NO_PAYOUT_ACCOUNT");
    await openPaymentIssue(c, { ticketId: null, providerRef: ref, provider: "paystack", reason: "payout_failed", error: "NO_PAYOUT_ACCOUNT", now }).catch(() => {});
    console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}) is due but the host has no verified payout account`);
    return "no_account";
  }
  // M5: an unmatched bank is retried at most once an hour, and counted as an attempt only the first time.
  const bankUnresolved = p.last_error === "PAYOUT_BANK_UNRESOLVED";
  if (bankUnresolved && now.getTime() - (bankUnresolvedTriedAt.get(p.id) ?? 0) < BANK_UNRESOLVED_RETRY_MS) return "wait";
  let recipientCode: string;
  try { recipientCode = (await createTransferRecipient({ subaccountCode: acct.paystack_subaccount_code })).recipientCode; }
  catch (e) {
    const msg = sanitizeMoneyError(e);
    if (msg.startsWith("PAYOUT_BANK_UNRESOLVED")) {
      bankUnresolvedTriedAt.set(p.id, now.getTime());
      if (bankUnresolvedTriedAt.size > 5000) bankUnresolvedTriedAt.clear();
      await openPaymentIssue(c, { ticketId: null, providerRef: ref, provider: "paystack", reason: "payout_failed", error: "PAYOUT_BANK_UNRESOLVED: the payout account's bank could not be matched; check the host's Paystack subaccount", now }).catch(() => {});
      if (bankUnresolved) return "wait"; // already counted once
      console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}): the payout account's bank could not be matched`);
      return failAttempt(c, p, "PAYOUT_BANK_UNRESOLVED", now);
    }
    if (isProviderAnswer(e)) return failAttempt(c, p, msg, now);
    await setNote(c, p.id, "PROVIDER_UNAVAILABLE"); return "wait";
  }
  bankUnresolvedTriedAt.delete(p.id);

  // 3) The transfer, with the deterministic reference and the stored amount.
  try {
    const res = await createTransfer({ amountKobo: amount, recipientCode, reference: ref, reason: "Vib3Pulse room tickets payout" });
    return applyTransferStatus(c, p, res.status, now);
  } catch (e) {
    const msg = sanitizeMoneyError(e);
    // Paystack refusing a duplicate reference means a transfer with it exists: the next pass verifies and follows it.
    if (/duplicate|already exists/i.test(msg)) { await setNote(c, p.id, "TRANSFER_REFERENCE_EXISTS"); return "wait"; }
    if (isProviderAnswer(e)) return failAttempt(c, p, msg, now);
    // No answer at all: the transfer may or may not exist. Not an attempt; the next pass asks Paystack first.
    await setNote(c, p.id, "PROVIDER_UNAVAILABLE"); return "wait";
  }
}

// ------------------------------------------------------------ transfer webhooks (transfer.success | failed | reversed)

/** A paid payout whose transfer Paystack now reports failed or reversed: failed, reversal ledger row, alert. One transaction. */
async function markReversed(c: PoolClient, p: PayoutRow & { title: string }, status: string, now: Date): Promise<"reversed" | "skip"> {
  const ref = refOf(p) ?? payoutReference(p.room_id);
  const error = `TRANSFER_${String(status).toUpperCase().replace(/[^A-Z_]/g, "")}_AFTER_PAID`;
  try {
    await c.query("BEGIN");
    const won = await c.query(`update room_payouts set status = 'failed', last_error = $2, paid_at = null where id = $1 and status = 'paid' returning id`, [p.id, error]);
    if (!won.rowCount) { await c.query("ROLLBACK"); return "skip"; }
    await c.query(
      `insert into payment_transactions (type, provider, provider_payment_id, currency, organizer_id, gross_amount, platform_fee_amount,
                                         net_to_organizer_amount, status, created_at)
       select 'room_payout_reversal', 'paystack', $1::text, 'NGN', $2::varchar, $3::int, 0, $3::int, 'reversed', $4::timestamp
        where not exists (select 1 from payment_transactions where type = 'room_payout_reversal' and provider_payment_id = $1::text)`,
      [ref, p.host_id, Number(p.amount_kobo), iso(now)],
    );
    await openPaymentIssue(c, { ticketId: null, providerRef: ref, provider: "paystack", reason: "payout_failed", error: `${error}: the host was NOT paid`, now });
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}): transfer ${ref} came back ${status} after it was marked paid. The host is NOT paid.`);
  return "reversed";
}

/** Re-verifies one payout's transfer with Paystack and applies what Paystack (not the webhook body) says. */
async function reconcileTransfer(c: PoolClient, payoutId: string, ref: string, now: Date): Promise<PayOutcome | "reversed"> {
  const p = (await c.query(PAYOUT_SELECT, [payoutId])).rows[0] as (PayoutRow & { title: string }) | undefined;
  if (!p || p.transfer_ref !== ref) return "skip";
  const v = await verifyTransfer(ref); // throws on an outage: the webhook answers 500 and Paystack retries
  if (!v) return "skip";
  if (p.status === "queued") return applyTransferStatus(c, p, v.status, now);
  if (p.status === "paid" && classifyTransferStatus(v.status) === "final_failure") return markReversed(c, p, v.status, now);
  return "skip";
}

/**
 * Paystack `transfer.success` / `transfer.failed` / `transfer.reversed` (signature already verified by the route). Room
 * payouts only: false when the reference is not a room payout. The body is never trusted: the transfer is re-verified.
 * Throws when Paystack cannot be asked or the payout is busy, so the webhook answers 500 and Paystack sends it again.
 */
export async function handleRoomTransferWebhook(data: unknown): Promise<boolean> {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const ref = typeof d.reference === "string" && d.reference.length <= 100 ? d.reference : null;
  if (!ref || !ref.startsWith("room-payout-")) return false;
  let row: { id: string } | undefined;
  try {
    row = (await pool.query(`select id from room_payouts where transfer_ref = $1 limit 1`, [ref])).rows[0] as { id: string } | undefined;
  } catch (e) {
    if (isMissingTable(e)) return false;
    throw e;
  }
  if (!row) { console.warn(`[rooms] transfer webhook for unknown payout reference ${ref}; ignored`); return true; }
  const payoutId = row.id;
  const r = await withAdvisoryLock(LOCK_PAYOUT, payoutId, (c) => reconcileTransfer(c, payoutId, ref, moneyClock.now()), 8000);
  if (r === BUSY) throw new Error("room payout is busy; retry the webhook");
  return true;
}

// ------------------------------------------------------------ the job

export interface SettlementPassResult { scheduled: number; queued: string[]; removed: string[]; refunding: string[]; clawedBack: string[]; outcomes: Record<string, PayOutcome> }

/**
 * One pass: (1) safety net: ended + started rooms with paid tickets and no payout row get one (or refunds); (2) held
 * payouts past release_at are queued (amount recomputed under the lock), removed when empty, or refunded when the room
 * may not pay out; admin holds are skipped; (3) queued payouts are paid.
 */
export async function runSettlementPass(now: Date = moneyClock.now()): Promise<SettlementPassResult> {
  const out: SettlementPassResult = { scheduled: 0, queued: [], removed: [], refunding: [], clawedBack: [], outcomes: {} };
  try {
    const missing = await pool.query(
      `select r.id from rooms r
        where r.status = 'ended' and r.started_at is not null
          and exists (select 1 from room_tickets t where t.room_id = r.id and t.status = 'paid')
          and not exists (select 1 from room_payouts p where p.room_id = r.id)
        limit 50`,
    );
    for (const { id } of missing.rows as { id: string }[]) {
      if (await scheduleRoomPayout(id).catch((e) => { console.error("[rooms] schedule payout failed:", id, sanitizeMoneyError(e)); return null; })) out.scheduled++;
    }

    const due = await pool.query(
      // Review r3 N1: payable hosts first, so payouts kept held for an unpayable host can never take every slot.
      `select id from room_payouts
        where status = 'held' and release_at <= $1::timestamp and release_at < $2::timestamp
        order by (exists (select 1 from organizer_payment_accounts a where a.user_id = room_payouts.host_id and ${PAYABLE_ACCOUNT_SQL})) desc,
                 release_at
        limit 50`,
      [iso(now), PAYOUT_HOLD_SENTINEL_ISO],
    );
    for (const { id } of due.rows as { id: string }[]) {
      const s = await queueDuePayout(id, now).catch((e) => { console.error("[rooms] queue payout failed:", id, sanitizeMoneyError(e)); return null; });
      if (s === "queued") out.queued.push(id);
      if (s === "removed") out.removed.push(id);
      if (s === "refunding") out.refunding.push(id);
      if (s === "clawed_back") out.clawedBack.push(id);
    }

    const queued = await pool.query(`select id from room_payouts where status = 'queued' order by release_at limit 20`);
    for (const { id } of queued.rows as { id: string }[]) {
      const r = await withAdvisoryLock(LOCK_PAYOUT, id, (c) => payQueued(c, id, now))
        .catch((e) => { console.error("[rooms] payout failed:", id, sanitizeMoneyError(e)); return "skip" as const; });
      out.outcomes[id] = r === BUSY ? "skip" : r;
    }
  } catch (e) {
    if (isMissingTable(e)) return out;
    throw e;
  }
  return out;
}

let settleTimer: ReturnType<typeof setInterval> | null = null;
let settleRunning = false;
/**
 * Every 5 minutes. Runs whatever the paidRooms flag says: payouts already held for hosts must still be paid (and refunds
 * already owed still finished) if sales are switched off later. Safe to call twice; never keeps the process alive.
 */
export function startSettlementJob(): void {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    if (settleRunning) return;
    settleRunning = true;
    runSettlementPass()
      .catch((e) => console.error("[rooms] settlement pass failed:", sanitizeMoneyError(e)))
      .finally(() => { settleRunning = false; });
  }, MONEY_JOB_EVERY_MS);
  settleTimer.unref();
}

// ------------------------------------------------------------ admin levers (finance roles; routes in admin-routes.ts)
// Each returns a result for the route; the route checks the role, CSRF is global on /api, and the route writes the
// admin activity log row. No free-text SQL: the only admin input is the room id (uuid-checked) and the reason (stored
// sanitized in last_error for a hold, and in the audit row).

export type AdminLeverResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): AdminLeverResult<never> => ({ ok: false, status, code, message });

export interface AdminPayoutView {
  roomId: string; status: string; amountKobo: number; releaseAt: string | null; onHold: boolean; transferRef: string | null; attempts: number; lastError: string | null;
}

async function payoutView(q: Queryable, roomId: string): Promise<AdminPayoutView | null> {
  const p = (await q.query(
    `select room_id, status, amount_kobo, transfer_ref, attempts, last_error, round(extract(epoch from release_at) * 1000)::float8 as release_ms
       from room_payouts where room_id = $1`,
    [roomId],
  )).rows[0] as { room_id: string; status: string; amount_kobo: number; transfer_ref: string | null; attempts: number; last_error: string | null; release_ms: number | null } | undefined;
  if (!p) return null;
  const releaseMs = p.release_ms === null ? null : Number(p.release_ms);
  const onHold = p.status === "held" && isAdminHold(releaseMs);
  return {
    roomId: p.room_id, status: p.status, amountKobo: Number(p.amount_kobo), releaseAt: onHold || releaseMs === null ? null : new Date(releaseMs).toISOString(),
    onHold, transferRef: p.transfer_ref, attempts: Number(p.attempts), lastError: p.last_error,
  };
}

/**
 * Hold: a 'held' payout gets release_at = the sentinel (never due) and last_error 'ADMIN_HOLD: <reason>'. A room with no
 * payout row yet (still scheduled or live) gets a held row now, so the hold survives the room ending. Refused for a payout
 * that left the hold (queued: a transfer may be on its way; paid; failed: use requeue or nothing).
 */
export async function adminHoldPayout(roomId: string, reason: string): Promise<AdminLeverResult<{ payout: AdminPayoutView | null }>> {
  if (!isUuid(roomId)) return fail(404, "NOT_FOUND", "Room not found");
  const note = `${ADMIN_HOLD_NOTE}: ${sanitizeMoneyError(reason)}`.slice(0, 200);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const room = (await c.query(`select id, host_id from rooms where id = $1 for update`, [roomId])).rows[0] as { id: string; host_id: string } | undefined;
    if (!room) { await c.query("ROLLBACK"); return fail(404, "NOT_FOUND", "Room not found"); }
    const p = (await c.query(`select status from room_payouts where room_id = $1 for update`, [roomId])).rows[0] as { status: string } | undefined;
    if (p && p.status !== "held") {
      await c.query("ROLLBACK");
      return fail(409, "PAYOUT_NOT_HELD", p.status === "queued" ? "This payout is already being sent." : `This payout is ${p.status}; a hold is not possible.`);
    }
    if (p) {
      await c.query(`update room_payouts set release_at = $2::timestamp, last_error = $3 where room_id = $1 and status = 'held'`, [roomId, PAYOUT_HOLD_SENTINEL_ISO, note]);
    } else {
      await c.query(
        `insert into room_payouts (room_id, host_id, amount_kobo, status, release_at, last_error)
         select $1, $2, coalesce((select sum(host_kobo) from room_tickets where room_id = $1 and status = 'paid'), 0), 'held', $3::timestamp, $4`,
        [roomId, room.host_id, PAYOUT_HOLD_SENTINEL_ISO, note],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { ok: true, payout: await payoutView(pool, roomId) };
}

/** Release: an admin-held payout gets release_at = ended_at + 48 h back (or now + 48 h while the room has not ended). */
export async function adminReleasePayout(roomId: string, now: Date = moneyClock.now()): Promise<AdminLeverResult<{ payout: AdminPayoutView | null }>> {
  if (!isUuid(roomId)) return fail(404, "NOT_FOUND", "Room not found");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const p = (await c.query(
      `select p.status, round(extract(epoch from p.release_at) * 1000)::float8 as release_ms,
              round(extract(epoch from r.ended_at) * 1000)::float8 as ended_ms
         from room_payouts p join rooms r on r.id = p.room_id where p.room_id = $1 for update of p`,
      [roomId],
    )).rows[0] as { status: string; release_ms: number | null; ended_ms: number | null } | undefined;
    if (!p) { await c.query("ROLLBACK"); return fail(404, "NO_PAYOUT", "This room has no payout."); }
    if (p.status !== "held" || !isAdminHold(p.release_ms === null ? null : Number(p.release_ms))) {
      await c.query("ROLLBACK"); return fail(409, "NOT_ON_HOLD", "This payout is not on hold.");
    }
    const block = await payoutBlockFor(c, roomId);
    if (block) { await c.query("ROLLBACK"); return fail(409, "PAYOUT_BLOCKED", `This room may not pay its host (${block}). Refund the room instead.`); }
    const releaseAt = new Date(payoutReleaseAt(p.ended_ms === null ? now.getTime() : Number(p.ended_ms)));
    await c.query(`update room_payouts set release_at = $2::timestamp, last_error = null where room_id = $1 and status = 'held'`, [roomId, iso(releaseAt)]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { ok: true, payout: await payoutView(pool, roomId) };
}

/**
 * Requeue a FAILED payout (attempts 0), under the payout's advisory lock so it never races the job. Paystack is asked
 * first about the current reference: success => marked paid (nothing re-sent); pending / otp / none => queued with the
 * SAME reference; a conclusive failure (failed, reversed...) => queued with the next generation reference (a new
 * transfer). Paystack unreachable => 503, nothing changes.
 */
export async function adminRequeuePayout(roomId: string, now: Date = moneyClock.now()): Promise<AdminLeverResult<{ payout: AdminPayoutView | null; outcome: "queued" | "paid" }>> {
  if (!isUuid(roomId)) return fail(404, "NOT_FOUND", "Room not found");
  const row = (await pool.query(`select id from room_payouts where room_id = $1`, [roomId])).rows[0] as { id: string } | undefined;
  if (!row) return fail(404, "NO_PAYOUT", "This room has no payout.");
  const r = await withAdvisoryLock(LOCK_PAYOUT, row.id, async (c): Promise<AdminLeverResult<{ outcome: "queued" | "paid" }>> => {
    const p = (await c.query(PAYOUT_SELECT, [row.id])).rows[0] as (PayoutRow & { title: string }) | undefined;
    if (!p) return fail(404, "NO_PAYOUT", "This room has no payout.");
    if (p.status !== "failed") return fail(409, "NOT_FAILED", `This payout is ${p.status}; only a failed payout can be requeued.`);
    const block = await payoutBlockFor(c, roomId);
    if (block) return fail(409, "PAYOUT_BLOCKED", `This room may not pay its host (${block}). Refund the room instead.`);
    const gen = payoutGeneration(p.room_id, p.transfer_ref);
    let nextRef = payoutReference(p.room_id, gen ?? 1);
    if (gen && p.transfer_ref) {
      let v: { status: string } | null;
      try { v = await verifyTransfer(p.transfer_ref); }
      catch { return fail(503, "PROVIDER_UNAVAILABLE", "Paystack could not be asked about this payout. Nothing was changed; try again."); }
      const kind = v ? classifyTransferStatus(v.status) : null;
      if (kind === "paid") {
        const done = await markPaid(c, p, now, "failed");
        return done === "paid" ? { ok: true, outcome: "paid" } : fail(409, "CHANGED", "The payout changed while it was being checked. Reload.");
      }
      if (kind === "final_failure") nextRef = payoutReference(p.room_id, gen + 1);
    }
    await c.query("BEGIN");
    // Fix round I3: not while the host's payout account is being changed (held to COMMIT, see queueDuePayout).
    if (!(await accountChangeIdle(c, p.host_id))) {
      await c.query("ROLLBACK");
      return fail(409, "ACCOUNT_CHANGING", "The host is changing their payout account right now. Try again in a minute.");
    }
    const moved = await c.query(
      `update room_payouts set status = 'queued', attempts = 0, last_error = null, transfer_ref = $2 where id = $1 and status = 'failed' returning id`,
      [p.id, nextRef],
    );
    if (!moved.rowCount) { await c.query("ROLLBACK"); return fail(409, "CHANGED", "The payout changed while it was being checked. Reload."); }
    await c.query(`update payment_issues set resolved_at = $2::timestamp where provider_payment_id like $1 and reason = 'payout_failed' and resolved_at is null`,
      [`${payoutReference(p.room_id)}%`, iso(now)]);
    await c.query("COMMIT");
    return { ok: true, outcome: "queued" };
  }, 8000);
  if (r === BUSY) return fail(409, "BUSY", "This payout is being processed right now. Try again in a minute.");
  if (!r.ok) return r;
  return { ok: true, outcome: r.outcome, payout: await payoutView(pool, roomId) };
}

/**
 * Refund every paid ticket of a room (host_cancelled) and remove its payout row if it is still held. Refused when the
 * payout already left the hold (queued, paid, failed): then nothing can be refunded automatically.
 */
export async function adminRefundRoom(roomId: string): Promise<AdminLeverResult<{ refunds: RoomRefundTally; payoutRemoved: boolean }>> {
  if (!isUuid(roomId)) return fail(404, "NOT_FOUND", "Room not found");
  const room = (await pool.query(`select id from rooms where id = $1`, [roomId])).rows[0];
  if (!room) return fail(404, "NOT_FOUND", "Room not found");
  const p = (await pool.query(`select status from room_payouts where room_id = $1`, [roomId])).rows[0] as { status: string } | undefined;
  if (p && p.status !== "held") return fail(409, "PAYOUT_RELEASED", `The payout is ${p.status}; tickets can no longer be refunded automatically.`);
  const refunds = await refundAllForRoom(roomId, "host_cancelled");
  const left = (await pool.query(`select 1 from room_payouts where room_id = $1`, [roomId])).rows.length;
  return { ok: true, refunds, payoutRemoved: !!p && left === 0 };
}
