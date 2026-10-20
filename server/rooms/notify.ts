// Room money notifications (phase 6, task 6.4). Every export is FIRE-AND-FORGET SAFE: it returns a promise that never
// rejects and never throws synchronously, so a money path can call it with `void notifyX(...)` and a notification failure
// can never fail, delay or roll back the payment, ticket, refund or payout that triggered it.
//
// Copy and links: shared/roomNotifications.ts. Amounts come from stored rows only. A notification never names or points to
// a payer (spray_received has no related_user_id, and its copy says only how much and where).
//
// Spray batching (review focus "notification storm"): ONE unread spray_received notification per (recipient, room), whose
// title carries the recipient's total share of the sprays delivered to them in that room (summed from spray_payments, so a
// retry or a lost call can never make it wrong). It is changed at most once per SPRAY_BATCH_WINDOW_MS:
//  - across processes: the read-decide-write runs in one transaction under pg_advisory_xact_lock('spray-notify:<user>:<room>'),
//    and the "last written" time is the row's created_at (set from notifyClock), so two servers can never both insert, and
//    neither updates inside the window;
//  - inside a process: calls for one key are coalesced (one connection at most per key; a call that arrives while one is
//    running only marks "run once more"), so 300 sprays in a minute use a handful of short transactions, not 300 waiting
//    connections;
//  - the last sprays of a burst are not lost: a call refused by the window arms ONE timer per key for when the window
//    opens (in memory, best effort; a restart loses only the wait, the next spray brings the total up to date).
import { pool } from "../storage";
import { deliverNotification } from "../notifications";
import { wsManager } from "../websocket";
import { sendPushNotification } from "../pushService";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import {
  notificationLinkFor, payoutPaidNotice, refundIssuedNotice, sprayBatchDecision, sprayBatchKey, sprayReceivedNotice,
  ticketIssuedNotice, type SprayBatchDecision,
} from "@shared/roomNotifications";

/** The one clock for room notifications. Tests replace now(); production never does. */
export const notifyClock = { now: (): number => Date.now() };

/** Test-only seams (ignored when NODE_ENV=production). */
export const notifyTestHooks: {
  /** Throw inside a notify call, to prove the money path that called it is unaffected. */
  fail?: (kind: string) => boolean;
  /** Arm no trailing timer (a suite drives the window with the clock and calls again itself). */
  noTrailing?: boolean;
} = {};
const testing = () => process.env.NODE_ENV !== "production";

const iso = (ms: number) => new Date(ms).toISOString();
const UUIDISH = /^[A-Za-z0-9-]{1,64}$/;
const validId = (s: unknown): s is string => typeof s === "string" && UUIDISH.test(s);
const validKobo = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Ids and an outcome only: never amounts, names, emails or references. */
function logFail(kind: string, ids: string, e: unknown): void {
  console.error(`[rooms:notify] ${kind} failed ${ids}:`, sanitizeMoneyError(e));
}

/** Runs fn and swallows everything: the contract of every export here. */
function safely(kind: string, ids: string, fn: () => Promise<void>): Promise<void> {
  try {
    if (testing() && notifyTestHooks.fail?.(kind)) throw new Error(`injected ${kind} failure (test)`);
    return fn().catch((e) => logFail(kind, ids, e));
  } catch (e) {
    logFail(kind, ids, e);
    return Promise.resolve();
  }
}

async function roomTitle(roomId: string): Promise<string | null> {
  const r = (await pool.query(`select title from rooms where id = $1`, [roomId])).rows[0] as { title: string } | undefined;
  return r ? r.title : null;
}

// ---------------------------------------------------------------- one-shot notices
/** A paid room ticket was issued (call once, from the call that inserted the ticket). */
export function notifyTicketIssued(userId: string, roomId: string): Promise<void> {
  return safely("ticket", `user=${userId} room=${roomId}`, async () => {
    if (!validId(userId) || !validId(roomId)) return;
    const title = await roomTitle(roomId);
    if (title === null) return;
    const n = ticketIssuedNotice(title);
    await deliverNotification({
      userId, type: "room_ticket", title: n.title, message: n.message, link: notificationLinkFor("room_ticket", roomId), relatedEntityId: roomId,
    });
  });
}

