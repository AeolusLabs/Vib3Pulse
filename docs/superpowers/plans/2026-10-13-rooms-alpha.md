# Rooms Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can host and join virtual rooms: an avatar scene with a shared screen, chat, reactions, follow-gated avatar interactions, per-user room privacy, and an age bouncer.

**Architecture:** Durable room data in Postgres; live presence in memory behind a `RoomHub` driven from the existing `/ws` server; all rules (age, interaction, join, hosting, screen parsing) are pure functions in `shared/` so server, WebSocket handlers and client agree. The client room page renders the existing `Avatar` component on a 2D scene.

**Tech Stack:** TypeScript, Drizzle + Postgres, Express, `ws`, React 18, wouter, TanStack Query; test scripts via `tsx` and `node:assert` (pattern: `scripts/test-avatar*.ts`, runner `scripts/run-avatar-tests.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-13-rooms-alpha-design.md` (decisions and market context: `docs/superpowers/specs/2026-10-13-rooms-roadmap.md`).

## Global Constraints

- Platform minimum age is 13. Room age limits are exactly `all` (means 13+), `13+`, `16+`, `18+`, `21+`. Age bands: 13 to 17 is `teen`, 18 and over is `adult`. Unknown age (`null`) can enter no room.
- Birthdate is locked once set: no self-edit through profile PATCH or the Edit Profile dialog; changes only through an admin route that writes an audit entry.
- Under-18s: cannot host `public` rooms, never listed as public hosts. Interactions (wave, private reaction, DM, invite) only between users in the same band.
- Capacity default 50, maximum 100 (both constants in `ROOM_LIMITS`; an admin-config key is a later addition). One live room per host; at most 10 scheduled rooms per host.
- Default `room_privacy.interactions` is `mutuals`. Blocks enforced both ways (`isBlockedEitherWay`, `blockedWith` in `server/utils/blocks.ts`).
- Chat text 1..300 chars; reactions from a fixed set; rate limits: chat 1/s burst 5, reactions 3/s, interactions 1 per 2 s per target.
- Screens: only allow-listed providers get an iframe (YouTube, Vimeo, Spotify, Apple Music, SoundCloud); everything else is a link card; all outbound links `rel="noopener noreferrer"`. Nothing is recorded or relayed.
- Schema changes are applied to the production database in the same task that adds them (additive/nullable/defaulted), then verified. `ensureSchema()` in `server/storage.ts` also gets the `ALTER`s.
- Never respond before an `req.login()`/session callback completes. Never leak sensitive user fields: route user rows through `toPublicUser()`.
- Commit only when the user asks; stage by name; never push without being asked; run `npm run build` before any push.
- Interactive controls: `button` with `aria-pressed`/labels, 44px targets, visible focus, `prefers-reduced-motion` respected, chat is an `aria-live` region.

## Review Focus

- A banned, kicked, under-age or blocked user can never re-enter by reconnecting, using an invite link, or calling REST directly. (Tasks 6, 7, 8)
- The server re-checks every interaction; a client that skips the slide-out checks gets rejected. (Tasks 4, 7)
- A teenager cannot be reached by an adult through any room feature (wave, DM, invite), and cannot appear as a public host. (Tasks 4, 5, 6, 7)
- A hostile screen URL (javascript:, data:, lookalike hosts such as `youtube.com.evil.test`, iframe-able arbitrary pages) never becomes an iframe. (Task 3)
- Host crash or disconnect never leaves a zombie live room or ghost members; two tabs by one user do not double-count. (Task 7)

## File Structure

- Create `shared/age.ts`, `shared/rooms.ts`, `shared/screen.ts`, `shared/roomRules.ts`.
- Create `server/rooms/roomStorage.ts`, `server/rooms/roomRoutes.ts`, `server/rooms/RoomHub.ts`, `server/rooms/roomSocket.ts`, `server/rooms/rateLimit.ts`.
- Modify `shared/schema.ts` (tables, `users.roomPrivacy`, notification type), `server/storage.ts` (`ensureSchema`), `server/websocket.ts`, `server/index.ts` (register routes), `server/routes/users-routes.ts` (signup min age, DOB lock), `server/admin-routes.ts` (DOB correction, room admin), `server/services/eventAbuse.ts` (re-export `ageFromDob`).
- Client: `client/src/providers/WebSocketProvider.tsx` (expose `send` and `subscribe`), `client/src/hooks/useRoomSocket.ts`, `client/src/pages/RoomsPage.tsx`, `client/src/pages/RoomPage.tsx`, `client/src/components/rooms/{CreateRoomDialog,RoomScene,RoomScreen,RoomChat,AvatarActionsSheet,MemberListSheet,HostControls}.tsx`, `client/src/components/RoomPrivacyCard.tsx`.
- Modify client: `client/src/App.tsx`, `Navigation.tsx`/`BottomNavigation.tsx`, `AccountSettingsPage.tsx`, `EditProfileDialog.tsx`, `SignupPage.tsx`, `EventDetailPage.tsx`, `VenueDetailPage.tsx`.
- Tests: `scripts/test-rooms-unit.ts`, `scripts/test-rooms-api.ts`, `scripts/test-rooms-ws.ts`, runner `scripts/run-rooms-tests.mjs` (`npm run test:rooms`), migration `migrations/add_rooms.sql`.

---

### Task 1: Age module and minimum age at signup

**Files:**
- Create: `shared/age.ts`
- Modify: `server/services/eventAbuse.ts` (re-export `ageFromDob` from `shared/age`), `server/routes/users-routes.ts` (signup at `/api/auth/signup` and `completeProfileSchema`), `client/src/pages/SignupPage.tsx`, `client/src/pages/CompleteProfilePage.tsx`
- Test: `scripts/test-rooms-unit.ts` (created here, extended later)

**Interfaces:**
- Produces in `shared/age.ts`: `MIN_PLATFORM_AGE = 13`; `type AgeLimit = "all"|"13+"|"16+"|"18+"|"21+"`; `AGE_LIMITS: readonly AgeLimit[]`; `type AgeBand = "teen"|"adult"`; `ageFromDob(dob: string|null|undefined, now?: Date): number|null` (same behavior as today's function); `ageBand(age: number|null): AgeBand|null` (13..17 teen, 18+ adult, else null); `minAgeForLimit(l: AgeLimit): number` (`all`→13); `meetsAgeLimit(age: number|null, l: AgeLimit): boolean`; `sameBand(a: number|null, b: number|null): boolean` (false if either null).

- [ ] **Step 1: Write failing unit tests** in `scripts/test-rooms-unit.ts` using `node:assert/strict`: `ageFromDob` (birthday today, day before, invalid strings, null); `ageBand` at 12, 13, 17, 18, null; `meetsAgeLimit` for each limit at ages 12, 13, 15, 16, 17, 18, 20, 21 and null (always false); `sameBand(17,18)` false, `(13,17)` true, `(18,40)` true, `(null,18)` false.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `shared/age.ts`** per Interfaces; make `server/services/eventAbuse.ts` import and re-export `ageFromDob` and keep `minAgeFor` unchanged so social-event tests still pass.
- [ ] **Step 4: Write failing API tests** (extend `scripts/test-avatar-api.ts` pattern in a new `scripts/test-rooms-api.ts` skeleton with the same in-process app helper): `POST /api/auth/signup` with a DOB making the user 12 returns 400 with a message naming the minimum age; age exactly 13 today is accepted; Google `completeProfile` with a 12-year-old DOB returns 400. Run, expect FAIL.
- [ ] **Step 5: Enforce** the minimum age in the signup zod schema and in `completeProfileSchema` (server) using `ageFromDob`/`MIN_PLATFORM_AGE`, and mirror the rule in the client schemas with a clear message ("You must be at least 13 to use Vib3Pulse").
- [ ] **Step 6: Run** `npx tsx scripts/test-rooms-unit.ts` and the API script via the runner (Task 2 creates it; until then run with a scratch DB as `scripts/run-avatar-tests.mjs` does). Expected: all pass; `npx tsc --noEmit` error count unchanged (10 baseline).

---

### Task 2: Birthdate lock and test runner

**Files:**
- Modify: `server/routes/users-routes.ts` (profile PATCH strips `dateOfBirth` when one is already stored), `server/admin-routes.ts` (new `PUT /api/admin/users/:id/date-of-birth` with audit via `storage.logAdminActivity`), `client/src/components/EditProfileDialog.tsx` (DOB read-only when set)
- Create: `scripts/run-rooms-tests.mjs`, package script `test:rooms`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Consumes: `ageFromDob`, `MIN_PLATFORM_AGE` (Task 1).
- Produces: profile PATCH ignores `dateOfBirth` when the user already has one (first-time set still allowed); admin route body `{ dateOfBirth: string, reason: string }`, requires an admin with the existing user-management permission, validates min age, writes audit row `{action:"user.dob_corrected"}`, returns the updated public user.

- [ ] **Step 1: Write failing API tests**: PATCH `/api/users/me` with a new `dateOfBirth` for a user who has one leaves it unchanged and still saves other fields (200); a user with no DOB can set it once; admin route without admin session is 401/403; with admin session it changes the DOB, requires `reason`, rejects under-13, and writes an audit row.
- [ ] **Step 2: Run** via the runner; expected FAIL.
- [ ] **Step 3: Implement** the PATCH guard (`delete updates.dateOfBirth` when stored value exists), the admin route, and make the DOB input in `EditProfileDialog` `disabled` with helper text "Your birthdate is locked. Contact support to correct it." when `user.dateOfBirth` is set.
- [ ] **Step 4: Create `scripts/run-rooms-tests.mjs`** by copying `scripts/run-avatar-tests.mjs` (scratch DB `vib3_rooms_test_<hex>`, drop pattern guard, unit file `scripts/test-rooms-unit.ts`, API files `scripts/test-rooms-api.ts` and `scripts/test-rooms-ws.ts` when present) and add `"test:rooms": "node --env-file=.env scripts/run-rooms-tests.mjs"`.
- [ ] **Step 5: Run** `npm run test:rooms`. Expected: ALL GREEN.

---

### Task 3: Screen resolver

**Files:**
- Create: `shared/screen.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces: `type ScreenProvider = "youtube"|"vimeo"|"spotify"|"apple_music"|"soundcloud"|"image"|"link"`; `interface Screen { v: 1; provider: ScreenProvider; kind: "video"|"audio"|"image"|"link"; url: string; embedUrl?: string; openUrl: string; title?: string; thumb?: string }`; `resolveScreen(input: string): { ok: true; screen: Screen } | { ok: false; reason: "invalid_url"|"unsafe_scheme"|"too_long" }` (pure, no network); `screenFromStored(input: unknown): Screen | null` (re-validates a stored value, never throws).
- Rules: only `https:`; trim; max 2048 chars. YouTube: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`, `music.youtube.com/watch?v=` → `https://www.youtube-nocookie.com/embed/<id>`; Vimeo `vimeo.com/<id>` → `https://player.vimeo.com/video/<id>`; Spotify `open.spotify.com/(track|album|playlist|episode|show|artist)/<id>` (optional `intl-xx/` prefix) → `https://open.spotify.com/embed/<type>/<id>`; Apple Music `music.apple.com/<cc>/(album|song|playlist)/...` → host replaced with `embed.music.apple.com`; SoundCloud `soundcloud.com/<artist>/<track>` → `https://w.soundcloud.com/player/?url=<encoded>`; image: `https` URL ending `.png|.jpg|.jpeg|.webp|.gif` or a path under our media route (`/api/media/`) → provider `image`; everything else valid https → `link` (no `embedUrl`). Host matching is exact or true subdomain (`www.`, `m.`), never substring.

- [ ] **Step 1: Write failing tests** with the spec's exact values: each provider URL form above yields the stated `embedUrl`; `javascript:alert(1)`, `data:text/html,...`, `http://youtube.com/watch?v=x`, `https://youtube.com.evil.test/watch?v=abcdefghijk`, `https://evil.test/?u=https://youtube.com/watch?v=x`, 3000-char URLs are rejected or become `link` with no `embedUrl` as specified; a random `https://example.com/page` is `link`; `screenFromStored("junk")` and `screenFromStored({provider:"youtube",embedUrl:"https://evil.test"})` return `null`.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement `shared/screen.ts`**; construct embed URLs from parsed ids only (never echo user strings into `embedUrl`); `screenFromStored` re-runs `resolveScreen` on `screen.url`.
- [ ] **Step 4: Run**; expected PASS.

---

### Task 4: Room types, privacy and rules

**Files:**
- Create: `shared/rooms.ts`, `shared/roomRules.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces in `shared/rooms.ts`: `ROOM_KINDS = ["party","listening","talk","event"]`, `ROOM_VISIBILITY = ["public","friends","invite"]`, `ROOM_REACTIONS: readonly string[]` (8 emoji), `ROOM_LIMITS = { capacityDefault: 50, capacityMax: 100, title: 80, description: 500, chat: 300 }`; `interface RoomPrivacy { v: 1; interactions: "everyone"|"mutuals"|"none"; appearInLists: boolean; allowInvites: boolean }`; `DEFAULT_ROOM_PRIVACY = { v:1, interactions:"mutuals", appearInLists:true, allowInvites:true }`; `resolveRoomPrivacy(stored: unknown): RoomPrivacy`; `validateRoomPrivacy(input: unknown): {ok:true,value}|{ok:false,field}` (strict, names the field); `interface RoomInput { title; description?; kind; visibility; ageLimit: AgeLimit; eventId?; venueId?; scheduledFor?: string; noDirectInteractions?: boolean; screenUrl?: string; capacity?: number }`; `validateRoomInput(input: unknown): {ok:true,value}|{ok:false,field}` (title 1..80, capacity 2..`capacityMax`, at most one of `eventId`/`venueId`, `scheduledFor` in the future and within 90 days).
- Produces in `shared/roomRules.ts`: `canJoinRoom(user:{age:number|null}, room:{ageLimit:AgeLimit}): {ok:true}|{ok:false;code:"AGE_UNKNOWN"|"AGE_LIMIT"}`; `canInteract(actor:{age;privacy}, target:{age;privacy}, room:{noDirectInteractions:boolean}, rel:{blocked:boolean;mutualFollow:boolean}): {ok:true}|{ok:false;code:"BLOCKED"|"ROOM_NO_DIRECT"|"PRIVACY"|"AGE_BAND"}` evaluated in that order; `canHostRoom(host:{age:number|null;accountAgeDays:number}, input:{visibility;ageLimit}, cfg:{minAccountAgeDays:number}): {ok:true}|{ok:false;code:"AGE_UNKNOWN"|"HOST_BELOW_LIMIT"|"TEEN_PUBLIC"|"ACCOUNT_TOO_NEW"}` (a host cannot set a limit above their own age; teens cannot host `public`; accounts younger than `minAccountAgeDays` cannot host `public`).

- [ ] **Step 1: Write failing tests**: `canInteract` full matrix over {blocked, mutual, privacy everyone/mutuals/none, room noDirect, age band same/different/unknown} asserting the first failing code in the stated order and `ok` only when all pass (`everyone` still requires same band and no block); `canJoinRoom` for each limit at boundary ages; `canHostRoom` cases (teen+public, 17yo setting `18+`, adult with `21+` at age 20, new account public); `validateRoomPrivacy` rejects unknown keys values; `resolveRoomPrivacy(null|"x"|{})` returns defaults; `validateRoomInput` boundary cases.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** both modules as pure functions per Interfaces.
- [ ] **Step 4: Run**; expected PASS.

---

### Task 5: Schema, migration and room storage

**Files:**
- Modify: `shared/schema.ts` (tables `rooms`, `roomMembers`; `users.roomPrivacy` jsonb; add `"room_live"` to `notificationTypes`; `contentReports` allowed `contentType` values documented), `server/storage.ts` (`ensureSchema`)
- Create: `migrations/add_rooms.sql`, `server/rooms/roomStorage.ts`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Produces tables per the spec's data model (`rooms` includes `age_limit text not null default 'all'`, `capacity int not null default 50`, `no_direct_interactions boolean default false`, `screen jsonb`, `status`, timestamps, `event_id`/`venue_id` FKs `on delete set null`; `room_members` pk `(room_id,user_id)` with `role`, `joined_at`, `left_at`, `muted`, `banned`).
- `roomStorage` exports: `createRoom(hostId: string, input: RoomInput & { screen?: Screen|null }): Promise<Room>`; `getRoom(id: string): Promise<Room|null>`; `listRooms(opts:{ scope:"live"|"upcoming"|"friends"; viewerId:string; eventId?:string; venueId?:string; limit?:number }): Promise<Room[]>` (applies visibility, blocks both ways, `appearInLists`, teen-host exclusion from public); `updateRoom(id, patch): Promise<Room>`; `setStatus(id, status, now?: Date): Promise<Room>`; `getMember(roomId,userId)`, `upsertMember(roomId,userId,role)`, `markLeft(roomId,userId)`, `setMemberFlag(roomId,userId,{muted?:boolean;banned?:boolean})`, `isBanned(roomId,userId): Promise<boolean>`, `countLiveRoomsByHost(hostId)`, `countScheduledByHost(hostId)`.

- [ ] **Step 1: Write failing API/DB tests** (throwaway DB): create and fetch a room; `listRooms` live scope excludes rooms of users the viewer blocked, excludes `appearInLists:false` hosts for non-followers, excludes `friends` rooms for non-mutuals, never lists teen-hosted rooms in `live` or `upcoming` public scopes; `setMemberFlag` ban persists and `isBanned` is true; unique member pk.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Add tables and column**, `migrations/add_rooms.sql` (additive, idempotent), `ensureSchema` entries, and implement `roomStorage`.
- [ ] **Step 4: Apply the migration to the production database now** (`node --env-file=.env scripts/run-social-events-migration.mjs add_rooms.sql`) and verify tables and `users.room_privacy` exist and `users` row count unchanged.
- [ ] **Step 5: Run** `npm run test:rooms`; expected green; type-check count unchanged.

---

### Task 6: Rooms REST routes

**Files:**
- Create: `server/rooms/roomRoutes.ts` (`registerRoomRoutes(app: Express): void`)
- Modify: `server/index.ts` (register), `server/routes/users-routes.ts` or new route for `PUT /api/users/me/room-privacy`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Consumes: `shared/*` modules, `roomStorage`, `getConfig("min_account_age_days")` (existing), `deliverNotification` (type `room_live`).
- Produces endpoints: `POST /api/rooms` (validates with `validateRoomInput`, `resolveScreen`, `canHostRoom`, limits; 201 with room), `GET /api/rooms?scope=live|upcoming|friends&eventId&venueId`, `GET /api/rooms/:id` (includes `canJoin` result for the viewer), `PATCH /api/rooms/:id` (host: title, description, ageLimit not lowered while live, screen, noDirectInteractions, capacity), `POST /api/rooms/:id/start` (status live, `room_live` notification to followers who allow it), `POST /api/rooms/:id/end`, `POST /api/rooms/:id/report` (creates `content_reports` row with `contentType:"room"` and the chat excerpt supplied by the hub in Task 7), `PUT /api/users/me/room-privacy` (strict validation, response session-shaped like the avatar route, inside the `req.login` callback).
- Errors: 400 names the failing `field`; 403 codes from `canHostRoom`; 429 on limits; age failures never reveal the user's age.

- [ ] **Step 1: Write failing API tests**: create with valid input; 400 per invalid field; teen cannot create `public` (403 `TEEN_PUBLIC`); user with null DOB blocked; account-too-new blocked for public; second live room blocked; `GET /api/rooms/:id` shows `canJoin:{ok:false,code:"AGE_LIMIT"}` for an under-age viewer; `PATCH` by non-host 403; `start` notifies followers (assert notification rows) and respects `appearInLists`; hostile screen URLs rejected; room-privacy PUT validation and session-shaped response.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** routes with rate limiting via existing limiter patterns (`server/security.ts`), `requireAuth`, and `toPublicUser` for any embedded users.
- [ ] **Step 4: Run**; expected PASS. Also run the phase-6 route sweep once at the end of the plan (Task 12).

---

### Task 7: RoomHub and WebSocket protocol

**Files:**
- Create: `server/rooms/RoomHub.ts`, `server/rooms/roomSocket.ts`, `server/rooms/rateLimit.ts`
- Modify: `server/websocket.ts` (route `room:*` messages and socket close to `roomSocket`; keep existing messages working)
- Test: `scripts/test-rooms-ws.ts` (real `ws` clients against an in-process server using the existing session-cookie auth path with a fake session store)

**Interfaces:**
- `RoomHub` class: `join(roomId: string, m: {userId; role; muted; joinedAt: number; send: (msg:object)=>void}): void`; `leave(roomId, userId): void`; `broadcast(roomId, msg: object, exceptUserId?: string): void`; `sendTo(userId, msg): void`; `members(roomId, limit?: number)`; `count(roomId): number`; `roomOf(userId): string|null`; `end(roomId): void` (notifies and clears); one room per user (joining another leaves the first); multiple sockets of one user count once.
- `rateLimit.ts`: `class TokenBucket { constructor(ratePerSec:number, burst:number); take(): boolean }` and per-user bucket maps cleared on leave.
- `roomSocket.ts`: `handleRoomMessage(ws, userId, message): Promise<void>` handling `room:join|leave|chat|react|interact|screen|mod` exactly as the spec's protocol, and `handleSocketClose(userId)`.
- Server rules inside handlers: join runs bouncer (`canJoinRoom`), ban check, capacity, blocked-host check, invite token check, status must be `live` (host may join a `scheduled` room only to start via REST); `chat` sanitized with the existing sanitizer and dropped for muted users; `interact` re-runs `canInteract` with real follows and blocks loaded from the database; host disconnect starts a 120 s timer that ends the room via REST-equivalent storage call; reconnect within grace cancels it; an in-memory ring of the last 50 chat messages per room is kept for reports.

- [ ] **Step 1: Write failing WS tests**: join/leave presence deltas to others; member list capped at 40 with `memberCount`; chat and reaction fan-out; rate limits drop excess; muted user's chat dropped; an under-age user, a banned user and a blocked-by-host user are refused (`room:error` codes `AGE_LIMIT|BANNED|BLOCKED`) including after reconnect; `room:interact` accepted only when `canInteract` is ok (mutual + same band + privacy) and rejected with the matching code otherwise; capacity 2 room refuses the third; one user two sockets counts once; host disconnect then no reconnect ends the room after the grace (use a short injectable grace); host reconnect cancels; kick closes the target's room membership immediately.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** hub, buckets and handlers; make the grace period and rate constants injectable for tests.
- [ ] **Step 4: Run** `npm run test:rooms`; expected green.

---

### Task 8: Moderation and admin

**Files:**
- Modify: `server/rooms/roomSocket.ts` (`room:mod` handling), `server/rooms/roomRoutes.ts` (`POST /api/rooms/:id/members/:userId/ban|unban`, report excerpt), `server/admin-routes.ts` (end any room, change a room's age limit with audit, list reported rooms)
- Test: `scripts/test-rooms-api.ts`, `scripts/test-rooms-ws.ts`

**Interfaces:**
- Consumes: `RoomHub`, `roomStorage.setMemberFlag`, `contentReports` insert helper used by existing report routes.
- Produces: host and co-host can `mute|unmute|kick|ban`; co-hosts cannot act on the host or other co-hosts; ban persists and blocks every future join; reports store `contentType` in `"room"|"room_message"|"room_user"` with the last 50 chat lines attached; admin routes require admin session and write audit entries.

- [ ] **Step 1: Write failing tests**: permission matrix (guest cannot mod, co-host cannot ban host); ban persists across a server-side hub reset; report creation attaches the excerpt and appears in the admin list; admin end-room closes live sockets; admin age-limit change is audited and applies to the next join.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** moderation paths and admin additions.
- [ ] **Step 4: Run**; expected PASS.

---

### Task 9: Client socket layer

**Files:**
- Modify: `client/src/providers/WebSocketProvider.tsx`
- Create: `client/src/hooks/useRoomSocket.ts`
- Test: pure reducer test inside `scripts/test-rooms-unit.ts`

**Interfaces:**
- `WebSocketProvider` context now exposes `{ send(msg: object): boolean; subscribe(handler: (msg: any) => void): () => void }` (existing query-invalidation behavior unchanged).
- `roomReducer(state: RoomState, event: RoomServerMessage): RoomState` (pure, exported from `useRoomSocket.ts`) handling `room:state|joined|left|chat|react|screen|mod|ended|error`; `useRoomSocket(roomId: string)` returns `{ state, join(), leave(), chat(text), react(emoji), interact(targetId, kind, emoji?), setScreen(screen), mod(action, targetId), status: "connecting"|"live"|"reconnecting"|"ended"|"denied" }`, re-sends `room:join` after reconnect.

- [ ] **Step 1: Write failing reducer tests**: state after join, member delta, duplicate join idempotent, chat list capped at 200, `room:ended` and `room:error` terminal states, reaction events expire into a list the UI can animate.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** provider additions and the hook.
- [ ] **Step 4: Run**; reducer tests pass; `npx tsc --noEmit` unchanged.

---

### Task 10: Rooms list and create dialog

**Files:**
- Create: `client/src/pages/RoomsPage.tsx`, `client/src/components/rooms/CreateRoomDialog.tsx`
- Modify: `client/src/App.tsx` (`/rooms`, `/rooms/:id`), `Navigation.tsx` account menu and `BottomNavigation.tsx` entry per existing patterns

**Interfaces:**
- Consumes: REST from Task 6, `validateRoomInput`.
- Produces: Rooms page with tabs Live now, Upcoming, Friends (TanStack Query keys `["/api/rooms", scope]`), room cards showing title, host avatar, age-limit badge ("All ages", "16+" and so on), member count, linked event/venue; create/schedule dialog with fields title, kind, visibility, **age limit selector described as the door policy**, optional event/venue link (organizer's own), schedule, screen link with live preview of the resolved provider, direct-interactions toggle, capacity; locked options explained inline (teens: public disabled with reason; age limits above the host's age disabled).

- [ ] **Step 1: Implement** the pages and dialog following existing page patterns (`AccountSettingsPage`, `CreateVenueModal`).
- [ ] **Step 2: Browser check** (real browser, scratch DB per the avatar phases: stub geolocation not needed here): create a room as an adult with `18+`, see it in Upcoming, start it, see it in Live now as another adult, and confirm a teen account sees the age-limit badge and cannot open it.
- [ ] **Step 3: Verify** `npx tsc --noEmit` count and `npm run build`.

---

### Task 11: Room page, scene and screen

**Files:**
- Create: `client/src/pages/RoomPage.tsx`, `client/src/components/rooms/RoomScene.tsx`, `RoomScreen.tsx`, `RoomChat.tsx`, `HostControls.tsx`
- Modify: `client/src/index.css` (scene and reaction animation, reduced-motion safe)

**Interfaces:**
- `RoomScreen({ screen, canControl, onChange }: …)`: renders by provider (YouTube/Vimeo/Spotify/Apple/SoundCloud iframes with a fixed `sandbox`/`allow` list and `referrerpolicy`, image, or a link card), shows an "Open in {Spotify|Apple Music|YouTube|link}" button using `openUrl` (`target="_blank" rel="noopener noreferrer"`), and implements the **tap-to-fullscreen shield**: a transparent overlay captures taps and calls `requestFullscreen()` on the screen container (iOS fallback: fixed full-viewport overlay), the overlay is removed in fullscreen, an exit button and Escape restore, and a collapsible chat/reaction strip stays reachable.
- `RoomScene({ members, you, onAvatarTap })`: back wall (screen), stage row for host and co-hosts with `Avatar mode="bust"`, floor grid for up to 40 guests plus a "+N more" chip, reaction bursts, name labels, tap and keyboard activation on every avatar.
- `RoomChat`: `aria-live="polite"` list, input with 300-char limit and rate-limit feedback.

- [ ] **Step 1: Implement** the components; no layout shift while embeds load (reserve a 16:9 box), buffering skeleton, reconnecting banner, clear denied/ended states ("This room has an age limit", "The host ended the room").
- [ ] **Step 2: Browser check** with two logged-in users in one room: both appear on the floor, chat and reactions arrive, host changes the screen to a YouTube link and the other user sees it, tapping the screen enters fullscreen and Escape exits, "Open in" buttons carry the right URLs, an unsupported link shows a link card, a reconnect (restart dev server) restores the room.
- [ ] **Step 3: Verify** type-check count and build.

---

### Task 12: Avatar slide-out, privacy settings and event/venue entry points

**Files:**
- Create: `client/src/components/rooms/AvatarActionsSheet.tsx`, `MemberListSheet.tsx`, `client/src/components/RoomPrivacyCard.tsx`
- Modify: `client/src/pages/AccountSettingsPage.tsx` (mount `RoomPrivacyCard`), `EventDetailPage.tsx` and `VenueDetailPage.tsx` ("Join the virtual room" when a live or upcoming linked room exists, using `GET /api/rooms?eventId|venueId`), `client/src/pages/RoomPage.tsx` (open sheet on avatar tap)

**Interfaces:**
- `AvatarActionsSheet({ target, you, room, rel, onAction })` shows: always view profile, report, block, mute locally; when `canInteract(...)` is ok: wave, private reaction, DM (calls `POST /api/conversations/direct` then navigates to the chat), invite to a room (if `allowInvites`); host/co-host: mute chat, remove, ban. The sheet computes availability with the same shared `canInteract`, but the server is the gate.
- `RoomPrivacyCard`: radio group `interactions` (everyone, mutual followers only default, nobody), switches `appearInLists`, `allowInvites`; saves via `PUT /api/users/me/room-privacy` and updates the session cache with `setQueryData`.
- `MemberListSheet`: same actions without tapping avatars (accessibility).

- [ ] **Step 1: Implement** the components and entry points.
- [ ] **Step 2: Browser matrix check** with scratch-DB users: mutual adult pair sees all actions; non-mutual sees only the basic set; adult vs teen shows no wave/DM/invite; target set to "nobody" hides actions immediately after the change (privacy change takes effect without rejoining); host kick/ban works and the banned user cannot rejoin; event page shows the join button for a linked live room.
- [ ] **Step 3: Full verification**: `npm run test:rooms`, `npm run test:avatar`, `npm run test:social -- --only=6` (route sweep and leak sweep must stay green; add the new public/auth routes to its expectations only if they are intentionally open), `npx tsc --noEmit` (10 baseline), `npm run build`.
- [ ] **Step 4: Update memory**: add a project memory note for Rooms alpha (where files live, protocol, rules, test command, deferred items) and an index line in `MEMORY.md`.
- [ ] **Step 5: Report** what was verified in a real browser and what was not. Do not commit or push unless asked.
