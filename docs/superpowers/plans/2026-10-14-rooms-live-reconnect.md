# Rooms live screen: keep the stream through bad internet (reconnect hold)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A performer whose internet drops keeps the live screen for a hold window; viewers see a "be right back" slate, and the stream resumes by itself when the connection returns. A drop must never end the stream until the window runs out (or the host takes the screen back).

**Why (research, Oct 2026):** Twitch Disconnect Protection holds 90 s with a holding image and resumes without a gap; Mux uses a reconnect window (default 60 s, up to 30 min) with a slate and a single continuous recording; YouTube is weaker (a short break can end the stream, recovery is manual); LiveKit already resumes short network changes by itself (1-2 s freeze) and fully rejoins and republishes tracks if that fails, but removes a participant 15 s after signalling is lost. Our code removed the performer from the room and from LiveKit the instant their WebSocket closed, so every blip ended the stream. Sources: Twitch/Speedify, Mux docs, LiveKit docs and community post (links in the chat message that introduced this plan).

**Architecture:** Three layers, each doing what the research says. (1) Room layer: when the screen holder's WebSocket closes, the server marks them *away* and keeps their member entry, the holder slot and their stage right for `tuning.liveGraceMs`, instead of dropping them; a rejoin inside the window resumes silently, expiry (or a host stop) releases as today. (2) Media layer: the holder's browser keeps LiveKit's own resume, then rejoins and republishes the camera automatically with the same devices. (3) Viewer layer: a slate ("<name> lost connection, back in a moment") replaces "No one is live" while away.

**Tech Stack:** unchanged (TypeScript, `ws`, LiveKit, React 18, tsx + node:assert).

**Spec:** `docs/superpowers/specs/2026-10-14-rooms-live-screen-design.md` (its Reconnect line: "a holder who briefly disconnects keeps the slot for the reconnect window"; this plan builds that, replacing ledger ruling "holder loses the screen on any disconnect").

## Decisions (confirmed by the owner, 2026-10-14)

- **Hold window: 2 minutes** (`tuning.liveGraceMs = 120_000`, env `ROOM_LIVE_GRACE_MS` overrides it for tests and tuning).
- **Scope of the hold: the screen holder only.** Other members who drop leave immediately, as today.
- **Must work on weak connections** (many users, e.g. across Africa, are on slow, lossy mobile data): Task 4 is required, not optional. Facts it rests on: LiveKit Cloud has a Johannesburg region and routes people to the nearest edge; LiveKit audio uses Opus with RED, which tolerates roughly 20-30% packet loss; LiveKit offers simulcast, dynacast and adaptive stream. Limits of what can be tested here: WebRTC traffic cannot be throttled or made lossy from the headless browser, so real behaviour on a 3G phone needs the owner's testing.

## Global Constraints

- `npm run test:rooms` green after every task; `npx tsc --noEmit` stays at the 10-error baseline; `npm run build` passes at the end.
- The hold applies only to the current live-screen holder while `roomHub.liveVideoOn(roomId)`; the member stays in the hub, so the teen rule, kick/ban, host revoke and room end still apply to them exactly as to anyone present.
- No ages in any payload. Tokens stay mic-only for everyone except the *current holder*, who may receive a camera-capable token (60 s TTL, identity-bound) so a rejoining performer can republish at once.
- Server stays authoritative: the camera permission is still `canCameraNow` (holder, on stage, eligible, live video on). A holder who is away is not removed from LiveKit by us, but LiveKit drops them after its own 15 s signalling timeout; that is fine.
- Match surrounding rooms code style; `data-testid` on UI; design tokens only.

## Review Focus

- Holder drops and never returns: after the window they are removed everywhere exactly as a normal leave (holder cleared, camera permission gone, LiveKit participant removed, `room:left` sent).
- Holder drops, host revokes during the hold: slot cleared at once and the away member is released (no ghost member left in the room).
- Holder rejoins on a second tab or twice quickly: no duplicate member, no leaked timers, the hold timer cleared exactly once.
- Teen holder away when an adult joins: screen cleared by the existing reconcile even though the holder is away.
- Room ends / host leaves while the holder is away: timers cleared, nothing fires after `roomHub.end`.

