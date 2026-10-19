// Pure timing rule for the "starts in 15 minutes" reminder, shared by the server job and its unit test.
const MIN = 60_000;

/** Rooms starting 14 to 15 minutes from `now`. The job ticks every minute, so each room falls in the window once. */
export function reminderWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() + 14 * MIN), to: new Date(now.getTime() + 15 * MIN) };
}
