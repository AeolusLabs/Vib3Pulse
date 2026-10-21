# Rooms build, phase 2 (revised): minors' rooms and profile safety

> **Supersedes** `2026-10-17-rooms-build-02-age-and-anonymous-join.md`. The owner scrapped anonymous join entirely and replaced the "Teens-only room type" with a rule based on the host's age. Do not build anything from the old plan 02.

**Owner decisions (2026-10-18):**
1. **No anonymous join. Ever.** Remove the flag, the config field, the types and any hook that exists only for it.
2. **A room hosted by someone aged 17 or under (a "minors' room") looks and behaves like any other room.** The only difference: nobody aged 18 or over can join unless the host has given them a personal invite. An adult who tries to get in sees a clear warning: the room is for minors; any inappropriate behaviour or indecent act will lead to account suspension, an investigation and possible legal action.
3. **View profile** opens the person's profile the way the rest of the app already opens profiles (plain in-app navigation, leaving the room). It must include a blocked-user check.
4. End-of-sprint items, NOT in this phase: staying in a room while using other parts of the app (minimised room); a room-wide Wave (research and brainstorm); a full codebase sweep for bugs and security gaps.

**Architecture:** One derived fact, `rooms.minors_room` (true when the host was under 18 when the room was created, set only by the server). One shared pure rule (`canAdultEnterMinorsRoom`) used by the server gate and the client. Adults need a personal invite row (`room_adult_invites`), never a shareable link token, because a teen could forward a link. The adult must also acknowledge the warning before entering; the acknowledgement time is stored for any later investigation.

**Existing rules stay exactly as they are** (do not change): `TEEN_PUBLIC` (teen hosts cannot host public rooms), age limits `all/13+/16+/18+/21+`, and the existing rule that teen speakers come off the stage when an adult is present in a room (`NOT_ELIGIBLE`). Note for the owner: an invited adult therefore still takes teens off the mic; report this, do not change it.

## Global Constraints

- Branch `feat/rooms-redesign`; no push or merge without the owner's go-ahead. `docs/` stays untracked.
- Schema changes: migration in `migrations/` + `ensureSchema` mirror in `server/storage.ts` + `shared/schema.ts` + **applied to the real database in the same task** (additive and idempotent only). The orchestrator applies the migration after review.
- Never serialize `passwordHash`, reset or verification tokens, or date of birth. A minors' room must not leak to adults: not in lists, not in `GET /api/rooms/:id`, not in notifications, not in search or trending, not in profile pages (a teen host's live room badge), not in invite-token flows.
- The server is the gate; the client mirrors the shared rule. Do not trust any client-sent flag (`minorsRoom`, `ack`, ages).
- Do not add `req.login()` or `req.session.regenerate()`.
- `npx tsc --noEmit` error count at most 10; `npm run build` passes; `npm run test:rooms` green. Tests are tsx scripts in NEW files `scripts/test-rooms-{unit,api,ws}-<topic>.ts` (the runner globs them). They run on a remote scratch DB (about 200 ms per query): wait for events, never assert after short fixed sleeps. Never create users in the real database.
- Copy: plain words, no em dashes, never the word "cash". Violet is the single accent; use the destructive token for the warning, not amber.

## Review Focus

- Every path by which an adult could learn of, see, or enter a minors' room without a personal invite: join over WebSocket, REST `GET /api/rooms`, `GET /api/rooms/:id`, invite-token links, live-room notifications, "friends" visibility (an adult friend of a teen host), the profile page of the teen host, trending/search, report and peek endpoints, the `actions` endpoint, `room:state` to an adult who was already inside when something changes.
- An adult with a valid personal invite but no acknowledgement must be refused; with both, admitted; the invite does not transfer to another user; revoking the invite removes the adult from the room.
- A teen host who turns 18 mid-room: the room stays a minors' room until it ends (stored flag), new rooms are normal.
- A user with unknown age (no DOB) enters nothing, as today.
- The host and co-hosts: an adult co-host cannot be added to a minors' room without an invite; the host themself is never blocked.
- A banned adult cannot rejoin with an old invite; kicks last 10 minutes as today.
- The warning is shown to the adult in every denial path with the same wording, and never to teens.
- Block checks: a blocked pair gets the same answer as "does not exist"; no difference between not found and blocked.

---

### Task 2.1: Remove anonymous join; View profile with a blocked-user check

