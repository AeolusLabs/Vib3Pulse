# Virtual Rooms: roadmap

Status: design approved in conversation 2026-10-13; this document records the market reasoning, constraints, decisions and the split into buildable parts. Each part gets its own spec, plan and build. Part 1 and 2 spec: [2026-10-13-rooms-alpha-design.md](2026-10-13-rooms-alpha-design.md).

## What a room is

A virtual space attached to a real moment, hosted by one person: a party (with or without music), a listening session, a talk, or the virtual side of a real event or venue night. Guests join as their avatar and see and hear what the host shares on a screen in the room. Guests can interact with each other's avatars (follow-gated, privacy-controlled) and gift the host.

## Market read (researched 2026-10-13)

| Product | What happened / what it shows |
|---|---|
| Clubhouse | Live audio rooms peaked 2021 at a $4B valuation, then Twitter Spaces and others copied the feature and it had no revenue; staff cut by over half in 2023 and live rooms dropped. Rooms alone are not a product. |
| Turntable.fm | Avatars in DJ rooms. Shut down Dec 2013: music licensing cost, DMCA-only licence meant US-only. |
| Stationhead | Listening parties through each listener's own Spotify/Apple Music subscription, so every listener is a paid stream and no licence negotiation is needed. 17M+ users. Audio only, no space. |
| Highrise | Mobile avatar rooms with gifting and a creator cash-out; 45M+ users, $250M+ virtual transactions. Dress-up and gaming audience; no real-world events, venues or ticketing. |
| TikTok Live / Bigo / Twitch / Kick | Gifting is the proven business. TikTok keeps about 50% of gift value, Twitch 50/50 (up to 70/30), Kick 95/5. |
| Roblox / Fortnite / Zepeto / Gather | Large 3D or game-first worlds; heavy to build, not event-anchored. |

Sources: thinkinsights.net/strategy/clubhouse-after-boom, en.wikipedia.org/wiki/Turntable.fm, hypebot.com (Stationhead), highrise.game (earned gold), muvi.com (TikTok Live), musicbusinessworldwide.com (UK livestream licensing), engadget.com (Apple tipping rules), ofcom.org.uk (Online Safety Act roadmap), livekit.com (pricing).

## Positioning

Nobody combines a nightlife/events graph, avatars, ticketing/payouts and a safety layer. Vib3Pulse already has all four. The wedge is **the room attached to a real night**: a remote ticket to a club night, pre-party and after-party rooms for events, venue-hosted rooms with gifts to the DJ. Clubhouse had no anchor and no revenue; Highrise has no real-world events.

## Constraints that shape the design

1. **Music licensing.** UK PRS and PPL licences apply even to small DJ livestreams. We never host or relay copyrighted audio. The screen shows images, embedded YouTube/Vimeo video and host-uploaded originals. Commercial music through listeners' own Spotify/Apple accounts is a later add-on (Stationhead model).
2. **Money.** Platform credits, not a blockchain token. Closed-loop, bought with existing Stripe/Paystack, spent on gifts, host earnings cashed out through existing payouts. UK e-money rules may apply to cash-out: get legal sign-off before cash-out goes live. If the product is ever wrapped as a native iOS app, Apple's 30% in-app-purchase rule applies to gifts tied to content.
3. **Safety.** Rooms are open to all ages. The host sets a room age limit (all, 13+, 16+, 18+, 21+) and the platform enforces it like a bouncer. Birthdate is locked after signup. Under-18s and adults cannot directly interact (wave, DM, invite) across the age line. Under-18s cannot buy credits, gift or earn. Ofcom expects age assurance for livestream features, so an ID or age-check provider is the upgrade path for 18+/21+ rooms. No recording of rooms. Reports feed the existing moderation queue.
4. **Cost.** Voice via LiveKit is cheap (about $0.0005 per participant-minute, per its pricing page); video streaming is the expensive part, so it is deferred. Alpha uses the existing `/ws` server.

## Decisions made

- Screen and music: safe stack (above). Providers play in the room under their own licences: YouTube, Vimeo, Spotify, Apple Music and SoundCloud are embedded; everything else is a link card. Guests can open any item in their own app or site, and tap the screen to go fullscreen.
- Age: all-ages rooms with a host-set limit and a bouncer; locked birthdate; age-band interaction rules (alpha).
- Capacity: 50 per room to start. Default privacy: mutual follows only.
- Gifts: credits with cash-out. **Prices must cover card cost and platform fee, the rest goes to the host, and the split must be shown clearly to the buyer of credits and to the receiving host.**
- Realtime: extend the existing `ws` server behind a small `RoomHub` interface (Redis pub/sub later if needed). LiveKit enters only for audio in part 3.

## Parts

| # | Part | Delivers |
|---|---|---|
| 1 | Rooms core | Create/schedule/join/end rooms, link to events and venues, host roles, live presence, 2D avatar scene, reactions, text chat, discovery |
| 2 | Social layer | Tap-an-avatar slide-out (follow-gated), room privacy settings, moderation (mute/kick/ban/report), age gate. Ships with part 1 as the alpha. |
| 3 | Sound and screen | Host live voice (LiveKit), mic-request stage, "now playing" sync across guests (YouTube and Vimeo seekable; Spotify and Apple loosely synced because each plays on the listener's own account), host-uploaded originals, smooth playback (preload, buffering states, no layout shift), fullscreen on every device |
| 4 | Gifts and earnings | Credit packs, animated gifts, host earnings, payouts, fraud and chargeback controls, fee transparency |
| 5 | Paid rooms | Virtual tickets reusing the ticketing system, subscriptions later |

Order: 1+2 alpha, then 3, then 4, then 5. The gifts ledger and fee model are specified before part 3 so the data model is ready, but the code ships in part 4.

## Gifts: transparency requirements (for the part 4 spec)

- Credit pack screen shows, before payment, how the price breaks down: payment-processing fee, platform fee, and the host's share it represents.
- The host's earnings screen shows the same breakdown per gift and per payout.
- Every ledger row stores the fee components in force at the time (append-only, versioned fee schedule), so history never changes when fees change.
- Price per credit is set so that host share plus platform fee plus card cost never exceeds the price paid, including small packs where fixed card fees bite.
- 18+ only for buying, gifting and earning; spending limits; refund and chargeback policy stated up front.

## Open items (do not block part 1+2)

- Exact fee schedule and credit pack prices (part 4 spec).
- Legal review of cash-out under UK e-money rules and any Nigeria equivalents for Paystack payouts.
- Whether to add the Spotify/Apple listening-party mode, and partner approvals if so.
- Platform minimum age 13: confirm, and enforce at signup (not enforced today).
- Optional later: "teens only" room type; ID or age-check provider for 18+/21+ rooms.
