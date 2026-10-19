// Pure timing and copy rules for the "starts soon" reminder, shared by the server job and its unit test.
const MIN = 60_000;

/** How far ahead the reminder looks. */
export const REMINDER_LEAD_MIN = 15;

/**
 * Rooms starting from `now` up to 15 minutes ahead. Wide on purpose: the job ticks every minute, and a late or missed
 * tick (busy event loop, restart) must not lose a reminder. A room is still told only once, because the job claims it
 * with one conditional UPDATE (reminder_notified_at IS NULL). A room scheduled less than 15 minutes ahead (created or
 * moved late) is caught by the next tick, with the real time left in the copy. A start time already past is never sent.
 */
export function reminderWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime()), to: new Date(now.getTime() + REMINDER_LEAD_MIN * MIN) };
}

/** Whole minutes left until the start, rounded to the nearest minute, at least 1 (never "0 minutes"). */
export function minutesUntil(start: Date, now: Date): number {
  return Math.max(1, Math.round((start.getTime() - now.getTime()) / MIN));
}

/** The notification title: "<title> starts in N minutes" with the real time left ("1 minute" when it is one). */
export function reminderTitle(title: string, start: Date, now: Date): string {
  const n = minutesUntil(start, now);
  return `${title} starts in ${n} ${n === 1 ? "minute" : "minutes"}`;
}
