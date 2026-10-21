# Rooms build, phase 1: chat-first UI, live video views, person actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tabbed room screen with the chat-first layout, add the compact and immersive live video views (immersive by default under 1024 px), swipe-to-reply, a reaction tray with a hype bar, a faded scrollbar, and View profile as the first person action.

**Architecture:** Presentational components in `client/src/components/rooms/shell/` and `.../chat/` composed by `RoomPage.tsx`. Only one small server change: an optional `replyTo` on chat messages. A dev-only fixture route renders every scene from seeded state so UI can be checked without sockets or LiveKit.

**Tech Stack:** React 18, TypeScript, Tailwind + shadcn/ui (`Sheet`, `Button`), TanStack Query, wouter, existing `useRoomSocket` and `roomReducer`.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md` (sections 2, 4). Visual reference: `docs/design/rooms-2026-10/rooms.html` (open it; scenarios Voice room, Live video, Immersive; screenshots in `img/r4` to `r10`).

## Global Constraints

- Branch `feat/rooms-redesign`; no push or merge without the owner's go-ahead. `docs/` stays untracked.
- Do not copy prototype CSS. Use the app's Tailwind and shadcn variables. Brand: violet is the one accent, amber only for money moments (none in this phase), no pink, Bodoni Moda only for text of 1.5rem and up, Jost for UI. Dark is the default theme; light must also work.
- Touch targets at least 44 px. Respect `prefers-reduced-motion`. Animate only `transform` and `opacity`. Hover styles only under `@media (hover: hover) and (pointer: fine)`. Safe-area insets on the dock.
- Icons: import from `@/components/ui/icons` (folder `client/src/components/ui/icons/`, one file per icon, exported in `index.ts`). If an icon is missing, add a file and an export. Also grep for object-literal usage (`icon: Search`) before any rename.
- Never put real user ids of anonymous people in new payloads (relevant from phase 2; do not introduce shapes that would block it: always address people by the `userId` field of `RoomMemberView`, never by username).
- Existing behaviour must keep working: voice, stage requests, live camera with reconnect hold, bandwidth profiles, sound only, weak link advice, host controls.
- Copy: no em dashes, no word "cash", plain words.
- `npx tsc --noEmit` error count must not exceed the baseline in `docs/superpowers/plans/2026-10-17-baseline.md`.

## Review Focus

- A long unbroken word or URL in a chat message must wrap inside the bubble without horizontal scroll at 320 px.
- 300 messages in 10 seconds: chat stays smooth, memory bounded (`CHAT_CAP` in the reducer), and a reader who scrolled up is not yanked down.
- A reply to a message whose author has left the room still renders (name remembered, or "Someone").
- Immersive view when the picture is audio only, or when the holder's connection drops (be-right-back slate), or when the viewer has "sound only" on.
- Keyboard and screen reader: the chat log announces new messages politely, the immersive rail buttons have labels, focus never gets trapped behind a hidden chrome layer.
- Tablet in portrait and landscape; desktop at 1280 px uses compact with a right-hand chat rail and never immersive.
- Reaction spam: tapping a reaction 20 times in 2 seconds must not exceed the server rate limit silently; show the existing "slow down" notice.

---

### Task 1.1: Dev fixture route and seeded room state

**Files:**
- Create: `client/src/lib/roomFixtures.ts`, `client/src/pages/dev/RoomFixture.tsx`
- Modify: `client/src/App.tsx` (add route `/dev/room-fixture`, only when `import.meta.env.DEV`)
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces: `export type FixtureScene = "voice" | "live" | "immersive" | "weak" | "dropped"`, `export function fixtureState(scene: FixtureScene): RoomState` (a fully valid state: 11 members including host, co-host, one on stage, one placeholder anonymous-looking guest labelled by name only, 9 chat lines, `liveVideo` and `holder` set for live scenes), `export const FIXTURE_NAMES: Record<string, string>` for `nameOf`.
- Consumes: `initialRoomState`, `roomReducer`, `RoomState` from `client/src/lib/roomReducer.ts`.
- The route reads `?scene=voice|live|immersive|weak|dropped` and `?theme=dark|light`.

- [ ] **Step 1: Failing test:** for each scene, `fixtureState(scene).members.length >= 8`, `.chat.length >= 6`, and feeding the state through `roomReducer` with a `client:self` event does not throw. For `live` and `immersive`, `liveVideo === true` and `holder` is a member id.
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`; see FAIL.
- [ ] **Step 3: Implement** `roomFixtures.ts` (pure).
- [ ] **Step 4: Implement the page.** It renders `RoomPage`'s building blocks with the seeded state and no network. At this task it renders the current `RoomChat`, `RoomScene` and `VoiceBar` so the route works; later tasks swap in new components.
- [ ] **Step 5: Verify in a browser** (use the `browse` skill): open `http://localhost:5077/dev/room-fixture?scene=voice` at 390x800. Expected: the page renders with 11 people and chat lines. Open without the dev server flag in a production build: the route must 404.
- [ ] **Step 6: Commit** `feat(rooms-ui): dev fixture route and seeded room state`.

