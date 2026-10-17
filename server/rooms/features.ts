// Switches for parts of Rooms that exist in the code but are not offered to users right now.
//
// linkScreens: the room "screen" showing a YouTube / Vimeo / Spotify / Apple Music / SoundCloud link (with synced playback and
// the countdown cue). Paused by the owner while live streaming from a device replaces the screen; music and video playback
// come back later. The code, the CSP hosts and the tests all stay in place: flip this to bring it back.
export const DEFAULT_ROOM_FEATURES = { linkScreens: false, anonymousJoin: false, paidRooms: false, spray: false } as const;

export type RoomFeatures = { linkScreens: boolean; anonymousJoin: boolean; paidRooms: boolean; spray: boolean };

/** Only exactly "1" or "true" turn a flag on. Any other non-empty value is off; empty or unset uses the fallback. */
export function parseFlag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true";
}

/** Reads the env switches. linkScreens has no env switch; it stays a code-level default. */
export function loadRoomFeatures(env: NodeJS.ProcessEnv): RoomFeatures {
  return {
    linkScreens: DEFAULT_ROOM_FEATURES.linkScreens,
    anonymousJoin: parseFlag(env.ROOMS_ANONYMOUS_JOIN, DEFAULT_ROOM_FEATURES.anonymousJoin),
    paidRooms: parseFlag(env.ROOMS_PAID, DEFAULT_ROOM_FEATURES.paidRooms),
    spray: parseFlag(env.ROOMS_SPRAY, DEFAULT_ROOM_FEATURES.spray),
  };
}

/** Mutable only so tests can exercise the dormant code. Production never changes it. */
export const roomFeatures: RoomFeatures = loadRoomFeatures(process.env);
