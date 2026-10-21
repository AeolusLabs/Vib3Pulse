# Rooms build, phase 3: create-a-room wizard, host controls, discover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Before executing, expand each task below into step-level checkboxes with the writing-plans skill** (this file is task cards: files, interfaces, tests, acceptance). Phases 0 to 2 must be merged first.

**Goal:** Replace `CreateRoomDialog` with the five-step wizard whose options are driven by the shared age rules, give hosts the Controls sheet (requests, stage, people, settings, end), add pinned message, slow mode and room lock, rebuild the Rooms home with filters and states, and add reminders.

**Architecture:** Wizard rules are a pure client module mirroring `shared/roomRules.ts` (the server still validates). Host settings are three additive columns on `rooms`, set by `PATCH`, broadcast as one WS event, enforced in the chat and join paths.

**Tech Stack:** as phase 1 and 2.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md`. Visual reference: `docs/design/rooms-2026-10/flows.html` boards 1 (Find a room), 2 (Create a room), 5 (Hosting), 4 (Joining and waiting); screenshots `img/f-discover`, `f-start`, `f-audience`, `f-teenhost`, `f-features`, `f-requests`, `f-settings`.

## Global Constraints

Same as phases 0 to 2 (branch, schema applied in the same task, `toPublicUser`/`publicRoom`, no `req.login`, tsc baseline, tests green, copy rules). Plus:
- The wizard must never offer an option the server would refuse (adult host: no Teens only; teen host: no 18+/21+ and only Friends or Invite visibility; money options hidden unless the `paidRooms` or `spray` flag is on **and** the room is 18+/21+ with an adult host).
- Wizard labels for kinds are Party, Listening, Talk, Event (existing `ROOM_KINDS`). Live video is a toggle (existing `liveVideo`). No new kind.
- Do not break creating a room from an event or venue page (existing `eventId` / `venueId` linking, `LinkedRoomBanner`).

## Review Focus

- Host creates a scheduled room then edits the time into the past; a scheduled room whose time passed 24 hours ago is hidden (existing rule) but still editable by its host.
- Slow mode with two tabs from the same user; host and co-hosts are exempt; the notice includes how many seconds remain.
- A locked room must still admit its host, co-hosts, current members who reconnect, and anyone holding a valid invite token.
- Pinned message with HTML or very long text is stored as plain text, 200 characters, never rendered as HTML.
- Wizard on a 320 px wide screen and with the keyboard open: the footer buttons stay reachable.
- Teen host choosing `Friends` visibility then trying to switch to `Public` (server refuses `TEEN_PUBLIC`; wizard never offers it).
- Reminder job running twice (two server instances) must not send duplicate notifications.

---

### Task 3.1: Host settings columns and server rules

**Files:** Create `migrations/add_rooms_host_settings.sql`; modify `shared/schema.ts`, `server/storage.ts` (`ensureSchema`), `shared/rooms.ts` (`RoomInput`, `validateRoomInput`, `ROOM_LIMITS.pinned = 200`, `SLOW_MODES = [0, 5, 15, 30]`), `server/rooms/roomRoutes.ts` (`PATCH`), `server/rooms/roomSocket.ts` (chat slow mode, join lock, settings broadcast), `server/rooms/roomStorage.ts` (`RoomPatch`), `client/src/lib/roomReducer.ts` (`room:settings`).
**Interfaces:** columns `rooms.pinned_message text null`, `rooms.slow_mode_sec integer not null default 0`, `rooms.locked boolean not null default false`. WS out `{ type: "room:settings", pinnedMessage: string | null, slowModeSec: number, locked: boolean }` on every change and inside `room:state.room`. Chat refusal notice `{ type: "room:notice", code: "SLOW_MODE", retryMs: number }`. Join refusal `ROOM_LOCKED`. Permissions: host edits all three; co-host edits pinned message only.
**Tests (add to existing suites):** validator accepts `slowModeSec` 0, 5, 15, 30 and rejects 7 and "5"; pinned text is stripped to plain text and cut at 200; ws: member sends two chats within slow mode and gets `SLOW_MODE` with `retryMs` between 1 and 5000; host is exempt; lock refuses a new joiner with `ROOM_LOCKED` but admits the host and an existing member reconnecting; settings change is broadcast to everyone and appears in the state of a later joiner.
**Acceptance:** `npm run test:rooms` green; migration applied to the real DB and verified.

### Task 3.2: Wizard rules module (pure)

**Files:** Create `client/src/lib/createRoomRules.ts`. Test: `scripts/test-rooms-unit.ts`.
**Interfaces:** `export interface WizardHost { age: number | null; accountAgeDays: number; idVerifiedAdult: boolean }`, `export interface WizardState { title: string; description: string; kind: RoomKind; ageLimit: AgeLimit; visibility: RoomVisibility; anonymousAllowed: boolean; voice: boolean; liveVideo: boolean; slowModeSec: number; pinned: string; capacity: number; when: "now" | "later"; scheduledFor: string | null }`, `export function wizardOptions(host: WizardHost, flags: { paidRooms: boolean; spray: boolean }): { ageOptions: Array<{ value: AgeLimit; label: string; sub: string; disabledReason?: string }>; visibilityOptions: Array<{ value: RoomVisibility; disabledReason?: string }>; moneyLocked: string | null; anonymousNote: (s: WizardState) => string }`, `export function normalizeWizard(s: WizardState, host: WizardHost): WizardState` (forces legal combinations: adult host `teen` becomes `13+`; teen host `18+` becomes `13+`; teen host `public` becomes `friends`), `export function stepsFor(s: WizardState, flags): string[]`.
**Tests:** adult host: `teen` option has `disabledReason` "Only teens can host a teens only room."; teen host: `18+` and `21+` disabled "You need to be 18 to host an adult room." and `public` visibility disabled; `moneyLocked` is non-null for any `ageLimit` outside 18+/21+; for an adult at `18+` with flags off it is "Paid rooms and spray are not available yet."; `normalizeWizard` examples above; `anonymousNote` says adults cannot join anonymously for `13+` and `16+`, says anyone can for `18+`.

### Task 3.3: The wizard UI

**Files:** Create `client/src/components/rooms/create/CreateRoomWizard.tsx`, `Step*.tsx` (Basics, Audience, Features, When, Review, Done), `QuickStartSheet.tsx`; modify `client/src/pages/RoomsPage.tsx` (open the wizard), remove `CreateRoomDialog.tsx` once unused; keep event/venue entry points working.
**Interfaces:** `CreateRoomWizard(props: { open: boolean; onOpenChange(o: boolean): void; defaults?: Partial<WizardState>; link?: { eventId?: string; venueId?: string } })`. Uses `wizardOptions`, `normalizeWizard`, `stepsFor`. Submits `POST /api/rooms` (existing contract plus `anonymousAllowed`, `pinnedMessage`, `slowModeSec`), then `POST /api/rooms/:id/start` for "Go live now", then navigates to `/rooms/:id`. Done screen shows the room link with Copy and Share.
**Acceptance:** fixture-free manual run with an adult account and a teen account: every locked option shows its reason; going live creates and starts the room; scheduling creates a scheduled room that appears under Upcoming; keyboard-only completion works; screenshots match `img/f-start`, `f-audience`, `f-teenhost`, `f-features`.

### Task 3.4: Host Controls sheet

**Files:** Create `client/src/components/rooms/host/ControlsSheet.tsx`, `RequestsPanel.tsx`, `SettingsPanel.tsx`, `EndRoomDialog.tsx`; reuse `StagePanel.tsx` logic; modify `RoomPage.tsx` only through the existing `onControls` prop from phase 1.
**Interfaces:** tabs Requests (raised hands plus go-live asks, one-tap accept), Stage (mute, remove, make co-host), People (moderation: mute, remove 10 minutes, ban, report), Settings (pinned message editor, slow mode chips, lock room, allow anonymous guests, spray toggle shown only when `spray` flag and room money-eligible, voice and live video switches, End room). End asks "End for everyone?" with the count of people.
**Acceptance:** all actions use existing REST and WS endpoints plus the new `PATCH` fields; changes appear for other members within a second (`room:settings`); co-host sees only what they may do.

### Task 3.5: Rooms home, filters and empty states

**Files:** Modify `client/src/pages/RoomsPage.tsx`; create `client/src/components/rooms/home/RoomCard.tsx`, `FiltersSheet.tsx`.
**Interfaces:** tabs map to the existing scopes (`live`, `upcoming`, `friends` labelled Following); `RoomCard` shows cover colour block (deterministic from room id), title, host, age tag, kind, member count, friends-inside from `peek`, price chip later; filters: kind, friends inside, free or paid (visible only when `paidRooms` flag); empty state "Quiet right now" with Start a room.
**Acceptance:** rooms the viewer cannot join never appear (server filter from task 2.3); screenshot matches `img/f-discover`.

### Task 3.6: Room states

**Files:** Modify `RoomPage.tsx` branches and `RoomLobby.tsx`: not started (countdown, Remind me, Share), invite-only landing ("Mara invited you"), room full, removed (10 minutes), ended with recap placeholder.
**Interfaces:** maps server codes `ROOM_NOT_LIVE`, `ROOM_FULL`, `KICKED`, `BANNED`, `ROOM_ENDED`, `ROOM_LOCKED` to the copy in `flows.html` board 4.
**Acceptance:** each code reproduced by a ws test and a screenshot.

### Task 3.7: Reminders

**Files:** Create `migrations/add_room_reminders.sql`, `server/rooms/reminders.ts`; modify `shared/schema.ts`, `ensureSchema`, `roomRoutes.ts`, `shared/schema.ts` `notificationTypes` (add `"room_starting"`).
**Interfaces:** table `room_reminders(room_id, user_id, created_at, notified_at, primary key (room_id, user_id))`; `PUT /api/rooms/:id/reminder` and `DELETE` (self only, viewable rooms only); `startReminderJob(): void` runs every 60 seconds, claims rooms whose `scheduled_for` is 14 to 15 minutes away with `UPDATE ... SET notified_at = now() WHERE notified_at IS NULL RETURNING` (so two instances cannot double-send) and calls `storage.createNotification` (type `room_starting`) for each reminder plus the host.
**Tests:** api: set and clear reminder; job function called twice sends once; non-viewable room refused 404.

### Task 3.8: Phase gate

`npm run test:rooms`, tsc baseline, build; two-account real run (adult, teen); `code-review`; update handoff progress table; flip nothing else.
