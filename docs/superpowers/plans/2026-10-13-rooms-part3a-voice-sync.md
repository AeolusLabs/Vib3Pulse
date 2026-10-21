# Rooms Part 3a: Voice, Synced Playback, Fullscreen Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host can switch on live voice, bring guests on stage, and play YouTube or Vimeo on the room screen in sync for everyone (with a countdown cue for Spotify, Apple Music and SoundCloud), with fullscreen working properly on phones.

**Architecture:** LiveKit Cloud carries the audio. Our server stays the authority: it decides who may speak (stage rules in `shared/`), mints short-lived LiveKit tokens, and changes or revokes a person's publish permission through a `VoiceService` interface (real LiveKit implementation, in-memory fake for tests). Playback state is a small persisted record the host updates over the existing `/ws` room channel; guests compute the target position from a server timestamp and correct their embedded player when they drift.

**Tech Stack:** TypeScript, `livekit-server-sdk` (server), `livekit-client` (browser), existing `ws` room channel, YouTube IFrame API and Vimeo Player API (loaded only from allow-listed hosts), `tsx` + `node:assert` tests (same runner as `npm run test:rooms`).

**Spec:** `docs/superpowers/specs/2026-10-13-rooms-part3-sound-screen-design.md` (decisions recorded at its end). Alpha context: `docs/superpowers/specs/2026-10-13-rooms-alpha-design.md`, `docs/superpowers/plans/2026-10-13-rooms-alpha.md`.

## Global Constraints

- LiveKit config comes only from server env: `LIVEKIT_URL` (`wss://vib3pulse-5o7irzml.livekit.cloud`), `LIVEKIT_API_KEY` (`APIFYcNaKWQsTGy`), `LIVEKIT_API_SECRET` (never written to the repo, logs or responses). If any is missing, voice is unavailable: endpoints answer `503 {code:"VOICE_UNAVAILABLE"}` and nothing else in rooms changes.
- LiveKit room name is `vp-<roomId>`; participant identity is the user id; tokens last 10 minutes (client re-requests at 8). No recording, no egress, no data channels (`canPublishData: false`).
- Speaker cap 6 = host + co-hosts present + stage guests (`MAX_SPEAKERS`). Host and co-hosts are implicit speakers when voice is on; `stage` holds guests only.
- Teens (13 to 17) may speak only when EVERYONE present in the room is a teen (host, co-hosts, guests); an adult being present, even only listening, blocks teen speaking, and an adult joining demotes teens already on stage. Unknown age never speaks. Adults may always be on stage. Anyone eligible may raise a hand; teens can always listen. The host or a co-host can give speaking rights to ANY eligible person present, whether or not they raised a hand (a raised hand is only a request; waves are not requests).
- Public and private rooms both support voice. Free rooms hold at most 50 people (`ROOM_LIMITS.capacityMax` becomes 50, default 50); paid rooms (part 5) will hold 100 to 150, recorded now as `ROOM_LIMITS.capacityMaxPaid = 150` and not used yet.
- Audio starts only after a user gesture ("Tap to hear the room"); the mic is requested only when a speaker taps the mic control.
- Playback sync tolerance 1500 ms; host heartbeat every 5 s while playing; guests can opt out ("Watch on my own") and "Catch up".
- Only the already allow-listed embed hosts get iframes. New script hosts allowed in CSP: `https://www.youtube.com`, `https://s.ytimg.com`, `https://player.vimeo.com`. `Permissions-Policy` becomes `microphone=(self)`.
- Schema changes are additive and applied to the production database in the same task that adds them (verify with a query), plus `ensureSchema()` in `server/storage.ts`.
- Never respond before a session callback completes; user rows go through `toPublicUser`; sensitive keys stay redacted.
- Do not commit or push unless the user asks; stage by name; `npm run build` before any push. Baseline `npx tsc --noEmit` is 10 errors.
- Tests never call the real LiveKit: they use the fake `VoiceService`. Real LiveKit is verified manually in Task 12 once the secret is in `.env`.

## Review Focus

- A teen speaker loses the stage the moment an adult is present (an adult joins), and teens keep it in an all-teen room. (Tasks 2, 6)
- A kicked, banned, removed, under-age or room-ended person loses audio at once: no new token, publish permission revoked, participant removed from LiveKit, even if their socket message was missed. (Tasks 4, 5, 6)
- A token is never issued to someone who is not in the room, when voice is off, when the room is not live, or with publish rights they have not been given; claims are checked by decoding the JWT. (Tasks 4, 5)
- Host crash, disconnect or room end leaves no zombie audio session or stage state, and a reconnect keeps a stage guest's rights but not a stale hand. (Task 6)
- Hostile or wrong playback input: a guest sending `room:playback`, a stale `screenVersion`, NaN or negative or enormous positions, floods. The server ignores or clamps; nothing crashes. (Task 7)
- A provider API script that is blocked or offline never breaks the screen: the plain embed still shows, sync is silently off. (Tasks 10, 12)

