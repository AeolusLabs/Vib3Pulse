// Who a locked room still lets in. Pure (no database, no hub), so the join path can run it twice (a pre-check before the
// joiner is taken out of their current room, and the authoritative check next to the hub insert) and the unit test can
// run it with no server.

/** Written as joined_at AND left_at when a member row is created for someone who never joined (a ban before arrival). */
export const NEVER_JOINED = new Date(0);

/** When this process started. A left_at that is still null (crash, failed write) is trusted no further back than this. */
export const PROCESS_STARTED_AT = Date.now();

/** joined_at is written by the database clock, started_at by the app clock: allow this much disagreement between them. */
export const SESSION_CLOCK_SKEW_MS = 5 * 60_000;

export interface LockMember { role: string; banned: boolean; joinedAt: Date | string | null; leftAt: Date | string | null }

export interface LockInput {
  userId: string;
  room: { hostId: string; startedAt: Date | string | null };
  member: LockMember | null;
  /** The room is a minors' room (row flag or hub flag). */
  minorsRoom: boolean;
  age: number | null;
  /** The person's minors' room invite. The minors' gate has already passed when this runs. */
  invite: { invited: boolean; acknowledged: boolean };
  now: number;
  rejoinMs: number;
  /** Defaults to PROCESS_STARTED_AT (tests pass their own). */
  bootAt?: number;
}

const ms = (d: Date | string | null): number | null => {
  if (d === null || d === undefined) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * A member of THIS live session coming back within the rejoin window (a reconnect, or someone who just stepped out).
 *  - The row must come from an actual join in this live session: joined_at at or after rooms.started_at (with clock slack).
 *    A row made for someone who never joined carries NEVER_JOINED (1970), so it never counts.
 *  - The window runs from left_at. A left_at that is still null while they are not in the hub means the leave was never
 *    recorded (crash, failed write): it is trusted only from the later of joined_at and this process's start, so it can
 *    never grant a permanent pass.
 * Note: a kick keeps the person out for tuning.kickMs, which is never shorter than the rejoin window, so a kicked person
 * cannot use the window either (and kicks are refused before the lock is looked at).
 */
export function isRecentMember(i: Pick<LockInput, "room" | "member" | "now" | "rejoinMs" | "bootAt">): boolean {
  const m = i.member;
  if (!m || m.banned) return false;
  const started = ms(i.room.startedAt);
  const joined = ms(m.joinedAt);
  if (started === null || joined === null) return false;
  if (joined < started - SESSION_CLOCK_SKEW_MS) return false; // not a join of this live session
  const left = ms(m.leftAt);
  const lastSeen = left !== null ? left : Math.max(joined, i.bootAt ?? PROCESS_STARTED_AT);
  return i.now - lastSeen < i.rejoinMs;
}

/**
 * True when a locked room still admits this person: the host; a co-host (role reset to guest by a kick); an adult with an
 * acknowledged personal invite to a minors' room; a member of this live session coming back within the rejoin window.
 * Holding the invite link does NOT get anyone past the lock (every joiner of an invite-only room holds it): the host
 * unlocks, or rotates the link with /invite-token. Someone already in the hub (a second tab) is let in by the caller
 * before this is asked.
 */
export function lockAdmits(i: LockInput): boolean {
  if (i.userId === i.room.hostId) return true;
  if (i.member && !i.member.banned && i.member.role === "cohost") return true;
  if (i.minorsRoom && i.age !== null && i.age >= 18 && i.invite.invited && i.invite.acknowledged) return true;
  return isRecentMember(i);
}
