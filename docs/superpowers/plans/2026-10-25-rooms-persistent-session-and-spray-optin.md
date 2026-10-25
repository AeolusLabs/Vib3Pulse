# Rooms: persistent session and spray opt-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A joined room keeps playing behind a docked mini-bar while the user uses the rest of the app, and a host can switch spray on, on purpose, when creating or running a room.

**Architecture:** Lift `useRoomSocket` and `useRoomVoice` out of `RoomPageInner` into one app-level `RoomSessionProvider`; `RoomPage` and a new `RoomMiniBar` are two views of that one session. Spray becomes an explicit per-room column `rooms.spray_enabled` (default false) checked by the server, with a wizard switch and a Controls-sheet toggle.

**Tech Stack:** React + wouter + TanStack Query, `livekit-client`, Express + `ws`, Drizzle/Postgres, existing room test runner (`npm run test:rooms`).

**Spec:** `docs/superpowers/specs/2026-10-25-rooms-persistent-session-and-spray-optin-design.md`

## Global Constraints

- Two agents only, both **Sonnet 5.5** (never Opus): one backend, one frontend; the orchestrator merges and owns the DB.
- Frontend agent applies the design skills: /hallmark, /impeccable, /emil-design-eng, /ui-ux-pro-max (touch targets 44px, `prefers-reduced-motion`, no emoji icons, no layout-shifting hover, ease-out under 300ms, tokens from `DESIGN.md`, amber reserved for premium).
- Schema change is additive, idempotent, **applied to the real DB in the same task** (CLAUDE.md rule), mirrored in `shared/schema.ts`, `ensureSchema` and `migrations/*.sql`.
- Server is the authority for spray eligibility; the client switch only asks. With `ROOMS_SPRAY` off nothing new is reachable and no response gains a field.
- No endpoint response may carry sensitive fields; reuse `publicRoom`/`hostRoom` shaping.
- One joined room per user per tab. A second join needs the explicit confirm; never a silent switch.
- Do not run suites or builds until every task is built; ONE full `npm run test:rooms`, tsc (baseline 10 errors), `npm run build` at the end (workflow rule). Write the tests with the code.
- Stage files by name; push to origin only after the build is verified.

## Review Focus

- A hosted live room whose host minimises or closes the tab: the room must not end or look abandoned (existing live-grace behaviour must still hold).
- Kicked, banned, ended or age-evicted while minimised: the bar disappears and the reason is shown on next open, with the mic released.
- Sign-out or session expiry while a room is joined: the session tears down, no audio or mic left running.
- Two tabs/devices for one user: each holds its own session; the server's existing behaviour must not regress.
- A host flips `sprayEnabled` off while a spray is mid-checkout: the in-flight charge still delivers (no-refund rule), new sprays are refused.
- Existing rooms (no column value) behave as spray off; a gaming room needs `sprayEnabled` for player and team spray.

---

### Task 1: Column `rooms.spray_enabled` (backend; orchestrator applies to the real DB)

**Files:**
- Create: `migrations/add_rooms_spray_enabled.sql`, `server/rooms/roomSprayEnabledMigration.ts`
- Modify: `shared/schema.ts` (rooms table), `server/storage.ts` (ensureSchema hook, next to the game/spray-batches hooks)
- Test: `scripts/test-rooms-unit-sprayenabled-migration.ts`

**Interfaces:**
- Produces: `ROOM_SPRAY_ENABLED_SCHEMA_SQL: string`; `rooms.sprayEnabled: boolean` (drizzle, `spray_enabled`, NOT NULL DEFAULT false).

- [ ] Write the test: the SQL string equals the statements between BEGIN/COMMIT in the `.sql` file, contains `ADD COLUMN IF NOT EXISTS spray_enabled boolean NOT NULL DEFAULT false`, and is idempotent text (no DROP).
- [ ] Add the schema field, migration module and file; hook it into `ensureSchema`.
- [ ] Orchestrator applies the migration to the real database and confirms the column exists and existing rows read `false`.
- [ ] Commit.

### Task 2: Server rules for `sprayEnabled` (backend)

**Files:**
- Modify: `server/rooms/roomRoutes.ts` (POST /api/rooms ~l.201, PATCH ~l.470-580, config `features`), `server/rooms/roomStorage.ts` (`CreateInput.sprayEnabled?: boolean`, `RoomPatch` gains `sprayEnabled`), `server/rooms/roomAccess.ts` (expose `sprayEnabled` to host and members only through the existing shaping, not to strangers), `server/rooms/spray.ts` (`sprayBlockFor`, `sprayGate` return not-eligible when `room.sprayEnabled !== true`), `server/rooms/teamSpray.ts` (same gate), `shared/rooms.ts` (`SPRAY_ENABLE_CODES`, messages)
- Test: `scripts/test-rooms-api-sprayoptin.ts`, update `scripts/test-rooms-api-spray.ts`, `scripts/test-rooms-ws-spray.ts` fixtures to set `sprayEnabled: true` on spray rooms