## File Structure

- Create `shared/stage.ts` (stage rules, pure), `shared/playback.ts` (sync maths, pure).
- Create `server/rooms/voice/voiceService.ts` (interface, selector), `livekitVoice.ts` (real), `fakeVoice.ts` (tests).
- Create `server/rooms/stage.ts` (hub-side stage state and the `room:stage` handler), keep `roomSocket.ts` as the router.
- Create `migrations/add_rooms_voice.sql`.
- Modify `server/security.ts`, `shared/schema.ts`, `server/storage.ts` (`ensureSchema`), `server/rooms/{roomStorage,roomRoutes,roomSocket,RoomHub}.ts`, `package.json`.
- Client create: `client/src/lib/{playerAdapters,voiceState}.ts`, `client/src/hooks/useRoomVoice.ts`, `client/src/components/rooms/{StagePanel,VoiceBar,SyncControls}.tsx`.
- Client modify: `client/src/lib/roomReducer.ts`, `client/src/hooks/useRoomSocket.ts`, `client/src/components/rooms/{RoomScreen,RoomScene,HostControls}.tsx`, `client/src/pages/RoomPage.tsx`.
- Tests: extend `scripts/test-rooms-unit.ts`, `scripts/test-rooms-api.ts`, `scripts/test-rooms-ws.ts`; the runner already runs all three.

---

### Task 1: Platform prep (headers and dependencies)

**Files:**
- Modify: `server/security.ts` (`securityHeaders`), `package.json`
- Test: `scripts/test-rooms-api.ts` (the CSP block added for the embed hosts)

**Interfaces:**
- Produces: `ROOM_LIMITS.capacityMax = 50` and `ROOM_LIMITS.capacityMaxPaid = 150` in `shared/rooms.ts` (`validateRoomInput` rejects capacity above 50); `ROOM_EMBED_HOSTS` (exists); new exported `ROOM_SCRIPT_HOSTS = ["https://www.youtube.com","https://s.ytimg.com","https://player.vimeo.com"] as const`; `Permissions-Policy` value `geolocation=(self), microphone=(self), camera=()`; `worker-src 'self' blob:`.

- [ ] **Step 1: Extend the tests.** Unit: `ROOM_LIMITS` equals `{ capacityDefault: 50, capacityMax: 50, capacityMaxPaid: 150, title: 80, description: 500, chat: 300 }`, `validateRoomInput` accepts capacity 50 and rejects 51 and 100 (field `capacity`); update the existing alpha tests that assumed 100. API: `POST /api/rooms` with capacity 51 is 400 field `capacity`. CSP test assertions: the `script-src` directive contains each `ROOM_SCRIPT_HOSTS` entry (development and production variants both), `worker-src` contains `blob:`, the `Permissions-Policy` header contains `microphone=(self)` and still `camera=()`, and `script-src` still contains no `*` and no `https:` wildcard.
- [ ] **Step 2: Run** `npm run test:rooms -- --only=api`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement** the three header changes in `securityHeaders` (add `ROOM_SCRIPT_HOSTS` to both `scriptSrc` strings).
- [ ] **Step 4: Install** `npm install livekit-server-sdk livekit-client`. Expected: both appear in `package.json` dependencies; `npm run build` still passes.
- [ ] **Step 5: Run** `npm run test:rooms -- --only=api`. Expected: green; `npx tsc --noEmit` stays at 10.

---

### Task 2: Stage rules and playback maths (pure)