/**
 * A refund the provider accepted ("on its way"). Ticket refunds are already told by refunds.ts (its staged, de-duplicated
 * room_refund notice, phase 4), so that path does not call this; it is here for other refund paths.
 */
export function notifyRefundIssued(userId: string, roomId: string, kobo: number): Promise<void> {
  return safely("refund", `user=${userId} room=${roomId}`, async () => {
    if (!validId(userId) || !validId(roomId) || !validKobo(kobo)) return;
    const title = await roomTitle(roomId);
    if (title === null) return;
    const n = refundIssuedNotice(kobo, title);
    await deliverNotification({
      userId, type: "room_refund", title: n.title, message: n.message, link: notificationLinkFor("room_refund", roomId), relatedEntityId: roomId,
    });
  });
}

/**
 * A room payout Paystack confirmed (called once, by the call that moved room_payouts to 'paid' from a verified transfer).
 * kobo is the stored payout amount. A payout fully used by clawbacks (amount 0) is never announced.
 */
export function notifyPayoutPaid(hostId: string, roomId: string, kobo: number): Promise<void> {
  return safely("payout", `host=${hostId} room=${roomId}`, async () => {
    if (!validId(hostId) || !validId(roomId) || !validKobo(kobo)) return;
    const title = await roomTitle(roomId);
    if (title === null) return;
    const n = payoutPaidNotice(kobo, title);
    await deliverNotification({
      userId: hostId, type: "payout_paid", title: n.title, message: n.message, link: notificationLinkFor("payout_paid", roomId), relatedEntityId: roomId,
    });
  });
}

// ---------------------------------------------------------------- spray batching
/** The recipient's share of every spray DELIVERED to them in the room: host_kobo as the host, guest_kobo as a stage guest. */
const SPRAY_TOTAL_SQL = `
  select (coalesce(sum(case when host_id = $2 then host_kobo else 0 end), 0)
        + coalesce(sum(case when recipient_id = $2 and recipient_id <> host_id then coalesce(guest_kobo, 0) else 0 end), 0))::bigint as total
    from spray_payments
   where room_id = $1 and status = 'delivered' and (host_id = $2 or recipient_id = $2)`;

export type SprayFlushOutcome = SprayBatchDecision["action"] | "nothing";

/**
 * One read-decide-write for (recipient, room), in one transaction under the advisory lock. Exported for the tests;
 * production calls go through notifySprayReceived. Throws on a database error (the caller swallows it).
 */
