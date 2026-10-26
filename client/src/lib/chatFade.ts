// Immersive live-stream chat: lines show for a few seconds, then fade out, like other live apps. Pure, no DOM.
// Judged on the server clock (`at` is the server's time), so a viewer with a wrong clock still sees the right lifetime.

/** How long a line stays fully readable. */
export const CHAT_TTL_MS = 8000;
/** The last stretch of a line's life, when it fades out. */
export const CHAT_FADE_MS = 1000;
/** Most lines on the picture at once. */
export const CHAT_MAX_LINES = 6;

export interface FadeLine<T> { item: T; fading: boolean }

/**
 * The lines to draw now: not older than the lifetime, newest `max`. A line whose action row is open (`keepId`) is kept
 * while it is within the newest `max`, however old, so a reader is never robbed mid-tap.
 */
export function liveLines<T extends { id: string; at: number }>(
  lines: readonly T[],
  nowMs: number,
  keepId: string | null = null,
  max: number = CHAT_MAX_LINES,
): FadeLine<T>[] {
  const out: FadeLine<T>[] = [];
  for (const item of lines) {
    const age = nowMs - item.at;
    const kept = item.id === keepId;
    if (!kept && age >= CHAT_TTL_MS) continue;
    out.push({ item, fading: !kept && age >= CHAT_TTL_MS - CHAT_FADE_MS });
  }
  return out.slice(-Math.max(1, max));
}
