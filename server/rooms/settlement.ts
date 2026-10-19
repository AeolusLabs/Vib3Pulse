// Paying the host of a ticketed room (phase 4, task 4.6).
//
// MONEY RULES (read before changing anything here)
//  - A payout exists only for a room that really went live (started_at set) and ended with paid tickets. A room that never
//    started never pays out: its tickets are refunded (refunds.ts).
//  - held -> queued happens in ONE transaction holding the payout row lock (refundTicket takes the same lock), and the amount
//    is recomputed right there as sum(host_kobo) of the paid tickets. From queued on, refunds are refused (not_allowed),
//    so the amount sent can never include a refunded ticket. Amounts only ever come from stored host_kobo.
//  - Paying runs under a per-payout advisory lock (one process at a time) and always asks Paystack first whether a transfer
//    with the deterministic reference `room-payout-<roomId>` exists. Only when Paystack says "none" is a transfer started,
//    with that same reference (Paystack's idempotency key). An outage while asking means: do nothing, try next pass.
//  - queued -> paid / failed are conditional UPDATEs (WHERE status = 'queued'); only the winner writes the ledger row.
//  - Bank details come only from the host's verified Paystack subaccount (organizer_payment_accounts), resolved inside the
//    payment layer. They are never stored, logged or put in last_error.
//
// Failure windows (all safe):
//  - crash after queued, before the transfer call: next pass verifies (none) and starts it with the same reference.
//  - transfer accepted but our process died (or the response was lost) before 'paid': next pass verifies and finds it.
//  - Paystack answers with an error (insufficient balance, bad account...): attempts + 1, last_error, stays queued; the 5th
//    failure marks 'failed' and opens a payout_failed issue for finance (admins check Paystack for the reference before any
//    manual action). A final transfer status (failed / reversed / abandoned / rejected / blocked) marks 'failed' at once:
//    the same reference is never re-sent automatically after Paystack itself gave up.
//  - Paystack unreachable (network, 5xx without an answer): last_error PROVIDER_UNAVAILABLE, attempts unchanged, stays
//    queued (an outage never burns the 5 attempts); the admin list flags payouts still queued 24 h after release.
//  - no verified payout account: last_error NO_PAYOUT_ACCOUNT, stays queued, payout_failed issue opened (one per payout).
import type { PoolClient } from "pg";
import { pool } from "../storage";
import { createTransfer, createTransferRecipient, verifyTransfer } from "../payments";
import { recordTransaction } from "../payments/ledger";
import {
  afterFailedAttempt, classifyTransferStatus, payoutReference, payoutReleaseAt, sanitizeMoneyError, MONEY_JOB_EVERY_MS,
} from "@shared/roomRefunds";
import { BUSY, LOCK_PAYOUT, iso, moneyClock, openPaymentIssue, refundAllForRoom, withAdvisoryLock } from "./refunds";

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";

export interface PayoutRow {
  id: string; room_id: string; host_id: string; amount_kobo: number; status: string; transfer_ref: string | null; attempts: number;
}

/**
 * Called when a ticketed room ENDS (hook in roomSocket.endRoom) and by the settlement job as a safety net.
 * Creates (or, while still held, updates) the payout: release_at = ended_at + 48 h, amount = sum(host_kobo) of paid tickets.
 * No-op for rooms that never started, have not ended, or have no paid tickets. Returns the row, or null.
 */
export async function scheduleRoomPayout(roomId: string): Promise<PayoutRow | null> {
  const room = (await pool.query(
    `select id, host_id, status, (started_at is not null) as started, round(extract(epoch from ended_at) * 1000)::float8 as ended_ms
       from rooms where id = $1`,
    [roomId],
  )).rows[0] as { id: string; host_id: string; status: string; started: boolean; ended_ms: number | null } | undefined;
  if (!room || room.status !== "ended" || !room.started || room.ended_ms === null) return null;
  const releaseAt = new Date(payoutReleaseAt(Number(room.ended_ms)));
  const r = await pool.query(
    `insert into room_payouts (room_id, host_id, amount_kobo, status, release_at)
     select $1, $2, coalesce(sum(t.host_kobo), 0), 'held', $3::timestamp
       from room_tickets t where t.room_id = $1 and t.status = 'paid'
     having count(*) > 0
     on conflict (room_id) do update set amount_kobo = excluded.amount_kobo, release_at = excluded.release_at
       where room_payouts.status = 'held'
     returning id, room_id, host_id, amount_kobo, status, transfer_ref, attempts`,
    [room.id, room.host_id, iso(releaseAt)],
  );
  return (r.rows[0] as PayoutRow | undefined) ?? null;
}

