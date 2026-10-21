// Switches for parts of Rooms that exist in the code but are not offered to users right now.
//
// linkScreens: the room "screen" showing a YouTube / Vimeo / Spotify / Apple Music / SoundCloud link (with synced playback and
// the countdown cue). Paused by the owner while live streaming from a device replaces the screen; music and video playback
// come back later. The code, the CSP hosts and the tests all stay in place: flip this to bring it back.
//
// gaming (ROOMS_GAMING): players put their own screens into a room (docs/superpowers/specs/2026-10-21-rooms-gaming-design.md).
// Off = no game route, WS message, UI or LiveKit change is reachable, and every existing payload is unchanged.
export const DEFAULT_ROOM_FEATURES = { linkScreens: false, paidRooms: false, spray: false, gaming: false } as const;

export type RoomFeatures = { linkScreens: boolean; paidRooms: boolean; spray: boolean; gaming: boolean };

/** Only exactly "1" or "true" turn a flag on. Any other non-empty value is off; empty or unset uses the fallback. */
export function parseFlag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true";
}

/** Reads the env switches. linkScreens has no env switch; it stays a code-level default. */
export function loadRoomFeatures(env: NodeJS.ProcessEnv): RoomFeatures {
  return {
    linkScreens: DEFAULT_ROOM_FEATURES.linkScreens,
    paidRooms: parseFlag(env.ROOMS_PAID, DEFAULT_ROOM_FEATURES.paidRooms),
    spray: parseFlag(env.ROOMS_SPRAY, DEFAULT_ROOM_FEATURES.spray),
    gaming: parseFlag(env.ROOMS_GAMING, DEFAULT_ROOM_FEATURES.gaming),
  };
}

/** Mutable only so tests can exercise the dormant code. Production never changes it. */
export const roomFeatures: RoomFeatures = loadRoomFeatures(process.env);

/**
 * Gaming parts that are built (switched by the code, not the environment): GET /api/rooms/config reports them under `game`
 * while ROOMS_GAMING is on, so the client offers only what the server can do.
 */
export const GAME_PARTS = { lanes: false, teamSpray: false };

/** OBS / RTMP ingest (LiveKit Ingress) is switched on for this deployment. */
export const ingressFlag = (): boolean => parseFlag(process.env.LIVEKIT_INGRESS, false);
