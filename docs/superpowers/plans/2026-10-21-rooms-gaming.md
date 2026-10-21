# Rooms: Gamers Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players put their own screens in a room (1v1 to 4v4, four-way, spotlight), with player and team spray, age lanes and drop handling, without changing anything for existing rooms.

**Architecture:** A new, flag-gated "game" layer beside the existing single-holder live screen. New pure rules (`shared/gameScreen.ts`), new in-memory hub state, a new `room:game` WebSocket message and a new `VoiceService.setPublishSources` that sets LiveKit sources per player. The old `holder`/`room:live` path, `MIC_AND_CAMERA`, `stage.ts` and `ScreenStage.tsx` keep working unchanged. Age lanes reuse minors' rooms: a game room is a parent with two child lane rooms; the teen lane is a minors' room.

**Tech Stack:** TypeScript, Express + `ws`, Drizzle/Postgres, LiveKit (`livekit-server-sdk` 2.x, `livekit-client` 2.x), React + Vite, existing `scripts/test-rooms-*.ts` suites.

**Spec:** `docs/superpowers/specs/2026-10-21-rooms-gaming-design.md`. Visual reference: `docs/design/rooms-2026-10/gamer-rooms-mockup.html`.

## Global Constraints

- Flag `ROOMS_GAMING`, default OFF; only exactly `"1"`/`"true"` turn it on (same as `parseFlag`). Flag off: no new route, WS message or UI is reachable and every existing payload is byte-identical.
- Migrations are additive and idempotent (`IF NOT EXISTS`, nullable or defaulted), one `BEGIN/COMMIT` file, and are **applied to the real DB in the same task** by the orchestrator (agents propose SQL, never apply). Run with `node --env-file=.env scripts/run-room-peak-migration.mjs <file>.sql` (the script takes a file argument).
- Stage cap `MAX_SPEAKERS = 6` is unchanged; players do not count toward it. Max players: 8 (4 per team). Max tiles on screen: 4. Viewer cap: `ROOM_LIMITS.liveVideoMax` = 50.
- Drop timeout choices: 30 000 ms, 120 000 ms (default, = `LIVE_HOLD_MS`), 0 (hold slot).
- Quality profiles: Light 540p30, Smooth 720p60, Sharp 1080p30; game video uses `contentHint = "motion"`.
- Sources a player may publish: `screen_share` and `screen_share_audio` only. Never microphone or camera for a player. Stream keys never appear in logs, `room:state` or any broadcast.
- New tests go in new `scripts/test-rooms-<kind>-game*.ts` files (the runner picks up every `test-rooms-<kind>*.ts`). Write tests with the code. Per owner rule (2026-10-18) do not run suites per task; run only the single file you changed through `scripts/run-one-room-test.mjs --reuse` if the owner has lifted the rule, otherwise leave everything to the Task 12 gate and report "not run".
- Two persistent agents only (backend, frontend); the orchestrator merges and owns DB and schema. Keep briefs short and point at files.
- Railway rule: `npm run build` locally before any push; every imported file must exist.
- Colours, type and spacing follow `DESIGN.md` (OLED dark, single violet accent, Bodoni only for display, Jost for UI, 44 px touch targets, `prefers-reduced-motion` respected).

## Review Focus

Failure modes the spec implies that no feature task's happy path covers (each has its test in the named task):

1. A player clicks the browser's own "Stop sharing" bar: the track ends but the server still thinks they are live (Task 6, Task 3).
2. Cross-lane leaks: member counts, chat, spray notices, room list, notifications, profile peek, report excerpts crossing between 13-17 and 18+ (Task 9).
3. Host removes or bans a player mid-match: LiveKit screen source removed, feed stops, team spray excludes them, their stream key is revoked (Task 3, Task 10, Task 11).
4. A viewer on a weak or data-saver connection must not subscribe to eight feeds; default is the featured feed only, sound-only option still works (Task 6).
5. The same account sharing from two devices, or a stale client sending `room:game` after the flag was turned off (Task 3).

---

## File Structure

