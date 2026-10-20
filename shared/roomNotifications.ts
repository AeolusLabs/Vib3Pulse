// Room money notifications (phase 6, task 6.4): copy, links and the spray batching rule. Pure; shared by the server
// (server/rooms/notify.ts) and the client bell (NotificationBell.tsx).
//
// Rules: plain words, no em dashes, never "cash", never the payer. Amounts are integer kobo read from stored rows by the
// caller, shown with nairaText. Room titles are already plain text (the server strips tags when a room is created) and the
// bell renders every field as text, never HTML.
import { nairaText } from "./roomRefunds";

/** The room money notification types this module owns copy and links for. */
export const ROOM_MONEY_NOTIFICATION_TYPES = ["room_ticket", "room_refund", "spray_received", "spray_reversed", "payout_paid"] as const;
export type RoomMoneyNotificationType = (typeof ROOM_MONEY_NOTIFICATION_TYPES)[number];

export const EARNINGS_LINK = "/rooms/earnings";
export const roomLink = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

/** Where each type leads. Earnings for money a person received; the room for anything about a ticket or a payment. */
export function notificationLinkFor(type: RoomMoneyNotificationType, roomId: string): string {
  return type === "spray_received" || type === "payout_paid" ? EARNINGS_LINK : roomLink(roomId);
}

const ROOM_ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
/**
 * The bell only follows a room money link of one of the two shapes this module makes (an in-app path, never a full URL),
 * so a stored row can never send someone off the site. Anything else: null (the item shows, but does not navigate).
 */
export function safeRoomMoneyLink(link: string | null | undefined): string | null {
  if (typeof link !== "string") return null;
  if (link === EARNINGS_LINK) return link;
  const m = /^\/rooms\/([^/?#]+)$/.exec(link);
  if (!m) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  return ROOM_ID_SHAPE.test(id) && id !== "earnings" ? link : null;
}

export const isRoomMoneyNotificationType = (t: string): t is RoomMoneyNotificationType =>
  (ROOM_MONEY_NOTIFICATION_TYPES as readonly string[]).includes(t);

/** Room titles in copy: one line, at most 80 characters (ROOM_LIMITS.title), quoted. */
function titleOf(roomTitle: string | null | undefined): string {
  const t = (typeof roomTitle === "string" ? roomTitle : "").replace(/\s+/g, " ").trim().slice(0, 80);
  return t || "your room";
}

export interface NoticeCopy { title: string; message: string }

/**
 * Sprays a person received in one room, as ONE notification (see sprayBatchDecision). totalKobo is their share of every
 * spray delivered to them in that room so far, summed from spray_payments. Never who sprayed.
 */
export function sprayReceivedNotice(totalKobo: number, roomTitle: string): NoticeCopy {
  return {
    title: `You received ${nairaText(totalKobo)} in ${titleOf(roomTitle)}`,
    message: "From sprays in this room. Tap to see your earnings.",
  };
}

export function ticketIssuedNotice(roomTitle: string): NoticeCopy {
  return { title: "Your ticket is ready", message: `You have a ticket for "${titleOf(roomTitle)}". Tap to open the room.` };
}

/** A refund the provider accepted but may not have processed yet: "on its way", never "refunded". */
export function refundIssuedNotice(amountKobo: number, roomTitle: string): NoticeCopy {
  return {
    title: "Refund on its way",
    message: `Your refund of ${nairaText(amountKobo)} for "${titleOf(roomTitle)}" is on its way. It can take a few working days to reach your account.`,
  };
}

/** Only after Paystack confirmed the transfer (room_payouts moved to 'paid' from a verified transfer status). */
export function payoutPaidNotice(amountKobo: number, roomTitle: string): NoticeCopy {
  return {
    title: "Your payout was sent",
    message: `${nairaText(amountKobo)} from "${titleOf(roomTitle)}" was sent to your bank account. Banks can take up to a day to show it.`,
  };
}

// ---------------------------------------------------------------- spray batching
/** One spray notification per (recipient, room) is changed at most this often. */
export const SPRAY_BATCH_WINDOW_MS = 60_000;

/** notifications.related_entity_id of the batch for a room (the recipient is notifications.user_id). */
export const sprayBatchKey = (roomId: string) => `spray-received:${roomId}`;

export type SprayBatchDecision =
  | { action: "insert" }
  | { action: "update" }
  | { action: "unchanged" }
  | { action: "wait"; retryInMs: number };

/**
 * existing: the recipient's UNREAD batch notification for this room (null when there is none, or it was read or removed),
 * with when it was last written and its title. title: the copy the current total would give.
 *  - none: insert a new one.
 *  - same title: nothing new to say.
 *  - written less than SPRAY_BATCH_WINDOW_MS ago: wait (retryInMs until the window opens; the caller tries once more then).
 *  - else: update it in place.
 * A clock that went backwards (lastAtMs in the future) waits a full window rather than updating early.
 */
export function sprayBatchDecision(existing: { lastAtMs: number; title: string } | null, title: string, nowMs: number): SprayBatchDecision {
  if (!existing) return { action: "insert" };
  if (existing.title === title) return { action: "unchanged" };
  const age = nowMs - existing.lastAtMs;
  if (!Number.isFinite(age) || age < 0) return { action: "wait", retryInMs: SPRAY_BATCH_WINDOW_MS };
  if (age < SPRAY_BATCH_WINDOW_MS) return { action: "wait", retryInMs: SPRAY_BATCH_WINDOW_MS - age };
  return { action: "update" };
}