**Files:**
- Create: `shared/stage.ts`, `shared/playback.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces in `shared/stage.ts`:
  - `MAX_SPEAKERS = 6`
  - `type StageAction = "raise" | "lower" | "invite" | "accept" | "remove"`
  - `interface StageState { stage: string[]; hands: string[]; invited: string[] }`
  - `type StageError = "FORBIDDEN" | "STAGE_FULL" | "NOT_ELIGIBLE" | "TARGET_GONE" | "BAD_STATE"`
  - `canBeOnStage(user: { age: number | null }, present: { bands: Array<AgeBand | null> }): Check<"AGE_UNKNOWN" | "ADULT_PRESENT">` where `present.bands` is the age band of everyone currently in the room, the user included (adults: always ok; teens: ok only when every band is `"teen"`; unknown age: never)
  - `applyStage(state: StageState, action: StageAction, ctx: { actorId: string; actorRole: "host" | "cohost" | "guest"; targetId: string; targetRole: "host" | "cohost" | "guest"; targetPresent: boolean; targetEligible: boolean; implicitSpeakers: number; maxSpeakers: number }): { ok: true; state: StageState } | { ok: false; code: StageError }`
  - Semantics: `raise` is self only (guest, eligible, not already on stage) and adds to `hands`. `lower` is self only and removes the actor from `hands`, `invited` and `stage`. `invite` is host/co-host on a present eligible guest not on stage and adds to `invited`. `accept` by host/co-host moves ANY present eligible guest to `stage` (a raised hand is not required; the target is removed from `hands` and `invited`); `accept` by the target moves the target from `invited` to `stage`; both fail `STAGE_FULL` when `implicitSpeakers + stage.length >= maxSpeakers`. `remove` is host/co-host on a guest and clears the target from all three lists; nobody can act on a host, and a co-host cannot act on another co-host.
- Produces in `shared/playback.ts`:
  - `type PlaybackState = "playing" | "paused" | "ended" | "cue"`
  - `interface NowPlaying { v: 1; screenVersion: number; state: PlaybackState; positionMs: number; atServerMs: number; startAtServerMs?: number }`
  - `sanitizePlaybackInput(input: unknown, currentScreenVersion: number): { ok: true; state: PlaybackState; positionMs: number; inMs?: number } | { ok: false }` (state must be one of the four, `positionMs` finite integer clamped to `0..86_400_000`, `inMs` only for `cue` clamped to `1000..30000`, `screenVersion` must equal the current one)
  - `targetPositionMs(np: NowPlaying, serverNowMs: number): number` (`playing` advances with time, others stay; never negative)
  - `needsCorrection(currentMs: number, targetMs: number, toleranceMs?: number): boolean` (default 1500)
  - `cueCountdownMs(np: NowPlaying, serverNowMs: number): number | null` (null unless `cue`; never negative)

- [ ] **Step 1: Write failing tests** in `scripts/test-rooms-unit.ts`: `canBeOnStage`: an adult is ok in any room; a teen is ok only when `present.bands` is all `teen`; a teen with one `adult` band present gets `ADULT_PRESENT`; unknown age never speaks (`AGE_UNKNOWN`); an `applyStage` matrix covering every action for host, co-host, guest actor and each target role (raise/lower self only; invite and accept and remove permissions; accept moves hands to stage and invited to stage; `STAGE_FULL` exactly at `implicitSpeakers + stage.length === maxSpeakers`; host and co-host targets rejected `FORBIDDEN`; ineligible target `NOT_ELIGIBLE`; absent target `TARGET_GONE`; a target `accept` without an invite `BAD_STATE`; a host `accept` on a guest who never raised a hand SUCCEEDS); `lower` removes from all lists; state is never mutated in place. `sanitizePlaybackInput` rejects `"play"`, `NaN`, `Infinity`, `-5`, a string position, a wrong `screenVersion`, and clamps `9e12`; `targetPositionMs` for `playing` at +2500 ms is `positionMs + 2500`, `paused` is constant; `needsCorrection(1000, 2400)` false, `(1000, 2600)` true; `cueCountdownMs` is null for `playing` and never below 0 for a past `startAtServerMs`.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both modules per Interfaces (pure functions; return new arrays).
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: all pass.

---

### Task 3: Schema, migration and storage for voice and playback

**Files:**
- Modify: `shared/schema.ts` (`rooms`, `roomMembers`), `server/storage.ts` (`ensureSchema`), `server/rooms/roomStorage.ts`
- Create: `migrations/add_rooms_voice.sql`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Consumes: `NowPlaying` (Task 2).
- Produces: columns `rooms.voice_enabled boolean not null default false`, `rooms.max_speakers integer not null default 6`, `rooms.screen_version integer not null default 0`, `rooms.now_playing jsonb`, `room_members.on_stage boolean not null default false`. In `roomStorage.ts`: `setVoiceEnabled(roomId: string, enabled: boolean): Promise<Room>`, `setNowPlaying(roomId: string, np: NowPlaying | null): Promise<Room>`, `bumpScreenVersion(roomId: string): Promise<number>` (returns the new version and also clears `now_playing`), `setOnStage(roomId: string, userId: string, onStage: boolean): Promise<void>`, `listOnStage(roomId: string): Promise<string[]>`, `clearStage(roomId: string): Promise<void>`. `updateRoom({ screen })` must call `bumpScreenVersion` semantics (a changed screen resets playback): implement inside `updateRoom` when `patch.screen !== undefined`.

- [ ] **Step 1: Write failing storage tests** (throwaway DB): defaults on a new room (`voiceEnabled false`, `maxSpeakers 6`, `screenVersion 0`, `nowPlaying null`); `setVoiceEnabled` round trip; `setNowPlaying` stores and returns the object, `null` clears; `updateRoom(id,{screen: X})` increments `screenVersion` by 1 and nulls `nowPlaying`, while `updateRoom(id,{title})` leaves both alone; `setOnStage` true then `listOnStage` returns the user, false removes; `clearStage` empties; `on_stage` survives `upsertMember` (re-joining does not clear it) and `markLeft`.
- [ ] **Step 2: Run** `npm run test:rooms -- --only=api`. Expected: FAIL.
- [ ] **Step 3: Add columns** to `shared/schema.ts`, write `migrations/add_rooms_voice.sql` (additive, idempotent `ADD COLUMN IF NOT EXISTS`), mirror the same statements in `ensureSchema`, implement the storage functions.
- [ ] **Step 4: Apply to production now:** `node --env-file=.env scripts/run-social-events-migration.mjs add_rooms_voice.sql`, then verify with a query that the five columns exist and `select count(*) from users` and `from rooms` are unchanged.
- [ ] **Step 5: Run** `npm run test:rooms`. Expected: green; tsc unchanged.

---

### Task 4: VoiceService (LiveKit, fake and selector)

**Files:**
- Create: `server/rooms/voice/voiceService.ts`, `server/rooms/voice/livekitVoice.ts`, `server/rooms/voice/fakeVoice.ts`
- Test: `scripts/test-rooms-unit.ts` (token claims, fake behaviour, selector)

**Interfaces:**
- Produces in `voiceService.ts`:
  - `interface VoiceService { readonly url: string; mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean }): Promise<string>; setCanPublish(roomId: string, userId: string, canPublish: boolean): Promise<void>; removeParticipant(roomId: string, userId: string): Promise<void>; deleteRoom(roomId: string): Promise<void> }`
  - `getVoiceService(): VoiceService | null` (null when `LIVEKIT_URL`, `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` is missing)
  - `setVoiceServiceForTests(v: VoiceService | null | undefined): void` (`undefined` restores env behaviour)
  - `roomNameFor(roomId: string): string` returning `vp-<roomId>`
- Produces in `fakeVoice.ts`: `class FakeVoice implements VoiceService` with a public `calls: Array<{ op: "mint" | "setCanPublish" | "remove" | "delete"; roomId: string; userId?: string; canPublish?: boolean }>` log, `url = "wss://fake.livekit.test"`, `mintToken` returning a decodable string `fake.<base64 json of the args>.sig`.
- `livekitVoice.ts` uses `AccessToken` (ttl `"10m"`, identity = userId, name = displayName, grant `{ roomJoin: true, room, canSubscribe: true, canPublish, canPublishData: false }`), `RoomServiceClient.updateParticipant` for `setCanPublish`, `removeParticipant`, `deleteRoom`. It treats "participant or room not found" as success.

- [ ] **Step 1: Write failing tests**: with env vars unset `getVoiceService()` is null and with all three set (dummy values) it is non-null and `url` equals `LIVEKIT_URL`; `roomNameFor("abc") === "vp-abc"`; decoding the JWT from the real `mintToken` (no network: `AccessToken.toJwt` only) shows `video.room === "vp-<id>"`, `video.roomJoin === true`, `video.canSubscribe === true`, `video.canPublish` equal to the argument, `video.canPublishData === false`, `sub === userId`, `name === displayName`, and `exp - iat === 600`; with `canPublish:false` the claim is false; `setVoiceServiceForTests` swaps and restores; `FakeVoice` records every call in order.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files per Interfaces. The real client is constructed lazily from env on first use and cached; the secret is never logged.
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: pass; `npx tsc --noEmit` unchanged.

---

### Task 5: Voice REST routes

**Files:**
- Modify: `server/rooms/roomRoutes.ts`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Consumes: `getVoiceService`, `setVoiceServiceForTests`, `FakeVoice` (Task 4); `setVoiceEnabled`, `listOnStage`, `clearStage` (Task 3); `roomHub`.
- Produces: `POST /api/rooms/:id/voice-token` returns `200 { url, token, canPublish, expiresInSec: 600 }`. Refusals: `503 VOICE_UNAVAILABLE` (no service), `404` (room not visible), `409 VOICE_OFF` (voice not enabled), `409 ROOM_NOT_LIVE`, `403 NOT_IN_ROOM` (caller not present in the hub), `403 BANNED`. `canPublish` is true for host, co-host and persisted on-stage guests. `PUT /api/rooms/:id/voice` body `{ enabled: boolean }` (host only; `400` otherwise) persists, broadcasts `{type:"room:voice", enabled}` to the room, and when turning off also clears persisted stage, empties in-memory stage/hands and calls `deleteRoom` on the service. Enabling requires the service (`503` otherwise).

- [ ] **Step 1: Write failing API tests** with a `FakeVoice` installed: token for the host has `canPublish true`; for a plain guest `false`; for an on-stage guest `true` (decode the fake token); `409 VOICE_OFF` before the host enables it; `403 NOT_IN_ROOM` for a user who is not in the hub; `403 BANNED` for a banned member; `404` for an invisible room; `409 ROOM_NOT_LIVE` for a scheduled room; `503` when no service is installed; unauthenticated `401`; non-host `PUT /voice` is `403`; enabling broadcasts `room:voice` to hub members (use capturing `send`); disabling clears `listOnStage`, calls `deleteRoom`, and a later token request is `409 VOICE_OFF`; the response and logs never contain the API secret string (set a recognisable dummy secret and assert it is absent from the JSON).
- [ ] **Step 2: Run** `npm run test:rooms -- --only=api`. Expected: FAIL.
- [ ] **Step 3: Implement** both routes in `roomRoutes.ts` (apply `roomLimiter`; reuse `canViewRoom`, `loadHostRoom`).
- [ ] **Step 4: Run** `npm run test:rooms`. Expected: green.

---

### Task 6: Stage protocol over WebSocket, with LiveKit revocation

**Files:**
- Create: `server/rooms/stage.ts`
- Modify: `server/rooms/{RoomHub,roomSocket,roomRoutes,roomAdmin}.ts`
- Test: `scripts/test-rooms-ws.ts`, `scripts/test-rooms-api.ts`

**Interfaces:**
- Consumes: `applyStage`, `canBeOnStage`, `MAX_SPEAKERS` (Task 2); `setOnStage`, `listOnStage`, `clearStage` (Task 3); `getVoiceService` (Task 4).
- Produces: `HubMember` gains `band: AgeBand | null` (computed at join from the date of birth); `RoomHub.bandsIn(roomId): Array<AgeBand | null>`; `RoomHub` gains `stageOf(roomId): StageState` and `setStage(roomId, s: StageState): void` (in-memory; cleared by `end` and `leave` of the last member). In `stage.ts`: `handleStage(ws, userId, roomId, msg): Promise<void>` and `revokeVoice(roomId: string, userId: string): Promise<void>` (removes the person from the stage lists and `on_stage`, then `removeParticipant`). WebSocket in: `room:stage {action, targetId?}` (`targetId` defaults to self for `raise`, `lower`, and self-`accept`). Out to everyone in the room after any change: `{type:"room:stage", stage: string[], hands: string[]}`; to an invited person: `{type:"room:stage", invitedYou: true}`. `room:state` gains `stage`, `hands`, `voiceEnabled`, `nowPlaying` (Task 7 fills the last). Refusals use `room:notice` with the `StageError` code or `VOICE_OFF`.
- `evict`, `endRoom`, `leaveRoom`, `applyMod` (kick/ban), `enforceAgeLimit` and the room-ended paths call `revokeVoice` / `deleteRoom` through the service when voice is on. A stage guest who disconnects keeps `on_stage` in the database (a reconnect restores the right; `hands` and `invited` are dropped).

- [ ] **Step 1: Write failing WebSocket tests** with `FakeVoice`: voice off → any `room:stage` gets notice `VOICE_OFF`; guest `raise` shows up in the broadcast `hands`; host `accept` moves them to `stage`, persists `on_stage`, and the fake log shows `setCanPublish(…, true)`; guest `lower` while on stage returns to listener and logs `setCanPublish(…, false)`; host `invite` then target `accept` reaches the stage; `STAGE_FULL` at the cap (host + 1 co-host + 4 stage guests = 6; a 5th guest is refused); a teen cannot raise or be accepted while any adult is present (`NOT_ELIGIBLE`) but can when everyone present is a teen; when an adult joins a room where teens are on stage those teens are removed from the stage (fake log shows `setCanPublish false`), `on_stage` cleared and the new `room:stage` broadcast; unknown age cannot; the host can `accept` a present guest who never raised a hand; a guest cannot `accept` or `remove` anyone (`FORBIDDEN`); co-host can accept and remove guests but not act on the host or another co-host; `remove` revokes (`setCanPublish false`) and clears `on_stage`; kick, ban, leave, disconnect-of-last-socket-past-grace, room end (`endRoom`), admin end and an age-limit raise each call `removeParticipant` (and `deleteRoom` on end) in the fake log; a stage guest who reconnects gets `stage` containing them in `room:state` and a token with `canPublish true`, but their old hand is gone; disabling voice (Task 5) clears everything; messages from a non-member or before joining get `NOT_IN_ROOM`.
- [ ] **Step 2: Run** `npm run test:rooms -- --only=api`. Expected: FAIL.
- [ ] **Step 3: Implement** `stage.ts` and the hub methods; route `room:stage` from `handleRoomMessage`; add the `revokeVoice` calls to every removal path listed above; extend `sendState`.
- [ ] **Step 4: Run** `npm run test:rooms`. Expected: green; tsc unchanged.

---

### Task 7: Playback sync over WebSocket

**Files:**
- Modify: `server/rooms/roomSocket.ts`, `server/rooms/roomRoutes.ts` (screen PATCH path already goes through `updateRoom`)
- Test: `scripts/test-rooms-ws.ts`

**Interfaces:**
- Consumes: `sanitizePlaybackInput`, `NowPlaying` (Task 2); `setNowPlaying`, `bumpScreenVersion` (Task 3).
- Produces: WebSocket in `room:playback {state, positionMs, inMs?, screenVersion}` from host or co-host only. Server stamps `atServerMs = Date.now()`, for `cue` sets `startAtServerMs = atServerMs + inMs`, persists via `setNowPlaying`, and broadcasts `{type:"room:playback", nowPlaying: NowPlaying, serverNowMs: number}` to everyone including the sender. `room:state.nowPlaying` carries the stored value. A `room:screen` change (host message or REST PATCH) bumps `screenVersion`, clears `nowPlaying`, and broadcasts `room:playback` with `nowPlaying: null`. A token bucket limits playback messages per user to 4/s, burst 8 (`tuning.playback`).

- [ ] **Step 1: Write failing tests**: host `playing` at 5000 ms is stored, stamped, and broadcast with `serverNowMs`; a guest sending `room:playback` is refused (`FORBIDDEN`) and nothing changes; stale `screenVersion` is ignored; `"play"`, `NaN`, `-5`, a string position are ignored with notice `BAD_REQUEST`, `9e12` is clamped to `86_400_000`; `cue` with `inMs: 5000` stores `startAtServerMs` about now + 5000; a late joiner's `room:state.nowPlaying` equals the stored value; changing the screen resets `nowPlaying` to null, increments `screenVersion`, and broadcasts it; 20 messages in a burst are rate limited (some dropped with `RATE_LIMITED`); the persisted value survives a hub reset.
- [ ] **Step 2: Run** `npm run test:rooms -- --only=api`. Expected: FAIL.
- [ ] **Step 3: Implement** `doPlayback` in `roomSocket.ts` and the screen-change hook (reuse `notifyScreen`; add the `nowPlaying: null` broadcast).
- [ ] **Step 4: Run** `npm run test:rooms`. Expected: green.

---

### Task 8: Client reducer and socket hook for stage, voice and playback

**Files:**
- Modify: `client/src/lib/roomReducer.ts`, `client/src/hooks/useRoomSocket.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Consumes: `NowPlaying` (Task 2); server messages from Tasks 5 to 7.
- Produces: `RoomState` gains `stage: string[]`, `hands: string[]`, `voiceEnabled: boolean`, `nowPlaying: NowPlaying | null`, `serverOffsetMs: number` (server time minus client time at the last playback message), `invitedYou: boolean`. `RoomServerMessage` gains `room:stage`, `room:voice`, `room:playback`; `room:state` carries the new fields. `useRoomSocket(roomId)` additionally returns `stageAction(action: StageAction, targetId?: string): boolean`, `sendPlayback(p: { state: PlaybackState; positionMs: number; inMs?: number }): boolean` (adds the current `screenVersion` from `state.room`), `setVoice(enabled: boolean): Promise<boolean>` (REST `PUT`).

