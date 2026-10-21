# Rooms part 3: sound and screen (draft for review)

Status: DECISIONS RECORDED 2026-10-13 (see "Decisions" at the end); part 3a (voice, sync, fullscreen) is planned in `docs/superpowers/plans/2026-10-13-rooms-part3a-voice-sync.md`, part 3b (uploads) is planned later. Nothing here is built yet. Context and constraints: [roadmap](2026-10-13-rooms-roadmap.md). Alpha design: [rooms-alpha-design](2026-10-13-rooms-alpha-design.md).

## Goal

A host can talk to the room (live voice), bring guests up to speak, and put music or video on the screen so everyone is watching or listening at roughly the same moment, with smooth playback on every device. Still no recording, no relayed copyrighted audio, no money.

## What the alpha already gives us

- `RoomScreen` (embed allow-list, fullscreen shield, pseudo-fullscreen fallback, buffering skeleton, "Open in {provider}") and the `Screen` shape resolved by `shared/screen.ts`.
- The `/ws` room channel, `RoomHub`, roles (host, co-host, guest), mute/kick/ban, the age bouncer, per-user rate limits, reports with a chat excerpt.
- `room:screen` broadcast and persisted `rooms.screen`.
- The client reducer (`lib/roomReducer.ts`) is the single place room state is derived, so new events slot in beside the existing ones.

## Scope

In:
1. **Live voice.** Host and co-hosts publish audio; guests listen. Guests can ask to speak ("raise hand"); the host or a co-host brings them up and can take them down. One speaker mic at a time per person; max speakers per room (default 6).
2. **Now playing, synced.** The host's play, pause and seek on a YouTube or Vimeo screen are mirrored to guests with a small drift tolerance. Spotify and Apple Music cannot be driven from outside the player, so those are "loosely synced": the room shows what is playing and a "start together" countdown, each guest presses play on their own account.
3. **Host-uploaded originals.** The host may upload their own audio or video (their own mix, set, talk). Hosted by us, streamed to the room from the object store. Rules and limits below.
4. **Smooth playback.** Preload the next item, buffering states, no layout shift, graceful failure when a provider blocks an embed.
5. **Fullscreen on every device.** Already partly done; finish the iOS path and add landscape handling.

Out: recording, replays, DJ mixing in the browser, relaying anything from Spotify/Apple/YouTube audio into the voice channel, video calls, paid rooms, gifts.

## Proposed design

### Voice: LiveKit (as decided in the roadmap)