### Task 1.2: Shell, top bar, dock, People and More sheets

**Owns (only this task may edit):** `client/src/pages/RoomPage.tsx`.

**Files:**
- Create: `client/src/components/rooms/shell/RoomFrame.tsx`, `RoomTopBar.tsx`, `RoomDock.tsx`, `PeopleSheet.tsx`, `RoomMoreSheet.tsx`
- Modify: `client/src/pages/RoomPage.tsx` (compose the shell; remove the Chat/People/Controls `Tabs`), `client/src/components/rooms/HostControls.tsx` and `StagePanel.tsx` only to be reachable from a Controls sheet
- Test: `scripts/test-rooms-unit.ts` (pure helpers), manual via fixture

**Interfaces:**
- Produces:
  - `RoomFrame(props: { layout: "stack" | "rail"; immersive: boolean; top: ReactNode; zone: ReactNode; pin?: ReactNode; chat: ReactNode; dock: ReactNode; floating?: ReactNode })`. `stack` is the phone and tablet layout (grid rows: top, zone, chat 1fr, dock). `rail` is desktop (video left, chat right 360 px, dock under the chat). When `immersive`, `zone` fills the frame and `chat`/`dock`/`top` are absolutely positioned over it.
  - `RoomTopBar(props: { title: string; ageLabel: string; hostName: string; isLive: boolean; subtitle?: string; count: number; immersive: boolean; onBack(): void; onPeople(): void; onMore(): void })` (data-testids `room-back`, `room-people`, `room-more`).
  - `RoomDock(props: { muted: boolean; reply: { userId: string; text: string } | null; onCancelReply(): void; onSend(text: string): void; onReact(emoji: string): void; trayOpen: boolean; onToggleTray(): void; voice: { hasHand: boolean; canAsk: boolean; onRaise(): void; onLower(): void; muteLocked?: string }; cam: { visible: boolean; pressed: boolean; onClick(): void; lockedReason?: string }; immersive: boolean; slowModeSec?: number })` (data-testids `dock-input`, `dock-send`, `dock-mic`, `dock-cam`, `dock-heart`).
  - `PeopleSheet(props: { open: boolean; onOpenChange(o: boolean): void; members: RoomMemberView[]; memberCount: number; selfId: string | null; hidden: Set<string>; onPick(m: RoomMemberView): void })`.
  - `RoomMoreSheet(props: { open: boolean; onOpenChange(o: boolean): void; roomId: string; isHost: boolean; canShare: boolean; onShare(): void; onSafety(): void; onReport(): void; onLeave(): void; onControls?: () => void })`.
- Consumes: existing `RoomState`, `RoomMemberView`, `useRoomSocket` returns.

