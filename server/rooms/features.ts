// Switches for parts of Rooms that exist in the code but are not offered to users right now.
//
// linkScreens: the room "screen" showing a YouTube / Vimeo / Spotify / Apple Music / SoundCloud link (with synced playback and
// the countdown cue). Paused by the owner while live streaming from a device replaces the screen; music and video playback
// come back later. The code, the CSP hosts and the tests all stay in place: flip this to bring it back.
export const DEFAULT_ROOM_FEATURES = { linkScreens: false } as const;

/** Mutable only so tests can exercise the dormant code. Production never changes it. */
export const roomFeatures: { linkScreens: boolean } = { ...DEFAULT_ROOM_FEATURES };
