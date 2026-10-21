> **SUPERSEDED 2026-10-18 by `2026-10-18-rooms-build-02-minors-rooms.md`. The owner scrapped anonymous join and the Teens-only room type. Do not build from this file.**

# Rooms build, phase 2: strict age rules and anonymous join

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Teens-only room type with its one-way rule (adults never enter), let people join anonymously where the rules allow, and make every payload the server sends respect that anonymity, while hosts and moderators can still see who anyone is.

**Architecture:** Pure rule functions in `shared/` (one source of truth for server and client). A pseudonymous public id (`publicId`) per member per room, generated from an HMAC and applied at **one choke point** in the hub: every outbound message has its identity fields rewritten to public ids, every inbound `targetId` is resolved back. Moderators receive an extra `real` field. Anonymous members are restricted on the server (no interact, mic, camera, cohost, pay).

**Tech Stack:** TypeScript, Express, `ws`, Drizzle/Postgres, React.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md` (sections 2, 3, 4). Visual reference: `docs/design/rooms-2026-10/rooms.html` scenario "Join screen" (and screenshots `img/r1`, `r2`, `r3`).

## Global Constraints

- Branch `feat/rooms-redesign`; no push or merge without the owner's go-ahead.
- Schema changes: migration + `ensureSchema` mirror + `shared/schema.ts` + **applied to the real database in the same task**. Additive only.
- **A real `userId`, username, avatar or display name of an anonymous member must never reach a client that is not the member themself or a host, co-host or admin.** This is the one rule the whole phase exists for. Anonymous members' own socket receives their own `publicId`.
- Public id shape: `anon_` + 12 lowercase hex characters, `HMAC-SHA256(ROOM_ANON_SECRET, roomId + ":" + userId)` truncated. Alias shape: `Guest ` + 3 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, derived from the same HMAC. If two members of one room collide, re-derive the later one with a `:1`, `:2` suffix. `ROOM_ANON_SECRET` falls back to `SESSION_SECRET`; the process must refuse to start in production if neither is set.
- Age is read from the account (`dateOfBirth`) on the server every time. The client never decides.
- Do not add `req.login()` or session regeneration. Do not respond before async callbacks finish.
- Use `toPublicUser`, `hostSummary`, `publicRoom` for user and room shapes. Anonymous members are shown through new masking helpers, never by deleting fields at call sites.
- Existing behavior preserved: bans follow the real account, kicks last 10 minutes, hosts see everyone.
- `npx tsc --noEmit` not above baseline; `npm run test:rooms` green at the end of every task.
- Copy: plain words, no em dashes. Never imply an adult in a mixed room "could" be anonymous; say it is not available.

## Review Focus

- **Leak vectors** (each needs a test): `room:state` members; `room:joined`; `room:left`; chat history replayed to a new joiner; `room:chat` and `room:react`; `room:interact`; `room:stage` and `room:live` arrays (`stage`, `hands`, `asks`, `holder`); `room:mod`; REST `peek` on `GET /api/rooms` and `GET /api/rooms/:id`; the `actions` endpoint; error and notice codes that echo ids; LiveKit participant identity (voice token); `report` responses; server logs.
- A banned anonymous user rejoining must be refused with the same code as a banned named user; their alias is stable across reconnects and tabs in the same room.
- A host or co-host can never be anonymous. A member promoted to co-host while anonymous must be refused.
- An adult must be refused anonymity in 13+ and 16+ rooms and in "all ages" rooms, even if they send `anonymous: true` by hand; a teen is refused anonymity when the host turned it off.
- A teen whose birthday makes them 18 today: next join evaluates as adult; an adult in a teens-only room whose date of birth is later corrected below 18 gains access only on next join.
- Unknown age (no DOB) enters nothing, as today, with the same code.
- Two tabs of the same user: both show the same public id and alias.
- The client must not break when `username` and `avatar` are null for a member.

---

### Task 2.1: Age and anonymity rules as pure functions

**Files:**
- Modify: `shared/age.ts`, `shared/roomRules.ts`, `shared/rooms.ts`, `client/src/lib/roomsApi.ts` (labels and messages)
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces (`shared/age.ts`): `AgeLimit` gains `"teen"`; `AGE_LIMITS` includes it; `maxAgeForLimit(l: AgeLimit): number | null` (17 for `teen`, else null); `meetsAgeLimit(age, l)` returns false when `age` is above the max; `minAgeForLimit("teen")` is 13; `export const OPEN_TO_MINORS: readonly AgeLimit[] = ["all", "13+", "16+", "teen"]`; `isOpenToMinors(l: AgeLimit): boolean`.
- Produces (`shared/roomRules.ts`): `canJoinRoom` returns `Check<"AGE_UNKNOWN" | "AGE_LIMIT" | "AGE_TOO_OLD">` (`AGE_TOO_OLD` when the room is `teen` and the user is 18 or more); `canJoinAnonymously(user: { age: number | null; role?: "host" | "cohost" | "guest" }, room: { ageLimit: AgeLimit; anonymousAllowed: boolean }): Check<"AGE_UNKNOWN" | "ANON_OFF" | "ANON_ADULT_MIXED" | "ANON_HOST">`; `canHostRoom` gains `"HOST_TOO_OLD"` (adult host, `teen` room); `moneyEligibleRoom(room: { ageLimit: AgeLimit }): boolean` (true only for `18+` and `21+`); `export const ANON_RESTRICTIONS = ["interact", "dm", "stage", "live", "cohost", "pay"] as const`.
- Produces (`shared/rooms.ts`): `RoomInput` gains `anonymousAllowed?: boolean` (default true) validated as boolean; `validateRoomInput` accepts `ageLimit: "teen"`.
- Produces (client labels): `ageLimitLabel("teen")` is "Teens only"; `DENIED_MESSAGE.AGE_TOO_OLD` is "This room is for under 18s. Adults can't join, and that can't be changed."; `DENIED_MESSAGE.ANON_ADULT_MIXED` and `ANON_OFF` plain explanations.

- [ ] **Step 1: Failing tests** for the whole matrix in spec section 3, as a table-driven test: ages 12, 13, 15, 16, 17, 18, 21, null against limits `all`, `13+`, `16+`, `18+`, `21+`, `teen`. Expected examples: `canJoinRoom({age:17},{ageLimit:"teen"})` ok; `({age:18},{ageLimit:"teen"})` is `{ok:false, code:"AGE_TOO_OLD"}`; `({age:16},{ageLimit:"18+"})` is `AGE_LIMIT`; `({age:12},{ageLimit:"all"})` is `AGE_LIMIT`; `({age:null},{ageLimit:"all"})` is `AGE_UNKNOWN`. `canJoinAnonymously({age:30},{ageLimit:"13+",anonymousAllowed:true})` is `ANON_ADULT_MIXED`; `({age:30},{ageLimit:"18+",anonymousAllowed:true})` ok; `({age:30},{ageLimit:"18+",anonymousAllowed:false})` is `ANON_OFF`; `({age:15},{ageLimit:"13+",anonymousAllowed:true})` ok; `({age:15},{ageLimit:"teen",anonymousAllowed:true})` ok; `({age:30, role:"host"},...)` is `ANON_HOST`. `canHostRoom({age:30,accountAgeDays:90},{visibility:"friends",ageLimit:"teen"},cfg)` is `HOST_TOO_OLD`; `({age:16,...},{visibility:"public",ageLimit:"teen"})` is `TEEN_PUBLIC`; `({age:16,...},{visibility:"friends",ageLimit:"teen"})` ok. `moneyEligibleRoom` true for 18+ and 21+, false for the other four.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`; see FAIL.
- [ ] **Step 3: Implement** the shared changes (keep existing exports and codes working; existing tests for `13+`/`16+`/`18+`/`21+` must still pass).
- [ ] **Step 4: Update client labels/messages** and fix any exhaustive `switch` or `Record<AgeLimit,...>` the compiler flags (`npx tsc --noEmit`).
- [ ] **Step 5: Run** `npm run test:rooms` (all suites). Expected: green.
- [ ] **Step 6: Commit** `feat(rooms): teens-only age limit and anonymous join rules`.

