// Room recap (phase 6, task 6.5): GET /api/rooms/:id/recap. Pure shapes and the one function that decides which fields a
// viewer gets, so "a guest never sees a host-only field" is enforced by a whitelist and unit-tested.

/** What every member sees about their own visit. */
export interface GuestRecap {
  /** Whole minutes this viewer spent in the room, over every visit, never more than the room lasted. */
  minutesIn: number;
  /** Chat lines this viewer sent. */
  messages: number;
  /** The host's next scheduled room this viewer may see, or null. */
  next: { roomId: string; scheduledFor: string } | null;
  /** The viewer already follows the host (false for the host themselves). */
  follow: boolean;
}

/** Host only. */
export interface HostRecapExtras {
  /** Whole minutes the room was live. */
  minutes: number;
  /** The most people in the room at once; null when it was not tracked (rooms that ended before tracking existed). */
  peak: number | null;
  /** Tickets still paid (refunded ones are not counted). */
  ticketsSold: number;
  /**
   * People who were in the room and started following the host while it was live (and still follow). null when the room
   * has no start or end time, so the count cannot be trusted.
   */
  followersGained: number | null;
  /** The host's share of paid tickets and delivered sprays in this room, integer kobo, from stored rows. */
  earnedKobo: number;
}

export type RoomRecap = GuestRecap & Partial<HostRecapExtras>;

export interface RoomRecapResponse {
  room: { id: string; title: string; startedAt: string | null; endedAt: string | null };
  host: { id: string; username: string | null; displayName: string | null; organizationName: string | null; avatarUrl: string | null } | null;
  isHost: boolean;
  recap: RoomRecap;
}

const int0 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Builds the recap a viewer may see. Guest fields are copied one by one; the host fields are added ONLY when isHost, so a
 * new field in `all` can never reach a guest by accident.
 */
export function shapeRecap(all: GuestRecap & HostRecapExtras, isHost: boolean): RoomRecap {
  const guest: GuestRecap = {
    minutesIn: int0(all.minutesIn),
    messages: int0(all.messages),
    next: all.next ? { roomId: all.next.roomId, scheduledFor: all.next.scheduledFor } : null,
    follow: isHost ? false : all.follow === true,
  };
  if (!isHost) return guest;
  return {
    ...guest,
    minutes: int0(all.minutes),
    peak: all.peak === null ? null : int0(all.peak),
    ticketsSold: int0(all.ticketsSold),
    followersGained: all.followersGained === null ? null : int0(all.followersGained),
    earnedKobo: int0(all.earnedKobo),
  };
}

/** Whole minutes in the room: stored seconds plus a visit still open at `untilMs`, capped at how long the room lasted. */
export function minutesInRoom(o: { secondsIn: number; joinedAtMs: number | null; leftAtMs: number | null; untilMs: number; roomMinutes: number }): number {
  let s = int0(o.secondsIn);
  if (o.leftAtMs === null && o.joinedAtMs !== null && Number.isFinite(o.joinedAtMs) && o.untilMs > o.joinedAtMs) {
    s += Math.floor((o.untilMs - o.joinedAtMs) / 1000);
  }
  return Math.min(Math.floor(s / 60), int0(o.roomMinutes));
}

/** Whole minutes between two instants (0 when either is missing or the order is wrong). */
export function liveMinutes(startedAtMs: number | null, endedAtMs: number | null): number {
  if (startedAtMs === null || endedAtMs === null || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs <= startedAtMs) return 0;
  return Math.floor((endedAtMs - startedAtMs) / 60_000);
}
