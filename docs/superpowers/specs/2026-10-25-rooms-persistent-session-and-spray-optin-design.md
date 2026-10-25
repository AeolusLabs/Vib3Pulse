# Rooms: persistent session (mini-bar) and spray opt-in (design)

Date: 2026-10-25. Status: owner decisions captured, awaiting spec review. Builds on rooms, voice (LiveKit), spray and gaming.

## Intent

1. A room must keep playing when the user leaves the room screen, like Twitter Spaces: a mini-bar stays docked, the user keeps using the app, and on a phone the audio keeps going in the background where the browser allows it.
2. A host must be able to start a room with spray, on purpose, and see why it is unavailable when it is.

## Findings (current code)

- The socket (`useRoomSocket`) and LiveKit connection (`useRoomVoice`) are created inside `RoomPageInner` (`client/src/pages/RoomPage.tsx`). Unmounting the page ends both (`useRoomVoice.ts:231` "leaving the page ends the session"; the socket sends `room:leave` on unmount). The Back arrow also calls `sock.leave()`. No global room state or mini-player exists; `RoomDock` is the in-room chat bar.
- Spray has no host switch. It is implicit: `sprayBlockFor` offers it when `ROOMS_SPRAY` is on, the room is live, 18+/21+ and not a minors' room, the host is an ID-verified adult with a payout subaccount, and the payer is a verified adult. The wizard's money step only renders the ticket price screen (needs `ROOMS_PAID`); with only spray on it shows "Paid rooms and spray notes are not available here yet".

## Decided by the owner (2026-10-25)

1. Spray is **off per room and opt-in at creation**.
2. **One room per user at a time.** The limit is per user and per device/tab; many rooms run live at once across the app, each user's bar shows only their own room. Opening a second room asks "Leave [first room] and join this one?" and never switches silently.
3. A game room's mini-bar **shows the live score and match**.
4. **Host warning:** a host leaving the screen of their own live room is offered "minimise" instead of "leave", and Leave on their own room carries a warning that it is their live audience.

## A. Persistent room session

- One app-level `RoomSessionProvider` owns the socket and the voice connection for the one joined room. `RoomPage` becomes a view onto that session: opening the same room re-attaches with no reconnect and no audio gap; opening another room goes through the confirm above.
- The session ends only on: explicit Leave, being kicked/removed, the room ending, sign-out, or the user confirming a switch to another room. Navigating, closing the room screen, or the Back arrow only **minimise**.
- `RoomMiniBar`, docked above the bottom navigation (and as a compact bar on desktop), on every page except the room's own screen. It shows: room title, host, speaking indicator, mute/unmute (speakers only), Expand, Leave. For a game room it also shows the match line (format, team names, live score) from the existing `GameView`.
- Lock-screen/notification controls through the Media Session API (title, mute toggle, leave).
- Reconnect behaviour is unchanged (`reconnecting` counts as live; the existing hold policy stays).
- Phone limit, stated to the user: Android Chrome keeps web audio playing in the background; iOS Safari often suspends it on screen lock and usually stops the microphone in the background. Reliable iOS background audio needs the native app. v1 ships the web version.
- All existing room rules are unchanged: age, minors' room, listen-only, tickets, kicks. The session reuses the same join path; nothing gets a new way in.

## B. Spray opt-in at creation

- New column `rooms.spray_enabled boolean NOT NULL DEFAULT false` (additive, idempotent, applied to the real DB in the same task; mirrored in `shared/schema.ts`, `ensureSchema` and a `migrations/*.sql` file, the same pattern as `add_rooms_game.sql`). Not a leaked field: guests see only whether spray is on, via the existing `spray` block.
- Wizard: a **Spray** switch in the money step, shown only when `ROOMS_SPRAY` is on and the room is 18+/21+ and the host is an adult. The step shows a readiness checklist (adult, ID verified, payout account added), each missing item linking to where it is fixed. The step must render for spray alone (today it requires `ROOMS_PAID`). The "not available yet" placeholder is removed.
- Server: create and PATCH accept `sprayEnabled` and refuse it with a clear code when the host is not eligible (not adult, not ID-verified, no payout account, room not 18+/21+, minors' room, flag off). `sprayBlockFor` returns null when `spray_enabled` is false. The host can switch it on or off in the room's Controls sheet, including while live.
- Existing rooms default to off. Nothing is sprayed in any room until its host opts in.
- Gaming: team spray and player spray require the room's `spray_enabled` as well.

## Rules the code must hold

- Everything stays behind existing flags; with `ROOMS_SPRAY` off, no new UI is reachable and the config body gains no field.
- Server is the authority for spray eligibility; the client switch is a request.
- One joined room per user per tab: the provider refuses a second join without the confirm, and the server's existing single-session behaviour is untouched.
- The session never outlives sign-out and never keeps a mic open after Leave.

## Non-goals (v1)

Native-app background audio; joining several rooms at once; picture-in-picture video; changing any money rule.

## Open items to verify later

Real-device pass (Android Chrome, iOS Safari lock screen); host-warning wording; whether the `spray_enabled` switch needs an admin override.