- [ ] **Step 1: Write failing reducer tests**: `room:state` fills the new fields; `room:stage` replaces `stage`/`hands`; `{invitedYou:true}` sets `invitedYou` and a later stage message that includes self clears it; `room:voice` toggles `voiceEnabled` and when turned off clears `stage` and `hands`; `room:playback` stores `nowPlaying` and computes `serverOffsetMs = serverNowMs - clientNow` using the injected clock; `nowPlaying: null` clears it; a `room:screen` message clears `nowPlaying`; terminal phases still ignore all of these.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the reducer cases and the hook additions.
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts` and `npx tsc --noEmit`. Expected: pass; 10 errors.

---

### Task 9: Voice on the client

**Files:**
- Create: `client/src/lib/voiceState.ts`, `client/src/hooks/useRoomVoice.ts`, `client/src/components/rooms/{StagePanel,VoiceBar}.tsx`
- Modify: `client/src/components/rooms/{RoomScene,HostControls}.tsx`, `client/src/pages/RoomPage.tsx`
- Test: `scripts/test-rooms-unit.ts` (pure helpers only; the UI is verified in Task 12)

**Interfaces:**
- Consumes: `RoomState` stage fields (Task 8); `POST /api/rooms/:id/voice-token` (Task 5); `useRoomSocket` additions.
- Produces in `voiceState.ts`: `type VoiceStatus = "off" | "needs-tap" | "connecting" | "listening" | "speaking" | "error"`; `voiceStatus(i: { voiceEnabled: boolean; unlocked: boolean; connected: boolean; failed: boolean; canPublish: boolean; micOn: boolean }): VoiceStatus`; `refreshDelayMs(expiresInSec: number): number` (80% of the lifetime, at least 30 s); `speakingRings(speakers: string[], active: string[]): Record<string, boolean>`.
- Produces `useRoomVoice(roomId: string, opts: { enabled: boolean; canPublish: boolean })` returning `{ status: VoiceStatus; unlock(): Promise<void>; micOn: boolean; toggleMic(): Promise<void>; activeSpeakers: string[]; error: string | null }`. It fetches a token on `unlock()`, connects with `livekit-client` `Room`, subscribes to remote audio and attaches it to a hidden audio element, requests the microphone only inside `toggleMic()` (a click), re-requests a token at `refreshDelayMs`, disconnects on unmount or when voice is turned off, and maps LiveKit active-speaker events to ids.
- UI: `VoiceBar` shows "Tap to hear the room" until unlocked, then the status, the mic button (only when `canPublish`), and "Raise hand" / "Lower hand" for listeners. `StagePanel` (host and co-hosts) lists hands with "Bring up", the current speakers with "Remove", and has the "Go on mic" voice switch (REST `setVoice`). Stage avatars in `RoomScene` get a ring when `activeSpeakers` contains them, an `aria-label` suffix "speaking", and a "On stage" label. A guest who receives `invitedYou` sees "The host invited you to speak" with Accept and Decline.

- [ ] **Step 1: Write failing tests** for the three pure helpers: every `voiceStatus` branch (voice off → `off`; on but locked → `needs-tap`; unlocked and not connected and not failed → `connecting`; failed → `error`; connected listener → `listening`; connected publisher with mic on → `speaking`); `refreshDelayMs(600) === 480_000`, `refreshDelayMs(10) === 30_000`; `speakingRings` marks only active speakers that are on stage.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `voiceState.ts`, then the hook and components per Interfaces. Mic and audio only start from click handlers. Show the mic permission denial as a plain message.
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`, `npx tsc --noEmit` (10), `npm run build`. Expected: pass.