- A **LiveKit room per Vib3Pulse room**, named by room id. The server mints a short-lived access token per join (`POST /api/rooms/:id/voice-token`), only after the same checks as `room:join` (bouncer, ban, kick, block, capacity). Tokens: `canSubscribe` always; `canPublish` only when the member is on stage (host, co-host, or a guest the host brought up). Token lifetime 10 minutes with silent refresh, so a ban or kick takes effect within minutes even if the socket event is missed.
- **Server is the authority for who may speak.** The WebSocket gains `room:stage {action:'raise'|'lower'|'invite'|'accept'|'remove', targetId}` and the hub keeps a `stage` set. On change the server calls the LiveKit server API to update that participant's publish permission and broadcasts `room:stage`. Removing someone from the room, a ban, a kick or the room ending also revokes and disconnects them in LiveKit.
- Client: `useRoomVoice(roomId)` wraps the LiveKit client SDK; the room page shows speaking rings on stage avatars and a mic control. Autoplay rules: audio starts only after a user gesture (the join button), with a clear "Tap to hear the room" state.
- **Teens:** can listen, can raise a hand, cannot be brought on stage in a room where an adult is the only host unless the room is `friends` or `invite` (mirrors the existing rule that teens never host public rooms). To confirm.
- **Moderation:** report a speaker (report type `room_user` already exists); host can mute a speaker immediately (LiveKit mute plus permission removal). No recording on our side, and LiveKit egress is left disabled.
- **Cost guard:** voice is only started when the host turns it on ("Go on mic"), and rooms with no publisher have no media session. Listeners are the cost driver (about $0.0005 per participant-minute per the roadmap's source), so the capacity cap of 50 bounds a room at roughly $1.50 an hour of listening.

### Now playing sync

- New persisted field `rooms.now_playing jsonb` : `{ v:1, screenVersion, state:'playing'|'paused'|'ended', positionMs, atServerMs, rate:1 }`.
- Host client reports transitions only (play, pause, seek, end) plus a heartbeat every 5 s while playing, as `room:playback {state, positionMs}`; the server stamps `atServerMs`, stores it, and broadcasts. Guests compute `target = positionMs + (now - atServerMs)` and correct their embedded player if drift is over 1.5 s (YouTube IFrame API and Vimeo Player API both expose seek and state; reuse the allow-listed embed hosts, no new origins).
- Late joiners get `now_playing` in `room:state` and seek on first play.
- Guests can opt out of syncing ("Watch on my own"), with a "Catch up" button.
- Spotify / Apple Music / SoundCloud: no remote control, so the message is `room:playback {state:'cue', startAtServerMs}` and the UI shows a countdown and a prominent "Play" button. Documented as loosely synced.

### Host-uploaded originals

- Upload: images already exist through `/api/media`. Audio and video need a streaming path and bigger limits. Recommendation: object storage with signed URLs (S3-compatible, e.g. Cloudflare R2) and a short HLS transcode for video; audio served as AAC/MP3 with range requests. This is the one new piece of infrastructure in part 3.
- Rules: the host attests they own the rights ("my own recording or I have the rights"); a visible report path; auto-removal when a rights complaint is upheld; max 15 minutes of audio, 5 minutes of video in the alpha of this part; adults only to upload (teens can still host non-public rooms but cannot upload media to them: to confirm); size caps and a type sniff like `storeMedia`; virus/transcode failures are surfaced to the host.
- Screen model gains `provider:'upload'`, `kind:'audio'|'video'`, with `embedUrl` pointing at our own signed streaming URL (same-origin or our CDN host only).
- **Licensing:** unchanged principle. We never relay copyrighted third-party audio. Uploaded originals are the host's own responsibility, with the attestation and takedown process above. Legal review before public launch (UK PRS/PPL position for rooms that play recordings the host did not make).

### Smooth playback and fullscreen

- Reserve the 16:9 box before the embed loads (done), show buffering from the player events instead of a timer, preload the next queued item's iframe off-screen (YouTube/Vimeo only), and fall back to the link card when the provider reports "embedding disabled".
- iOS Safari: element fullscreen exists only for `<video>`. For uploaded video use the native video element (real fullscreen); for iframes keep the viewport-cover overlay and move focus into it. Landscape: lock to the overlay's aspect and hide the browser chrome where possible.
- Accessibility: captions pass-through for providers that have them, a visible "now playing" text line (live region, polite), and a reduced-motion setting for the equaliser art.

## Data model additions (additive)

```
rooms.now_playing jsonb null
rooms.voice_enabled boolean default false
rooms.max_speakers int default 6
room_members.on_stage boolean default false        -- persisted so a reconnect keeps stage rights
room_media (id, room_id, owner_id, kind, object_key, duration_ms, bytes, mime, status, created_at)   -- uploads
```

All applied to the production database in the same task that adds them (per the standing rule), plus `ensureSchema` entries.

## Protocol additions

Client to server: `room:stage {action, targetId?}`, `room:playback {state, positionMs}`, `room:voice {enabled}` (host).
Server to client: `room:stage {stage:[userIds], hands:[userIds]}`, `room:playback {state, positionMs, atServerMs}`, `room:voice {enabled}`.
REST: `POST /api/rooms/:id/voice-token`, `POST /api/rooms/:id/media` (upload init), `DELETE /api/rooms/:id/media/:mediaId`.

## Risks

- **Voice moderation is the real risk.** Live audio can't be word-filtered. Mitigations: stage is invite-only, instant mute/remove, reports with who-was-speaking, the age rules above, and starting with `friends` and `invite` rooms plus small public rooms.
- **Sync accuracy.** YouTube/Vimeo drift correction is good; Spotify/Apple will never be exact. Set the expectation in the UI.
- **Provider embed restrictions** (autoplay policies, regional blocks) differ by browser; every state needs a visible fallback.
- **Cost surprise.** Cap speakers, cap capacity, and show voice-minute totals to admins.
- **Uploads become a rights and storage problem.** Keep the first release small (length caps, adults only, takedown tooling) and legal-review before public launch.
- **Ofcom.** Live voice with mixed ages raises the bar for age assurance; the ID / age-check provider deferred in the alpha becomes more pressing for public voice rooms.

## Decisions (owner, 2026-10-13)

1. **LiveKit Cloud.** Project URL `wss://vib3pulse-5o7irzml.livekit.cloud`, API key `APIFYcNaKWQsTGy`. The API secret is NOT in the repo or this document: it goes in server env only (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, also on Railway). Voice stays switched off when any of the three is missing. A monthly spend ceiling was not given; until it is, the safeguards are the 50-person capacity cap, the 6-speaker cap, voice off until the host turns it on, and a kill switch (unset the env vars).
2. **Teens on stage:** only when everyone present in the room is a teen (an adult being present blocks teen speaking; an adult joining demotes teen speakers). Teens can always listen and raise a hand. The host or a co-host can give speaking rights to any eligible person present, whether or not they raised a hand.
3. **Order:** 3a first (voice, now-playing sync, fullscreen polish), 3b second (uploads).
4. **Uploads (3b):**
   - Lengths, chosen as reasonable: audio up to 20 minutes and 50 MB; video up to 10 minutes and 200 MB.
   - Adults only upload. Adults-only (mature) content may be played only in rooms whose age limit is 18+ or 21+, because then no minor can be inside; a mature upload cannot go on the screen of a room with a lower limit.
   - Rights wording (draft, owner to confirm): "I made this, or I have the right to play it to an audience. If someone reports it and a moderator agrees, it will be removed."
   - Takedown: any attendee can report; a human moderator removes it; an AI moderation agent will take over later (3b leaves a `moderation_status` field and one function where that agent plugs in).
5. **Public and private rooms both from day one** for voice. Capacity: free rooms 50 people; paid rooms 100 to 150 (part 5).
6. **No age-check provider for now.**
7. **"Your Vib3" is the final home for Rooms** (no bottom-nav tab).

Adjustments made while planning 3a: `rooms.screen_version` (so a late playback message for a previous screen is ignored); stage = guests brought up only (host and co-hosts are implicit speakers); the speaker cap of 6 counts host + co-hosts + stage guests.

Alpha bug found and fixed while planning: the app's Content-Security-Policy `frame-src` did not list the embed hosts, so room screens (YouTube, Vimeo, Spotify, Apple Music, SoundCloud) were blocked by browsers. Fixed in `server/security.ts` (`ROOM_EMBED_HOSTS`) with a test.

## Proposed plan shape (after approval)

3a: stage + voice token + LiveKit client + speaking UI + moderation hooks; now-playing sync for YouTube/Vimeo; cue/countdown for Spotify/Apple/SoundCloud; fullscreen/iOS polish; tests (server unit for the stage rules, WebSocket tests for stage and playback, a fake LiveKit service so tests never need the real one, real-browser run with two sessions).
3b: object store, upload pipeline, `provider:'upload'` screens, takedown tooling.

Accounts and secrets needed before 3a: LiveKit project URL, API key and secret (server env only, never in the client bundle).
