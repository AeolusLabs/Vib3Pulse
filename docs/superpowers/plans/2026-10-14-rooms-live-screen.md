# Rooms live camera + mic screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One person at a time can stream camera + mic to the room screen, granted by the host, server-authoritative, with LiveKit permissions following the grant.

**Architecture:** A pure rules module (`shared/liveScreen.ts`) decides asks/grants/stops. `RoomHub` keeps `{holder, asks}` in memory per room (like the stage); a new `server/rooms/liveScreen.ts` applies actions under the existing per-room lock and tells LiveKit (camera source added/removed) before the DB. The client shows a `ScreenStage` that renders the holder's LiveKit video track and, for the holder, device pickers + Go live/Stop.

**Tech Stack:** TypeScript, Express, Drizzle/Postgres, `ws`, `livekit-server-sdk` / `livekit-client`, React 18, TanStack Query, tsx + node:assert tests.

**Spec:** `docs/superpowers/specs/2026-10-14-rooms-live-screen-design.md` (binding). Adjustment ruled in this plan: the host switches "Live video" on through `PUT /api/rooms/:id/live-video {enabled}` and the Controls tab, mirroring how voice is switched on (`PUT /api/rooms/:id/voice`), not on the create dialog. Create dialog is unchanged except an informational tag is NOT added (YAGNI). Room list cards show a "Live video" tag.

## Global Constraints

- Native approach: `npm run test:rooms` (unit + api + ws) must stay green after every task; `npx tsc --noEmit` stays at the 10-error baseline; `npm run build` passes before the branch is considered done.
- Only camera and microphone LiveKit sources, ever (never screen share). Tokens stay mic-only; only the holder gets camera.
- Max one holder per room. Holder must be on stage (host/co-host implicit), pass the teen rule (`canBeOnStage`), and be granted by host/co-host. Host may grant themselves.
- Live video requires voice on (LiveKit available) and `capacity <= ROOM_LIMITS.liveVideoMax` (50).
- Nothing recorded. Never put anyone's age in a message (`room:state` etc.).
- Schema change is additive (`rooms.live_video boolean not null default false`) and MUST be applied to the database in the same task (global rule); tests use throwaway DBs `vib3_<name>_test_<8hex>`. Production DB is the same DB as dev: apply with the same method used for `add_rooms_voice.sql`.
- Send responses only after async work completes; sanitize user rows via existing helpers; no new public fields beyond `liveVideo`, `holder`, `asks`.
- Permissions-Policy becomes `microphone=(self), camera=(self)`.
- Code style: match surrounding rooms code (terse comments explaining why, zod-free hand validation, `data-testid` on UI).

## Review Focus

- A teen holder when an adult arrives mid-stream: holder cleared, camera source removed, screen shows empty state.
- Holder disconnects/reconnects or is kicked/banned: slot cleared, no ghost video, LiveKit camera source removed.
- Grant to a second person while one is live: first loses camera before second gains it; never two camera publishers.
- Live video switched off or voice switched off mid-stream: holder cleared, asks cleared, camera permission removed.
- A non-holder publishing camera via a stale/raced token: sweep removes the camera source.

---

### Task 1: Pure rules