**Interfaces:**
- Consumes: `sprayAllowed()`, `moneyEligibleRoom`, `isIdVerifiedAdult`, `subaccountOf(userId)`.
- Produces: `canEnableSpray(host, room): Check<"FEATURE_OFF"|"HOST_NOT_ADULT"|"HOST_NOT_VERIFIED"|"NO_PAYOUT_ACCOUNT"|"ROOM_NOT_ADULT">` in `shared/roomRules.ts` (pure, fails closed, same order as `canSellTickets`); `GET /api/rooms/config` gains `features.spray` unchanged plus `hostMoneyReadiness` only for the signed-in host: `{ adult: boolean; idVerified: boolean; payoutAccount: boolean }`.

- [ ] Tests (names): `create with sprayEnabled by an eligible host stores true`; `create refused with code per failing rule (flag off, teen host, unverified, no payout, 13+ room, minors room)`; `unknown or non-boolean sprayEnabled is a 400 on field sprayEnabled`; `PATCH toggles on and off while live and hub follows`; `sprayBlockFor is null when spray_enabled is false even with every other rule met`; `in-flight spray still delivers after the host turns it off`; `team spray refused when off`; `default for a room created without the field is false`.
- [ ] Implement `canEnableSpray` and wire create + PATCH to it (check before ticket checks; 403 `{code, message}`), set the column, gate `sprayGate` at phase "start" only (phase "deliver" must still pass).
- [ ] Add `hostMoneyReadiness` to the config response for the host only; verify no other viewer's body changes (assert byte-equality for a guest).
- [ ] Commit.

### Task 3: Wizard switch, checklist and Controls toggle (frontend)

**Files:**
- Modify: `client/src/lib/createRoomRules.ts` (`stepsFor` shows "money" for spray alone; `wizardOptions` unchanged contract), `client/src/lib/createRoomWizardUi.ts` (remove the "not available yet" copy use), `client/src/components/rooms/create/CreateRoomWizard.tsx` (step render, `moneyPlaceholder`), `client/src/components/rooms/create/createRoomApi.ts` (`buildCreatePayload` sends `sprayEnabled`), `client/src/components/rooms/host/ControlsSheet.tsx` (live toggle via PATCH), `client/src/lib/roomsApi.ts` (types)
- Create: `client/src/components/rooms/create/StepSpray.tsx`
- Test: `scripts/test-rooms-unit-wizard-spray.ts`

**Interfaces:**
- Consumes: Task 2 config `hostMoneyReadiness`, create/PATCH `sprayEnabled`, error codes of `canEnableSpray`.
- Produces: `WizardState.sprayEnabled: boolean` (default false); `StepSpray({ value, onChange, readiness, ageLimit })`.

- [ ] Tests: `stepsFor includes "money" when only spray flag on and host/room eligible`; `excludes it for a teen host or a 13+ room`; `payload sends sprayEnabled only when true and the flag is on`; `checklist lists each missing item with its fix link`; `switch is disabled with a reason until readiness is met`.
- [ ] Build `StepSpray`: one switch (default off), a three-row readiness checklist (adult, ID verified, payout account added; each missing row links to its settings screen), helper line "Spray is non-refundable for people who tip", price step only when tickets are also on.
- [ ] Controls sheet: same switch for the host while the room is scheduled or live; confirm copy when turning off during a live room ("People can't tip once this is off").
- [ ] Remove the placeholder path; make sure nothing renders when `ROOMS_SPRAY` is off.
- [ ] Commit.

### Task 4: `RoomSessionProvider`, page becomes a view (frontend)

