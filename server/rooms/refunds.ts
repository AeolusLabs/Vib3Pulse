// Paid room tickets: refunds, cancellation and the automatic refund of rooms that never started (phase 4, task 4.5).
//
// MONEY RULES (read before changing anything here)
//  1. The ticket row changes first, the provider second. One transaction moves a ticket paid -> refunded (refunded_at NULL)
//     under a row lock on the ticket, its ROOM (a start in flight finishes first, so the buyer window re-reads the committed
//     status) and the room's payout row, recomputes the held payout from the paid tickets, and records when the refund
//     became owed (a payment_issues 'refund_pending' marker, not an alert). From that commit the ticket no longer opens the
//     door, is no longer part of any payout, and the holder is taken out of a live room (enforceTicketFor, best effort).
//  2. The provider refund happens after that commit, under a per-ticket advisory lock, and only after asking the provider
//     whether a refund for this payment already exists (our deterministic note `ticket-refund-<ticketId>`, or the
//     transaction already reversed). A lookup that fails means NO refund call (fail closed, retried later, never capped).
//  3. "Accepted" is not "refunded". refunded_at is set only when the provider reports the refund PROCESSED (lookup, the
//     job's poll, or the refund.processed webhook, which only triggers a lookup). Until then the ticket is owed/pending:
//     status='refunded' AND refunded_at IS NULL, and the buyer is told "Your refund is on its way", never "refunded".
//  4. refunded_at and the ledger row commit in ONE transaction (on the advisory-lock connection), conditional on
//     refunded_at IS NULL: exactly one ledger row, or none and the next pass tries again. The buyer is notified after
//     the commit, once per stage, keyed by notifications.related_entity_id = `ticket-refund-<id>:<stage>`.
//  5. Never once the host's money left the hold: a payout row that is not 'held' (queued, paid, failed) refuses every
//     refund with not_allowed. The settlement side takes the same payout row lock before it queues, so the two never race.
//  6. Refused charges (lane S2: room_tickets rows created as status 'refunded' with refund_reason auto_*, split columns 0)
//     are never tickets: no host ledger row (there is no sale row to reverse), "Your payment ... was returned" copy, and
//     the job leaves them to the request that refused them for AUTO_REFUND_JOB_DELAY_MS (S2 refunds under the same lock).
//
// Failure windows (all safe):
//  - crash after the commit, before the provider call: ticket refunded/owed; the job retries (lookup first).
//  - provider accepted but our process died: the retry's lookup finds the refund (pending or processed), no second refund.
//  - provider REJECTED the refund (for example the payment was charged back): a payment_issues row (refund_failed,
//    REFUND_REJECTED) is opened for finance, the job retries for 24 hours after that, then only an admin follows up (an
//    admin resolving the issue re-arms the retries). The ticket stays refunded (no entry, no payout).
//  - lookup outage: no issue at first, retried every pass for as long as it lasts; a refund owed for more than 24 h
//    raises ONE refund_overdue alert.
//  - ledger write fails: the whole confirmation rolls back (refunded_at stays NULL); the next pass confirms again.
//
// Advisory locks are SESSION locks: they need a session-mode pool (a transaction-mode pooler such as PgBouncer in
// transaction mode would break them). See the 4F-S2 report.
import type { PoolClient } from "pg";
import { pool } from "../storage";
import { refundPayment, refundState, type PaymentProvider, type ProviderRefundState } from "../payments";
import { deliverNotification } from "../notifications";
import {
  buyerRefundCheck, isAutoRefundReason, reasonNeedsBuyerWindow, refundAllowedByPayout, refundNotice, refundNoticeKey,
  returnedPaymentNotice, sanitizeMoneyError, ticketRefundReference,
  AUTO_REFUND_JOB_DELAY_MS, MONEY_JOB_EVERY_MS, NEVER_STARTED_GRACE_MS, NO_START_TIME_GRACE_MS, REFUND_OVERDUE_MS,
  REFUND_REASONS, REFUND_RETRY_FOR_MS,
  type RefundReason, type RefundResult,
} from "@shared/roomRefunds";

export type { RefundReason, RefundResult };

/** The one clock for room money. Tests replace now(); production never does. */
export const moneyClock = { now: (): Date => new Date() };

/** Timestamps are written as UTC ISO strings cast to timestamp (the same convention drizzle uses for these columns). */
export const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/** SQL: this room_tickets row (alias t) is a refused charge of lane S2, not a ticket. */
export const SQL_IS_AUTO = `coalesce(left(t.refund_reason, 5), '') = 'auto_'`;

