# Competitive Research — Boomtown Festival App

**Type:** Feature research / opportunity brief
**Subject app:** Boomtown Festival (UK music festival companion app — not to be confused with BoomTown, the US real estate CRM)
**Date:** 2026-09-06
**Status:** Research complete, no features implemented yet
**Purpose:** Reference document for future feature planning. Read this before scoping Night Timeline, Venue Safety Score, gamification, or wallet features — several are already speculatively covered here.

---

## Why Boomtown

Boomtown is a UK music festival's official companion app (available iOS/Android, v10.0.1 as of Aug 2026). It's a useful comparison for Vib3Pulse despite the different context — one is a single multi-day festival, the other is ongoing city nightlife — because its engagement mechanics (gamification, recap/wrapped features, community persistence, lightweight safety reporting) map cleanly onto features Vib3Pulse has already scoped as Tier 2/3 or left as open gaps.

Sources:
- [Boomtown App page](https://www.boomtownfair.co.uk/app)
- [Boomtown App News](https://www.boomtownfair.co.uk/news/boomtown-app)
- [App Store listing](https://apps.apple.com/gb/app/boomtown-festival/id6504767448)

---

## What Boomtown's App Does

### Lineup & Planning
- **Personalised timetable builder** — save favourite artists/sets across 12 main stages and 50+ hidden venues
- **Clash finder** — flags scheduling conflicts between saved sets automatically

### Interactive Map
- **3D world map** of the festival site, live once set times are published
- **Personal pins** — users drop and share their own location markers
- **Scheduled points of interest** synced to the user's saved timetable
- **Category filters** (stages, food, medical, camping, etc.)

### Gamification — Quest Portal & Changemaker Cards
- **Quest Portal**: story-based quests tied to the festival's fictional "districts" — collections with unlock codes, checklists, and open-text answers
- **Changemaker Cards**: physical cards attendees scan in-app to unlock digital reveals and narrative content, shareable to social
- **"Unboxed" hub**: a dedicated home layout tying the above together, culminating in a recap film

### Wrapped-Style Recap
- End-of-festival summary in the "Unboxed" flow — a Spotify-Wrapped-style personalised recap of the user's festival journey (quests completed, sets attended, cards unlocked)

### Cashless Wallet
- Top up and spend via wristband directly through the app
- Clear top-up cutoff time display
- **Prize-draw incentive**: spend/top-up thresholds (e.g. £200, £300) entered users into prize draws for camp upgrades — a growth lever tied to a desired financial behaviour, not just a sweepstakes

### Safety & Reporting
- **Incident reporting** built into the main app — separate and lower-friction than an emergency escalation flow
- Framed as a community-safety feature, not an emergency service

### Community
- Explicitly pitched as building "communities that can last forever" — persistence beyond the event is a stated design goal, not an afterthought

### Other
- Full lineup + news feed
- Early ticket/deal access for app users
- Offline mode (functions with degraded/no signal on-site)

---

## Vib3Pulse Context (for future readers who haven't re-read the PRD)

Vib3Pulse is a safety-first nightlife social platform (event discovery + ticketing + social feed/stories/DMs/communities + a 7-layer safety/buddy system). Full spec lives in [`VIB3PULSE_PRD.md`](VIB3PULSE_PRD.md) and [`VibePulse_Business_Brief.md`](VibePulse_Business_Brief.md). Relevant existing roadmap items referenced below:

- **Night Timeline** (Tier 2, post-launch) — collaborative 24-hour story of a night out
- **Venue Safety Score** (Tier 2) — 0–100 aggregated incident rating
- **Event Groups** — DM groups auto-created per event, currently spec'd to **dissolve 7 days after the event**
- **Safety Buddy confirmation targets** — 70% (UK) / 65% (Nigeria) of signups, currently with no incentive mechanism attached
- **Layer 7: Venue Safety Network** — clusters SOS/missed-check-in alerts by venue+time window; currently the *only* input is emergency-tier alerts, no soft-signal reporting

---

## Mapped Opportunities

| Boomtown feature | Vib3Pulse opportunity | Rationale | Suggested tier |
|---|---|---|---|
| Wrapped-style recap | **"Your Night(s) Wrapped"** — periodic recap of events attended, photos/stories posted, friends partied with, safe check-ins completed | Every data point already exists (tickets, posts, stories, check-in timers). Near-zero build cost, high shareability — directly serves the "user tells friends" growth loop in the PRD's success vision | **High priority / low cost** |
| Incident reporting (lightweight) | A **"flag a concern" button** distinct from full SOS — for harassment, suspected spiking, or venue issues that don't warrant an emergency alert | Current safety system only has one gear: full SOS/buddy/timer escalation. A soft-signal report gives Layer 7 (Venue Safety Network) a second data source beyond alert clustering, without triggering emergency-response weight for non-emergencies | **High priority / low cost** |
| Quest Portal + unlock codes/badges | Gamified attendance — badges for check-ins at partner venues, city-based quest streaks unlocking discounts or perks | Pairs directly with the already-planned **Night Timeline** and Communities features; turns passive discovery into repeat engagement | Tier 2 candidate |
| Cashless wallet + prize-draw top-up promo | In-app stored-value wallet for cover charges/drinks at partner venues; incentive promos tied to **safety completion** (e.g. "confirm your buddy, get entered to win VIP tickets") rather than just spend | Payment rails (Stripe/Paystack) already exist. The promo mechanic is a real lever for the currently-unincentivized 70%/65% buddy confirmation targets | Tier 2/3 — wallet is a bigger build; the promo-for-safety-completion idea is cheap and should be considered sooner, independent of the wallet |
| Interactive map + personal pins + category filters | Venue/event discovery map view | Ranking algorithm already factors "venue proximity" but there's no visual map surface; natural home for the planned Venue Safety Score once built | Tier 2 |
| "Communities that last forever" | Reconsider the 7-day auto-dissolve on Event Groups | Boomtown's stated design principle is that post-event community persistence drives retention — worth revisiting for high-turnout events instead of a blanket 7-day kill | Cheap policy change, worth a product decision before Tier 2 build-out |
| Offline mode | Extend existing PWA offline caching to the **ticket QR wallet + event details**, not just the SOS queue | Vib3Pulse already caches app shell and queues SOS offline; clubs/basements are notoriously bad-signal venues, so caching the ticket wallet specifically closes a real gap at the door | Low cost, launch-adjacent |

---

## Recommended Next Step

Highest leverage, lowest cost, in order:
1. **"Flag a concern" lightweight incident report** — feeds Layer 7 safety network with soft signals
2. **"Your Night(s) Wrapped" recap** — pure data-replay feature, no new capture needed
3. **Safety-completion prize-draw promo** — directly targets an existing, currently-unmet PRD metric
4. Everything else (Quest/badges, wallet, map, community persistence policy) — treat as Tier 2/3 scoping candidates, not immediate work

Nothing in this document has been built. When any of these move from "idea" to "planned," promote the relevant row into `VIB3PULSE_PRD.md`'s Feature Tiers table with full acceptance criteria, per that document's own process.