**Files:**
- Create: `shared/liveScreen.ts`
- Test: `scripts/test-rooms-unit.ts` (append a "live screen rules" block using the file's existing `check` helper)

**Interfaces:**
- Produces:
  - `type LiveAction = "ask" | "withdraw" | "grant" | "revoke" | "stop"`
  - `type LiveError = "LIVE_OFF" | "NOT_ON_STAGE" | "NOT_ALLOWED" | "TEEN_RULE" | "NOT_PRESENT" | "NO_CHANGE"`
  - `interface LiveState { holder: string | null; asks: string[] }`
  - `interface LiveContext { actorId: string; actorRole: "host"|"cohost"|"guest"; targetId: string; targetPresent: boolean; targetOnStage: boolean; targetEligible: boolean; liveOn: boolean }` (`targetOnStage` is true for host/co-host or a guest on the stage)
  - `applyLive(state: LiveState, action: LiveAction, c: LiveContext): { ok: true; state: LiveState } | { ok: false; code: LiveError }`
  - `dropFromLive(state: LiveState, userId: string): LiveState` (removes holder and ask)
  - `emptyLive: LiveState`

- [ ] **Step 1: Write failing tests** covering: ask ok; ask when `liveOn=false` → `LIVE_OFF`; ask off-stage → `NOT_ON_STAGE`; ask teen-ineligible → `TEEN_RULE`; ask twice → `NO_CHANGE`; grant by guest → `NOT_ALLOWED`; grant by host to present eligible on-stage target sets holder and removes from asks; grant to self by host ok; grant replaces existing holder; grant absent target → `NOT_PRESENT`; grant off-stage → `NOT_ON_STAGE`; grant ineligible → `TEEN_RULE`; grant to current holder → `NO_CHANGE`; revoke by mod clears holder; revoke by guest → `NOT_ALLOWED`; stop by holder clears; stop by mod clears someone else's; stop by other guest → `NOT_ALLOWED`; stop with no holder → `NO_CHANGE`; withdraw removes ask / `NO_CHANGE` when absent; `dropFromLive` clears holder and ask for that user only.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `shared/liveScreen.ts` per the Interfaces block (pure functions, no I/O, mirror the style of `shared/stage.ts`; `Check` type not needed).
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `git add shared/liveScreen.ts scripts/test-rooms-unit.ts && git commit -m "feat(rooms): live screen rules"` (branch `rooms`; do not push).

### Task 2: Schema, storage, hub state, voice service camera permission, toggle route

**Files:**
- Create: `migrations/add_rooms_live_video.sql`
- Modify: `shared/schema.ts` (rooms: `liveVideo: boolean("live_video").notNull().default(false)` beside `voiceEnabled` ~line 1135), `shared/rooms.ts` (`ROOM_LIMITS.liveVideoMax: 50`), `server/rooms/roomStorage.ts` (`setLiveVideo(roomId, enabled): Promise<Room>` mirroring `setVoiceEnabled` ~line 50; ensure `publicRoom`/room JSON carries `liveVideo`), `server/rooms/RoomHub.ts` (`liveOf(roomId): LiveState`, `setLive(roomId, s)`, `liveVideoOn(roomId)`/`setLiveVideoOn(roomId, on)` mirroring `voiceOn`/`setVoiceOn`; cleared with the room), `server/rooms/voice/voiceService.ts` (interface), `server/rooms/voice/livekitVoice.ts`, `server/rooms/voice/fakeVoice.ts`, `server/rooms/roomRoutes.ts` (new route beside `PUT /api/rooms/:id/voice` ~line 437)
- Test: `scripts/test-rooms-api.ts`, `scripts/test-rooms-ws.ts` (fake voice assertions in Task 3)

**Interfaces:**
- Consumes: Task 1 `LiveState`, `emptyLive`.
- Produces:
  - `VoiceService.setCanPublish(roomId, userId, canPublish, camera?: boolean)`: with `camera` true the participant may publish `[MICROPHONE, CAMERA]`, otherwise `[MICROPHONE]`.
  - `VoiceService.mintToken(a)` unchanged signature plus optional `camera?: boolean` (default false; only passed `true` never at join time).
  - `VoiceService.listParticipants` entries gain `canCamera: boolean`.
  - `FakeVoice`: `VoiceCall` gains optional `camera?: boolean` (set only when true so existing assertions stay valid); `participants` entries gain `canCamera` (default false).
  - `PUT /api/rooms/:id/live-video {enabled: boolean}` (host only, same auth/guard helpers as the voice route). Enabling requires `room.voiceEnabled` and `roomHub.voiceOn` (else 409 `{code:"VOICE_OFF"}`), LiveKit available (`getVoiceService()` else 409 `{code:"LIVE_UNAVAILABLE"}`), and `room.capacity <= ROOM_LIMITS.liveVideoMax` (else 400 `{field:"liveVideo", reason:"too_large"}`). Success: persists, `roomHub.setLiveVideoOn`, broadcasts `{type:"room:livevideo", enabled}`; disabling also calls `stopAllLive(roomId)` from Task 3 (import added in Task 3; in this task disabling just clears hub live state via `roomHub.setLive(roomId, emptyLive)` and removes camera permission through `setCanPublish(...)` is deferred to Task 3).

- [ ] **Step 1: Failing API tests** in `scripts/test-rooms-api.ts`: host toggles on with voice on → 200 and `GET /api/rooms/:id` has `room.liveVideo === true`; toggling on with voice off → 409 `VOICE_OFF`; non-host → 403; capacity 51 room impossible (capacity max is 50) so test `too_large` through a direct `roomHub`/storage-level capacity override only if the route reads `room.capacity` (assert with a room row updated via `db.update`); toggling off → `liveVideo === false`; FakeVoice `setCanPublish` called with `camera` omitted for ordinary speakers.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-api.ts`. Expected: FAIL (route/column missing).
- [ ] **Step 3: Implement** column + migration SQL (`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS live_video boolean NOT NULL DEFAULT false;` inside BEGIN/COMMIT, idempotent), storage, hub, voice service changes (`LiveKitVoice.setCanPublish` uses `canPublishSources: camera ? [MICROPHONE, CAMERA] : MIC_ONLY`; `listParticipants` reads `permission.canPublishSources`), FakeVoice, route.
- [ ] **Step 4: Apply the migration to the database now** using the same method as `add_rooms_voice.sql` (check how it was applied: the scratchpad/handover notes; run the SQL file against `DATABASE_URL` with node `pg`), then verify with `select column_name from information_schema.columns where table_name='rooms' and column_name='live_video'`. Also apply to the throwaway local test DB if the dev server runs against it (`vib3_roomsui_test_5e33e4ce`). Expected: column exists.
- [ ] **Step 5: Run** `npm run test:rooms`. Expected: ALL GREEN. `npx tsc --noEmit` baseline 10.
- [ ] **Step 6: Commit** the files by name.

### Task 3: Server live handler, WebSocket wiring, sweep enforcement

**Files:**
- Create: `server/rooms/liveScreen.ts`
- Modify: `server/rooms/roomSocket.ts` (dispatch `room:live` near `room:stage` ~line 407; include `liveVideo`, `holder`, `asks` in `room:state` ~line 153; call hooks on leave ~113, join ~216, removal ~232/237), `server/rooms/stage.ts` (`sweepVoice`: pass `camera` and correct a non-holder with camera; `publishChange` keeps camera false for non-holders; `shutdownVoice` also clears live), `server/rooms/roomRoutes.ts` (disable path calls `stopAllLive`)
- Test: `scripts/test-rooms-ws.ts`

**Interfaces:**
- Consumes: Task 1 rules; Task 2 hub/voice APIs.
- Produces:
  - `handleLive(userId: string, roomId: string, msg: any): Promise<{ ok: true } | { ok: false; code: string }>` (runs under the per-room lock; export a `withRoomLock` from `stage.ts` for reuse if it isn't exported yet)
  - `dropFromLiveScreen(roomId: string, userId: string): Promise<void>` (call BEFORE leaving the hub: clears holder/ask, removes camera permission)
  - `reconcileLive(roomId: string): Promise<void>` (after join/leave/role change: holder no longer on stage or no longer eligible → cleared)
  - `stopAllLive(roomId: string): Promise<void>` (live video or voice switched off: holder and asks cleared, camera permission removed)
  - WS out: `{type:"room:live", holder: string | null, asks: string[]}` broadcast on every change; `room:livevideo {enabled}` from Task 2; refusals as `room:notice {code}`.
  - `canCameraNow(roomId, userId): boolean` = `liveOf(roomId).holder === userId && canPublishNow(roomId, userId)`.

- [ ] **Step 1: Failing WS tests** (FakeVoice installed as in existing WS tests; use `liveRoom`, `mk`, `connect`, `join` helpers; turn voice and live video on first): ask by on-stage guest → broadcast `room:live` with the ask; ask by non-stage guest → notice `NOT_ON_STAGE`; ask with live off → `LIVE_OFF`; grant by host → `room:live` holder = guest and FakeVoice has `setCanPublish(..., camera:true)` for that guest; grant by guest → `NOT_ALLOWED`; second grant to another person → FakeVoice call order is camera removed from first (`camera` absent/false) before camera added to second; host stop → holder null and camera removed; holder stop themselves; holder leaves (`room:leave`) → holder null and camera removed; kick/ban of holder → cleared; teen holder + adult joins → cleared (use the adult/teen setup from the existing "adult arrives" test); live video off via the PUT route → holder null, camera removed; voice off → same; `room:state` for a late joiner includes `holder`/`asks`/`liveVideo` and contains no `age`; sweep: set `fake.participants` with a non-holder `canCamera:true`, run `sweepVoice(roomId)`, assert a `setCanPublish(..., camera false)` correction call.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-ws.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/rooms/liveScreen.ts` and wire it. Order inside every change: update hub memory and broadcast first, then `await` LiveKit (`getVoiceService()?.setCanPublish(roomId, id, canPublishNow(roomId, id), canCameraNow(roomId, id))`, errors logged and not thrown via the existing `soft` pattern), no DB write is needed (live state is in memory only). Replacing a holder removes the old holder's camera before granting the new one. `sweepVoice` compares `p.canPublish`/`p.canCamera` to `canPublishNow`/`canCameraNow` and corrects both.
- [ ] **Step 4: Run** `npm run test:rooms`. Expected: ALL GREEN; `npx tsc --noEmit` baseline.
- [ ] **Step 5: Commit** the files by name.

### Task 4: Client

**Files:**
- Create: `client/src/components/rooms/ScreenStage.tsx`, `client/src/lib/mediaDevices.ts`
- Modify: `client/src/lib/roomReducer.ts` (state `liveVideo`, `holder`, `asks`; events `room:live`, `room:livevideo`; `room:state` carries them), `client/src/hooks/useRoomSocket.ts` (`liveAction(action, targetId?)` sending `room:live`; `setLiveVideo(enabled)` calling `PUT /api/rooms/:id/live-video`), `client/src/hooks/useRoomVoice.ts` (expose `holderVideoTrack` from `RoomEvent.TrackSubscribed`/`Unsubscribed` for `Track.Kind.Video`, plus `startCamera({cameraId, micId})`, `stopCamera()`, `cameraOn`, `cameraError`; camera capture limited to 1280x720 at 30 fps), `client/src/pages/RoomPage.tsx` (render `ScreenStage` instead of nothing in the `!LINK_SCREENS` case, above the scene), `client/src/components/rooms/StagePanel.tsx` (asks to go live with Grant, a Stop button, and a "Live video" switch with its disabled reason), `client/src/pages/RoomsPage.tsx` + `client/src/lib/roomsApi.ts` (`liveVideo?: boolean` on `RoomView`, small "Live video" tag on cards), `server/security.ts` (Permissions-Policy camera)
- Test: `client/src/lib/mediaDevices.ts` pure helpers unit-tested in `scripts/test-rooms-unit.ts`

**Interfaces:**
- Consumes: Task 3 messages; `RoomVoice` from `useRoomVoice`.
- Produces:
  - `mediaDevices.ts`: `pickDevices(list: Array<{kind: string; deviceId: string; label: string}>): { cameras: Dev[]; mics: Dev[] }` (labels fallback "Camera 1", "Microphone 1"; ignores empty ids; `Dev = { deviceId: string; label: string }`) and `rememberedDevice(kind: "camera"|"mic", available: Dev[]): string | null` (reads/writes `localStorage` inside try/catch, returns null when the saved id is gone).
  - `ScreenStage` props: `{ holderName: string | null; holderId: string | null; selfId: string | null; track: MediaStreamTrack-like | null; canGoLive: boolean; isHolder: boolean; onStop: () => void; voice: RoomVoice; onAsk: () => void; asked: boolean; onWithdraw: () => void; canAsk: boolean }`.

- [ ] **Step 1: Failing unit tests** for `pickDevices` (labels, empty ids, ordering) and `rememberedDevice` (missing saved id → null; storage throwing → null).
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, reducer/socket/voice changes and `ScreenStage` per spec (16:9 stage, "No one is live" empty state, holder preview, camera/mic pickers refreshed on `devicechange`, Go live/Stop, errors for denied permission and unplugged device stopping the stream with a message, fullscreen with the iOS pseudo-fullscreen fallback copied from `RoomScreen`, video `muted` until the viewer has unlocked audio, `data-testid`s: `screen-stage`, `button-go-live`, `button-stop-live`, `button-ask-live`, `select-camera`, `select-mic`, `live-empty`). Design tokens only (theme-aware `bg-muted`, `border-border`, violet primary; no italic headings; 44px targets). Update Permissions-Policy.
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`, `npx tsc --noEmit` (baseline 10), `npm run build`. Expected: pass.
- [ ] **Step 5: Commit** the files by name.

### Task 5: Verification

**Files:** none new (temporary `scripts/_tmp_*` removed afterwards).

- [ ] **Step 1: Full suites** `npm run test:rooms`, `npm run test:avatar`, `npm run test:social -- --only=6`, `npx tsc --noEmit`, `npm run build`. Expected: all green / baseline.
- [ ] **Step 2: Real LiveKit check** with a temporary script against the real service (owner's env): mint token, connect two participants, `setCanPublish(..., true, true)` then `(..., true, false)`, assert `listParticipants` reports `canCamera` true then false. Delete the script. Record results; if the secret is rejected, report instead of retrying.
- [ ] **Step 3: Browser test** on the scratch DB dev server (restart with `RESEND_API_KEY=re_dummy` and the throwaway `DATABASE_URL`; apply `add_rooms_live_video.sql` to the throwaway DB first): host + guest in two sessions with Chromium fake media devices, host switches live video on, guest asks, host grants, guest goes live, host sees the video element, host stops. Check 375 px and desktop. Report what could not be verified (real external cameras, capture cards, phones, iOS).
- [ ] **Step 4: Memory + handover**: update `project_rooms_alpha.md` (live screen built, what is unverified) and add a short section to the handover doc. Do not commit docs; do not push; commit code to `rooms` only if the owner asked.
