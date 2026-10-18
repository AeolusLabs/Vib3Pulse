import { CHAT_QUOTE_WINDOW } from "@shared/rooms";
/** Pure helpers for swipe-to-reply in the chat log. */

/** Drag distance in px at which a swipe counts as a reply. */
export const REPLY_COMMIT_PX = 56;
const MAX_EXTRA_PX = 23; // the row stays under 56 + 23 = 79 px

/**
 * Maps a rightward drag distance to what the row should do.
 * `offset` is the translateX in px (follows the finger 1:1 up to 56 px, then damps towards 80), never negative.
 * `reveal` is 0..1 for the reply hint, `commit` is true once the drag reaches 56 px.
 */
export function replyProgress(dx: number): { offset: number; reveal: number; commit: boolean } {
  if (!Number.isFinite(dx) || dx <= 0) return { offset: 0, reveal: 0, commit: false };
  const offset = dx <= REPLY_COMMIT_PX ? dx : REPLY_COMMIT_PX + MAX_EXTRA_PX * (1 - Math.exp(-(dx - REPLY_COMMIT_PX) / 48));
  return { offset, reveal: Math.min(1, dx / REPLY_COMMIT_PX), commit: dx >= REPLY_COMMIT_PX };
}

/** Who a quote is attributed to. A member who left (or has no known name) shows as "Someone". */
export function quoteLabel(userId: string, nameOf: (userId: string) => string): string {
  return nameOf(userId)?.trim() || "Someone";
}

/**
 * What a pointer move means for a row's swipe. "cancel": a mouse move with no button held is a stale drag (the release
 * happened outside the row), so it must never slide the row or reply. "start": a clear rightward move (over 10 px and
 * mostly horizontal). "drag": already swiping. "wait": keep watching (vertical moves stay a scroll).
 */
export function swipeDecision(i: { active: boolean; dx: number; dy: number; pointerType: string; buttons: number }): "wait" | "start" | "drag" | "cancel" {
  if (i.pointerType === "mouse" && i.buttons === 0) return "cancel";
  if (i.active) return "drag";
  return i.dx > 10 && i.dx > Math.abs(i.dy) * 1.5 ? "start" : "wait";
}

/** How a reply quote is shown. If the viewer hid its author, the words are not shown inside someone else's reply either. */
export function quoteView(reply: { userId: string; text: string }, hidden: ReadonlySet<string> | undefined, nameOf: (userId: string) => string): { name: string; text: string } {
  if (hidden?.has(reply.userId)) return { name: "Someone", text: "" };
  return { name: quoteLabel(reply.userId, nameOf), text: reply.text };
}

/** Whether the line at `index` of a chat of `length` lines is still in the server's quote window (the newest 50). */
export function canQuote(index: number, length: number): boolean {
  return index >= 0 && index < length && length - index <= CHAT_QUOTE_WINDOW;
}
