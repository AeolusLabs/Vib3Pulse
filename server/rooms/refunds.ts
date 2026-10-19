// Paid room tickets: refunds, cancellation and the automatic refund of rooms that never started (phase 4, task 4.5).
//
// MONEY RULES (read before changing anything here)
//  1. The ticket row changes first, the provider second. One transaction moves a ticket paid -> refunded (refunded_at NULL)
//     under a row lock on the ticket AND on the room's payout row, and recomputes the held payout from the paid tickets.
//     From that moment the ticket no longer opens the door and is no longer part of any payout.
//  2. The provider refund happens after that commit, under a per-ticket advisory lock, and only after asking the provider
//     whether a refund for this payment already exists (our deterministic note `ticket-refund-<ticketId>`, or the
//     transaction already reversed). A lookup that fails means NO refund call (fail closed, retried later).
//  3. refunded_at is set only when the provider accepted the refund (conditional UPDATE ... WHERE refunded_at IS NULL), and
//     only the request that sets it writes the ledger row and tells the buyer: exactly once.
//     status='refunded' AND refunded_at IS NULL means "refund owed, provider not confirmed yet": the job retries those.
//  4. Never once the host's money left the hold: a payout row that is not 'held' (queued, paid, failed) refuses every
//     refund with not_allowed. The settlement side takes the same payout row lock before it queues, so the two never race.
//
// Failure windows (all safe):
//  - crash after the commit, before the provider call: ticket refunded/unconfirmed; the job retries (lookup first).
//  - provider accepted but our process died before refunded_at: the retry's lookup finds the refund, no second refund.
//  - provider refused (for example the payment was charged back): a payment_issues row (reason refund_failed) is opened for
//    finance, the job retries for 24 hours, then only an admin follows up. The ticket stays refunded (no entry, no payout).
import type { PoolClient } from "pg";
import { pool } from "../storage";
import { refundPayment, refundState, type PaymentProvider } from "../payments";
import { recordTransaction } from "../payments/ledger";
import { deliverNotification } from "../notifications";
import {
  buyerRefundCheck, reasonNeedsBuyerWindow, refundAllowedByPayout, refundNotice, sanitizeMoneyError, ticketRefundReference,
  MONEY_JOB_EVERY_MS, NEVER_STARTED_GRACE_MS, NO_START_TIME_GRACE_MS, REFUND_REASONS, REFUND_RETRY_FOR_MS,
  type RefundReason, type RefundResult,
} from "@shared/roomRefunds";

export type { RefundReason, RefundResult };

/** The one clock for room money. Tests replace now(); production never does. */
export const moneyClock = { now: (): Date => new Date() };

/** Timestamps are written as UTC ISO strings cast to timestamp (the same convention drizzle uses for these columns). */
export const iso = (d: Date) => d.toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

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

/** One open finance alert per subject: inserted only if no unresolved row of this reason exists for it. */
type Queryable = { query: (text: string, values?: any[]) => Promise<unknown> };
export async function openPaymentIssue(c: Queryable, issue: {
  ticketId: string | null; providerRef: string; provider: string; reason: "refund_failed" | "payout_failed"; error: string; now: Date;
}): Promise<void> {
  await c.query(
    `insert into payment_issues (ticket_id, provider_payment_id, provider, reason, error_message, created_at)
     select $1::varchar, $2::text, $3::text, $4::text, $5::text, $6::timestamp
     where not exists (select 1 from payment_issues where provider_payment_id = $2::text and reason = $4::text and resolved_at is null)`,
    [issue.ticketId, issue.providerRef, issue.provider, issue.reason, issue.error, iso(issue.now)],
  );
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
  /** true when the provider has accepted the refund (or it already had); false = owed, the job retries. */
  settled: boolean;
  /** Why not_allowed (or already): NOT_FOUND, PAYOUT_RELEASED, BAD_STATE, or a buyer-window code from shared/roomRefunds. */
  code?: string;
}

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
    const t = (await c.query(`${TICKET_SELECT} for update of t`, [ticketId])).rows[0] as TicketRow | undefined;
    if (!t) { await c.query("ROLLBACK"); return { result: "not_allowed", settled: false, code: "NOT_FOUND" }; }
    if (t.status === "refunded") {
      await c.query("COMMIT");
      const settled = t.confirmed ? true : await finishProviderRefund(c, t, now);
      return { result: "already", settled };
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
    await c.query("COMMIT");
    const settled = await finishProviderRefund(c, { ...t, status: "refunded", refund_reason: reason }, now);
    return { result: "refunded", settled };
  }, 8000);
  if (out === BUSY) throw new MoneyLockBusy();
  return out;
}

