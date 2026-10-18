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
