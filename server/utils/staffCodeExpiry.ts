const HOUR = 60 * 60 * 1000;
const DEFAULT_DURATION_HOURS = 8; // when the event has no end time
const GRACE_HOURS = 2; // late-night scanning / clean-up

// Staff codes must stay valid for the whole event. They used to expire at the
// event START, so a code generated on the day died the moment doors opened.
// Returns null when the event is already over (no point issuing a code).
export function staffCodeExpiry(start: Date, end?: Date | null, now: Date = new Date()): Date | null {
  const finish = end ?? new Date(start.getTime() + DEFAULT_DURATION_HOURS * HOUR);
  const expiresAt = new Date(finish.getTime() + GRACE_HOURS * HOUR);
  return expiresAt > now ? expiresAt : null;
}
