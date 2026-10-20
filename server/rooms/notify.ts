// Room money notifications (phase 6, task 6.4). Every export is FIRE-AND-FORGET SAFE: it returns a promise that never
// rejects and never throws synchronously, so a money path can call it with `void notifyX(...)` and a notification failure
// can never fail, delay or roll back the payment, ticket, refund or payout that triggered it.
//
// Copy and links: shared/roomNotifications.ts. Amounts come from stored rows only. A notification never names or points to
// a payer (spray_received has no related_user_id, and its copy says only how much and where).
//
// Sprays: ONE notification per delivered spray per person it reached (owner decision, fix round; see the section below).
import { pool } from "../storage";
import { deliverNotification } from "../notifications";
import { wsManager } from "../websocket";
import { sendPushNotification } from "../pushService";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import {
  notificationLinkFor, payoutPaidNotice, refundIssuedNotice, sprayNoticeKey, sprayReceivedNotice, ticketIssuedNotice,
} from "@shared/roomNotifications";

/** The one clock for room notifications. Tests replace now(); production never does. */
export const notifyClock = { now: (): number => Date.now() };

/** Test-only seams (ignored when NODE_ENV=production). */
export const notifyTestHooks: {
  /** Throw inside a notify call, to prove the money path that called it is unaffected. */
  fail?: (kind: string) => boolean;
} = {};
const testing = () => process.env.NODE_ENV !== "production";

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

// ---------------------------------------------------------------- one notification per spray (owner decision, fix round)
// Each delivered spray notifies the person it reached (the host for their share, a stage guest for theirs): "You received
// N in <room>", N being THAT spray's share read from the stored row (never a running total, never the payer). Cost: one
// notification row (and one push) per spray per person; a host sprayed 300 times gets 300 notifications.
//  - De-duplicated by spray: related_entity_id = sprayNoticeKey(sprayId), inserted only if no row with that key exists for
//    the person, so a retried finalize can never notify twice. (Only the call that won the delivery transition calls this;
//    the guard covers retries and replays.)
//  - Pool-safe: at most SPRAY_NOTIFY_CONCURRENCY run at once in this process, each two short autocommit statements (no
//    transaction, no lock); beyond SPRAY_NOTIFY_QUEUE_MAX waiting, new ones are dropped and logged (a notification is never
//    worth starving a money path; the money is already delivered and recorded).
export const SPRAY_NOTIFY_CONCURRENCY = 4;
export const SPRAY_NOTIFY_QUEUE_MAX = 2000;
let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (running >= SPRAY_NOTIFY_CONCURRENCY) {
    if (waiting.length >= SPRAY_NOTIFY_QUEUE_MAX) { console.error("[rooms:notify] spray notification queue full; one dropped"); return null; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try { return await fn(); }
  finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

/** This person's share of ONE delivered spray, and the room title, from the stored rows. null: nothing to say. */
async function sprayShareOf(sprayId: string, userId: string): Promise<{ kobo: number; roomId: string; title: string } | null> {
  const r = (await pool.query(
    `select s.room_id, r.title,
            (case when s.host_id = $2 then s.host_kobo else 0 end
             + case when s.recipient_id = $2 and s.recipient_id <> s.host_id then coalesce(s.guest_kobo, 0) else 0 end)::bigint as share
       from spray_payments s join rooms r on r.id = s.room_id
      where s.id = $1::uuid and s.status = 'delivered' and (s.host_id = $2 or s.recipient_id = $2)`,
    [sprayId, userId],
  )).rows[0] as { room_id: string; title: string; share: string | number } | undefined;
  const kobo = r ? Number(r.share) : 0;
  return r && Number.isSafeInteger(kobo) && kobo > 0 ? { kobo, roomId: r.room_id, title: r.title } : null;
}

export type SprayNotifyOutcome = "inserted" | "duplicate" | "nothing";

/** One spray, one person: the insert (de-duplicated by spray id). Exported for the tests. Throws on a database error. */
export async function insertSprayNotice(recipientId: string, sprayId: string): Promise<SprayNotifyOutcome> {
  const share = await sprayShareOf(sprayId, recipientId);
  if (!share) return "nothing";
  const copy = sprayReceivedNotice(share.kobo, share.title);
  const link = notificationLinkFor("spray_received", share.roomId);
  const key = sprayNoticeKey(sprayId);
  const r = await pool.query(
    `insert into notifications (user_id, type, title, message, link, related_entity_id, is_read)
     select $1::varchar, 'spray_received', $2::text, $3::text, $4::text, $5::varchar, false
      where not exists (select 1 from notifications where user_id = $1::varchar and type = 'spray_received' and related_entity_id = $5::varchar)`,
    [recipientId, copy.title, copy.message, link, key],
  );
  if (!r.rowCount) return "duplicate";
  // After the insert, best effort: the bell refreshes and the phone is pinged.
  try { wsManager.sendToUser(recipientId, { type: "notification", data: { type: "spray_received" } }); } catch { /* best effort */ }
  sendPushNotification(recipientId, { title: copy.title, body: copy.message, url: link, tag: key }).catch(() => {});
  return "inserted";
}

/**
 * A spray was delivered and reached recipientId (called after the delivery commits, once per person the money reached).
 * kobo only gates the call (> 0); the notification shows the stored share of THIS spray. Fire-and-forget safe.
 */
export function notifySprayReceived(recipientId: string, roomId: string, kobo: number, sprayId: string): Promise<void> {
  return safely("spray", `user=${recipientId} room=${roomId}`, async () => {
    if (!validId(recipientId) || !validId(roomId) || !validKobo(kobo) || !validId(sprayId)) return;
    await withSlot(() => insertSprayNotice(recipientId, sprayId));
  });
}

/** Test-only: release the slot counters (a suite between scenarios). */
export function resetNotifyStateForTests(): void {
  running = 0;
  waiting.splice(0).forEach((w) => w());
}