/**
 * The provider half. Caller holds the ticket's advisory lock and has no transaction open. Returns true when the provider
 * has the refund (now or before). Never throws.
 */
async function finishProviderRefund(c: PoolClient, t: TicketRow, now: Date): Promise<boolean> {
  const note = ticketRefundReference(t.id);
  const provider = t.provider as PaymentProvider;
  try {
    const state = await refundState(t.provider_ref, provider, note);
    if (state === "none" || state === "failed") await refundPayment(t.provider_ref, provider, { note });
  } catch (e) {
    const msg = sanitizeMoneyError(e);
    console.error(`[rooms] ticket ${t.id}: provider refund not confirmed, will retry:`, msg);
    await openPaymentIssue(c, { ticketId: t.id, providerRef: t.provider_ref, provider, reason: "refund_failed", error: msg, now }).catch(() => {});
    return false;
  }
  try {
    const confirmed = await c.query(
      `update room_tickets set refunded_at = $2::timestamp where id = $1 and status = 'refunded' and refunded_at is null returning id`,
      [t.id, iso(now)],
    );
    if (!confirmed.rowCount) return true; // confirmed by someone else already: they wrote the ledger row and told the buyer
    await c.query(`update payment_issues set resolved_at = $2::timestamp where ticket_id = $1 and reason = 'refund_failed' and resolved_at is null`, [t.id, iso(now)]);
    await recordTransaction({
      type: "room_ticket_refund", provider, providerPaymentId: t.provider_ref, currency: "NGN",
      buyerUserId: t.user_id, organizerId: t.host_id, ticketId: t.id,
      grossAmount: Number(t.amount_kobo), platformFeeAmount: Number(t.platform_kobo), netToOrganizerAmount: Number(t.host_kobo),
      status: "refunded",
    });
    const reason = (REFUND_REASONS as readonly string[]).includes(t.refund_reason ?? "") ? (t.refund_reason as RefundReason) : "host_cancelled";
    const n = refundNotice(Number(t.amount_kobo), t.room_title, reason);
    await deliverNotification({
      userId: t.user_id, type: "room_refund", title: n.title, message: n.message,
      link: `/rooms/${t.room_id}`, relatedUserId: t.host_id, relatedEntityId: t.room_id,
    }).catch((e) => console.error("[rooms] refund notification failed:", sanitizeMoneyError(e)));
  } catch (e) {
    // The provider has the refund; only our bookkeeping failed. The retry finds the refund and finishes this.
    console.error(`[rooms] ticket ${t.id}: refund bookkeeping failed:`, sanitizeMoneyError(e));
  }
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
export interface RefundPassResult { claimed: string[]; swept: string[]; retried: number }

const isMissingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";
let warnedMissing = false;

/**
 * One pass:
 *  1. claims scheduled rooms with paid tickets that did not start in time (one conditional UPDATE: only one instance gets
 *     each room) and refunds everyone (never_started);
 *  2. sweeps ended rooms that never started but still have paid tickets (a host who ended or cancelled a scheduled room,
 *     an admin end, a birthdate correction, a crash halfway through step 1);
 *  3. retries refunds the provider has not confirmed yet (for 24 hours after the first failure, then admins only).
 */
export async function runRoomRefundPass(now: Date = moneyClock.now()): Promise<RefundPassResult> {
  const result: RefundPassResult = { claimed: [], swept: [], retried: 0 };
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
        limit 50`,
    );
    for (const row of leftovers.rows as { id: string; late: boolean }[]) {
      result.swept.push(row.id);
      await refundAllForRoom(row.id, row.late ? "never_started" : "host_cancelled", { now })
        .catch((e) => console.error("[rooms] leftover refund failed:", row.id, sanitizeMoneyError(e)));
    }

    const retryCutoff = new Date(now.getTime() - REFUND_RETRY_FOR_MS);
    const owed = await pool.query(
      `select t.id from room_tickets t
        where t.status = 'refunded' and t.refunded_at is null
          and not exists (select 1 from payment_issues i where i.ticket_id = t.id::text and i.reason = 'refund_failed'
                            and i.resolved_at is null and i.created_at <= $1::timestamp)
        limit 50`,
      [iso(retryCutoff)],
    );
    for (const { id } of owed.rows as { id: string }[]) {
      const done = await withAdvisoryLock(LOCK_TICKET, id, async (c) => {
        const t = (await c.query(TICKET_SELECT, [id])).rows[0] as TicketRow | undefined;
        if (!t || t.status !== "refunded" || t.confirmed) return false;
        return finishProviderRefund(c, t, now);
      }).catch((e) => { console.error("[rooms] refund retry failed:", id, sanitizeMoneyError(e)); return false; });
      if (done === true) result.retried++;
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