export async function flushSprayBatch(recipientId: string, roomId: string): Promise<{ outcome: SprayFlushOutcome; retryInMs?: number }> {
  const nowMs = notifyClock.now();
  const key = sprayBatchKey(roomId);
  const c = await pool.connect();
  let decision: SprayBatchDecision | null = null;
  let copy: { title: string; message: string } | null = null;
  try {
    await c.query("BEGIN");
    await c.query("select pg_advisory_xact_lock(hashtext($1::text))", [`spray-notify:${recipientId}:${roomId}`]);
    const room = (await c.query(`select title from rooms where id = $1`, [roomId])).rows[0] as { title: string } | undefined;
    const total = room ? Number((await c.query(SPRAY_TOTAL_SQL, [roomId, recipientId])).rows[0]?.total ?? 0) : 0;
    if (!room || !Number.isSafeInteger(total) || total <= 0) { await c.query("ROLLBACK"); return { outcome: "nothing" }; }
    copy = sprayReceivedNotice(total, room.title);
    const existing = (await c.query(
      `select id, title, round(extract(epoch from created_at) * 1000)::float8 as at_ms
         from notifications
        where user_id = $1 and type = 'spray_received' and related_entity_id = $2 and is_read = false
        order by created_at desc limit 1`,
      [recipientId, key],
    )).rows[0] as { id: string; title: string; at_ms: number } | undefined;
    decision = sprayBatchDecision(existing ? { lastAtMs: Number(existing.at_ms), title: existing.title } : null, copy.title, nowMs);
    if (decision.action === "insert") {
      await c.query(
        `insert into notifications (user_id, type, title, message, link, related_entity_id, is_read, created_at)
         values ($1, 'spray_received', $2, $3, $4, $5, false, $6::timestamp)`,
        [recipientId, copy.title, copy.message, notificationLinkFor("spray_received", roomId), key, iso(nowMs)],
      );
    } else if (decision.action === "update" && existing) {
      // Still unread (checked in the write): a row read meanwhile is left alone and the next call inserts a fresh one.
      const r = await c.query(
        `update notifications set title = $2, message = $3, created_at = $4::timestamp where id = $1 and is_read = false`,
        [existing.id, copy.title, copy.message, iso(nowMs)],
      );
      if (!r.rowCount) decision = { action: "wait", retryInMs: 0 };
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  if (!decision) return { outcome: "nothing" };
  if (decision.action === "insert" || decision.action === "update") {
    // After the commit, best effort: the bell refreshes; a phone is pinged only for a NEW batch (an update is quiet).
    try { wsManager.sendToUser(recipientId, { type: "notification", data: { type: "spray_received" } }); } catch { /* best effort */ }
    if (decision.action === "insert" && copy) {
      sendPushNotification(recipientId, { title: copy.title, body: copy.message, url: notificationLinkFor("spray_received", roomId), tag: key })
        .catch(() => {});
    }
  }
  return decision.action === "wait" ? { outcome: "wait", retryInMs: decision.retryInMs } : { outcome: decision.action };
}

/** In this process: one flush per key at a time; a call during a flush only asks for one more pass. */
const inflight = new Map<string, { again: boolean }>();
/** In this process: at most one trailing timer per key. */
const trailing = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_TRAILING = 5000;

function armTrailing(recipientId: string, roomId: string, inMs: number): void {
  if (testing() && notifyTestHooks.noTrailing) return;
  const k = `${recipientId}|${roomId}`;
  if (trailing.has(k) || trailing.size >= MAX_TRAILING) return;
  const t = setTimeout(() => {
    trailing.delete(k);
    void notifySprayReceived(recipientId, roomId, 1);
  }, Math.max(0, Math.min(inMs, 2 * 60_000)) + 250);
  t.unref?.();
  trailing.set(k, t);
}

/**
 * Sprays delivered to recipientId in roomId (called after each delivery commits, once per person the money reached). kobo
 * is this delivery's share; it only gates the call (> 0): the notification shows the stored total, never a passed-in sum.
 */
export function notifySprayReceived(recipientId: string, roomId: string, kobo: number): Promise<void> {
  return safely("spray", `user=${recipientId} room=${roomId}`, async () => {
    if (!validId(recipientId) || !validId(roomId) || !validKobo(kobo)) return;
    const k = `${recipientId}|${roomId}`;
    const cur = inflight.get(k);
    if (cur) { cur.again = true; return; }
    const st = { again: false };
    inflight.set(k, st);
    try {
      let passes = 0;
      do {
        st.again = false;
        const r = await flushSprayBatch(recipientId, roomId);
        if (r.outcome === "wait") armTrailing(recipientId, roomId, r.retryInMs ?? 0);
        passes++;
      } while (st.again && passes < 50);
    } finally {
      inflight.delete(k);
    }
  });
}

/** Test-only: forget timers and in-flight markers (a suite between scenarios). */
export function resetNotifyStateForTests(): void {
  trailing.forEach((t) => clearTimeout(t));
  trailing.clear();
  inflight.clear();
}
