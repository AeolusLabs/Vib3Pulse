# Rooms: gamers live (design)

Date: 2026-10-21. Status: owner decisions captured, awaiting spec review. Builds on the live screen (`2026-10-14-rooms-live-screen-design.md`), the stage, minors' rooms and spray.
Visual reference: `docs/design/rooms-2026-10/gamer-rooms-mockup.html` (interactive; example names/amounts; its spray amounts are stale, use the real tiers in `shared/spray.ts`).

## Intent

Gamers put their own screen into a room: 1v1, 2v2, 3v3, 4v4, plus a four-way grid and a spotlight view. Viewers back players with spray. Competitions (brackets, referees, prizes) are **version 2** and out of scope.

## Decided

- **Architecture: one pipeline, three ways onto it.** A player's screen is a LiveKit track whatever put it there. v1 sources: browser capture (`getDisplayMedia`, PC) and OBS/RTMP via LiveKit Ingress (PC, and console through a capture card). Native phone capture arrives with the native app and reuses the same track path.
- **Every player shares their own screen.** Up to 8 publish (4v4). Viewers see at most 4 tiles: one featured feed per team plus small thumbnails. Feeds nobody watches stop uploading (`dynacast`).
- **Who is featured.** The host picks the featured feed per team. Any viewer can follow another player on their own device (changes only that viewer's subscriptions).
- **Audio.** Only the featured feed plays game sound. Players share game audio only, never team voice chat (warned on the go-live sheet).
- **Spray: player or team.** Spraying a player is today's spray. Spraying a team splits equally between players still in the match, remainder to the featured player. It tips people; it is never a bet on the result.
- **Age lanes.** All ages may join; each age group (13-17, 18+) gets its own lane with its own matches, chat, spray, members and counts. Adults and teens never see or message each other.
- **Drops.** A dropped player keeps their slot, shown as "Reconnecting" with a countdown. If the host set a timeout and it runs out, the room posts "[name] has dropped out". "Hold slot" keeps it as is. Default 120 s (the existing `LIVE_HOLD_MS`); choices 30 s / 120 s / hold.
- **Quality.** Players choose Light 540p30, Smooth 720p60 or Sharp 1080p30 (game content hint "motion"). Viewers get the layer their tile size needs (720/360/180 p) via `adaptiveStream`.

## Decided by the owner (2026-10-22)

1. **Teen lane host.** A teen creates the teen lane (the room is a minors' room, host 17 or under). Adults may join it only through the existing minors'-room path: a personal invite from the host plus the acknowledged warning that they are entering a room with a minor or minors and that any misconduct is recorded and investigated. Nobody is routed into the other lane automatically.
2. **Team spray minimum = 500 NGN x the number of players on the team** (a team of 2 is 1,000). Equal split; each player's share is at least the 500 NGN minimum. Only spray tiers at or above that minimum are offered for a team.
3. **Mixed-age teams are allowed**, only through the invite path above (an invited adult may play in a teen lane, screen only, no microphone).
4. **Spectator delay is not in v1.** (It would hold the stream back 30-60 s so opponents cannot watch the other team live and use what they see; LiveKit has no built-in delay and it needs a broadcast pipeline, so it is a later item.)

## Still to confirm with Paystack test keys

How one team charge fans out to several recipient subaccounts, and refund behaviour of a split batch (the open G3 question). The build keeps one charge with one spray record per share and a shared batch id.

## Rules the code must hold

- Everything is behind `ROOMS_GAMING` (default OFF). Flag off = no route, WS message, UI or LiveKit change is reachable; the existing single-holder live screen is untouched and its `room:live` payload does not change.
- Schema changes are additive and applied to the real DB in the same task.
- The server is the authority: a client can ask, only the server grants. LiveKit sources are set by the server, and `sweepVoice` removes screen tracks from anyone who is not a current player.
- Player eligibility reuses `canBeOnStage` (teen rule, minors' room). Lane membership is decided by the server from the member's date of birth, never by the client.
- Stream keys are secrets: shown only to their owner, one per player per room, revoked when the player leaves, is removed, or the room ends; never logged or put in `room:state`.
- Teen lane is a minors' room (`minors_room=true`), so all existing minors' protections apply unchanged.

## Non-goals (v1)

Competitions and brackets; prizes and entry fees; recording; phone-native capture (native app); HLS/CDN for large audiences (cap stays `ROOM_LIMITS.liveVideoMax` = 50 viewers); spectator delay UI beyond the setting.