**Files:**
- Create: `client/src/lib/roomSession.tsx` (provider + `useRoomSession()`), `client/src/lib/roomSessionRules.ts` (pure rules)
- Modify: `client/src/App.tsx` (wrap routes inside the auth provider), `client/src/pages/RoomPage.tsx` (consume the session instead of calling the two hooks; keep all denial/ticket/lobby screens), `client/src/hooks/useRoomVoice.ts` (remove the unmount `hangUp` coupling: `useEffect(() => hangUp, [hangUp])` moves to the provider's teardown), `client/src/hooks/useRoomSocket.ts` (leave-on-unmount moves to the provider)
- Test: `scripts/test-rooms-unit-roomsession.ts`

**Interfaces:**
- Produces:
  - `useRoomSession(): { active: { roomId: string; token: string | null } | null; sock: ReturnType<typeof useRoomSocket> | null; voice: RoomVoice | null; open(roomId, opts: { inviteToken?: string; enabledVoice: boolean }): "attached" | "needs-confirm"; confirmSwitch(): void; cancelSwitch(): void; pendingSwitch: { from: string; to: string } | null; minimise(): void; leave(): void; expanded: boolean }`.
  - `sessionAction(prev: ActiveRef | null, next: ActiveRef): "attach" | "confirm" | "start"` and `shouldEnd(state: SocketPhase, reason?: string): boolean` (true for `ended`, `denied`, kicked) in `roomSessionRules.ts`.
- Rule: navigating or Back = `minimise()` (session lives); `leave()` = explicit end (socket `room:leave`, `voice.hangUp`, mic released); sign-out calls `leave()`.

- [ ] Tests: `same room re-attaches without a second join`; `a different room returns confirm and does not touch the live one`; `ended/denied/kicked end the session`; `sign-out ends it`; `minimise keeps wantJoined true`; `leave sends exactly one room:leave`.
- [ ] Implement the provider so one `useRoomSocket(active.roomId)` and one `useRoomVoice(...)` live for the joined room only; `RoomPageInner` reads them (the `key={id}` clean-slate stays for the page's own queries).
- [ ] Host: Back arrow on their own live room becomes minimise; explicit Leave on their own live room shows the host warning ("You're hosting this live room. Leave and end your seat?") and still requires confirm.
- [ ] Keep `reconnecting` counted as live; do not change reconnect/hold policy.
- [ ] Commit.

### Task 5: `RoomMiniBar`, game match line, Media Session (frontend)

**Files:**
- Create: `client/src/components/rooms/shell/RoomMiniBar.tsx`, `client/src/lib/mediaSession.ts`
- Modify: `client/src/components/BottomNavigation.tsx` or `App.tsx` layout (mount the bar above the bottom nav; compact bar on desktop; hidden on the room's own route), `client/src/components/rooms/shell/RoomShell.tsx` (Minimise control, calls `useRoomSession().minimise`)
- Test: `scripts/test-rooms-unit-minibar.ts`

**Interfaces:**
- Consumes: Task 4 `useRoomSession`; `GameView` from `client/src/lib/gameScreen.ts` for format, team names and score.
- Produces: `matchLine(game: GameView | null): string | null`; `setMediaSession(opts: { title: string; host: string; muted: boolean; onToggleMute(): void; onLeave(): void }): () => void`.

- [ ] Tests: `matchLine returns null with no game and "2v2 · Team A 3 - 1 Team B" shape with one`; `bar hidden on the room route and shown elsewhere`; `mute shown only when the user can publish`; `Leave on own live room asks the host warning`; `Media Session handlers set on mount and cleared on unmount`.
- [ ] Bar content: title, host, speaking indicator (transform/opacity only), mute (speakers), Expand, Leave; 44px targets, safe-area padding, no layout shift when the bar appears (reserve space via a CSS variable on the app shell).
- [ ] Lock-screen controls via `navigator.mediaSession` (play/pause maps to mute toggle, `hangup` maps to leave).
- [ ] Switch-room confirm dialog: "Leave [first room] and join this one?" Confirm/Cancel, no silent switch.
- [ ] Phone limits note in a one-line help text in the bar's overflow ("On iPhone, audio can pause when the screen locks").
- [ ] Commit.

### Task 6: Integration tests, ledger and single full run (orchestrator)

**Files:** `scripts/run-rooms-tests.mjs` suite list (add the new suites), `.superpowers/sdd/2026-10-25-rooms-persistent-session-and-spray-optin/progress.md`

- [ ] Add the five new suites to the runner; run `npm run test:rooms` once (scratch DB in UTC), `tsc` against the 10-error baseline, `npm run build`.
- [ ] Browser pass (desktop, phone-width): create a room with spray on, join as a second adult, navigate across the app with the bar, switch rooms with the confirm, host warning, kicked-while-minimised. Real-device iOS/Android audio is reported as unverified if not run.
- [ ] Update `memory/project_rooms_gaming.md` or add `project_rooms_persistent_session.md` with outcomes and open items, then push after the build is verified.

## Amendment (2026-10-25, owner: "I did not see anywhere to start a paid room")

Paid rooms were also invisible: the "Paid room" switch sits in the Features step and renders only when ROOMS_PAID is on, the host is an adult and the room is 18+/21+; otherwise nothing or a vague placeholder shows. Task 3 therefore builds ONE always-visible **Money** section in the wizard (adult rooms): two switches, "Paid room" (ticket price step follows) and "Spray", plus a shared readiness checklist (adult, ID verified, payout account, 18+/21+ room, feature switched on by the platform) where every unmet item says why and links to the fix. Hosts of non-adult rooms see the section locked with the reason ("Change the room to 18+ to sell tickets or take spray"). The config field is named `hostMoneyReadiness` (covers both). The old placeholder copy is removed. The Controls sheet shows the same two states for a scheduled room.