---

### Task 1: Server hold (away state, resume, expiry)

**Files:**
- Modify: `server/rooms/RoomHub.ts` (`HubMember.away?: { until: number }`; `setAway(roomId, userId, until | null)`), `server/rooms/roomSocket.ts` (`tuning.liveGraceMs`, `awayTimers`, `handleSocketClose`, `doJoin`, `endRoom`), `server/rooms/stage.ts` (`broadcastLive` carries `away`; call the registered releaser when a holder who is away stops being holder), `server/rooms/roomRoutes.ts` (voice-token camera for the holder), `server/rooms/voice/voiceService.ts` + `livekitVoice.ts` + `fakeVoice.ts` (`mintToken` accepts `camera?: boolean`)
- Test: `scripts/test-rooms-ws.ts`, `scripts/test-rooms-unit.ts`, `scripts/test-rooms-api.ts`

**Interfaces:**
- Produces:
  - `tuning.liveGraceMs: number` (default `Number(process.env.ROOM_LIVE_GRACE_MS) || 120_000`; tests set it small).
  - WS `room:live` message gains `away: number | null` (epoch ms when the hold expires, null when the holder is present); `room:state` carries the same `away`.
  - `registerAwayReleaser(fn: (roomId: string, userId: string) => Promise<void>): void` exported from `stage.ts`; `roomSocket.ts` registers `releaseAwayMember` (clears the timer, then the normal leave path: `dropFromVoice(..., true)`, `roomHub.leave`, `markLeft`, broadcast `room:left`, `reconcileVoice`, host `scheduleEnd`).
  - `mintToken({ roomId, userId, displayName, canPublish, camera? })`: camera true only when the route finds `canCameraNow`.

- [ ] **Step 1: Failing tests (WS, `tuning.liveGraceMs = 700`):** holder's socket closes -> the room is told `room:live` with `holder` unchanged and `away` a number, `room:left` is NOT sent, FakeVoice has no `remove` call; holder reconnects with a new socket and `room:join` within the window -> `room:live` away null, `holder` still them, `room:state` carries holder, member list has them once; holder socket closes and nobody returns -> after the window `room:live` holder null, `room:left` sent, FakeVoice `remove` called; holder away then host `revoke` -> holder null at once and the member is released immediately (`room:left`) and no timer fires later (assert no second `room:left`); non-holder socket close still leaves immediately; two sockets of the holder, one closes -> not away; host leaves while holder away -> no crash and no timer fires after the room ended.
- [ ] **Step 2: Failing tests (unit/API):** `FakeVoice.mintToken` records `camera`; LiveKit token claims for `camera: true` list `["microphone","camera"]`, default stays `["microphone"]` (extend the existing claims test); API: voice token for the current holder carries camera, for everyone else mic only.
- [ ] **Step 3: Run** `npm run test:rooms`. Expected: the new checks FAIL.
- [ ] **Step 4: Implement** per Interfaces. In `handleSocketClose`: if the leaving user is the live holder (`roomHub.liveOf(roomId).holder === userId && roomHub.liveVideoOn(roomId)`) and has no other open socket, set `away`, broadcast `room:live`, start the timer and return (no `leaveRoom`); on timer expiry call `releaseAwayMember`. In `doJoin` for an existing member with `away`: clear the timer and flag, broadcast `room:live`, then proceed as a normal re-register + `sendState`. `endRoom` clears timers for the room's members. `stage.ts` calls the releaser (not awaited under the room lock) when `handleLive`/`stopAllLive`/`reconcileLiveLocked` clears a holder whose member is `away`.
- [ ] **Step 5: Run** `npm run test:rooms`. Expected: ALL GREEN; `npx tsc --noEmit` baseline.
- [ ] **Step 6: Commit** by file name on branch `rooms` (no push).