/**
 * Everything that follows a room ending, in one place (the hook in endRoom calls only this). A room that went live gets
 * its payout scheduled; a room ended before it ever started (host ended or cancelled it, admin, safety rule) refunds every
 * ticket in the background (the refund job sweeps anything this misses). Never throws.
 */
export async function afterRoomEnded(roomId: string): Promise<void> {
  try {
    const room = (await pool.query(`select status, (started_at is not null) as started from rooms where id = $1`, [roomId])).rows[0] as
      { status: string; started: boolean } | undefined;
    if (!room || room.status !== "ended") return;
    if (room.started) { await scheduleRoomPayout(roomId); return; }
    void refundAllForRoom(roomId, "host_cancelled").catch((e) => console.error("[rooms] refunds after end failed:", roomId, sanitizeMoneyError(e)));
  } catch (e) {
    if (!isMissingTable(e)) console.error("[rooms] after-end money step failed:", roomId, sanitizeMoneyError(e));
  }
}

/** held -> queued (or removed when nothing is left to pay), under the payout row lock. Returns the new status, or null. */
async function queueDuePayout(payoutId: string, now: Date): Promise<"queued" | "removed" | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const p = (await c.query(
      `select p.id, p.room_id, p.status, round(extract(epoch from p.release_at) * 1000)::float8 as release_ms,
              (r.started_at is not null) as started
         from room_payouts p join rooms r on r.id = p.room_id
        where p.id = $1 for update of p`,
      [payoutId],
    )).rows[0] as { id: string; room_id: string; status: string; release_ms: number | null; started: boolean } | undefined;
    if (!p || p.status !== "held" || p.release_ms === null || Number(p.release_ms) > now.getTime()) { await c.query("ROLLBACK"); return null; }
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
    await c.query(
      `update room_payouts set status = 'queued', amount_kobo = $2, transfer_ref = $3, last_error = null where id = $1 and status = 'held'`,
      [p.id, Number(sum.amount), payoutReference(p.room_id)],
    );
    await c.query("COMMIT");
    return "queued";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export type PayOutcome = "paid" | "wait" | "no_account" | "attempt_failed" | "failed" | "skip";

/** Paystack answered with an error (counts as an attempt) vs. could not be reached at all (does not). */
function isProviderAnswer(e: unknown): boolean {
  const m = e instanceof Error ? e.message : "";
  return m.startsWith("Paystack error") || /^(PAYOUT_|BAD_)/.test(m);
}

async function markPaid(c: PoolClient, p: PayoutRow & { title: string }, now: Date): Promise<PayOutcome> {
  const won = await c.query(
    `update room_payouts set status = 'paid', paid_at = $2::timestamp, last_error = null where id = $1 and status = 'queued' returning id`,
    [p.id, iso(now)],
  );
  if (!won.rowCount) return "skip";
  await c.query(`update payment_issues set resolved_at = $2::timestamp where provider_payment_id = $1 and reason = 'payout_failed' and resolved_at is null`,
    [payoutReference(p.room_id), iso(now)]).catch(() => {});
  await recordTransaction({
    type: "room_payout", provider: "paystack", providerPaymentId: payoutReference(p.room_id), currency: "NGN",
    organizerId: p.host_id, grossAmount: Number(p.amount_kobo), platformFeeAmount: 0, netToOrganizerAmount: Number(p.amount_kobo),
    status: "succeeded",
  });
  return "paid";
}