/**
 * Test-only seams (ignored when NODE_ENV=production): fail the ledger write of one confirmation, and observe the
 * enforceTicketFor calls made after a refund commits.
 */
export const refundTestHooks: { failLedger?: (ticketId: string) => boolean; onEnforce?: (roomId: string, userId: string) => void } = {};
const testing = () => process.env.NODE_ENV !== "production";

// ------------------------------------------------------------ advisory locks
export const LOCK_TICKET = 41001;
export const LOCK_PAYOUT = 41002;
export const BUSY = Symbol("busy");
export class MoneyLockBusy extends Error {
  constructor() { super("This refund is already being processed."); }
}

/**
 * Runs fn on a dedicated connection while holding a session advisory lock on (ns, key). Two server instances (or two
 * requests) never run fn for the same key at the same time. Returns BUSY when the lock was not free within waitMs.
 * Any transaction fn left open is rolled back; the lock is always released (or the connection destroyed, which releases it).
 */
export async function withAdvisoryLock<T>(ns: number, key: string, fn: (c: PoolClient) => Promise<T>, waitMs = 0): Promise<T | typeof BUSY> {
  const client = await pool.connect();
  let locked = false;
  let destroy = false;
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = await client.query("select pg_try_advisory_lock($1::int, hashtext($2::text)) as ok", [ns, key]);
      if (r.rows[0]?.ok === true) { locked = true; break; }
      if (Date.now() >= deadline) return BUSY;
      await new Promise((res) => setTimeout(res, 200));
    }
    return await fn(client);
  } finally {
    try { await client.query("ROLLBACK"); } catch { destroy = true; } // no-op (a warning) when no transaction is open
    if (locked) {
      try { await client.query("select pg_advisory_unlock($1::int, hashtext($2::text))", [ns, key]); } catch { destroy = true; }
    }
    client.release(destroy ? true : undefined);
  }
}

/**
 * One open finance row per subject and reason: inserted only if no unresolved row of this reason exists for it.
 * Returns true when this call inserted it. Reasons: refund_failed / payout_failed / refund_overdue are ALERTS (admin
 * list); refund_pending is a bookkeeping marker ("owed since"), never shown as an alert by itself.
 */
type Queryable = { query: (text: string, values?: any[]) => Promise<unknown> };
export type MoneyIssueReason = "refund_failed" | "payout_failed" | "refund_overdue" | "refund_pending";
export async function openPaymentIssue(c: Queryable, issue: {
  ticketId: string | null; providerRef: string; provider: string; reason: MoneyIssueReason; error: string; now: Date;
}): Promise<boolean> {
  const r = await c.query(
    `insert into payment_issues (ticket_id, provider_payment_id, provider, reason, error_message, created_at)
     select $1::varchar, $2::text, $3::text, $4::text, $5::text, $6::timestamp
     where not exists (select 1 from payment_issues where provider_payment_id = $2::text and reason = $4::text and resolved_at is null)`,
    [issue.ticketId, issue.providerRef, issue.provider, issue.reason, issue.error, iso(issue.now)],
  ) as { rowCount?: number | null };
  return (r?.rowCount ?? 0) > 0;
}

/** After a commit that moved a ticket to refunded: take the holder out of the live room if they are in it. Never throws. */
function enforceAfterRefund(roomId: string, userId: string): void {
  if (testing()) { try { refundTestHooks.onEnforce?.(roomId, userId); } catch { /* test hook */ } }
  // Lazy: roomSocket imports the room modules that import this file (cycle). Call time only, never at module load.
  void import("./roomSocket")
    .then((m) => m.enforceTicketFor(roomId, userId))
    .catch((e) => console.error("[rooms] removing a refunded holder failed:", roomId, sanitizeMoneyError(e)));
}

// ------------------------------------------------------------ refundTicket
interface TicketRow {
  id: string; room_id: string; user_id: string; amount_kobo: number; platform_kobo: number; host_kobo: number;
  provider: string; provider_ref: string; status: string; confirmed: boolean; refund_reason: string | null;
  room_status: string; refund_before_start: boolean | null; room_title: string; host_id: string; scheduled_ms: number | null;
}