- [ ] **Step 1: Failing unit test** for `client/src/lib/roomLayout.ts` (this task **owns** the width rule; task 1.5 imports it): `export const RAIL_MIN_WIDTH = 1024`, `export type VideoView = "compact" | "immersive"`, `export function defaultVideoView(width: number): VideoView` (under 1024 is `immersive`), `export function layoutFor(width: number, scene: "voice" | "live"): { layout: "stack" | "rail"; immersiveDefault: boolean }`. Cases: `defaultVideoView(390)`, `(768)`, `(1023)` are `immersive`; `(1024)`, `(1280)` are `compact`; `layoutFor(390, "live")` gives `stack`/true; `(1023, "live")` gives `stack`/true; `(1024, "live")` gives `rail`/false; `(1280, "voice")` gives `rail`/false; any width with scene `voice` gives `immersiveDefault` false. Run; see FAIL; implement; see PASS.
- [ ] **Step 2: Build `RoomFrame`, `RoomTopBar`** matching `rooms.html` voice scene (title one line with ellipsis, LIVE badge and host in the subtitle, people chip with count, More button). Verify via fixture at 390 and 1280 widths.
- [ ] **Step 3: Build `RoomDock`:** composer (16 px font to avoid iOS zoom), send button disabled when empty, reaction row (Wave, six emoji) for non-immersive, a single heart button that toggles the tray for immersive, mic (hand raise) and camera buttons with `aria-disabled` plus a visible reason toast when locked, reply chip above the input.
- [ ] **Step 4: Build `PeopleSheet` and `RoomMoreSheet`** (More: Share room, Room safety, Remind me about the next one is NOT in this phase, Report this room, Leave quietly; hosts also see Controls). Room safety text comes from `ruleList()` in `docs/design/rooms-2026-10/rooms.html` (read it) adapted to the room's `ageLimit`.
- [ ] **Step 5: Rewrite `RoomPage.tsx`** to compose the shell. Keep all state wiring (voice, stage, live, hold countdowns). Remove tabs. Host Controls opens in a sheet from More or from a host-only Controls chip in the top bar. Keep the lobby, ended, denied, scheduled and loading branches working.
- [ ] **Step 6: Verify** with the fixture and with a real local room (two users): chat visible without scrolling at 390x800; People and More open and close; Escape closes sheets; back button leaves the room via `sock.leave()`.
- [ ] **Step 7: `npx tsc --noEmit`** not above baseline; **commit** `feat(rooms-ui): chat-first shell, dock, people and more sheets`.

### Task 1.3: Chat log v2 with swipe-to-reply and quiet scrollbar

**Files:**
- Create: `client/src/components/rooms/chat/ChatLog.tsx`, `client/src/hooks/useIdleScrollbar.ts`, `client/src/lib/chatReply.ts`
- Modify: `shared/rooms.ts` (`ROOM_LIMITS.replyText = 120`, `ChatReply`, `validateChatReply`), `server/rooms/roomSocket.ts` (`room:chat` accepts and forwards `replyTo`), `server/rooms/RoomHub.ts` (`ChatLine.replyTo?`), `client/src/lib/roomReducer.ts` (`ChatItem.replyTo?`), `client/src/hooks/useRoomSocket.ts` (`chat(text, replyTo?)`), `client/src/index.css` (scrollbar rule)
- Test: `scripts/test-rooms-unit.ts`, `scripts/test-rooms-ws.ts`