### Task 2.2: Schema for anonymous membership

**Files:**
- Create: `migrations/add_rooms_anonymous.sql`
- Modify: `shared/schema.ts` (`rooms.anonymousAllowed`, `roomMembers.anonymous`, `roomMembers.alias`), `server/storage.ts` (`ensureSchema` mirror), `server/rooms/roomStorage.ts` (`upsertMember` takes `{ anonymous?: boolean; alias?: string | null }`), `server/rooms/roomRoutes.ts` `publicRoom` unchanged (the new room column is public and fine)
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Columns: `rooms.anonymous_allowed boolean not null default true`; `room_members.anonymous boolean not null default false`; `room_members.alias text null`.
- Produces: `upsertMember(roomId, userId, role, extra?: { anonymous?: boolean; alias?: string | null }): Promise<RoomMember>`; `RoomMember` now has `anonymous` and `alias`.

- [ ] **Step 1: Write the migration** (BEGIN; three `ADD COLUMN IF NOT EXISTS`; COMMIT), the `ensureSchema` mirror, and the three Drizzle columns.
- [ ] **Step 2: Apply to the real database now** (same method as phase 0 task 0.3 step 4) and verify with an `information_schema` query: three rows.
- [ ] **Step 3: Failing API test:** a created room has `anonymousAllowed === true`; `upsertMember` with `{ anonymous: true, alias: "Guest 4F2" }` persists; a second `upsertMember` without extras keeps the alias but does not flip `anonymous` back unless passed.
- [ ] **Step 4: Implement `upsertMember` extras.** Run tests green.
- [ ] **Step 5: Commit** `feat(rooms): anonymous membership columns`.