const TICKET_SELECT = `
  select t.id, t.room_id, t.user_id, t.amount_kobo, t.platform_kobo, t.host_kobo, t.provider, t.provider_ref, t.status,
         (t.refunded_at is not null) as confirmed, t.refund_reason,
         r.status as room_status, r.refund_before_start, r.title as room_title, r.host_id,
         round(extract(epoch from r.scheduled_for) * 1000)::float8 as scheduled_ms
    from room_tickets t join rooms r on r.id = t.room_id
   where t.id = $1`;

export interface RefundOutcome {
  result: RefundResult;
  /** true when the provider reports the refund PROCESSED; false = owed or pending (the job keeps checking). */
  settled: boolean;
  /** Why not_allowed (or already): NOT_FOUND, PAYOUT_RELEASED, BAD_STATE, or a buyer-window code from shared/roomRefunds. */
  code?: string;
}

/** Where the provider half got to. processed = refunded_at set (money confirmed back); pending = accepted, not processed. */
export type ProviderStep = "processed" | "pending" | "owed";

/**
 * The contract (lanes S2/S3): "refunded" when this call moved the ticket to refunded, "already" when it was refunded
 * before, "not_allowed" when policy or the payout guard refuses (or the ticket does not exist).
 * Throws MoneyLockBusy when another process holds this ticket for longer than a few seconds.
 */
export async function refundTicket(ticketId: string, reason: RefundReason, opts: { now?: Date } = {}): Promise<RefundResult> {
  return (await refundTicketDetailed(ticketId, reason, opts)).result;
}

export async function refundTicketDetailed(ticketId: string, reason: RefundReason, opts: { now?: Date } = {}): Promise<RefundOutcome> {
  const now = opts.now ?? moneyClock.now();
  if (!isUuid(ticketId) || !REFUND_REASONS.includes(reason)) return { result: "not_allowed", settled: false, code: "NOT_FOUND" };
  const out = await withAdvisoryLock(LOCK_TICKET, ticketId, async (c): Promise<RefundOutcome> => {
    await c.query("BEGIN");
    // The ROOM row is locked too (S3-I4): a start (UPDATE rooms ... where status = 'scheduled') in flight finishes first,
    // and READ COMMITTED re-reads the locked row, so a room that just went live answers ROOM_NOT_SCHEDULED.
    const t = (await c.query(`${TICKET_SELECT} for update of t, r`, [ticketId])).rows[0] as TicketRow | undefined;
    if (!t) { await c.query("ROLLBACK"); return { result: "not_allowed", settled: false, code: "NOT_FOUND" }; }
    if (t.status === "refunded") {
      await c.query("COMMIT");
      const step: ProviderStep = t.confirmed ? "processed" : await finishProviderRefund(c, t, now);
      return { result: "already", settled: step === "processed" };
    }
    if (t.status !== "paid") { await c.query("ROLLBACK"); return { result: "not_allowed", settled: false, code: "BAD_STATE" }; }

    // The payout guard, under the payout row lock (the settlement job takes the same lock before it queues a payout).
    const payout = (await c.query(`select status from room_payouts where room_id = $1 for update`, [t.room_id])).rows[0] as { status: string } | undefined;
    if (!refundAllowedByPayout(payout?.status ?? null)) {
      await c.query("ROLLBACK");
      return { result: "not_allowed", settled: false, code: "PAYOUT_RELEASED" };
    }
    if (reasonNeedsBuyerWindow(reason)) {
      const chk = buyerRefundCheck({
        status: t.room_status,
        refundBeforeStart: t.refund_before_start === true,
        scheduledForMs: t.scheduled_ms === null || t.scheduled_ms === undefined ? null : Number(t.scheduled_ms),
      }, now.getTime());
      if (!chk.ok) { await c.query("ROLLBACK"); return { result: "not_allowed", settled: false, code: chk.code }; }
    }

    const moved = await c.query(
      `update room_tickets set status = 'refunded', refund_reason = $2, refunded_at = null where id = $1 and status = 'paid' returning id`,
      [ticketId, reason],
    );
    if (!moved.rowCount) { await c.query("ROLLBACK"); return { result: "already", settled: false }; } // cannot happen under the row lock
    // The held payout follows the paid tickets (the settlement job recomputes it again when it queues).
    await c.query(
      `update room_payouts set amount_kobo = (select coalesce(sum(host_kobo), 0) from room_tickets where room_id = $1 and status = 'paid')
        where room_id = $1 and status = 'held'`,
      [t.room_id],
    );
    // "Owed since", in the same commit: the job orders by it (oldest first) and alerts when it passes 24 hours.
    await openPaymentIssue(c, { ticketId, providerRef: t.provider_ref, provider: t.provider, reason: "refund_pending", error: `REFUND_OWED: ${reason}`, now });
    await c.query("COMMIT");
    enforceAfterRefund(t.room_id, t.user_id);
    const step = await finishProviderRefund(c, { ...t, status: "refunded", refund_reason: reason }, now);
    return { result: "refunded", settled: step === "processed" };
  }, 8000);
  if (out === BUSY) throw new MoneyLockBusy();
  return out;
}

