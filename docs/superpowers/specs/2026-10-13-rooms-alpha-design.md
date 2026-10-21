# Rooms alpha (parts 1 and 2): design

Status: approved 2026-10-13 after review round 1 (all-ages rooms with a bouncer, capacity 50, richer screen, minimum age 13). Context and decisions: [2026-10-13-rooms-roadmap.md](2026-10-13-rooms-roadmap.md).

## Goal

Hosts can open a virtual room (optionally attached to an event or venue). Guests join as their avatar, appear in a 2D club scene, see the host's screen, chat, react, and interact with other avatars under privacy rules. No audio and no money in this alpha.

## Scope

In:
1. Rooms: create, schedule, start, end, list, join, leave.
2. Live presence over the existing `/ws` server.
3. 2D scene: screen, stage, dance floor of avatars, reactions, text chat.
4. Screen content (alpha): the host pastes a link; supported providers play inside the room screen, anything else becomes a link card. Every guest can tap the screen to go fullscreen and can open the item in their own app or site (see "The screen").
5. Tap-an-avatar slide-out with follow-gated actions.
6. Room privacy settings per user.
7. Moderation: mute, kick, ban, report; host roles; abuse limits.
8. Discovery: Rooms tab (Live now, Upcoming, Friends' rooms), "Join the virtual room" on event/venue pages, push when a followed host goes live.

Out (later parts): live audio and mic requests, uploaded video, synced playback beyond the embed's own player, gifts and credits, paid rooms, recording (never), avatar movement beyond assigned spots, 3D, under-18s.

## Rules inherited

- **Rooms are open to all ages; the host sets a room age limit and the platform enforces it like a bouncer.** Limits: `all` (platform minimum age, 13), `13+`, `16+`, `18+`, `21+`. Enforced at join over both REST and WebSocket, and re-checked on reconnect. A user whose age is unknown cannot enter any room.
- **Birthdate is locked after signup.** `users.dateOfBirth` can no longer be changed through the profile PATCH or Edit Profile (shown read-only); corrections go through an admin route with an audit entry. Existing users keep their stored value, which becomes locked. This closes the "edit my age to get in" hole.
- **Age bands:** under 18 is the teen band, 18 and over is the adult band. Direct interactions (wave, private reaction, DM from the slide-out, room invite) work only within the same band. Everyone in a room can still see the scene and use room chat (moderated). Teens never appear in public discovery as hosts; teen-hosted rooms are `friends` or `invite` only.
- Under-18s cannot buy credits, gift or earn (part 4); this applies from the first gifts release.
- Platform minimum age is 13 (confirmed). Signup does not enforce it today, so enforcing it (server and signup form) is the first task of the plan. Age verification by an ID or age-check provider is deferred to a later phase.
- Accounts younger than `min_account_age_days` (existing moderation config) cannot host public rooms; thresholds live in `moderation_config`, admin-editable.
- Blocks are enforced both ways with the existing `isBlockedEitherWay` / `blockedWith`.
- Avatar data shown to others is the public avatar config already in user payloads (`toPublicUser`); no new personal data is exposed.
- Schema changes are applied to the production database in the same task (additive, nullable or defaulted).
- No push or commit without being asked.

## Data model

```
rooms
  id uuid pk, host_id -> users, title text(1..80), description text(0..500)
  kind: 'party' | 'listening' | 'talk' | 'event'
  visibility: 'public' | 'friends' | 'invite'
  event_id -> events null, venue_id -> venues null          (at most one)
  invite_token text null (hashed, for 'invite')
  scheduled_for timestamp null, started_at null, ended_at null
  status: 'scheduled' | 'live' | 'ended'
  age_limit: 'all' | '13+' | '16+' | '18+' | '21+' default 'all'
  capacity int default 50 (admin config max 100)
  no_direct_interactions boolean default false
  screen jsonb null   { v:1, type:'image'|'embed', url, provider?:'youtube'|'vimeo', title? }
  moderation_status text default 'approved'   (public rooms from new accounts: 'pending')
  created_at

room_members
  room_id, user_id  pk
  role: 'host' | 'cohost' | 'guest'
  joined_at, left_at null
  muted boolean default false (chat), banned boolean default false

users.room_privacy jsonb null   -> { v:1, interactions:'everyone'|'mutuals'|'none', appearInLists:boolean, allowInvites:boolean }
  null = defaults { interactions:'mutuals', appearInLists:true, allowInvites:true }
```

Screen URLs are validated against an allow-list of embed hosts (`youtube.com`, `youtu.be`, `vimeo.com`) and https image URLs from our own media store or an allowed CDN; never arbitrary iframes. Chat is not stored beyond the live session except what reports capture (the last 50 messages of the room are kept in memory and attached to a report).

## Interaction rules (the slide-out)

`canInteract(actor, target, room)`: false if either blocks the other; false if `room.no_direct_interactions`; otherwise by `target.room_privacy.interactions`: `everyone` allows, `mutuals` requires both users to follow each other (`follows` rows both ways), `none` denies. The actor's own setting does not restrict them sending, but they cannot interact with someone who has opted out.

Age band rule (applies after the block and privacy rules): actor and target must be in the same band, otherwise wave, private reaction, DM and invite are not offered and the server rejects them.

Slide-out contents:
- Always: view profile, report, block, mute locally (client-only).
- When `canInteract`: wave (room-visible animation), private reaction (only target sees), direct message (opens the existing chat), invite to another room (if target `allowInvites`).
- Host and co-hosts additionally: mute chat, remove from room, ban from room.

Every interaction event goes through the server which re-checks `canInteract`; the client slide-out is a convenience, not the gate.

## WebSocket protocol (on `/ws`, room channel messages)

Client to server: `room:join {roomId, inviteToken?}`, `room:leave`, `room:chat {text}`, `room:react {emoji}`, `room:interact {targetId, kind:'wave'|'reaction', emoji?}`, `room:screen {screen}` (host/cohost), `room:mod {action:'mute'|'unmute'|'kick'|'ban', targetId}`.

Server to client: `room:state {room, members[], screen, you:{role,muted}}` on join, `room:joined {member}`, `room:left {userId}`, `room:chat {userId, text, at}`, `room:react {userId, emoji}`, `room:interact {fromId, kind, emoji?}` (only to the target, or room-wide for waves), `room:screen {screen}`, `room:mod {action, targetId}`, `room:ended`, `room:error {code}`.

Server validates every message: membership, role, rate limits (chat 1/s burst 5, reactions 3/s, interactions 1/2s per target), text length 1..300, emoji from a fixed set, and content filtering using the existing sanitizer. A user can be in one room at a time; joining another leaves the first.

Members payload is capped: the server sends the first 40 by join order plus `memberCount`; the client renders those as avatars and "+N". Presence updates are deltas.

## Architecture

- `server/rooms/RoomHub.ts`: interface `{ join, leave, broadcast, sendTo, members, count }` with an in-memory implementation holding live room state. Persistent state (rooms, members, bans) is in Postgres; live presence is memory-only and rebuilt by clients reconnecting.
- `server/rooms/roomRoutes.ts`: REST for create/list/get/update/start/end, moderation, privacy, reports, discovery.
- `server/websocket.ts`: routes `room:*` messages to the hub after existing session auth.
- Host disconnect: 2 minutes grace, then the room ends automatically; guests are told.
- Server restart: clients reconnect and re-send `room:join`; rooms with `status='live'` and no hub state are rehydrated lazily.
- Limits: capacity per room (default 50), max live rooms per host (1), max scheduled rooms per host (10).

REST (all require auth unless noted): `POST /api/rooms`, `GET /api/rooms?scope=live|upcoming|friends`, `GET /api/rooms/:id`, `PATCH /api/rooms/:id` (host), `POST /api/rooms/:id/start|end`, `POST /api/rooms/:id/report`, `PUT /api/users/me/room-privacy`. Moderation actions that must survive reconnects (ban) are REST + persisted.

## Client

- `/rooms` page (tabs: Live now, Upcoming, Friends) and `/rooms/:id` room page. Create/schedule dialog (title, kind, visibility, link to my events or venues, schedule, screen).
- Room scene (`RoomScene`): back wall screen (image or embedded player in a sandboxed iframe `allow` limited), stage row for host and co-hosts using `Avatar mode="bust"`, dance floor grid for guests, reaction bursts, chat drawer, member count, host controls bar.
- Slide-out sheet from the avatar tap (`AvatarActionsSheet`), privacy section in the existing Account Settings page (`RoomPrivacyCard`).
- Reconnect handling with exponential backoff; a clear "reconnecting" state; leave on tab close.
- Accessibility: all actions reachable without tapping avatars (member list sheet with the same actions), 44px targets, reduced-motion disables reaction animation, chat is an aria-live region.

## The screen (alpha)

The host sets `room.screen` to a link. The server resolves it to `{ v:1, provider, kind:'video'|'audio'|'image'|'link', url, embedUrl?, title?, thumb? }`.

| Provider | In the room | Open in own app or site |
|---|---|---|
| YouTube | Embedded player (IFrame API) | Opens youtube.com or the YouTube app |
| Vimeo | Embedded player | Opens vimeo.com |
| Spotify | Embedded player; full tracks play for listeners signed into Spotify in that browser, previews otherwise | "Open in Spotify" universal link |
| Apple Music | Embedded player; full playback for subscribers | "Open in Apple Music" universal link |
| SoundCloud | Embedded widget | Opens soundcloud.com |
| Image (our media or https) | Image | None |
| Anything else (TikTok, Twitch, news, any site) | Link card (title, thumbnail via the existing link-preview service) | "Open link" in a new tab |

Only the providers above get an iframe, from an allow-list of embed hosts; arbitrary pages are never framed. All outbound links use `rel="noopener noreferrer"`.

Fullscreen: a transparent tap target sits over the screen. Tapping it expands the screen to fullscreen (Fullscreen API; on iOS Safari, which cannot fullscreen an iframe, a fixed full-viewport overlay with the same controls). Inside fullscreen the shield is removed so the provider's own controls work; an exit button and the Escape key restore the room. Chat and reactions stay reachable from fullscreen as a collapsible strip.

Licensing note: nothing is recorded or re-streamed. Each listener plays the item from the provider under that provider's own licence and the listener's own account.

## Safety and moderation

- Reports use `content_reports` with `contentType: 'room' | 'room_message' | 'room_user'`; admin moderation queue shows room reports with the attached chat excerpt.
- Admins can end any room and ban hosts via existing admin tooling (small additions to the admin routes).
- Rate limits and length limits above; new accounts get stricter chat limits via `moderation_config`.
- Embed allow-list prevents arbitrary iframes; image URLs restricted.
- Age enforcement: bouncer checks on join (REST and WS), reconnect and invite-link use; denial messages say the room has an age limit without revealing the user's age. Admin tooling can see and change a room's age limit and end rooms.
- No recording, no persistent chat history. The privacy notice gains a short rooms section before launch.

## Discovery and notifications

- Live now: public rooms sorted by member count then recency; excludes hosts the viewer blocked and users whose `appearInLists` is false (their rooms only reach followers or invitees).
- Upcoming: scheduled public rooms, and rooms linked to events the viewer holds a ticket or RSVP for.
- Friends: rooms hosted or attended by mutual follows (respecting their `appearInLists`).
- `deliverNotification` when a followed host goes live or a scheduled room starts (type `room_live`).
- Event and venue pages show "Join the virtual room" when a live or upcoming room is linked.

## Error handling

Join to a full, ended, banned, or private room returns `room:error` with a code and the REST equivalent returns 4xx; the UI shows a specific message. Dropped sockets never leave ghost members: presence is tied to the live socket, with a short grace for reconnects.

## Testing

- Unit: interaction-rule matrix (every combination of block, mutual, privacy, room flag), screen URL validator, rate limiter, privacy defaults.
- API (throwaway DB, same runner pattern as `npm run test:avatar`): create/schedule/start/end, permissions, bans persist, discovery filters (blocks, appearInLists, visibility), report creation, 18+ gate, new-account host gate.
- WebSocket integration (in-process server, real `ws` clients): join/leave/presence deltas, chat and reaction fan-out, server-side re-check of interactions, kick and ban mid-session, host-disconnect auto-end, reconnect rehydration.
- Real browser with two logged-in users in one room: join, see each other, chat, react, tap-avatar slide-out matrix, privacy change takes effect immediately, kick.

## Risks

- Single-process presence: fine for alpha; the `RoomHub` interface isolates the move to Redis.
- Embedded players: autoplay and mute behaviour differ by browser; screen sync beyond the embed's own player is out of scope.
- Moderation load: live rooms need fast response; alpha limits discovery to small public capacity and invite-first growth.
- The bouncer relies on a typed birthdate (locked after signup). Ofcom may expect stronger age assurance, especially for 18+/21+ rooms; an ID or age-check provider is the upgrade path and is deliberately not in the alpha.
- Mixed-age rooms ("all ages"): chat is shared across bands by design; reports, rate limits and word filtering carry the load, and interaction features are band-gated.

## Open items for review

Resolved in review round 1:
1. All ages with a host-set age limit and a bouncer; birthdate locked; age bands for interactions.
2. Default `interactions` is `mutuals`.
3. Capacity 50 per room, 1 live room per host.

Also resolved: platform minimum age 13; age verification later.

Still open:
- Whether a "teens only" room type (13 to 17, adults barred except the host) is wanted; not in alpha.