### Task 2.3: REST: create, patch, list, and the join answer

**Files:**
- Modify: `server/rooms/roomRoutes.ts` (`POST /api/rooms`, `PATCH /api/rooms/:id`, `GET /api/rooms`, `GET /api/rooms/:id`), `server/rooms/roomStorage.ts` (`listRooms` gets `viewerAge`), `server/rooms/roomAccess.ts`
- Test: `scripts/test-rooms-api.ts`

**Interfaces:**
- Produces: `GET /api/rooms/:id` response gains `anonymous: { allowed: boolean; reason?: "ANON_OFF" | "ANON_ADULT_MIXED" | "AGE_UNKNOWN" | "ANON_HOST" }` computed with `canJoinAnonymously`; `canJoin` may now carry `AGE_TOO_OLD`. `ListRoomsOpts.viewerAge: number | null`: rooms the viewer cannot join are **omitted** (not shown locked), except rooms the viewer hosts. `POST` and `PATCH` accept `anonymousAllowed` and `ageLimit: "teen"`; `PATCH` of `ageLimit` or `anonymousAllowed` on a live room is allowed only for the host and never lets an adult host set `teen`.
- Behavior: an adult cannot create a `teen` room (400 with `field: "ageLimit"` and `code: "HOST_TOO_OLD"`); a teen host is refused `public` visibility as today.

- [ ] **Step 1: Failing API tests:** adult viewer list omits a `teen` room that a teen host made (friends visibility, mutual follow); teen viewer sees it; teen viewer list omits an `18+` room; `GET /api/rooms/:id` for an adult on a `13+` room gives `anonymous.allowed === false` and `reason === "ANON_ADULT_MIXED"`; for an adult on an `18+` room `allowed === true`; with `anonymousAllowed` false `reason === "ANON_OFF"`; adult creating a `teen` room gets 400 `HOST_TOO_OLD`; teen viewer on `GET /api/rooms/:id` of an adult-only room has `canJoin.code === "AGE_LIMIT"`; adult on a teen room has `AGE_TOO_OLD`.
- [ ] **Step 2: Run, see FAIL; implement; PASS.**
- [ ] **Step 3: Check the listing path:** `listRooms` already filters by block, visibility and host rules; add the age filter there rather than in the route so `GET /api/rooms` and any other caller agree.
- [ ] **Step 4: Run** `npm run test:rooms`; **commit** `feat(rooms): anonymous allowance and age-based visibility`.

### Task 2.4: Identity registry and the id-rewrite helpers (pure)