/** Paystack answered and refused (as opposed to an outage, where we cannot know and must look up again). */
const isRefusalAnswer = (e: unknown) => (e instanceof Error ? e.message : "").startsWith("Paystack error");

/**
 * The provider half. Caller holds the ticket's advisory lock and has no transaction open. Never throws.
 *  - lookup fails: nothing is sent (fail closed); "owed".
 *  - processed: confirm (refunded_at + ledger in one transaction), notify "refunded"; "processed".
 *  - pending / processing / needs-attention: "pending" (needs-attention opens a refund_failed issue), notify "on its way".
 *  - none, or every earlier refund failed: refund with our note; a rejection opens a refund_failed issue.
 */
async function finishProviderRefund(c: PoolClient, t: TicketRow, now: Date): Promise<ProviderStep> {
  const note = ticketRefundReference(t.id);
  const provider = t.provider as PaymentProvider;
  const issue = (error: string) =>
    openPaymentIssue(c, { ticketId: t.id, providerRef: t.provider_ref, provider, reason: "refund_failed", error, now }).catch(() => false);

  let state: ProviderRefundState;
  try { state = await refundState(t.provider_ref, provider, note); }
  catch (e) {
    console.error(`[rooms] ticket ${t.id}: refund lookup failed, nothing sent, will retry:`, sanitizeMoneyError(e));
    return "owed";
  }
  if (state === "done") return confirmRefund(c, t, now);
  if (state === "in_progress" || state === "needs_attention") {
    if (state === "needs_attention") await issue("REFUND_NEEDS_ATTENTION: the provider flagged this refund for review");
    await notifyRefund(c, t, "pending");
    return "pending";
  }
  if (state === "failed") await issue("REFUND_FAILED_AT_PROVIDER: an earlier refund failed at the provider; trying again");
  try {
    await refundPayment(t.provider_ref, provider, { note });
  } catch (e) {
    const msg = sanitizeMoneyError(e);
    if (isRefusalAnswer(e)) {
      console.error(`[rooms] ticket ${t.id}: the provider rejected the refund:`, msg);
      await issue(`REFUND_REJECTED: ${msg}`);
    } else {
      console.error(`[rooms] ticket ${t.id}: refund call got no answer, the next pass looks it up:`, msg);
    }
    return "owed";
  }
  // Accepted. Some refunds are processed at once: ask once more (a failed lookup here only means "pending").
  const after = await refundState(t.provider_ref, provider, note).catch(() => "in_progress" as ProviderRefundState);
  if (after === "done") return confirmRefund(c, t, now);
  if (after === "needs_attention") await issue("REFUND_NEEDS_ATTENTION: the provider flagged this refund for review");
  await notifyRefund(c, t, "pending");
  return "pending";
}

/**
 * The provider reports the refund processed: refunded_at, the issues for it, and (real tickets only) the
 * room_ticket_refund ledger row, in ONE transaction. Then the buyer is told (once). "owed" when the write failed.
 */