Create: `shared/gameScreen.ts` (rules), `server/rooms/game.ts` (handler, reconcile, sweep hook), `server/rooms/gameLanes.ts` (lane routing), `server/rooms/gameIngress.ts` (OBS keys), `client/src/lib/gameScreen.ts` (view helpers), `client/src/hooks/useGameTracks.ts`, `client/src/components/rooms/game/{GameStage,TeamLane,GameTile,GameConsole,GoLiveGameSheet,SprayTeamSheet}.tsx`, `migrations/add_rooms_game.sql`, `scripts/test-rooms-{unit,api,ws}-game*.ts`.
Modify (small, additive hooks only): `server/rooms/features.ts`, `server/rooms/RoomHub.ts`, `server/rooms/roomSocket.ts`, `server/rooms/stage.ts` (sweep + reconcile call), `server/rooms/voice/{voiceService,livekitVoice,fakeVoice}.ts`, `server/rooms/spray.ts` (recipient check), `shared/schema.ts`, `shared/rooms.ts`, `client/src/lib/roomReducer.ts`, `client/src/hooks/useRoomSocket.ts`, `client/src/hooks/useRoomVoice.ts`, `client/src/lib/bandwidth.ts`, `client/src/components/rooms/shell/RoomShell.tsx`, `client/src/components/rooms/create/*` (one toggle), `client/src/pages/dev/RoomFixture.tsx`.

---

### Task 0: Branch, flag, schema

**Files:** Modify `server/rooms/features.ts`, `shared/schema.ts` (rooms table ~line 1123), `GET /api/rooms/config` handler in `server/rooms/roomRoutes.ts`; Create `migrations/add_rooms_game.sql`, `scripts/test-rooms-unit-game-flags.ts`.

**Interfaces:**
- Produces: `roomFeatures.gaming: boolean`; `RoomFeatures` gains `gaming`; config response gains `features.gaming`; `rooms` columns `gameFormat: number | null` (1-4 per side), `gameDropTimeoutMs: number` (default 120000), `ageLane: "teen" | "adult" | null`, `parentRoomId` (same type as `rooms.id`, nullable, `ON DELETE RESTRICT`).