**Files:**
- Create: `shared/roomIdentity.ts`
- Modify: `server/rooms/RoomHub.ts` (registry methods)
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces (`shared/roomIdentity.ts`, no Node `crypto` import so the file stays shareable; the HMAC is passed in): `export interface Identity { userId: string; pid: string; anonymous: boolean; alias: string | null }`, `export function aliasFromDigest(hex: string, salt?: number): string`, `export function pidFromDigest(hex: string): string`, `export const ID_FIELDS: readonly string[] = ["userId", "fromId", "targetId", "holder"]`, `export const ID_ARRAY_FIELDS: readonly string[] = ["stage", "hands", "asks", "invited"]`, `export function rewriteIds<T extends object>(msg: T, toPid: (userId: string) => string): T` (walks `member`, `members[]` and `you` objects too; leaves unknown ids unchanged; never mutates the input), `export function resolveIdIn<T extends object>(msg: T, toUser: (id: string) => string | null): T | null` (null when a present `targetId` cannot be resolved).
- Produces (`RoomHub`): `register(roomId: string, id: Identity): void`, `identityOf(roomId: string, userId: string): Identity | undefined`, `byPid(roomId: string, pid: string): Identity | undefined`, `pidOf(roomId: string, userId: string): string` (falls back to the real id when unregistered), `userOf(roomId: string, idOrPid: string): string | null`, registry dropped when the room ends.
- Server helper (new `server/rooms/identity.ts`): `deriveIdentity(roomId: string, userId: string, anonymous: boolean, taken: Set<string>): Identity` using `crypto.createHmac("sha256", process.env.ROOM_ANON_SECRET ?? process.env.SESSION_SECRET)`.

- [ ] **Step 1: Failing tests:** `pidFromDigest("ab".repeat(32))` matches `/^anon_[0-9a-f]{12}$/`; `aliasFromDigest(hex)` matches `/^Guest [ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/`; same input gives same output; salt changes alias; `rewriteIds({type:"room:chat",userId:"U1",text:"hi",replyTo:{userId:"U2",text:"x"}}, toPid)` rewrites both `userId` fields (top level and inside `replyTo`); `rewriteIds` on `{type:"room:stage",stage:["U1","U3"],hands:["U2"]}` rewrites array members; leaves `text` containing "U1" alone; does not mutate its input (deep-equal original after call); `resolveIdIn({type:"room:mod",targetId:"anon_abc"}, toUser)` returns the message with the real id or null when unknown. `deriveIdentity` for a non-anonymous member returns `pid === userId` and `alias === null`; two different users in one room never share an alias (force a collision with a stub digest).
- [ ] **Step 2: Run, see FAIL; implement; PASS.**
- [ ] **Step 3: Add the registry to `RoomHub`** with unit tests (`register`, `pidOf` fallback, `userOf` for both a pid and a real id, cleared by `end`).
- [ ] **Step 4: Production guard:** in `server/index.ts` startup, throw if `NODE_ENV === "production"` and neither `ROOM_ANON_SECRET` nor `SESSION_SECRET` is set.
- [ ] **Step 5: Commit** `feat(rooms): identity registry and id rewriting helpers`.

### Task 2.5: Server join and the outbound choke point

**Files:**
- Modify: `server/rooms/roomSocket.ts` (`doJoin` and `joinOnce`, `memberPayload`, `sendState`, the room-level send path), `server/rooms/RoomHub.ts` (`broadcast`, per-member `send` wrappers), `server/rooms/stage.ts` (no direct id emission left that bypasses the choke point), `server/rooms/roomRoutes.ts` (`room:mod` role broadcast at about line 418, `peekOf`)
- Test: `scripts/test-rooms-ws.ts`

**Interfaces:**
- WS in: `{ type: "room:join", roomId, inviteToken?, anonymous?: boolean }`. New terminal refusals: `ANON_NOT_ALLOWED` (any `canJoinAnonymously` failure; include `reason` field with the specific code).
- WS out (`room:state` and `room:joined`): member payload `{ userId: <pid>, role, muted, joinedAt, displayName, username, avatarUrl, avatar, organizationName, anonymous: boolean, alias?: string }`; for anonymous members `displayName = alias`, `username/avatarUrl/avatar/organizationName = null`. For **privileged recipients** (host, cohost) an anonymous member also carries `real: { userId, username, displayName }`. `room:state.you` gains `{ publicId: string; anonymous: boolean; alias?: string }`.
- Choke point: every message that leaves through a member's `send` is passed through `rewriteIds(msg, (id) => roomHub.pidOf(roomId, id))` exactly once; the broadcast helper knows the room id. Direct sends (`direct(ws, ...)`) of `room:state` build payloads from already-masked members.
- `peekOf(roomId, n)` skips anonymous members.