async function markFailed(c: PoolClient, p: PayoutRow, error: string, now: Date, attempts?: number): Promise<PayOutcome> {
  const won = await c.query(
    `update room_payouts set status = 'failed', last_error = $2, attempts = coalesce($3, attempts) where id = $1 and status = 'queued' returning id`,
    [p.id, error, attempts ?? null],
  );
  if (!won.rowCount) return "skip";
  await openPaymentIssue(c, { ticketId: null, providerRef: payoutReference(p.room_id), provider: "paystack", reason: "payout_failed", error, now }).catch(() => {});
  console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}) failed: ${error}. Check Paystack for reference ${payoutReference(p.room_id)} before any manual payment.`);
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
      await openPaymentIssue(c, { ticketId: null, providerRef: payoutReference(p.room_id), provider: "paystack", reason: "payout_failed", error: "TRANSFER_NEEDS_OTP", now }).catch(() => {});
      return "wait";
    case "final_failure": return markFailed(c, p, `TRANSFER_${String(status).toUpperCase().replace(/[^A-Z_]/g, "")}`, now);
  }
}

/** One queued payout, under its advisory lock. */
async function payQueued(c: PoolClient, payoutId: string, now: Date): Promise<PayOutcome> {
  const p = (await c.query(
    `select p.id, p.room_id, p.host_id, p.amount_kobo, p.status, p.transfer_ref, p.attempts, r.title
       from room_payouts p join rooms r on r.id = p.room_id where p.id = $1`,
    [payoutId],
  )).rows[0] as (PayoutRow & { title: string }) | undefined;
  if (!p || p.status !== "queued") return "skip";
  const ref = payoutReference(p.room_id);
  if (p.transfer_ref !== ref) return markFailed(c, p, "REFERENCE_MISMATCH", now);
  const amount = Number(p.amount_kobo);
  if (!Number.isInteger(amount) || amount <= 0) return markFailed(c, p, "BAD_AMOUNT", now);

  // 1) Did a transfer with this reference already start? (An answer we cannot get means: touch nothing.)
  let existing: { status: string } | null;
  try { existing = await verifyTransfer(ref); }
  catch (e) {
    if (isProviderAnswer(e)) return failAttempt(c, p, sanitizeMoneyError(e), now);
    await setNote(c, p.id, "PROVIDER_UNAVAILABLE"); return "wait";
  }
  if (existing) return applyTransferStatus(c, p, existing.status, now);

  // 2) The recipient, only from the host's verified Paystack payout account.
  const acct = (await c.query(
    `select paystack_subaccount_code from organizer_payment_accounts
      where user_id = $1 and provider = 'paystack' and payouts_enabled = true and details_submitted = true
        and paystack_subaccount_code is not null
      limit 1`,
    [p.host_id],
  )).rows[0] as { paystack_subaccount_code: string } | undefined;
  if (!acct) {
    await setNote(c, p.id, "NO_PAYOUT_ACCOUNT");
    await openPaymentIssue(c, { ticketId: null, providerRef: ref, provider: "paystack", reason: "payout_failed", error: "NO_PAYOUT_ACCOUNT", now }).catch(() => {});
    console.error(`[rooms] ALERT payout ${p.id} (room ${p.room_id}) is due but the host has no verified payout account`);
    return "no_account";
  }
  let recipientCode: string;
  try { recipientCode = (await createTransferRecipient({ subaccountCode: acct.paystack_subaccount_code })).recipientCode; }
  catch (e) {
    if (isProviderAnswer(e)) return failAttempt(c, p, sanitizeMoneyError(e), now);
    await setNote(c, p.id, "PROVIDER_UNAVAILABLE"); return "wait";
  }

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

export interface SettlementPassResult { scheduled: number; queued: string[]; removed: string[]; outcomes: Record<string, PayOutcome> }

/**
 * One pass: (1) safety net: ended + started rooms with paid tickets and no payout row get one; (2) held payouts past
 * release_at are queued (amount recomputed under the lock) or removed when empty; (3) queued payouts are paid.
 */
export async function runSettlementPass(now: Date = moneyClock.now()): Promise<SettlementPassResult> {
  const out: SettlementPassResult = { scheduled: 0, queued: [], removed: [], outcomes: {} };
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

    const due = await pool.query(`select id from room_payouts where status = 'held' and release_at <= $1::timestamp order by release_at limit 50`, [iso(now)]);
    for (const { id } of due.rows as { id: string }[]) {
      const s = await queueDuePayout(id, now).catch((e) => { console.error("[rooms] queue payout failed:", id, sanitizeMoneyError(e)); return null; });
      if (s === "queued") out.queued.push(id);
      if (s === "removed") out.removed.push(id);
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