### Task 2: Viewer slate, holder banner, host countdown (client)

**Files:**
- Modify: `client/src/lib/roomReducer.ts` (`holderAwayUntil: number | null`; `room:live` and `room:state` set it), `client/src/components/rooms/ScreenStage.tsx` (slate + holder banner), `client/src/components/rooms/StagePanel.tsx` (host sees "reconnecting, 1:12 left" and keeps Stop), `client/src/pages/RoomPage.tsx` (pass `awayUntil`, `serverOffsetMs`)
- Create: `awayRemainingMs(awayUntil: number | null, serverOffsetMs: number, nowMs: number): number | null` in `client/src/lib/voiceState.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:** Consumes Task 1 `away`. Produces `awayRemainingMs` (null when not away; never negative).

- [ ] **Step 1: Failing unit tests:** `awayRemainingMs` (null -> null, future -> remaining using the server offset, past -> 0); reducer: `room:live {holder:'h', asks:[], away: 123}` sets `holderAwayUntil`, `away: null` clears it, `room:livevideo` off clears it.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Slate (viewers, and the empty state while a holder is away): "<name> lost connection. Holding their spot, back in a moment." with a spinner, no countdown. Holder view: banner "Your connection dropped. We're holding your spot for m:ss" with a live countdown, `role="status"`. Host Controls: the holder row shows "Reconnecting (m:ss left)" and keeps the Stop button. Copy honest, no invented numbers; tokens and 44px targets as elsewhere.
- [ ] **Step 4: Run** unit tests, `npx tsc --noEmit`, `npm run build`. Expected: pass.
- [ ] **Step 5: Commit.**

### Task 3: Media resilience (auto rejoin and republish)

**Files:** Modify `client/src/hooks/useRoomVoice.ts`, `client/src/components/rooms/ScreenStage.tsx` (reconnecting indicator), `client/src/pages/RoomPage.tsx`.

**Interfaces:** `RoomVoice` gains `reconnecting: boolean` (true on `RoomEvent.SignalReconnecting`/`Reconnecting` or connection quality `Lost`, false on `Reconnected`/`Connected`).

- [ ] **Step 1: Implement** (browser-only code, covered by the e2e in Task 5; note this in the ledger): create the `Room` with `adaptiveStream: true, dynacast: true`; remember the last devices and an `intendedLive` ref set by `startCamera`, cleared only by an explicit Stop or when the server says the holder changed; on `RoomEvent.Disconnected` while `intendedLive`, retry `connect()` with backoff (1 s, 2 s, 4 s, 8 s, then every 10 s) until the hold ends instead of showing "Tap to reconnect"; after a reconnect that republished nothing, call `startCamera(lastDevices)` automatically; if that fails show the button "Tap to go live again". The existing stop effect in `RoomPage` must not fire while `reconnecting` or while the socket status is `reconnecting`.
- [ ] **Step 2: Run** `npx tsc --noEmit`, `npm run build`, `npm run test:rooms`. Expected: baseline / green.
- [ ] **Step 3: Commit.**

### Task 4: Works on weak connections (data saver, audio first, small download)

**Files:**
- Create: `client/src/lib/bandwidth.ts`
- Modify: `client/src/hooks/useRoomVoice.ts`, `client/src/components/rooms/ScreenStage.tsx`, `client/src/pages/RoomPage.tsx`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces (all pure, in `bandwidth.ts`):**
- `type ConnInfo = { effectiveType?: string; downlink?: number; saveData?: boolean }` (what `navigator.connection` offers; absent on Safari and Firefox).
- `type VideoProfile = "saver" | "balanced" | "standard"` and `profileSettings(p: VideoProfile): { width: number; height: number; frameRate: number; maxBitrate: number }`: saver 640x360 at 15 fps, 350 kbps; balanced 960x540 at 24 fps, 800 kbps; standard 1280x720 at 30 fps, 1500 kbps (our caps, chosen to keep data use predictable).
- `pickStartProfile(c: ConnInfo | undefined): VideoProfile`: `saveData` true, or `effectiveType` slow-2g/2g/3g, or `downlink` under 1.5 -> saver; `effectiveType` 4g with `downlink` 5 or more -> standard; anything unknown -> balanced.
- `viewerStartsAudioOnly(c: ConnInfo | undefined): boolean`: true for `saveData` or effectiveType slow-2g/2g (a viewer on those starts with sound only and taps to watch).
- `weakLinkAdvice(quality: "excellent" | "good" | "poor" | "lost" | "unknown", poorForMs: number): "none" | "suggest-audio-only"`: poor or lost for 8000 ms or more -> suggest.

- [ ] **Step 1: Failing unit tests** for the four functions above (every branch, unknown inputs, boundaries 1.5 / 5 / 8000).
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `bandwidth.ts`, then wire it (browser-only code, covered by the Task 5 e2e and review; ledger says so):
  - Holder: a Quality picker (Auto / Data saver / Balanced / High, default Auto = `pickStartProfile(navigator.connection)`), applied through `setCameraEnabled(true, { deviceId, resolution: { width, height, frameRate } }, { videoEncoding: { maxBitrate, maxFramerate: frameRate }, simulcast: true })`. Microphone published with `AudioPresets.music` (48 kbps), `dtx: true`, `red: true`. A "Pause picture, keep sound" button (and a suggestion banner when `weakLinkAdvice` says so) unpublishes only the camera: the holder keeps the screen and the mic, viewers see "<name> is on audio only" with the avatars; "Turn picture back on" restores it.
  - Viewer: a toggle "Audio only (saves data)" that unsubscribes the remote video publication(s) (`setSubscribed(false)`) and persists in `localStorage` (try/catch); starts on when `viewerStartsAudioOnly`; the same suggestion banner when the viewer's own connection quality is poor for 8 s.
  - Room options: `adaptiveStream: true`, `dynacast: true`; connect options `peerConnectionTimeout` and `websocketTimeout` raised to 30 000 ms; `reconnectPolicy` that keeps retrying with delays 1 s, 2 s, 4 s, 8 s then every 8 s until 120 s have elapsed (then gives up), so LiveKit's own loop covers the hold window.
  - Download size: load `livekit-client` with a dynamic `import()` the first time room audio/video starts, so pages that never join a room do not pay for it; record the client bundle size before and after from `npm run build` and report only the measured numbers.
- [ ] **Step 4: Run** unit tests, `npx tsc --noEmit` (baseline 10), `npm run build`, `npm run test:rooms`. Expected: pass.
- [ ] **Step 5: Commit** by file name on `rooms` (no push).

### Task 5: Verification

- [ ] **Step 1: Full suites** `npm run test:rooms`, `npm run test:avatar`, `npm run test:social -- --only=6`, `npx tsc --noEmit`, `npm run build`.
- [ ] **Step 2: Two-browser network-drop test** (also check the Quality picker defaults, the audio-only viewer toggle and the pause-picture button; real throttling of WebRTC is not possible here, say so in the report) (Playwright with fake camera against real LiveKit; extend the session e2e script): the guest holder goes live, the host sees the video; `context.setOffline(true)` for 6 s then online -> the host's video resumes with no click from the guest (LiveKit resume path); offline for 25 s (past LiveKit's 15 s signalling timeout, forces a full rejoin) then online -> the slate appears for the host during the outage and the video comes back by itself, guest still holder; offline longer than the window (dev server run with `ROOM_LIVE_GRACE_MS=15000`) -> the screen is released and the host sees "No one is live". Screenshots at 375 px and desktop.
- [ ] **Step 3: Memory and handover:** update `project_rooms_alpha.md` (reconnect hold built, remove the "holder loses the screen on any disconnect" caveat) and the ledger. Do not push; commit only code to `rooms`.
- [ ] **Step 4: Fresh review** of the new commit range by an independent reviewer on the most capable model, with the Review Focus above; fix Critical/Important with tests first.