- [ ] **Step 1: Failing ws tests** (new block "anonymous join"): adult joins an `18+` room with `anonymous: true`; teen host's `13+` room... use real combinations: (a) adult guest A joins an 18+ room anonymously; named guest B and host H are in it. B's `room:joined` for A has `userId` matching `/^anon_/`, `displayName` matching `/^Guest /`, and the serialized frame contains neither A's real id nor A's username; H's frame has `real.userId === A`. (b) A sends chat; B's `room:chat` has `userId` = A's pid; chat history replayed to a later joiner C uses the pid. (c) A joins a `13+` room with `anonymous: true`: refused `ANON_NOT_ALLOWED` with `reason: "ANON_ADULT_MIXED"`. (d) a teen joins a `13+` room anonymously: ok. (e) host is never anonymous: host sending `anonymous: true` joins as themself. (f) `room:state.you.publicId` equals the pid seen by others; reconnect gives the same alias. (g) leak sweep helper `assertNoLeak(frames, realIds)` run over **every frame** every client received in the scenario.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Implement** `joinOnce`: parse `anonymous`, evaluate `canJoinAnonymously` with the room row and the member role, call `deriveIdentity`, `roomHub.register`, persist `{ anonymous, alias }` via `upsertMember`, put the identity on the hub member (`pid`, `anonymous`, `alias`).
- [ ] **Step 4: Implement the choke point** and the privileged `real` field; update `memberPayload` and `sendState`; make `stage.ts` and `roomRoutes.ts` broadcasts flow through the same path (they already call `roomHub.broadcast`; the rewrite happens inside it).
- [ ] **Step 5: Run** `npm run test:rooms`; all new and old ws tests pass (old tests use named members: `pid === userId`, so they must be unchanged).
- [ ] **Step 6: Commit** `feat(rooms): anonymous join with public ids at the hub choke point`.

### Task 2.6: Inbound resolution and server-side restrictions

**Files:**
- Modify: `server/rooms/roomSocket.ts` (`doInteract`, `doMod`, stage and live handlers), `server/rooms/stage.ts`, `server/rooms/roomRoutes.ts` (`actions`, `report`, `ban`, `unban`, `role`, `voice-token`)
- Test: `scripts/test-rooms-ws.ts`, `scripts/test-rooms-api.ts`

**Interfaces:**
- Behavior: every inbound `targetId` is resolved with `roomHub.userOf(roomId, id)` (accepts a pid or a real id; real ids of anonymous members are accepted only from host or co-host). Unresolvable targets get the existing not-found style notice.
- Restrictions for an **anonymous actor**: `room:interact` refused with notice `ANON_RESTRICTED`; `room:stage` `raise` refused `ANON_RESTRICTED`; `room:live` `ask` refused `ANON_RESTRICTED`; `PUT .../role` cannot make them co-host (409 `ANON_RESTRICTED`); `POST .../voice-token` returns a token with publish permission always false and LiveKit identity equal to their pid; the `actions` endpoint returns `{ actions: { interact: false, dm: false, invite: false } }` both when the actor is anonymous and when the target is anonymous.
- Restrictions for an **anonymous target**: wave or reaction to them refused with the same notice as a privacy refusal (`PRIVACY`), so nothing reveals why; host `invite` to the stage is refused `ANON_RESTRICTED` with a message the host can read; kick, ban and mute work through the pid.
- `report` accepts `targetUserId` as a pid or a real id; stored `contentId` always uses the real id (`roomId:realUserId`); the response never echoes ids.

- [ ] **Step 1: Failing tests** for every line above (ws and api). Include: anonymous A sends `room:interact` wave, receives `ANON_RESTRICTED`, nobody else receives anything; B waves at A's pid, B gets `PRIVACY`; host bans A by pid, A is removed, A cannot rejoin (same `BANNED` code as for named users) and `room_members.banned` is true for A's real id; report of A's pid by B stores `contentId` with A's real id; voice token for A has no publish grant (use `FakeVoice` as the existing tests do) and identity equals the pid; `PUT role` for A is 409.
- [ ] **Step 2: Run, see FAIL; implement; PASS.**
- [ ] **Step 3: Leak sweep over REST:** with A anonymous in a live room, `GET /api/rooms` and `GET /api/rooms/:id` (as B) have `peek` arrays containing no A; the `actions` response for A's pid is the all-false object and contains no ids.
- [ ] **Step 4: Run** `npm run test:rooms`; **commit** `feat(rooms): anonymous restrictions and inbound id resolution`.