**Files:**
- Modify: `server/rooms/features.ts`, `server/rooms/roomRoutes.ts` (config endpoint), `client/src/lib/roomsApi.ts` (config type), `scripts/test-rooms-unit-flags.ts`, `scripts/test-rooms-api-config.ts`, `client/src/components/rooms/ProfilePeekSheet.tsx`, `client/src/lib/profilePath.ts`, `client/src/components/rooms/AvatarActionsSheet.tsx`, `server/routes/users-routes.ts` (profile read routes used by the peek and the profile page), docs `HANDOVER_ROOMS_BUILD_2026-10-17.md` (mark anonymous scrapped)
- Test: new files `scripts/test-rooms-unit-profilesafety.ts`, `scripts/test-rooms-api-profilesafety.ts`

- [ ] **Step 1: Remove anonymous join.** Delete `anonymousJoin` from `roomFeatures`/`DEFAULT_ROOM_FEATURES`/`loadRoomFeatures`, the `ROOMS_ANONYMOUS_JOIN` env, the `/api/rooms/config` response field, the client config type, and their tests (update the config test to the new exact body). Remove the `member.anonymous` check from `shouldFetchProfile` and any code that exists only because anonymous members were planned (keep `canViewProfile`, now used for blocks). Grep the whole repo (`server`, `client`, `shared`, `scripts`) for `anonymous`/`Anonymous`/`ANON` in the rooms code and remove what is dead; leave unrelated uses (for example anonymous analytics) alone and list what you left.
- [ ] **Step 2: View profile opens the profile like the rest of the app.** Find how profiles are opened elsewhere (links to `/profile/:username` or `/user/:userId` through the router) and use exactly that mechanism for "Open full profile" and for the first action in the person actions sheet: plain in-app navigation in the same tab, leaving the room. Remove the new-tab helper (`openInNewTab`) and its tests if nothing else uses it. Keep one short honest line near the button: "This leaves the room." Make sure leaving cleanly closes the room socket and voice as the existing Back/leave does (navigating away must not leave a ghost member: check `useRoomSocket`/page unmount; for a host the room ends after the existing grace as today; say so in the report).
- [ ] **Step 3: Blocked-user check.** Read how blocks are handled today (`user_blocks`, `isBlocked`-style helpers, `canViewRoom`, `interactionVerdict`). Apply one rule everywhere a profile is read by id or username (`GET /api/users/:identifier`, `/follow-stats`, and the profile page's data route if separate): if the target has blocked the viewer, answer exactly as for a user who does not exist (same status and body); if the viewer has blocked the target, the viewer can still reach their own blocked-users management but not the target's profile content (decide by looking at how the app lets people unblock: do not break unblock). Document the rule you found and applied. In the room UI, the View profile row and the peek must not appear when either side has blocked the other (`canViewProfile` false), and the People sheet must not offer it either.
- [ ] **Step 4: Tests.** Unit: the pure decision for showing View profile. API (own username prefix, e.g. `pf_`): A blocks B -> B reading A by id and by username gets the same 404 as a missing user; B blocks A -> A gets the agreed answer; unblocked pair reads normally; a deleted user behaves as before; the peek never receives date of birth, email or phone.
- [ ] **Step 5: Verify and commit** (`chore(rooms): remove anonymous join; profile open and block check`).

### Task 2.2: Minors' rooms, server

**Files:**
- Create: `migrations/add_minors_rooms.sql`, `scripts/run-minors-rooms-migration.mjs` (copy `scripts/run-age-verification-migration.mjs`), `server/rooms/minorsRoom.ts`
- Modify: `shared/schema.ts` (`rooms.minors_room boolean not null default false`; new table `room_adult_invites(room_id, user_id, invited_by, created_at, acknowledged_at, revoked_at, primary key(room_id,user_id))`), `server/storage.ts` (`ensureSchema` mirror), `shared/roomRules.ts` (`canAdultEnterMinorsRoom`), `shared/rooms.ts` (denial codes + the warning text constant `MINORS_ROOM_WARNING`), `server/rooms/roomRoutes.ts`, `server/rooms/roomSocket.ts`, `server/rooms/roomStorage.ts`, `server/rooms/roomAccess.ts`, notifications for live rooms
- Test: new files `scripts/test-rooms-unit-minorsroom.ts`, `scripts/test-rooms-api-minorsroom.ts`, `scripts/test-rooms-ws-minorsroom.ts`

**Interfaces:**
- Produces (`shared/rooms.ts`): denial codes `MINORS_ROOM` (adult, no invite) and `MINORS_ROOM_ACK` (adult, invited, warning not yet acknowledged); `MINORS_ROOM_WARNING` (single source of the warning text, plain words, no em dashes): "This room is for under 18s. Adults can only come in if the host has invited them. Any inappropriate behaviour or indecent act will lead to your account being suspended, an investigation being opened, and possible legal action."
- Produces (`shared/roomRules.ts`): `canAdultEnterMinorsRoom(user: { age: number | null }, room: { minorsRoom: boolean }, invite: { invited: boolean; acknowledged: boolean }): Check<"MINORS_ROOM" | "MINORS_ROOM_ACK">` (teens and rooms that are not minors' rooms always ok; null age is handled by the existing `AGE_UNKNOWN` check first).
- Produces (HTTP): `POST /api/rooms/:id/adult-invites/:userId` (host only; target must be 18 or over, not blocked either way, not banned; rate limited; creates or revalidates the invite and sends a notification that does NOT contain the room title if the user is not yet allowed to see it, only "X invited you to a room"), `DELETE /api/rooms/:id/adult-invites/:userId` (host only; revokes and removes the adult from the live room), `POST /api/rooms/:id/adult-invites/acknowledge` (the invited adult records the acknowledgement; stored with the time). `GET /api/rooms/:id` for an adult without access returns the denial code and `MINORS_ROOM_WARNING` only (no title, no host, no members).
- Produces (WebSocket): `room:join` for an adult in a minors' room is refused with `MINORS_ROOM` or `MINORS_ROOM_ACK` (and the warning text) unless invited and acknowledged. The check runs in the join transaction AND again in the fresh re-read just before the hub insert (the join has a window of several awaits).
- Behaviour: `minors_room` is set by the server at room creation from the host's current age (under 18 => true), never from client input. Lists (`listRooms`), search, trending, live notifications and the host's profile live badge never show a minors' room to an adult who has no active invite.

- [ ] **Step 1: Failing tests** for the pure rule (table: teen/adult x minors/normal room x invited/acknowledged), then API tests (adult without invite: list hides the room, `GET /:id` returns code + warning only, join refused; with invite but not acknowledged: refused `MINORS_ROOM_ACK`; acknowledged: admitted; invite is per user; revoked invite removes the adult; teen host's new room has `minors_room` true, an adult host's false; client-sent `minorsRoom`/`ack` fields ignored; a friend-adult of a teen host sees nothing; invite-token link used by an adult without a personal invite is refused).
- [ ] **Step 2: Migration** (SQL, `ensureSchema` mirror, schema) and STOP: report the migration file for the orchestrator to apply to the real database. Do not run it against the real database yourself. Tests use the scratch database the runner builds from `shared/schema.ts`.
- [ ] **Step 3: Implement** rule, storage, routes, socket gate (both checks), listing filters, notifications, report/peek/actions endpoints, and every leak vector in Review Focus. Keep `redactSensitiveFields` and the shared sanitizers in use.
- [ ] **Step 4: ws tests** (own prefix `mr_`): adult refused over the socket; invited+acknowledged adult admitted; revoke while inside ejects with a notice; an adult cannot slip in during an in-flight join race (join, then host revokes, in parallel); teen speakers/stage rules unchanged.
- [ ] **Step 5: Verify and commit** (`feat(rooms): minors' rooms need a personal adult invite`).

### Task 2.3: Minors' rooms, client

**Files:**
- Create: `client/src/components/rooms/MinorsRoomWarning.tsx`, `client/src/components/rooms/AdultInviteSheet.tsx`
- Modify: `client/src/pages/RoomPage.tsx` (denied panel: new codes), `client/src/lib/roomsApi.ts`, `client/src/components/rooms/shell/PeopleSheet.tsx` or host controls (host can invite/revoke adults), create-room flow copy (a teen host is told once: "Only people under 18 can join. You can invite an adult yourself.")
- Test: new file `scripts/test-rooms-unit-minorsui.ts` (pure helpers)

- [ ] Warning screen for an adult without access: clear, calm, uses the destructive token, shows `MINORS_ROOM_WARNING` verbatim, no room title or host, one button back. For an invited adult: the same warning with an "I understand, enter" button that records the acknowledgement then joins. Never shown to teens. Host UI: "Invite an adult" (search by username among people the host can see, not blocked), list of invited adults with Revoke. 44 px targets, labels, focus return, reduced motion. Verify in the fixture at 375 and 1280 widths, dark and light, screenshots under `docs/design/rooms-2026-10/build-qa/phase2/`.

### Task 2.4: Phase gate

- [ ] Orchestrator applies the migration to the real database and verifies the columns/table exist.
- [ ] Security review (`security-review` skill) of the whole phase against Review Focus; whole-phase code review; full `npm run test:rooms`, `tsc`, `npm run build`.
- [ ] Update the handover progress table and the project memory.
