import { HOST_LEAVE_GRACE_MS } from "@shared/rooms";

/** Where a person's full profile lives. Prefers the username route; both segments are encoded so an odd name can't change the path. */
export function profilePath(m: { username?: string | null; userId: string }): string {
  const name = m.username?.trim();
  return name ? `/profile/${encodeURIComponent(name)}` : `/user/${encodeURIComponent(m.userId)}`;
}

/** The honest line beside View profile. A host leaving ends the room after the grace period unless they are back. */
export function leavesRoomHint(isHost: boolean): string {
  return isHost ? `This leaves the room. It ends if you're not back in ${Math.round(HOST_LEAVE_GRACE_MS / 60_000)} minutes.` : "This leaves the room.";
}

/**
 * Whether the "View profile" row shows in the person actions sheet. Your own profile always shows. For anyone else the
 * server decides (it hides the profile when either of you has blocked the other) and, until it has answered, the row stays
 * hidden rather than guessed. The caller's own canViewProfile=false always wins.
 */
export function showViewProfile(o: { self: boolean; canViewProfile?: boolean; profileAllowed?: boolean }): boolean {
  if (o.canViewProfile === false) return false;
  return o.self || o.profileAllowed === true;
}