### Task 2.7: Client: join screen, state, restrictions

**Files:**
- Modify: `client/src/components/rooms/RoomLobby.tsx` (becomes the real join screen), `client/src/lib/roomReducer.ts` (`RoomMemberView` gets `anonymous?`, `alias?`, `real?`; `RoomState.you` gets `publicId`, `anonymous`, `alias`; `selfId` follows `you.publicId`), `client/src/hooks/useRoomSocket.ts` (`join(opts?: { anonymous?: boolean })`), `client/src/pages/RoomPage.tsx` (anonymous bar, Reveal me), `client/src/components/rooms/HostAvatar.tsx` (plain avatar for anonymous), `client/src/components/rooms/shell/RoomDock.tsx` (disabled mic and camera with reasons), `client/src/components/rooms/AvatarActionsSheet.tsx` (`canViewProfile` false and actions disabled for anonymous), `client/src/lib/roomsApi.ts` (types for `anonymous`)
- Test: `scripts/test-rooms-unit.ts` (reducer), manual via `/dev/room-fixture`

**Interfaces:**
- Consumes: `GET /api/rooms/:id` `anonymous` and `canJoin`; WS `room:join` with `anonymous`.
- Produces: `JoinScreen` states: (1) adult at a teens-only room: block panel "This room is for under 18s" (no join button, "Find rooms for you"); (2) teen at an 18+ room: block "This room is 18+"; (3) can join: two choices "Join as yourself" and "Join anonymously", the second disabled with the plain reason when `anonymous.allowed` is false, and a rules list (what others see, what you can do, what you cannot, hosts can still see who you are) when selected; (4) already inside: goes straight in. Anonymous bar above the chat: "You are Guest 4F2. Hosts can still see who you are." with a **Reveal me** button that leaves and rejoins as yourself. Reducer rule: messages and members are keyed by `userId` (which is the pid for anonymous members); `nameOf` returns the alias; `real` is shown only inside host and co-host sheets as "You can see this is <name>".

- [ ] **Step 1: Failing reducer tests:** state with `you.publicId = "anon_x"` sets `selfId` to it; a `room:joined` member with `anonymous: true, alias: "Guest 4F2", username: null` is stored; `nameOf`-style helper returns the alias; a chat line from `anon_x` is attributed to self. Fixture additions: `fixtureState` gets an anonymous guest (`anon_fix1`).
- [ ] **Step 2: Run, see FAIL; implement; PASS.**
- [ ] **Step 3: Build the join screen** following `rooms.html` Join screen (use real data, no preview controls). Friends-inside row uses `peek`.
- [ ] **Step 4: Wire restrictions in the UI** (disabled controls with a toast reason, no Wave in the message actions for anonymous authors, "Profile hidden" in the person sheet). Server enforces regardless.
- [ ] **Step 5: Verify** with three real browser sessions or two browsers plus a ws peer script (see the memory recipe): adult and teen accounts in an 18+ room and a 13+ room; check each screen state from the list above; check the anonymous bar and Reveal me; check a host sees "You can see this is ..." and a normal guest does not.
- [ ] **Step 6: Commit** `feat(rooms-ui): join screen with anonymous option and restrictions`.

### Task 2.8: Security review and flag flip

- [ ] **Step 1: Leak audit by a fresh reviewer** (dispatch a subagent with only this plan's "Review Focus" and the diff; no other context). It writes a script that joins a room as anonymous A with a recording client B and greps every frame and REST response for A's real id, username and display name. Any hit is a blocker.
- [ ] **Step 2: Run the `security-review` skill** on the branch diff and fix findings.
- [ ] **Step 3: Flip the default** `anonymousJoin` to true in `server/rooms/features.ts` (`DEFAULT_ROOM_FEATURES`), keep env override; the join screen reads it from `useRoomsConfig()`.
- [ ] **Step 4: Gate:** `npm run test:rooms`, `npx tsc --noEmit` not above baseline, `npm run build` exits 0; update the handoff progress table and add a memory note about the identity choke point (see handoff, "Memory to write").