---

### Task 10: Synced playback on the client

**Files:**
- Create: `client/src/lib/playerAdapters.ts`, `client/src/components/rooms/SyncControls.tsx`
- Modify: `client/src/components/rooms/RoomScreen.tsx`, `client/src/pages/RoomPage.tsx`
- Test: `scripts/test-rooms-unit.ts` (pure parts), real browser in Task 12

**Interfaces:**
- Consumes: `targetPositionMs`, `needsCorrection`, `cueCountdownMs` (Task 2); `nowPlaying`, `serverOffsetMs`, `sendPlayback` (Task 8).
- Produces in `playerAdapters.ts`:
  - `interface PlayerAdapter { play(): void; pause(): void; seekTo(ms: number): void; positionMs(): number; onState(cb: (s: "playing" | "paused" | "ended" | "buffering") => void): () => void; destroy(): void }`
  - `attachPlayer(provider: "youtube" | "vimeo", iframe: HTMLIFrameElement): Promise<PlayerAdapter | null>` (null on any failure or timeout of 8 s; loads the YouTube IFrame API from `https://www.youtube.com/iframe_api` or the Vimeo player from `https://player.vimeo.com/api/player.js` once, only on demand)
  - `youtubeEmbedWithApi(embedUrl: string, origin: string): string` (adds `enablejsapi=1` and `origin`; throws if the host is not `www.youtube-nocookie.com`)
  - `syncDecision(i: { nowPlaying: NowPlaying | null; serverOffsetMs: number; clientNowMs: number; playerMs: number | null; watchOwn: boolean }): { action: "none" | "seek" | "play" | "pause"; seekToMs?: number }`