- [ ] **Step 1:** From the branch the owner names, create `feat/rooms-gaming`. Work in two worktrees (backend, frontend); unlink `node_modules` junctions before `git worktree remove`.
- [ ] **Step 2:** Write failing test `scripts/test-rooms-unit-game-flags.ts`: `loadRoomFeatures({})` has `gaming === false`; `{ROOMS_GAMING:"1"}` and `"true"` give `true`; `"yes"` and `""` give `false`.
- [ ] **Step 3:** Implement `gaming` in `DEFAULT_ROOM_FEATURES`, `RoomFeatures` and `loadRoomFeatures` (`parseFlag(env.ROOMS_GAMING, false)`), and expose it in the config route.
- [ ] **Step 4:** Write `migrations/add_rooms_game.sql` with four `ADD COLUMN IF NOT EXISTS` statements (read `rooms.id`'s type in `shared/schema.ts` and match it for `parent_room_id`), add the Drizzle columns, and a partial index on `parent_room_id`.
- [ ] **Step 5 (orchestrator):** apply the migration to the real DB with the runner and confirm `\d rooms` shows the columns. A purely additive migration needs no extra confirmation. Do not report this task done until applied.
- [ ] **Step 6:** Commit `feat(rooms-gaming): flag and additive schema`.

---

### Task 1: Game rules (pure)

**Files:** Create `shared/gameScreen.ts`, `scripts/test-rooms-unit-game.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type Side = "A" | "B";
  export interface GameState { format: 1|2|3|4; teams: Record<Side,string[]>; featured: Record<Side,string|null>; asks: Array<{ userId: string; side: Side }>; score: [number, number] }
  export type GameAction = "ask"|"withdraw"|"accept"|"decline"|"remove"|"feature"|"score"|"format";
  export type GameError = "GAME_OFF"|"NOT_ON_STAGE"|"NOT_ALLOWED"|"TEEN_RULE"|"NOT_PRESENT"|"TEAM_FULL"|"NO_CHANGE"|"BAD_VALUE";
  export const emptyGame: GameState
  export function applyGame(state: GameState, action: GameAction, c: GameContext): { ok: true; state: GameState } | { ok: false; code: GameError }
  export function dropFromGame(state: GameState, userId: string): GameState
  export function splitShares(amountKobo: number, memberIds: string[], featuredId: string | null): Record<string, number>
  export const DROP_TIMEOUTS_MS: readonly [30_000, 120_000, 0]
  ```
  `GameContext` carries `actorId`, `actorRole` (`"host"|"cohost"|"guest"`), `targetId`, `targetPresent`, `targetEligible` (= `canBeOnStage`), `gameOn`, `side?`, `value?`.

- [ ] **Step 1:** Write failing tests (as `ok`/`code` assertions): ask with `gameOn=false` -> `GAME_OFF`; ask while eligible false -> `TEEN_RULE`; accept by a guest -> `NOT_ALLOWED`; accept into a full team (`format` players already) -> `TEAM_FULL`; accept puts the player in the team and removes their ask; first player of a side becomes `featured`; `feature` of a non-member -> `NOT_PRESENT`; `remove` of the featured player moves `featured` to the next member or `null`; `score` value below 0 or non-integer -> `BAD_VALUE`; `format` smaller than a team's current size -> `TEAM_FULL`; `dropFromGame` clears membership, ask and featured; `splitShares(1000, ["a","b","c"], "b")` -> `{a:333,b:334,c:333}`, sums to the amount, and an empty member list returns `{}`.
- [ ] **Step 2:** Implement per the signatures above; pure, no imports from the server. Splitting: `floor(amount/n)` each, remainder to `featuredId` if present, else the first id.
- [ ] **Step 3:** Commit `feat(rooms-gaming): game rules`.

---

### Task 2: LiveKit per-player sources

**Files:** Modify `server/rooms/voice/voiceService.ts`, `livekitVoice.ts`, `fakeVoice.ts`; Create `scripts/test-rooms-unit-game-voice.ts`.

**Interfaces:**
- Produces: `export type PublishSource = "microphone"|"camera"|"screen_share"|"screen_share_audio"`; `VoiceService.setPublishSources(roomId: string, userId: string, sources: PublishSource[]): Promise<void>` (empty array = cannot publish); `listParticipants` rows gain optional `sources?: PublishSource[]` (granted) and `publishing?: PublishSource[]` (tracks live now). Existing methods and the `MIC_ONLY`/`MIC_AND_CAMERA` constants are unchanged.
- Consumes: `TrackSource.SCREEN_SHARE`, `TrackSource.SCREEN_SHARE_AUDIO` from `livekit-server-sdk`.

- [ ] **Step 1:** Write failing test against `FakeVoice`: after `setPublishSources("r","u",["screen_share","screen_share_audio"])`, `listParticipants("r")` returns `u` with exactly those `sources`; `[]` leaves `canPublish` false; the legacy `setCanPublish` behaviour is unchanged (existing voice tests stay green).
- [ ] **Step 2:** Implement in `LiveKitVoice` using `updateParticipant(..., { canPublish: sources.length > 0, canPublishSources: mapped })`, ignoring 404 like the other methods; implement in `FakeVoice` by recording sources.
- [ ] **Step 3:** Commit `feat(rooms-gaming): per-player publish sources`.

---

### Task 3: Server game state, handler, sweep

**Files:** Create `server/rooms/game.ts`, `scripts/test-rooms-ws-game.ts`; Modify `RoomHub.ts`, `roomSocket.ts`, `stage.ts`, `shared/rooms.ts`.

**Interfaces:**
- Consumes: Task 0 flag/columns, Task 1 rules, Task 2 `setPublishSources`, `canBeOnStage`, `withRoomLock` (export it from `stage.ts`; do not copy it).
- Produces: `RoomHub.gameOf(roomId): GameState`, `setGame(roomId, s)`, `gameOn(roomId): boolean`, `setGameOn(roomId, on)` (cleared in the same two places `lives` is cleared); `handleGame(userId: string, roomId: string, msg: unknown): Promise<{ ok: true } | { ok: false; code: string }>`; `broadcastGame(roomId)`; `reconcileGame(roomId)`; `sweepGame(roomId)` called from `sweepVoice`. WS in: `{type:"room:game", action: GameAction, targetId?: string, side?: "A"|"B", value?: number}`. WS out: `{type:"room:game", game: GameView}` where `GameView = GameState & { away: Record<string, number | null> }` (epoch ms when a dropped player's slot is released, `null` = present or held). `room:state` gains `game?: GameView` only when the flag is on.

- [ ] **Step 1:** Write failing WS tests (with `FakeVoice`): flag off -> `room:game` is refused `FEATURE_OFF` and `room:state` has no `game` key; host accepts an asker -> that user gets sources `["screen_share","screen_share_audio"]` and not the microphone; accepting a 5th player into a 4-player team -> notice `TEAM_FULL`; a guest cannot `accept`; a non-stage user cannot `ask`; host `remove` strips sources and `broadcastGame` shows them gone; leaving, kick, ban and an adult arriving (teen rule) all drop the player; **Review Focus 1/3/5:** a client sending `room:game {action:"remove", targetId:self}` after its own track ended (`player:ended`) releases the slot, and a second socket for the same user cannot add a second slot; the legacy `room:live` flow and payload are unchanged (snapshot assertion on `broadcastLive`).
- [ ] **Step 2:** Implement `handleGame` under `withRoomLock`: update memory, broadcast, then tell LiveKit, then write DB (same discipline as `stage.ts`). Players are added to `roomHub.stageOf(roomId).stage` (not mic-enabled, not counted against `MAX_SPEAKERS`) so the existing spray recipient rule recognises them; keep that stage entry in sync on add/remove.
- [ ] **Step 3:** Drops: reuse `tuning.liveGraceMs` logic in `roomSocket.ts` close handler: a player's disconnect sets `member.away = { until: now + room.gameDropTimeoutMs }` (no timer when the setting is 0); on expiry the releaser removes them and the room receives a system chat line `"<name> has dropped out"` through the existing chat broadcast path; a reconnect before expiry clears `away` and posts `"<name> is back"`.
- [ ] **Step 4:** Extend `sweepVoice` so any participant publishing `screen_share*` who is not a current player gets the sources removed.
- [ ] **Step 5:** Commit `feat(rooms-gaming): game state, handler, drops`.

---

### Task 4: Spray recipients include players

**Files:** Modify `server/rooms/spray.ts` (the `onStage` computation near line 180); Create `scripts/test-rooms-ws-game-spray.ts`.

**Interfaces:** Consumes `roomHub.gameOf(roomId).teams`. Produces: a player in `gameOf(roomId)` counts as on stage for `sprayGate`; nothing else about the spray path changes.

- [ ] **Step 1:** Write failing test: with the flag on and a player on a team, `sprayGate(roomId, payerId, playerId, "start")` is eligible; the same player after `remove` -> the standard single ineligible answer (no oracle: identical shape to every other failure); with the flag off the result equals today's.
- [ ] **Step 2:** One-line change: `onStage` also true when `roomFeatures.gaming && memberOfGame(roomId, recipientId)`. No other edit to the money path.
- [ ] **Step 3:** Commit `feat(rooms-gaming): players are spray recipients`.

---

### Task 5: Client state and socket

**Files:** Modify `client/src/lib/roomReducer.ts`, `client/src/hooks/useRoomSocket.ts`, `shared/rooms.ts`; Create `client/src/lib/gameScreen.ts`, `scripts/test-rooms-unit-game-client.ts`.

**Interfaces:**
- Produces: `RoomUiState.game: GameView | null` (default `null`); reducer case `"room:game"`; `useRoomSocket` returns `gameAction(action, extra?)`; `gameScreen.ts`: `membersOf(game, side)`, `featuredFor(game, side, follow: Partial<Record<Side,string>>): string | null` (viewer follow beats host pick if that player is still a member), `statusOf(game, userId, now): "live"|"reconnecting"|"out"`, `countdownMs(game, userId, now): number | null`.

- [ ] **Step 1:** Write failing tests: reducer ignores `room:game` when `game` is absent; applies a view; `featuredFor` returns the host pick, then the follow, then falls back to the first member when the followed player left; `countdownMs` returns `null` for a hold-slot room.
- [ ] **Step 2:** Implement the above; no component work yet.
- [ ] **Step 3:** Commit `feat(rooms-gaming): client game state`.

---

### Task 6: Client media (capture, profiles, subscriptions)

**Files:** Modify `client/src/lib/bandwidth.ts`, `client/src/hooks/useRoomVoice.ts` (expose the LiveKit `Room`); Create `client/src/hooks/useGameTracks.ts`, `scripts/test-rooms-unit-game-media.ts`.

**Interfaces:**
- Produces: `GameProfile = "light"|"smooth"|"sharp"`; `gameProfileSettings(p): { width; height; frameRate; maxBitrate }` (light 960x540@30, smooth 1280x720@60, sharp 1920x1080@30); `viewerLayer(tileWidthPx: number): 720|360|180` (>=560 -> 720, >=250 -> 360, else 180); `useGameTracks(room: Room | null, game: GameView | null, opts: { audioOnly: boolean })` returns `{ startShare(profile: GameProfile): Promise<void>; stopShare(): void; shareError: string | null; trackFor(userId: string): ScreenTrack | null; follow(side, userId): void; following: Partial<Record<Side,string>> }`.

- [ ] **Step 1:** Write failing tests: `viewerLayer(559)` is 360 and `viewerLayer(560)` is 720; `gameProfileSettings("smooth")` has `frameRate: 60`; **Review Focus 4:** with `audioOnly: true` or `saveData`, no video track is subscribed and only the featured feed's audio is; at most 4 video subscriptions at any time, never 8.
- [ ] **Step 2:** Implement `startShare` with `getDisplayMedia({ video: gameProfileSettings(p), audio: true })`, `videoTrack.contentHint = "motion"`, publish through `localParticipant.publishTrack` with `Track.Source.ScreenShare` (and `ScreenShareAudio`), simulcast of two layers only. **Review Focus 1:** when the captured track fires `ended` (browser "Stop sharing"), call `stopShare()` and send `room:game {action:"remove", targetId: self}`.
- [ ] **Step 3:** Subscriptions: set `setSubscribed` only for the featured feed per team plus visible thumbnails; thumbnails request the 180p layer; only the featured feed's audio is attached and unmuted; offscreen/hidden tiles unsubscribe.
- [ ] **Step 4:** Commit `feat(rooms-gaming): game capture and subscriptions`.

---

### Task 7: Game stage UI

**Files:** Create `client/src/components/rooms/game/{GameStage,TeamLane,GameTile}.tsx`; Modify `RoomShell.tsx` (render `GameStage` instead of `ScreenStage` only when `roomFeatures.gaming && state.game`), `client/src/pages/dev/RoomFixture.tsx` (scenes `?game=versus|team|drop|teen`), `scripts/test-rooms-unit-game-ui.ts`.

**Interfaces:** Consumes Tasks 5-6. `GameStage` props: `{ game: GameView; tracks: ReturnType<typeof useGameTracks>; me: string; onSpray(playerId: string): void; onSprayTeam(side: Side): void; layout: "versus"|"grid"|"spot"|"team" }`.

- [ ] **Step 1:** Write failing UI-logic tests on the pure helpers the components use (layout choice for a given `GameView` and container width; which tiles are thumbnails; the status text: `"Reconnecting… 0:24"`, `"Reconnecting…"` for hold, `"Dropped out"`).
- [ ] **Step 2:** Build the components to the mockup: team lanes with one featured tile and thumbnail roster, score banner, support bar, per-tile spray button, `Follow` on thumbnail tap with a "back to host pick" chip, status overlay on dropped players, `aria-label`s on every control, 44 px targets, tiles at `aspect-ratio: 16/9`, container queries (not viewport) for the phone/desktop switch, `prefers-reduced-motion` honoured for spray animations. Use `transform`/`opacity` only; cap simultaneous spray note elements at 70.
- [ ] **Step 3:** Immersive/phone: reuse the immersive rail pattern only for the featured feed; thumbnails stay in the stage. Do not touch `ScreenStage.tsx`.
- [ ] **Step 4:** Commit `feat(rooms-gaming): game stage UI`.

---

### Task 8: Host console, go-live sheet, create toggle

**Files:** Create `client/src/components/rooms/game/{GameConsole,GoLiveGameSheet}.tsx`; Modify `client/src/components/rooms/host/ControlsSheet.tsx` (one tab), `client/src/components/rooms/create/StepFeatures.tsx` (game format selector, shown only when the flag is on), `server/rooms/roomRoutes.ts` (create/PATCH accept `gameFormat`, `gameDropTimeoutMs` validated against `DROP_TIMEOUTS_MS`), `scripts/test-rooms-api-game.ts`.

**Interfaces:** Produces API: `POST/PATCH /api/rooms` accept `gameFormat?: 1|2|3|4|null` and `gameDropTimeoutMs?: 30000|120000|0`; anything else -> 400 `{ field, reason }`; `liveVideo` must also be on (and `voiceEnabled`) or `gameFormat` returns 400 `reason: "needs_live_video"`.

- [ ] **Step 1:** Write failing API tests: valid/invalid `gameFormat` and timeout values; flag off ignores the fields; `gameFormat` without live video is refused; `GET` carries both fields.
- [ ] **Step 2:** Implement routes and the console: layout, per-team roster with Feature / Remove, requests with Accept/Decline (Accept disabled when the team is full), score steppers, drop-timeout choice, quality cap. The go-live sheet offers "Share a game window" and, once Task 10 lands, "Stream with OBS"; "Phone" is shown disabled ("arrives with the Vib3 app"); it states "Share the game, not your whole screen" and "share game sound only".
- [ ] **Step 3:** Commit `feat(rooms-gaming): host console and go-live`.

---

### Task 9: Age lanes

**Files:** Create `server/rooms/gameLanes.ts`, `scripts/test-rooms-api-game-lanes.ts`, `scripts/test-rooms-ws-game-lanes.ts`; Modify `roomRoutes.ts`, `roomSocket.ts` (join path), `roomStorage.ts`, the Rooms home list query.

**Interfaces:**
- Produces: `laneForAge(age: number | null): "teen" | "adult" | null` (13-17 teen, 18+ adult, otherwise null = refused); `resolveLaneRoom(parentId: string, userId: string): Promise<{ roomId: string } | { refused: "NO_AGE" | "TOO_YOUNG" | "NO_LANE" }>`; creating a game room creates the parent and both child rooms in one transaction (teen child `minors_room = true`); the parent is never joinable, it only routes.

- [ ] **Step 1:** Write failing tests (**Review Focus 2**): a 16-year-old and a 30-year-old joining the same parent land in different child rooms; neither's chat, member list, count, spray receipt, reminder notification, profile peek or report excerpt ever carries the other lane's data; an adult cannot join the teen child by id or link (existing `MINORS_ROOM` refusal); the Rooms list shows the parent once; a user without a date of birth is refused (`NO_AGE`); an admin DOB correction moves a live user out of a now-wrong lane (reuse `RoomHub.refreshAge` eviction).
- [ ] **Step 2:** Implement routing at the door, before anything else about the room is revealed; lane comes only from the server's stored date of birth. Per-lane counts replace the combined count on every payload.
- [ ] **Step 3:** Owner decision (2026-10-22): the teen lane's host is a teen. Creation of the teen child is refused with `reason: "teen_host_required"` when the creator is 18+. Adults reach the teen lane only through the existing minors'-room path (personal invite + acknowledged warning, `MinorsRoomWarning`); the warning copy must say the adult is entering a room with a minor or minors and that misconduct is recorded and investigated (legal wording to be checked by the lawyer). An invited adult may be a game player (screen only, no mic), so game eligibility is its own check (`canPlayGame`), not `canBeOnStage`. Test: invited, acknowledged adult can be accepted as a player in the teen lane; an uninvited adult cannot enter at all.
- [ ] **Step 4:** Commit `feat(rooms-gaming): age lanes`.

---

### Task 10: OBS / RTMP ingest

**Files:** Create `server/rooms/gameIngress.ts`, `scripts/test-rooms-api-game-ingress.ts`; Modify `voiceService.ts` (+ Fake), `roomRoutes.ts`, `GoLiveGameSheet.tsx`.

**Interfaces:**
- Produces: `VoiceService.createIngress(roomId: string, userId: string): Promise<{ ingressId: string; url: string; streamKey: string }>` and `deleteIngress(ingressId: string): Promise<void>`; `POST /api/rooms/:id/game/ingress` (a player, or a user the host just accepted, receives their own key); the ingress participant identity is the user id, with only screen sources allowed.

- [ ] **Step 1:** Write failing tests: only an accepted player gets a key; a second call returns the same ingress (idempotent) not a new one; the key is absent from `room:state`, WS broadcasts and server logs (assert on captured console output); removal, leaving, ban, and room end all call `deleteIngress`; a non-player gets 403 with the same shape as other refusals.
- [ ] **Step 2:** Implement against LiveKit Ingress (`IngressClient.createIngress`) behind `LIVEKIT_INGRESS=1`; with it off, the sheet hides the OBS option. Store only `ingressId` (never the key) in memory next to the hub entry.
- [ ] **Step 3:** Commit `feat(rooms-gaming): OBS ingest`.

---

### Task 11: Team spray (gated)

**Owner decision (2026-10-22):** team minimum = 500 NGN x players on the team; equal split; only tiers at or above the minimum are offered (team of 3 = 1,500, so the 1,000 tier is not offered). Still to confirm with Paystack test keys: fan-out to several recipient subaccounts and refund of a batch. Build against the mock provider and list it as unverified.

**Files:** Create `client/src/components/rooms/game/SprayTeamSheet.tsx`; Modify `server/rooms/spray.ts`, `sprayRoutes.ts`; tests `scripts/test-rooms-{unit,ws}-game-teamspray.ts`.

**Interfaces:** Consumes `splitShares` (Task 1). Produces (after the decision): a team spray is one payer charge that becomes one spray record per share with a shared batch id, so a refund or clawback acts on the whole batch; the tray shows the share per player before the throw.

- [ ] **Step 1:** After the decision, write failing tests for: shares sum to the charged amount to the kobo; a player who dropped out mid-throw is excluded and their share goes to the featured player; a single failed leg refunds the whole batch; the minimum-charge rule from `shared/money.ts` holds per the owner's answer.
- [ ] **Step 2:** Implement and commit `feat(rooms-gaming): team spray`.

---

### Task 12: Verification and rollout

- [ ] **Step 1 (orchestrator, the one full test):** `npm run test:rooms`, `npx tsc` (baseline 10 errors, no new ones), `npm run build`, dev-fixture bundle grep (`/dev/room-fixture` and the game fixture scenes absent from the production bundle).
- [ ] **Step 2:** Browser pass with Chromium fake media (`--use-fake-ui-for-media-stream`, `--auto-select-desktop-capture-source=Entire screen`): two to four sessions, 2v2 and spotlight, spray on a player, drop and return, Stop-sharing bar, desktop and 375 px, teen and adult sessions side by side.
- [ ] **Step 3:** Confirm flag-off parity: with `ROOMS_GAMING` unset, snapshot `room:state`, `room:live` and the create-room payload against the pre-branch values.
- [ ] **Step 4:** Rollout: ship with the flag off; turn on for one test room; rollback is turning the flag off (columns stay, unused). Unverified here, owner to test: real consoles and capture cards, OBS from a real PC, real phones and iOS Safari, real network quality, real `getDisplayMedia` picker behaviour.
- [ ] **Step 5:** Update the memory index and the handover note.

---

## Self-review notes

- Spec coverage: pipeline and sources (Tasks 2, 6, 10); 8 players / 4 tiles / featured + follow (Tasks 1, 5, 6, 7); audio rule (Task 6); player and team spray (Tasks 4, 11); age lanes (Task 9); drops (Task 3); quality (Task 6); flag and additive schema (Task 0); stream-key secrecy (Task 10).
- Type names are used consistently: `GameState`/`GameView`, `applyGame`, `dropFromGame`, `splitShares`, `setPublishSources`, `viewerLayer`, `useGameTracks`.
- The four open decisions were answered 2026-10-22 and are in the spec: teen lane hosted by a teen with an invite-and-warning path for adults, team spray minimum 500 x players, mixed-age teams allowed via the invite path, spectator delay deferred. Paystack fan-out and batch refund remain unverified until test keys exist.
- `Task 1` rule `canPlayGame` replaces the plan's use of `canBeOnStage` for players (an invited adult may play in a teen lane); `GameContext.targetEligible` is computed by it.