**Interfaces:**
- Produces (shared): `export interface ChatReply { userId: string; text: string }`, `export function validateChatReply(x: unknown): ChatReply | null` (userId string up to 64 chars, text trimmed and cut to 120, rejects anything else including extra keys).
- Produces (client): `ChatLog(props: { chat: ChatItem[]; nameOf(userId: string): string; selfId: string | null; hidden?: Set<string>; immersive?: boolean; onReply(item: ChatItem): void; onHeart(item: ChatItem): void; onWave(userId: string): void; onPickAuthor(userId: string): void })`, `useIdleScrollbar(ref: RefObject<HTMLElement>, idleMs?: number): void` (sets `data-scrolling="true"` on wheel, touchstart, touchmove, pointerdown and keydown; clears after `idleMs`, default 1200), `swipeReply` pure helper `replyProgress(dx: number): { offset: number; reveal: number; commit: boolean }` (offset damps after 56 px, `commit` true at 56 or more, never negative).
- Behavior: sticks to the bottom only when within 48 px of it; otherwise shows a "N new messages" pill; tap a message toggles an action row (Heart, Reply, Wave unless it is yours); tap the avatar or name calls `onPickAuthor`; swipe right 56 px or more calls `onReply`; pointer events, `touch-action: pan-y`, a swipe suppresses the click that follows it.
- Scrollbar: CSS `.scroll-fade[data-scrolling="false"] { scrollbar-color: transparent transparent; transition: scrollbar-color 500ms }` and visible when `true` or on hover (fine pointers).

- [ ] **Step 1: Failing unit tests:** `validateChatReply({ userId: "u1", text: "  hi  " })` equals `{ userId: "u1", text: "hi" }`; a 300-character text is cut to 120; `validateChatReply({ userId: 5, text: "x" })` is null; extra key `{ userId: "u", text: "x", evil: 1 }` is null; `replyProgress(-20)` has offset 0 and `commit` false; `replyProgress(30)` has `commit` false; `replyProgress(60)` has `commit` true and offset below 80; reducer test: a `room:chat` event with `replyTo` stores it on the `ChatItem`; one without leaves it undefined.
- [ ] **Step 2: Failing ws test** in `scripts/test-rooms-ws.ts`: member A sends `{ type: "room:chat", text: "hello", replyTo: { userId: B, text: "earlier" } }`; member B receives a chat event whose `replyTo` equals that object; an invalid `replyTo` (number) is dropped but the message is still delivered without it; the chat ring buffer replayed to a new joiner includes `replyTo`.
- [ ] **Step 3: Run** `npm run test:rooms`; see FAIL.
- [ ] **Step 4: Implement** shared validator, server forwarding (validate with `validateChatReply`, never trust the client text), hub ring buffer, reducer and `useRoomSocket.chat`.
- [ ] **Step 5: Build `ChatLog` and the scrollbar hook and CSS.** Use `plainText` rules already applied server-side; render text as text, never HTML. Messages from `hidden` ids are filtered. Keep `role="log"` and `aria-live="polite"`; in immersive set `aria-live="off"` if the dock's log is mounted elsewhere to avoid double announcements.
- [ ] **Step 6: Verify** via fixture: swipe with mouse drag and with touch emulation; scroll up and receive messages (the pill appears, tapping it scrolls down); idle scrollbar fades after about a second; 320 px width has no horizontal scroll.
- [ ] **Step 7: Run** `npm run test:rooms` green; **commit** `feat(rooms-ui): chat log with swipe reply, new-message pill, quiet scrollbar`.

### Task 1.4: Reaction tray and hype bar

**Files:**
- Create: `client/src/lib/hype.ts`, `client/src/components/rooms/chat/ReactionTray.tsx`
- Modify: `client/src/components/rooms/shell/RoomDock.tsx` (hype bar slot and tray)
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces: `export const HYPE = { perReaction: 12, perHeart: 6, decayPerSec: 3, max: 100 } as const`, `export function hypeNext(value: number, event: "reaction" | "heart", now?: number): { value: number; burst: boolean }`, `export function hypeDecay(value: number, dtSec: number): number`, `ReactionTray(props: { emojis: readonly string[]; onPick(e: string): void; open: boolean; onClose(): void })`.
- Behavior: any reaction from anyone in the room adds `perReaction` (the client counts reactions it receives, including its own); at 100 the bar bursts once (`burst: true`) and resets to 0; decays 3 per second; never below 0; the tray scales in from the heart button (`transform-origin` bottom right), closes after a pick, Escape and outside tap.