- Behaviour: a host or co-host's local player transitions call `sendPlayback` (play, pause, seek, ended) and a 5 s heartbeat while playing. Guests apply `syncDecision` on every `room:playback` and every 2 s; "Watch on my own" stops applying, "Catch up" applies once. For Spotify, Apple Music and SoundCloud the host gets a "Start together in 5 s" button that sends a `cue`; everyone sees a countdown from `cueCountdownMs` and a "Play now" prompt at zero. If `attachPlayer` returns null the plain embed stays and a small note says syncing isn't available.

- [ ] **Step 1: Write failing tests** for the pure helpers: `youtubeEmbedWithApi` adds both params to a nocookie URL and throws for `https://evil.test/embed/x`; `syncDecision` returns `none` when the player is within tolerance, `seek` with the target when over 1500 ms away while playing, `play` when state is `playing` but the player is paused, `pause` when state is `paused`, `none` when `watchOwn` is true, `none` when `nowPlaying` is null; a `cue` returns `none`.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the adapters (script loaders with a single shared promise per provider, 8 s timeout, no throw), `SyncControls`, and wire `RoomScreen` (mount the adapter after the iframe loads; destroy on screen change and unmount).
- [ ] **Step 4: Run** `npx tsx scripts/test-rooms-unit.ts`, `npx tsc --noEmit` (10), `npm run build`. Expected: pass.