async function confirmRefund(c: PoolClient, t: TicketRow, now: Date): Promise<ProviderStep> {
  const auto = isAutoRefundReason(t.refund_reason);
  try {
    await c.query("BEGIN");
    const won = await c.query(
      `update room_tickets set refunded_at = $2::timestamp where id = $1 and status = 'refunded' and refunded_at is null returning id`,
      [t.id, iso(now)],
    );
    await c.query(
      `update payment_issues set resolved_at = $2::timestamp
        where ticket_id = $1::varchar and reason in ('refund_failed', 'refund_pending', 'refund_overdue') and resolved_at is null`,
      [t.id, iso(now)],
    );
    if (won.rowCount && !auto) {
      if (testing() && refundTestHooks.failLedger?.(t.id)) throw new Error("injected ledger failure (test)");
      // A refused charge (auto_*) has no sale row, so nothing to reverse: no ledger row for it, and never one against the host.
      await c.query(
        `insert into payment_transactions (type, provider, provider_payment_id, currency, buyer_user_id, organizer_id, ticket_id,
                                           gross_amount, platform_fee_amount, net_to_organizer_amount, status, created_at)
         select 'room_ticket_refund', $1::text, $2::text, 'NGN', $3::varchar, $4::varchar, $5::varchar, $6::int, $7::int, $8::int, 'refunded', $9::timestamp
          where not exists (select 1 from payment_transactions where type = 'room_ticket_refund' and ticket_id = $5::varchar)`,
        [t.provider, t.provider_ref, t.user_id, t.host_id, t.id, Number(t.amount_kobo), Number(t.platform_kobo), Number(t.host_kobo), iso(now)],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    // The provider has the refund; only our bookkeeping failed. Nothing was written: the next pass confirms again.
    console.error(`[rooms] ticket ${t.id}: refund processed but the bookkeeping failed, will retry:`, sanitizeMoneyError(e));
    return "owed";
  }
  await notifyRefund(c, t, "processed");
  return "processed";
}

/**
 * The buyer's notification for a stage, at most once: keyed by notifications.related_entity_id (the caller holds the
 * ticket's advisory lock, so check-then-insert cannot race). Never throws.
 */
async function notifyRefund(c: PoolClient, t: TicketRow, stage: "pending" | "processed"): Promise<void> {
  try {
    const key = refundNoticeKey(t.id, stage);
    const seen = await c.query(`select 1 from notifications where user_id = $1 and type = 'room_refund' and related_entity_id = $2 limit 1`, [t.user_id, key]);
    if (seen.rowCount) return;
    const amount = Number(t.amount_kobo);
    const auto = isAutoRefundReason(t.refund_reason);
    const reason = (REFUND_REASONS as readonly string[]).includes(t.refund_reason ?? "") ? (t.refund_reason as RefundReason) : "host_cancelled";
    const n = auto ? returnedPaymentNotice(amount, stage) : refundNotice(amount, t.room_title, reason, stage);
    await deliverNotification({
      userId: t.user_id, type: "room_refund", title: n.title, message: n.message,
      link: `/rooms/${t.room_id}`, relatedUserId: auto ? undefined : t.host_id, relatedEntityId: key,
    });
  } catch (e) {
    console.error(`[rooms] ticket ${t.id}: refund notification failed:`, sanitizeMoneyError(e));
  }
}

/**
 * Finishes the provider half of one owed refund (job poll, webhook, buyer retry), under the ticket's advisory lock.
 * "skip" = nothing owed (unknown, not refunded, or already confirmed); "busy" = someone else holds the ticket now.
 */
export async function settleOwedRefund(ticketId: string, now: Date = moneyClock.now(), waitMs = 0): Promise<ProviderStep | "skip" | "busy"> {
  if (!isUuid(ticketId)) return "skip";
  const r = await withAdvisoryLock(LOCK_TICKET, ticketId, async (c): Promise<ProviderStep | "skip"> => {
    const t = (await c.query(TICKET_SELECT, [ticketId])).rows[0] as TicketRow | undefined;
    if (!t || t.status !== "refunded" || t.confirmed) return "skip";
    return finishProviderRefund(c, t, now);
  }, waitMs);
  return r === BUSY ? "busy" : r;
}

/**
 * Paystack `refund.processed` / `refund.failed` (signature already verified by the webhook route). Only for room
 * charges: returns false when the transaction is not one of ours. The payload's status is NEVER trusted: it only
 * triggers the same lookup the job does (provider re-check), so a replayed or forged-but-signed event changes nothing
 * the provider does not confirm. Idempotent.
 */
export async function handleRoomRefundWebhook(data: unknown): Promise<boolean> {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const tx = d.transaction && typeof d.transaction === "object" ? d.transaction : null;
  const ref = [d.transaction_reference, tx?.reference, d.reference].find((v) => typeof v === "string" && v.length > 0 && v.length <= 200) as string | undefined;
  if (!ref) return false;
  let row: { id: string } | undefined;
  try {
    row = (await pool.query(`select id from room_tickets where provider_ref = $1 and status = 'refunded' limit 1`, [ref])).rows[0] as { id: string } | undefined;
  } catch (e) {
    // Ticket tables not there yet (migration not applied): not ours. Never fail the webhook for event/venue refunds.
    if ((e as { code?: string })?.code === "42P01") return false;
    throw e;
  }
  if (!row) return false;
  await settleOwedRefund(row.id, moneyClock.now(), 8000);
  return true;
}

// ------------------------------------------------------------ whole rooms
export interface RoomRefundTally { refunded: number; already: number; notAllowed: number; unsettled: number; errors: number }

/** Refunds every paid ticket of a room (host cancel, never started). Safe to run twice or concurrently: per-ticket claims. */
export async function refundAllForRoom(roomId: string, reason: RefundReason, opts: { now?: Date } = {}): Promise<RoomRefundTally> {
  const tally: RoomRefundTally = { refunded: 0, already: 0, notAllowed: 0, unsettled: 0, errors: 0 };
  const ids = (await pool.query(`select id from room_tickets where room_id = $1 and status = 'paid' order by created_at`, [roomId])).rows as { id: string }[];
  for (const { id } of ids) {
    try {
      const o = await refundTicketDetailed(id, reason, opts);
      if (o.result === "refunded") tally.refunded++;
      else if (o.result === "already") tally.already++;
      else tally.notAllowed++;
      if (o.result !== "not_allowed" && !o.settled) tally.unsettled++;
    } catch (e) {
      tally.errors++;
      console.error(`[rooms] refund of ticket ${id} failed:`, sanitizeMoneyError(e));
    }
  }
  // Nothing left to pay: a held payout row for this room goes (never one that already left the hold).
  await pool.query(
    `delete from room_payouts where room_id = $1 and status = 'held'
       and not exists (select 1 from room_tickets where room_id = $1 and status = 'paid')`,
    [roomId],
  );
  if (tally.notAllowed) console.error(`[rooms] ALERT room ${roomId}: ${tally.notAllowed} ticket(s) could not be refunded (${reason}); payout not held`);
  return tally;
}

// ------------------------------------------------------------ the job
export interface RefundPassResult { claimed: string[]; swept: string[]; retried: number; pending: number; overdueAlerts: number }

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";
let warnedMissing = false;

/** "Owed since" of a room_tickets row (alias t): its refund_pending marker, else (refused charges, older rows) created_at. */
const SQL_OWED_SINCE = `coalesce((select min(i.created_at) from payment_issues i
                                   where i.ticket_id = t.id::text and i.reason = 'refund_pending' and i.resolved_at is null), t.created_at)`;

/**
 * One pass:
 *  1. claims scheduled rooms with paid tickets that did not start in time (one conditional UPDATE: only one instance gets
 *     each room) and refunds everyone (never_started);
 *  2. sweeps ended rooms that never started but still have paid tickets (a host who ended or cancelled a scheduled room,
 *     an admin end, a birthdate correction, a crash halfway through step 1);
 *  3. polls/retries owed refunds, oldest first: pending ones flip to processed (or open an issue on failed /
 *     needs-attention); unsent ones are sent after a lookup. A lookup outage keeps retrying with no cap; a refund the
 *     provider REJECTED is retried for 24 hours after the rejection, then admins only;
 *  4. one refund_overdue alert per refund owed for more than 24 hours.
 */
export async function runRoomRefundPass(now: Date = moneyClock.now()): Promise<RefundPassResult> {
  const result: RefundPassResult = { claimed: [], swept: [], retried: 0, pending: 0, overdueAlerts: 0 };
  try {
    const startCutoff = new Date(now.getTime() - NEVER_STARTED_GRACE_MS);
    const createdCutoff = new Date(now.getTime() - NO_START_TIME_GRACE_MS);
    const claimed = await pool.query(
      `update rooms r set status = 'ended', ended_at = $1::timestamp
        where r.status = 'scheduled'
          and ((r.scheduled_for is not null and r.scheduled_for <= $2::timestamp)
            or (r.scheduled_for is null and r.created_at <= $3::timestamp))
          and exists (select 1 from room_tickets t where t.room_id = r.id and t.status = 'paid')
        returning r.id`,
      [iso(now), iso(startCutoff), iso(createdCutoff)],
    );
    for (const { id } of claimed.rows as { id: string }[]) {
      result.claimed.push(id);
      await refundAllForRoom(id, "never_started", { now }).catch((e) => console.error("[rooms] never-started refund failed:", id, sanitizeMoneyError(e)));
    }

    const leftovers = await pool.query(
      `select r.id,
              (r.scheduled_for is not null and r.ended_at >= r.scheduled_for + interval '60 minutes') as late
         from rooms r
        where r.status = 'ended' and r.started_at is null
          and exists (select 1 from room_tickets t where t.room_id = r.id and t.status = 'paid')
        order by r.ended_at
        limit 50`,
    );
    for (const row of leftovers.rows as { id: string; late: boolean }[]) {
      result.swept.push(row.id);
      await refundAllForRoom(row.id, row.late ? "never_started" : "host_cancelled", { now })
        .catch((e) => console.error("[rooms] leftover refund failed:", row.id, sanitizeMoneyError(e)));
    }

    // 3. Owed refunds, oldest first (M6). The 24 h cap applies only after the provider itself rejected or failed the refund
    // (issue text REFUND_* from this file, or "Paystack error" from lane S2); lookup outages never stop the retries.
    const retryCutoff = new Date(now.getTime() - REFUND_RETRY_FOR_MS);
    const autoCutoff = new Date(now.getTime() - AUTO_REFUND_JOB_DELAY_MS);
    const owed = await pool.query(
      `select t.id, ${SQL_OWED_SINCE} as owed_since
         from room_tickets t
        where t.status = 'refunded' and t.refunded_at is null
          and not (${SQL_IS_AUTO} and t.created_at > $2::timestamp)
          and not exists (select 1 from payment_issues i
                           where i.ticket_id = t.id::text and i.reason = 'refund_failed' and i.resolved_at is null
                             and i.created_at <= $1::timestamp
                             and (left(coalesce(i.error_message, ''), 7) = 'REFUND_' or coalesce(i.error_message, '') like 'Paystack error%'))
        order by owed_since asc, t.id
        limit 50`,
      [iso(retryCutoff), iso(autoCutoff)],
    );
    for (const { id } of owed.rows as { id: string }[]) {
      const step = await settleOwedRefund(id, now).catch((e) => { console.error("[rooms] refund retry failed:", id, sanitizeMoneyError(e)); return "owed" as const; });
      if (step === "processed") result.retried++;
      if (step === "pending") result.pending++;
    }

    // 4. Owed for more than 24 hours, whatever the cause: one alert each (deduped on the payment reference).
    const overdueCutoff = new Date(now.getTime() - REFUND_OVERDUE_MS);
    const overdue = await pool.query(
      `select o.id, o.provider_ref, o.provider, o.owed_since from (
          select t.id, t.provider_ref, t.provider, ${SQL_OWED_SINCE} as owed_since
            from room_tickets t where t.status = 'refunded' and t.refunded_at is null) o
        where o.owed_since <= $1::timestamp
          and not exists (select 1 from payment_issues i where i.provider_payment_id = o.provider_ref and i.reason = 'refund_overdue' and i.resolved_at is null)
        order by o.owed_since asc
        limit 100`,
      [iso(overdueCutoff)],
    );
    for (const o of overdue.rows as { id: string; provider_ref: string; provider: string }[]) {
      const opened = await openPaymentIssue(pool, {
        ticketId: o.id, providerRef: o.provider_ref, provider: o.provider, reason: "refund_overdue",
        error: "REFUND_OVERDUE: owed for more than 24 hours and the provider has not confirmed it", now,
      }).catch(() => false);
      if (opened) {
        result.overdueAlerts++;
        console.error(`[rooms] ALERT refund for ticket ${o.id} is owed for more than 24 hours; check the payment in Paystack`);
      }
    }
  } catch (e) {
    if (isMissingTable(e)) {
      if (!warnedMissing) { warnedMissing = true; console.warn("[rooms] refund job: ticket tables are not there yet (migration not applied); skipping"); }
      return result;
    }
    throw e;
  }
  return result;
}

let refundTimer: ReturnType<typeof setInterval> | null = null;
let refundRunning = false;
/**
 * Every 5 minutes. Runs whatever the paidRooms flag says: switching sales off must never strand money that was already
 * taken (it only finishes refunds owed). Safe to call twice; never keeps the process alive; one pass at a time per process.
 */
export function startRoomRefundJob(): void {
  if (refundTimer) return;
  refundTimer = setInterval(() => {
    if (refundRunning) return;
    refundRunning = true;
    runRoomRefundPass()
      .catch((e) => console.error("[rooms] refund pass failed:", sanitizeMoneyError(e)))
      .finally(() => { refundRunning = false; });
  }, MONEY_JOB_EVERY_MS);
  refundTimer.unref();
}