- [ ] **Step 1: Failing tests:** `hypeNext(0, "reaction")` equals `{ value: 12, burst: false }`; `hypeNext(95, "reaction")` equals `{ value: 0, burst: true }`; `hypeDecay(10, 2)` is 4; `hypeDecay(1, 5)` is 0; nine consecutive reactions from 0 burst on the ninth.
- [ ] **Step 2: Run, see FAIL; implement; see PASS.**
- [ ] **Step 3: Build the tray and wire the bar into the dock** (a 4 px bar above the composer; `aria-hidden`; on burst fire a floating-emoji burst with the existing `room-float` class and a toast "Hype moment").
- [ ] **Step 4: Verify** via fixture: 9 taps trigger the burst; tray opens and closes; Escape closes.
- [ ] **Step 5: Commit** `feat(rooms-ui): reaction tray and hype bar`.

### Task 1.5: Live video views (compact, immersive, rail)

**Files:**
- Create: `client/src/lib/videoViewState.ts`, `client/src/hooks/useVideoView.ts`, `client/src/components/rooms/shell/ImmersiveRail.tsx`, `client/src/components/rooms/shell/SpeakerStrip.tsx` (imports `VideoView` and `defaultVideoView` from `client/src/lib/roomLayout.ts`, created in task 1.2: if 1.2 has not merged yet, stub the import against the interface below and rebase)
- Modify: `client/src/components/rooms/ScreenStage.tsx` (add `layout: "compact" | "immersive"` and make overlays layout-aware; keep every existing prop and behavior), `client/src/components/rooms/RoomScene.tsx` (strip variant)
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces: `export function viewAfterResize(current: VideoView, userChose: boolean, widthBefore: number, widthAfter: number): VideoView` (pure, in `videoViewState.ts`: if the width crosses the 1024 line the view resets to `defaultVideoView(widthAfter)`; otherwise a user's choice is kept), `export function useVideoView(isLive: boolean): { view: VideoView; setView(v: VideoView): void; chromeHidden: boolean; toggleChrome(): void }` (view starts at `defaultVideoView(window.innerWidth)`; `chromeHidden` only meaningful in immersive), `ImmersiveRail(props: { qualityLabel: string; soundOnly: boolean; onQuality(): void; onSoundOnly(): void; onExit(): void })` (three 44 px buttons with visible labels to screen readers), `SpeakerStrip(props: { members: RoomMemberView[]; stage: string[]; speaking: string[]; selfId: string | null; onPick(m: RoomMemberView): void })`.
- Behavior: immersive: picture fills the frame; top bar shows title and "`<holder>` is live, `<n>` watching"; LIVE badge shown once (not twice); tapping the picture (not a button) toggles `chromeHidden` which fades top bar, rail and dock (opacity 200 ms, `pointer-events: none`) but never chat; the first time per browser a toast says "Tap the picture to hide controls" (localStorage key `rooms.immersiveHint`, try/catch); weak-link banner, be-right-back slate, sound-only panel and quality sheet keep working in both views.

- [ ] **Step 1: Failing tests** for `viewAfterResize`: phone to tablet width (390 to 768) keeps a user's `compact` choice; 768 to 1280 resets to `compact` even if the user chose `immersive`; 1280 to 768 resets to `immersive`; without a user choice the default always follows the width.
- [ ] **Step 2: Run, FAIL; implement; PASS.**
- [ ] **Step 3: Read `ScreenStage.tsx` end to end.** Then add the `layout` prop: compact keeps today's picture with a 16:9 box and overlay chips; immersive fills its parent (`absolute inset-0`, `object-cover` on the video element) and hides its own LIVE chip and quality chip (the rail and top bar own them).
- [ ] **Step 4: Build `ImmersiveRail` and `SpeakerStrip`.** The strip shows host, co-hosts and stage guests (about 44 px avatars, speaking ring from `useRoomVoice().activeSpeakers`).
- [ ] **Step 5: Verify** via fixture scenes `live`, `immersive`, `weak`, `dropped` at 390, 768 and 1280 widths: immersive default under 1024, compact at 1280 with chat rail, Exit and expand switch views, chrome hide works and chat stays readable, weak banner shows, dropped slate shows a countdown.
- [ ] **Step 6: Real test:** two browsers against a scratch DB and the real LiveKit credentials from `.env` (see the baseline recipe): holder goes live with a fake camera (`--use-fake-device-for-media-stream`); viewer sees immersive on a phone-width window; cut the holder's network and see the slate resume. If real LiveKit is unavailable, say so in the handoff log and rely on fixtures.
- [ ] **Step 7: Commit** `feat(rooms-ui): compact and immersive live video views`.

### Task 1.6: View profile and the profile peek sheet

**Files:**
- Create: `client/src/components/rooms/ProfilePeekSheet.tsx`
- Modify: `client/src/components/rooms/AvatarActionsSheet.tsx` (View profile first)
- Test: manual via fixture; unit test for the pure `profilePath`

**Interfaces:**
- Produces: `export function profilePath(m: { username?: string | null; userId: string }): string` returns `/profile/<username>` when a username exists, otherwise `/user/<userId>` (both routes exist in `client/src/App.tsx`); `ProfilePeekSheet(props: { open: boolean; onOpenChange(o: boolean): void; member: RoomMemberView | null })` shows avatar, name, username, short bio and counts from `GET /api/users/:identifier` (public profile; never DOB, email or phone), and an "Open full profile" button that navigates (and so leaves the room; say so in one line).
- Behavior: in `AvatarActionsSheet` the first row is "View profile" and opens `ProfilePeekSheet`. For yourself it reads "View my profile". The row must be driven by a prop `canViewProfile: boolean` that is true for everyone in this phase (phase 2 sets it false for anonymous guests).

- [ ] **Step 1: Failing test:** `profilePath({ username: "ada", userId: "1" })` is `/profile/ada`; with no username it is `/user/1`; a username with a slash or spaces is encoded.
- [ ] **Step 2: Implement; PASS.**
- [ ] **Step 3: Build the sheet** and wire it into the actions sheet. Add a `canViewProfile` prop defaulting to true.
- [ ] **Step 4: Verify** in a two-user local test that the peek shows no private fields (inspect the network response in the browser).
- [ ] **Step 5: Commit** `feat(rooms-ui): view profile action and peek sheet`.

### Task 1.7: Integration, accessibility and visual QA

**Owns:** `client/src/pages/RoomPage.tsx` again (single owner after tasks 1.2 to 1.6 land).

- [ ] **Step 1: Wire `ChatLog`, `ReactionTray`, `useVideoView`, `ImmersiveRail`, `SpeakerStrip`, `ProfilePeekSheet` into `RoomPage.tsx`** and remove superseded code (old `RoomChat` usage, tab triggers). Delete `RoomChat.tsx` and `MemberList.tsx` only after nothing imports them.
- [ ] **Step 2: Accessibility pass:** every icon-only button has `aria-label`; focus rings visible; sheets trap focus and return it; `prefers-reduced-motion` removes floating emoji and tray scale; colour contrast of chat text over the immersive picture uses the scrim.
- [ ] **Step 3: Visual QA matrix** with the `browse` skill: scenes voice, live, immersive, weak, dropped at 375, 768, 1280 widths, dark and light. Save screenshots under `docs/design/rooms-2026-10/build-qa/phase1/`. A reviewer subagent compares them with `docs/design/rooms-2026-10/img/r4` to `r10` and lists differences. Fix differences that are not intentional.
- [ ] **Step 4: Regression:** `npm run test:rooms` (unit, api, ws all green), `npx tsc --noEmit` not above baseline, `npm run build` exits 0.
- [ ] **Step 5: Real two-user run** on the local dev server: join, chat, reply by swipe, react nine times to see the burst, open People, More, a person's actions, View profile, go live with a fake camera, switch views.
- [ ] **Step 6: Phase gate:** run the `code-review` skill on the diff; fix; update the progress table in `HANDOVER_ROOMS_BUILD_2026-10-17.md`.
