// Pure helpers for the rooms "before and after" screens: countdown, code to state, the reminder toggle. No DOM, no network.

export type RoomStateKind = "full" | "kicked" | "banned" | "ended" | "locked" | "notlive";

/** The state screen for a join refusal code. Minors' room codes, AGE_LIMIT and AGE_UNKNOWN are deliberately NOT here: they keep their own screens. */
export function stateForCode(code: unknown): RoomStateKind | null {
  switch (code) {
    case "ROOM_FULL": return "full";
    case "KICKED": return "kicked";
    case "BANNED": return "banned";
    case "ROOM_ENDED": return "ended";
    case "ROOM_LOCKED": return "locked";
    case "ROOM_NOT_LIVE": return "notlive";
    default: return null;
  }
}

export const STATE_TITLE: Record<RoomStateKind, string> = {
  full: "This room is full",
  kicked: "You were removed",
  banned: "You can't join this room",
  ended: "This room has ended",
  locked: "This room is locked",
  notlive: "This room hasn't started",
};

/** "2d 3h", "3h 5m", "12m", "45s". Zero or less is "Starting now". */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Starting now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Milliseconds left until `iso`, or null when there is no usable date. */
export function msUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t - now : null;
}

/** How often the countdown needs to redraw: every second in the last minute, otherwise every 30 s. */
export const countdownTickMs = (ms: number | null) => (ms !== null && ms <= 60_000 ? 1000 : 30_000);

/** "You can try again in 10 minutes." Uses the time left on the removal when known, else the standard 10 minutes. */
export function kickedBody(remainingMs: number | null | undefined): string {
  if (remainingMs === null || remainingMs === undefined || !Number.isFinite(remainingMs)) return "The host removed you from this room. You can try again in 10 minutes.";
  if (remainingMs <= 0) return "The host removed you from this room. You can try again now.";
  const mins = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `The host removed you from this room. You can try again in ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
}

/** How long a removal lasts (the server's standard 10 minutes). */
export const KICK_WINDOW_MS = 10 * 60_000;

/**
 * When a room ends with everyone watching, every client asks for its recap at once (about 8 queries each). Each one
 * waits a random 0 to 5 seconds first (review r3 m9), so a 300-person room spreads over 5 s instead of one burst.
 * Opening an already ended room needs no wait (there is no crowd). `rand` is Math.random in the page, fixed in tests.
 */
export const RECAP_PROBE_JITTER_MS = 5_000;
export function recapProbeDelayMs(endedWhileWatching: boolean, rand: number): number {
  if (!endedWhileWatching) return 0;
  const r = Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 1) : 0;
  return Math.min(RECAP_PROBE_JITTER_MS, Math.floor(r * RECAP_PROBE_JITTER_MS));
}

/** Time left on a removal that reached this client at `kickedAt` (the server sends none). Null when we never saw it arrive: the copy then says the generic 10 minutes. */
export function kickRemainingAfter(kickedAt: number | null | undefined, now: number): number | null {
  if (typeof kickedAt !== "number" || !Number.isFinite(kickedAt)) return null;
  return kickedAt + KICK_WINDOW_MS - now;
}

/** The recap block of an ended room: a length and a peak only when the room object already carries them, else one plain line. */
export function recapLines(room: { startedAt?: string | null; endedAt?: string | null; peakCount?: number | null }): string[] {
  const out: string[] = [];
  const a = room.startedAt ? new Date(room.startedAt).getTime() : NaN;
  const b = room.endedAt ? new Date(room.endedAt).getTime() : NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
    const mins = Math.max(1, Math.round((b - a) / 60_000));
    out.push(mins >= 60 ? `Lasted ${Math.floor(mins / 60)}h ${mins % 60}m` : `Lasted ${mins} min`);
  }
  if (typeof room.peakCount === "number" && room.peakCount > 0) out.push(`${room.peakCount} ${room.peakCount === 1 ? "person" : "people"} at the busiest`);
  return out;
}

// ------------------------------------------------------------ reminder toggle (optimistic)
export interface ReminderState { on: boolean; pending: boolean; error: string | null; before: boolean }
export type ReminderAction = { type: "tap" } | { type: "ok"; on: boolean } | { type: "fail" };
export const REMINDER_ERROR = "Couldn't change your reminder. Try again.";

export const initialReminder = (on: boolean): ReminderState => ({ on, pending: false, error: null, before: on });

/** A tap flips the switch at once and remembers the old value; a failure puts it back and says so plainly; a second tap while one is in flight is ignored. */
export function reminderReducer(s: ReminderState, a: ReminderAction): ReminderState {
  switch (a.type) {
    case "tap": return s.pending ? s : { on: !s.on, pending: true, error: null, before: s.on };
    case "ok": return { on: a.on, pending: false, error: null, before: a.on };
    case "fail": return { on: s.before, pending: false, error: REMINDER_ERROR, before: s.before };
  }
}

/** The request that sets the reminder to `on`. */
export const reminderRequest = (roomId: string, on: boolean) => ({ method: on ? "PUT" : "DELETE", url: `/api/rooms/${encodeURIComponent(roomId)}/reminder` });

/** Reads the server's { reminder: boolean } answer; anything else counts as "do what was asked". */
export const reminderFromResponse = (body: unknown, asked: boolean): boolean => (body && typeof body === "object" && typeof (body as { reminder?: unknown }).reminder === "boolean" ? (body as { reminder: boolean }).reminder : asked);