---

### Task 11: Fullscreen and accessibility polish

**Files:**
- Modify: `client/src/components/rooms/RoomScreen.tsx`, `client/src/components/rooms/RoomChat.tsx`, `client/src/pages/RoomsPage.tsx`, `client/src/components/rooms/RoomScene.tsx`
- Test: browser checks in Task 12

**Interfaces:**
- Produces: when the viewport-cover overlay opens, focus moves to the Exit button, the overlay has `role="dialog"` with `aria-modal="true"` and a label, Tab stays inside it, and focus returns to the shield on exit; in fullscreen the compact chat does not mount a second `role="log"` live region (it is `aria-live="off"`); the Rooms list live region announces only changes in the number of rooms, not member counts; landscape on phones keeps the screen at its aspect ratio without the page scrolling behind it.

- [ ] **Step 1: Implement** each item above (small, contained edits).
- [ ] **Step 2: Verify** `npx tsc --noEmit` (10) and `npm run build`. Browser verification is part of Task 12.

---

### Task 12: Full verification, real LiveKit check, memory

**Files:** none new (docs and memory only)

- [ ] **Step 1: Run** `npm run test:rooms`, `npm run test:avatar`, `npm run test:social -- --only=6`, `npx tsc --noEmit` (10), `npm run build`. Expected: all green.
- [ ] **Step 2: Real browser run on a scratch database** (method in memory note `project_rooms_alpha.md`): with `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` set in the dev server's environment, check: host turns on "Go on mic" and speaks; a guest hears after "Tap to hear the room"; a guest raises a hand, is brought up, speaks, is removed and goes silent immediately; a kicked guest drops out of LiveKit; ending the room deletes the LiveKit room; a teen has no raise-hand while an adult is in the room, and in a room of only teens can speak; the CSP and Permissions-Policy allow the mic and the LiveKit socket (no console errors). Playback: set a YouTube link, host plays and seeks, a second session follows within about 2 seconds; "Watch on my own" and "Catch up" work; a Spotify link shows the countdown cue; with the YouTube script blocked the embed still shows and no error appears. Fullscreen: shield, exit, Escape, overlay focus. Record what could not be verified (no outbound network, no physical phone).
- [ ] **Step 3: Update memory** (`project_rooms_alpha.md`: voice/stage/playback code map, env vars, the revocation rule, how to run the real-LiveKit check) and the handover file. Do not commit or push unless asked.
