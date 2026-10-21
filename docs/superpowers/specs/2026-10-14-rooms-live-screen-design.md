# Rooms: live camera + mic screen (design)

Date: 2026-10-14. Status: awaiting owner review. Builds on Rooms part 3a (LiveKit voice, stage).

## Intent

The room "screen" becomes a live stream from a person's camera and mic, built-in or external (webcam, capture card, audio interface), so a band can perform live with sound and visuals in a room, IG-Live style. Link/music/video playback is switched off (`roomFeatures.linkScreens=false`) and returns in a later release. Owner decisions:

- Anyone on the stage (mic) may stream, but only if the host grants it, and only if the room has live video switched on and can carry it.
- One person on the screen at a time. A 2-4 tile grid is a later update; this design must not block it.
- Nothing is recorded.

## Non-goals (this release)

Music/video file or link playback, multi-streamer tiles, screen-capture (desktop sharing), recording/replay, HLS/CDN broadcast for large audiences, paid-room viewer limits above 50 (the reserved `capacityMaxPaid=150` is checked later).

## Rules (pure, in `shared/liveScreen.ts`, unit-tested)

State: `{ holder: string | null, asks: string[] }` (in memory per room, like the stage; cleared when the room ends).

- `canAsk`: actor is on stage (host, co-host or stage guest), room has live video on, actor is not already holder.
- `grant(target)`: actor is host or co-host; target is present, on stage, passes the teen rule (`canBeOnStage`-style: a teen may not hold the screen while any adult is present, same as speaking). Replaces the current holder (old holder loses camera first). Removes target from `asks`.
- `revoke` / `stop`: host or co-host may stop any holder; the holder may stop themselves; `withdraw` removes own ask.
- Holder is cleared automatically when the holder leaves the room, is removed from stage, loses stage eligibility (adult arrives), is kicked/banned, or voice/live video is switched off.
- Codes returned on refusal: `LIVE_OFF`, `NOT_ON_STAGE`, `NOT_ALLOWED`, `TEEN_RULE`, `NOT_PRESENT`, `NO_CHANGE`.

## Server

- **Schema:** additive column `rooms.live_video boolean not null default false` (migration `add_rooms_live_video.sql`). Applied to the database in the same task (project rule); tests use throwaway DBs.
- **Capability:** `live_video` can only be turned on when voice is configured (LiveKit available) and the room's capacity is within the live-video viewer cap (`ROOM_LIMITS.liveVideoMax`, 50 for now). Otherwise the API returns 400 `{ field: "liveVideo", reason: "unavailable" | "too_large" }` and the UI shows the reason. Host toggles it on create and via PATCH; switching it off clears the holder.
- **WebSocket:** new `room:live {action: "ask"|"withdraw"|"grant"|"revoke"|"stop", targetId?}`; broadcast `room:live {holder, asks}`; non-terminal refusals as `room:notice {code}`. `room:state` carries `liveVideo`, `holder`, `asks` (never ages). Handler lives in `server/rooms/liveScreen.ts`, runs under the existing per-room lock, updates memory and broadcasts before slow side effects, tells LiveKit before the database.
- **LiveKit:** `VoiceService` gains `setPublishSources(roomId, userId, sources)`. Tokens stay mic-only. A holder gets `microphone` + `camera`; everyone else `microphone` (speakers) or none. Revoking removes the camera source, which makes LiveKit drop the track. `sweepVoice` also verifies the holder (anyone publishing camera who is not the holder has the source removed) so the server stays authoritative. `FakeVoice` records sources so tests can assert them. Only camera and microphone sources are ever allowed (no screen share).
- **Reconnect:** a holder who briefly disconnects keeps the slot for the reconnect window used by the stage; after that it is cleared.
- **Age:** a room's age limit applies as today; the teen rule above applies to holding the screen.
- **Quality/cost:** client publishes at most 720p, 30 fps (one layer, no simulcast at first); server cannot enforce this in the token, so it is a client default plus a documented LiveKit-side limit.
- **Moderation:** existing report flow; a report on a room already reaches the moderation queue. No new surface.
- **Security headers:** nothing new needed beyond `camera=(self)` added to the existing Permissions-Policy (currently `microphone=(self)`).

## Client

- `components/rooms/ScreenStage.tsx` replaces `RoomScreen` in the room while `LINK_SCREENS` is off:
  - Viewers: 16:9 stage with the holder's video (attached from the LiveKit track, muted until the viewer has joined audio), "No one is live" empty state, holder name, fullscreen (native, with the iOS pseudo-fullscreen fallback reused from `RoomScreen`), chat/reaction strip in fullscreen as today.
  - Holder: local preview, camera and microphone pickers (`enumerateDevices`, remembered per browser, refreshed on `devicechange`), Go live / Stop, clear errors (permission denied, device unplugged mid-stream stops the stream with a message).
  - Stage members who are not holder: "Ask to go live" / "Cancel" button.
- `useRoomVoice` exposes the remote video track of the holder and `startCamera(deviceIds)` / `stopCamera()` for the holder; it listens to `RoomEvent` track events for attach/detach.
- `StagePanel` (Controls tab) shows asks to go live beside mic requests, with Grant / Stop and a "Live video" switch (disabled with a reason when unavailable). `CreateRoomDialog` gets a "Live video" switch, off by default.
- Room list cards show a small "Live video" tag when on.

## Testing

- Unit: `scripts/test-rooms-unit.ts` covers every rule above (grant/replace/revoke, teen rule, adult-arrives, leaves, off-switch).
- API: create/PATCH `liveVideo` accept/refuse (unavailable, too large), `GET` carries the flag.
- WebSocket (with `FakeVoice`): ask/grant/replace/stop flows, only host/co-host grant, non-stage ask refused (`NOT_ON_STAGE`), teen refused, holder cleared on leave/kick/adult-arrival/off, LiveKit sources asserted for each transition, sweep removes camera from a non-holder, `room:state` leaks no ages.
- Real LiveKit check: grant then revoke, assert camera source added and removed.
- Browser: two sessions with Chromium fake media devices (`--use-fake-device-for-media-stream`); desktop and 375 px.
- Cannot be verified here (owner to test): real external cameras/capture cards, audio interfaces, phones and iOS Safari behaviour, real network quality.

## Open items / later

2-4 tile grid (state becomes `holders[]`, rules gain a cap), paid viewer cap above 50 and an SFU-egress/HLS tier for large audiences, music/video playback, recording policy, per-stream moderation takedown by the AI moderator.
