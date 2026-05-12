# Vib3Pulse — Product Requirements Document

**Version:** 1.0  
**Date:** May 2026  
**Status:** Pre-launch development  
**Product Name:** Vib3Pulse (formerly VibePulse)

---

## DOCUMENT OVERVIEW

This PRD defines what Vib3Pulse is, who uses it, what they can do, and the success metrics for each feature. It is the source of truth for feature scope, priority, and acceptance criteria.

---

## TABLE OF CONTENTS

1. [Product Vision](#product-vision)
2. [User Types & Jobs to Be Done](#user-types--jobs-to-be-done)
3. [Core Features](#core-features)
4. [Feature Tiers](#feature-tiers)
5. [Safety System Specification](#safety-system-specification)
6. [Technical Requirements](#technical-requirements)
7. [Market-Specific Variations](#market-specific-variations)
8. [Success Metrics](#success-metrics)
9. [Future Features (Out of Scope)](#future-features-out-of-scope)

---

## PRODUCT VISION

**One-liner:** The safety-first nightlife social platform where you discover events, coordinate with friends, and have a net if things go wrong.

**Problem:** People plan nights out across WhatsApp, Eventbrite, Instagram, and word-of-mouth. There's no unified space to discover → book → coordinate → stay safe.

**Solution:** A single app that handles all four — discovery, ticketing, group planning, and personal safety.

**Why now:** Afrobeats and nightlife culture is booming in London and Lagos. Safety concerns (spiking, assault) are top-of-mind for young women. No platform has built safety into the core.

**Why us:** Our founders are from the culture we are serving. We have built the only multi-trigger SOS system that works without the app being open. We are not a ticketing company that added safety — we are a safety company that monetises through ticketing.

---

## USER TYPES & JOBS TO BE DONE

### User Type 1: Social Users (Attendees)

**Who:** People aged 18–35 going out to clubs, bars, festivals, cultural events.

**Where:** London primary, Lagos secondary, diaspora globally.

**What they want:**
- **Job 1:** Discover events happening this weekend that match my vibe
- **Job 2:** Buy a ticket without leaving the app
- **Job 3:** Coordinate with my mates — where to meet, what time, who's coming
- **Job 4:** Post about the night, see what others are posting, find the after-party
- **Job 5:** Know I have a safety net if things go wrong

**Success looks like:** User opens app, finds 3 events worth considering, buys a ticket, invites 4 friends via in-app DM, all 4 accept, all show up, user posts stories during the night, user enables safety buddy. User tells friends "go on Vib3Pulse for the event."

**Value prop:** One app for everything. Events you'll actually want to go to (not algorithmic noise). Safety system that actually works.

---

### User Type 2: Event Organisers (Promoters)

**Who:** DJs, promoters, producers, venue managers, brands running events.

**Where:** London and Lagos, both day one.

**What they want:**
- **Job 1:** Create an event and sell tickets without a middleman taking 20%
- **Job 2:** See who is coming, check them in at the door
- **Job 3:** Understand which nights drew crowds, which didn't
- **Job 4:** Get paid reliably and quickly
- **Job 5:** Have my event discovered by the right audience

**Success looks like:** Promoter creates event on Thursday, invites audience via social, sells 300 tickets by Friday, 200 people attend (67% show rate), promoter checks people in at door, gets paid Monday, analytics shows which 50-minute window had peak sales.

**Value prop:** Lower fees than Eventbrite. Built-in discovery via user network. Creator-focused (not consumer-first).

---

### User Type 3: Venue Operators

**Who:** Club, bar, lounge owners. Venue managers.

**Where:** London and Lagos, both day one.

**What they want:**
- **Job 1:** Promote my recurring event (Friday night, Saturday night)
- **Job 2:** Sell cover charge tickets
- **Job 3:** See foot traffic trends
- **Job 4:** Respond to safety incidents at my venue
- **Job 5:** Build a community around my space

**Success looks like:** Venue creates weekly Friday event, advertises on Vib3Pulse, sells 200 cover charge tickets, 150 show, venue gets ₦105,000 (200 × ₦700 ticket - 3.5% fee). Venue safety contact receives notification when 3+ SOS alerts fire at their location.

**Value prop:** Community-building tool. Early warning system for safety incidents. Recurring revenue (if using Vib3Pulse as ticketing backend).

---

## CORE FEATURES

### 1. Event Discovery & Exploration

#### Feature: Event Feed (Discover Tab)

**What it does:** User opens app, sees a curated feed of upcoming events ranked by relevance.

**User flow:**
1. User taps "Discover"
2. Sees 20 events (paginated)
3. Events show: cover image, event name, date/time, venue, ticket price, attendee count
4. User taps event → full event details page
5. User can share event, buy ticket, or add to "Going"

**Ranking algorithm:**
- Recency (events starting soonest, weighted 40%)
- User's follow graph (events by organisers/friends they follow, 30%)
- Venue proximity (events near user's saved location, 20%)
- Engagement (events with high ticket sales velocity, 10%)

**No personalization by AI — all ranking is deterministic and shown to user.**

**Acceptance criteria:**
- [ ] Feed loads in <2 seconds on 4G
- [ ] User can scroll infinitely (pagination with limit=20)
- [ ] Event cards show price in correct currency (GBP in UK, NGN in Nigeria)
- [ ] Cover images are compressed (WebP, <100KB each)

---

#### Feature: Event Detail Page

**What it does:** Full event information, ticket options, attendee list, reviews.

**Sections:**
1. **Header:** Event name, date/time, venue address, 10 event gallery images
2. **Ticket Tiers:** Multiple tiers (Early Bird, General, VIP) with prices and availability
3. **Attendees:** Profile pictures of 12 people confirmed attending
4. **About:** Event description, organiser bio, entry requirements
5. **Safety:** Venue safety score (if applicable), SOS button access if user has purchased
6. **Comments:** User reviews and questions (moderated)
7. **Buttons:** Buy Ticket, Add to Going, Share on WhatsApp/Insta, Add to Calendar

**Acceptance criteria:**
- [ ] Page loads all images lazily (don't block on image load)
- [ ] Ticket availability updates in real-time if another user buys while viewing
- [ ] Share button generates WhatsApp message with event name, date, ticket URL
- [ ] User who bought ticket sees "You're going" confirmation

---

#### Feature: Venue Profiles

**What it does:** Browse all events at a single venue, see venue info and reviews.

**Sections:**
1. **Header:** Venue name, address, cover photo, operating hours
2. **Upcoming Events:** All events at this venue in next 60 days
3. **Recurring Events:** Weekly/monthly nights (Fridays, Saturdays, etc.)
4. **Gallery:** 20 photos of the venue
5. **Reviews:** User-submitted reviews and safety notes
6. **Safety Score:** Aggregated from incident data (if applicable)
7. **Contact:** Phone number, email, website

**Acceptance criteria:**
- [ ] Venue profile shows all events across all organisers at that location
- [ ] Safety score visible (0–100 shield icon) with explanation page

---

### 2. Ticketing & Payment

#### Feature: Ticket Purchase Flow

**User flow:**
1. User taps "Buy Ticket" on event detail page
2. Selects ticket tier (Early Bird/General/VIP)
3. Selects quantity (1–10)
4. Sees price breakdown: subtotal, platform fee, payment processor fee
5. Enters email (if not logged in, offer account creation post-purchase)
6. Redirected to Stripe (UK) or Paystack (Nigeria) checkout
7. Completes payment
8. Returns to app, sees ticket in wallet with QR code
9. System sends confirmation email

**Ticket Wallet:**
- User taps "My Events"
- Shows all upcoming events user has tickets for
- Each ticket shows: event name, date/time, venue, ticket type, QR code
- User can share ticket via WhatsApp (generates link to ticket page)
- QR code does not expire (valid from purchase until event is 7 days past)

**Check-in at Door:**
- Venue staff (organiser) scans QR code with Vib3Pulse app
- System confirms ticket is valid, marks as checked in
- If ticket was shared (via WhatsApp), actual attendee name is shown to staff

**Acceptance criteria:**
- [ ] Payment flow completes in <60 seconds
- [ ] QR code generates immediately after payment
- [ ] Organiser can scan 10 tickets/minute without lag
- [ ] Payment fees are transparent (show GBP/NGN breakdown)
- [ ] Failed payment shows clear error message and retry option
- [ ] Refund request from organiser is processed within 24 hours

---

### 3. Social Layer

#### Feature: Feed (Posts)

**What it does:** Users post photos and text about their night, friends like/comment/repost.

**Post types:**
- Photo + caption (max 1 image)
- Video (max 30 seconds, auto-muted initially)
- Text only (max 300 characters)

**Feed ranking:**
- Chronological (most recent first)
- User's own posts always at top of their profile
- Likes and comments do not change ranking (reverse Instagram approach)

**Actions:**
- Like (❤️ icon, cumulative count shown)
- Comment (nested replies, 3-level deep max)
- Repost (share to user's profile)
- Share to WhatsApp/Instagram Stories

**Moderation:**
- System flags posts with 3+ reports for manual review
- Banned content: hate speech, explicit violence, sexual content, self-harm
- Removed posts notify user with reason

**Acceptance criteria:**
- [ ] New posts appear in feed within 2 seconds
- [ ] Images compress to <100KB before upload
- [ ] Video uploads limited to 100MB
- [ ] User can edit post within 5 minutes of posting
- [ ] User can delete post anytime (removes permanently)

---

#### Feature: Stories (24-hour Ephemeral Posts)

**What it does:** Users post photos/video that disappear after 24 hours.

**Mechanics:**
- User taps "+" → "Add Story"
- Uploads photo or records video (max 15 seconds)
- Story appears in timeline at top, with small profile picture
- Story is visible for exactly 24 hours, then deleted
- View count shown to poster (but not who viewed)

**Story Ring:**
- Users with unviewed stories show a colored ring around profile picture
- Tap ring to view all their stories

**Acceptance criteria:**
- [ ] Stories auto-delete exactly 24 hours after posting
- [ ] Video compresses to <20MB per 15-second clip
- [ ] Story view does not require messaging permission (privacy-first)
- [ ] User can screenshot their own stories (but not others')

---

#### Feature: Direct Messages (DMs)

**What it does:** One-to-one and group chats for coordinating who is going.

**Mechanics:**
- User taps user profile or chat icon → "New Message"
- Selects 1–50 people to start group chat
- Send text, images, and in-app event links
- Read receipts optional (toggle in settings)
- Can create "event group" linked to specific event (auto-fills all buyers)

**Event Groups:**
- Organiser can create event-linked group (all ticket holders added)
- User can mute notifications from event group
- Group dissolves 7 days after event

**Acceptance criteria:**
- [ ] Messages deliver within 500ms
- [ ] Group size limit: 50 people
- [ ] Image sharing (same compression as posts)
- [ ] User can delete their own messages (shows "message deleted" to others)
- [ ] Search messages by keyword

---

#### Feature: Communities

**What it does:** Topic-based groups where users discuss events, music, safety.

**Community types:**
- **City-based:** London, Lagos, diaspora hubs
- **Music genre:** Afrobeats, Grime, Drill, House
- **Safety discussions:** Dating safety, spiking awareness, solidarity
- **Event-specific:** Coachella 2026, London Jazz Festival, etc.

**Mechanics:**
- Community has moderator (often the organiser)
- Users post in community feed (same as main feed)
- Community has pinned posts, rules, and moderators list
- User can leave anytime
- Moderator can remove users or content

**Discovery:**
- Communities show in Discover tab
- Search by name or keyword
- Trending communities bubble up (by post activity)

**Acceptance criteria:**
- [ ] Communities support up to 10,000 members before performance degrades
- [ ] Community rules enforced by moderator + system flags
- [ ] User can filter community feed by post type (posts only, no videos, etc.)

---

### 4. Safety System (7 Layers)

**See [Safety System Specification](#safety-system-specification) section below for complete detail.**

---

### 5. Organiser Dashboard

**What it does:** Promoters see analytics and manage their events.

**Sections:**
1. **Event List:** All events (past/upcoming), status, ticket sales
2. **Event Edit:** Change event details, ticket tiers, cover image
3. **Analytics:** Ticket sales over time, attendee demographics, no-show rate
4. **Attendees:** List of all ticket holders, filter by tier/status
5. **Payouts:** View when money arrives, history, tax info for organiser
6. **Safety:** Incident log if SOS alerts fire at their venue

**Payout Schedule:**
- Stripe (UK): 2–3 days after event ends
- Paystack (Nigeria): 1–2 days after event ends

**Acceptance criteria:**
- [ ] Dashboard loads in <3 seconds
- [ ] Analytics update in real-time as tickets sell
- [ ] Organiser can export attendee list as CSV
- [ ] Payout history shows fee breakdown (VibePulse fee + payment processor fee)

---

## FEATURE TIERS

### Tier 1 — Launch (Must Have)

These features ship on day one. Without them, the product does not work.

| Feature | UK | Nigeria | Notes |
|---------|----|---------| ------|
| Event discovery feed | ✓ | ✓ | Core user flow |
| Event detail page | ✓ | ✓ | Information architecture |
| Ticket purchase | ✓ | ✓ | Revenue engine |
| Payment: Stripe (UK) | ✓ | | GBP billing |
| Payment: Paystack (NG) | | ✓ | NGN billing |
| Social feed (posts) | ✓ | ✓ | Engagement |
| Stories | ✓ | ✓ | Ephemeral sharing |
| DMs | ✓ | ✓ | Coordination |
| Communities | ✓ | ✓ | Moderation infrastructure |
| Buddy assignment (SMS) | ✓ | ✓ | Safety differentiator |
| SOS alert (3 triggers) | ✓ | ✓ | Safety differentiator |
| Check-in timer (graduated) | ✓ | ✓ | Safety differentiator |
| Alert delivery (SMS + FCM) | ✓ | ✓ | Reliability |
| Buddy dashboard | ✓ | ✓ | Activation |
| Organiser dashboard | ✓ | ✓ | Creator experience |
| Venue profiles | ✓ | ✓ | Exploration |
| Door check-in (QR scan) | ✓ | ✓ | Organiser tool |

---

### Tier 2 — Post-Launch (Nice to Have)

Features shipped in Q4 2025 or later, after launch feedback.

| Feature | Notes |
|---------|-------|
| Night Timeline | Collaborative 24-hour story of the night |
| Group split payments | Stripe split, all pay within 24h |
| Venue Safety Score | Aggregated incident rating (0–100) |
| After-Hours live feed | Midnight–5am feed, location-based |
| Promoted events | Paid placement in Discover |
| WhatsApp share optimisation | Native message templates per content type |
| Push notification customisation | User controls which alerts they get |

---

### Tier 3 — Future (Out of Scope)

Possible features for Series A or later.

| Feature | When | Why |
|---------|------|-----|
| White-label safety system | Year 3 | B2G and B2B revenue |
| Festival integrations | Year 2 | Coachella, Notting Hill Carnival partnerships |
| Artist profiles & merchandise | Year 3 | Secondary creator economy |
| Data / insights sales | Year 3 | Council planning, venue benchmarking |
| Relik integration (in-event marketplace) | Year 3 | Sell merch during events |

---

## SAFETY SYSTEM SPECIFICATION

### Overview

The safety system is the product's primary differentiator. It is not a feature — it is foundational.

**Design principle:** Safety should be on by default, friction-free, and work without requiring the user to think about it.

**Legal requirement:** Every user sees this disclaimer once on first use:

> "Vib3Pulse is a personal safety tool, not an emergency service. In a life-threatening emergency, always call 999 (UK) or 199 (Nigeria) first. Vib3Pulse cannot guarantee alert delivery and accepts no liability for failures beyond our control."

User must tap "I understand" to proceed.

---

### Layer 1: Frictionless Buddy Assignment

**Goal:** Get a buddy confirmed in <2 minutes. Zero friction.

**Buddy eligibility:** Anyone with a phone number (they do NOT need a Vib3Pulse account).

**User flow:**
1. User taps "Set up safety" → "Add a buddy"
2. User enters: buddy name, buddy phone number
3. System generates SMS: "[UserName] is going to [EventName] and has added you as their safety buddy on Vib3Pulse. If they need help, we will text you their location — no app needed. Reply YES to confirm or NO to decline."
4. Buddy replies YES via SMS
5. Buddy status updates to "Confirmed"
6. User sees confirmation in app with buddy name

**Multi-buddy support:**
- User can have up to 5 confirmed buddies
- User can remove a buddy anytime
- Buddy can unreply (decline) anytime
- If buddy does not reply in 48 hours, invitation expires and user is prompted to reassign

**Buddy status display:**
- Pending (awaiting SMS reply)
- Confirmed (ready to receive alerts)
- Declined (buddy said no)
- Expired (48 hours passed)

**SMS template (UK):**
"[Name] is going to [Event] on [Date] at [Venue]. If they need help, we'll text you their location — no app needed. Reply YES to confirm or NO to decline. Vib3Pulse"

**SMS template (Nigeria):**
"[Name] is going to [Event] on [Date] at [Venue]. If they need help, we go text you their location — no app needed. Reply YES to confirm or NO to decline. Vib3Pulse"

**Acceptance criteria:**
- [ ] SMS sent within 5 seconds of buddy assignment
- [ ] SMS reply (YES/NO) processed within 10 seconds
- [ ] User sees status update in real-time
- [ ] System shows which buddies are confirmed at top of safety screen
- [ ] User can add buddy while offline, SMS sends when online

---

### Layer 2: Ambient Night Mode

**Goal:** Safety is ON by default when user is out, OFF when at home.

**Activation logic:**
- When user has a ticket for an event starting after 21:00, night mode activates at 18:00 that day
- Night mode runs until 06:00 next morning
- User can manually dismiss night mode (one tap, no confirmation dialog)
- Night mode re-activates for next ticketed event automatically

**What night mode does:**
- Shows persistent shield icon in app header
- Displays primary buddy name next to shield
- Enables all SOS triggers (shake, power button, visible button)
- Activates check-in timer auto-setup

**When user has no ticket:**
- Soft prompt after 22:00 on Friday/Saturday: "Going out tonight? Set up a safety buddy."
- User can dismiss or set up

**Acceptance criteria:**
- [ ] Night mode icon shows primary buddy name (truncated if >15 chars)
- [ ] Dismiss can be re-enabled with one tap
- [ ] Night mode state persists across app closes
- [ ] User can override night mode (turn on during day if needed)

---

### Layer 3: Graduated Check-in Timer

**Goal:** Prevent false alarms with a 5-stage graduated response.

**User flow:**
1. User sets check-in time (default: 1 hour after event end time)
2. At target time, five-stage countdown begins

**Stage 1 (T+0 min):**
- In-app notification: "Quick check-in — still having a good night? Tap I AM SAFE to let [BuddyName] know."
- FCM push if app is closed
- Large "I AM SAFE" button

**Stage 2 (T+10 min, no response):**
- Second notification: "We haven't heard from you. Tap I Am Safe or we'll alert [BuddyName] in 10 minutes."
- Tone escalates (amber instead of blue)

**Stage 3 (T+20 min, no response):**
- Final warning: "Last chance — alerting [BuddyName] in 5 minutes unless you tap I Am Safe."
- Tone red

**Stage 4 (T+25 min, no response):**
- Alert fires to all confirmed buddies via SMS + FCM
- Status changes to "alerted"

**Snooze mechanism:**
- At any stage, user can tap "I'm fine, extend by 30 minutes"
- Maximum 3 snoozes per timer
- After 3 snoozes, next expiry skips T+0, goes straight to T+10

**Resolution:**
- User taps "I AM SAFE" at any stage → timer resolves
- SMS sent to all buddies: "[Name] has checked in and is safe."

**Auto-setup from ticket:**
- After ticket purchase for evening event, prompt appears: "Set up a check-in for [EventName]?"
- Pre-fills time as 1 hour after event end
- One tap to confirm, one tap to skip

**Acceptance criteria:**
- [ ] Notifications send at exact T+0, T+10, T+20, T+25
- [ ] Timer persists across app closes (background job checks every 5 minutes)
- [ ] User can edit timer time (extend by 1, 2, or 4 hours)
- [ ] Timer auto-resolves if user checks in via SOS
- [ ] User sees countdown on safety screen (e.g., "Buddy check-in in 23 minutes")

---

### Layer 4: Three SOS Trigger Methods

**Goal:** User can trigger alert in any scenario — covert or explicit.

#### Method 1: Visible Button

**What it does:** On-screen button, requires 3-second hold.

**Design:**
- Minimum 64px touch target
- Text: "Hold for SOS"
- During hold: circular countdown animation
- After 3 seconds: "Sending..." then success confirmation

**No confirmation dialog** — every extra tap costs seconds in emergency.

**Acceptance criteria:**
- [ ] Hold activation detected within 100ms of threshold
- [ ] Countdown animation smooth at 60fps
- [ ] Button haptic feedback (200ms vibration) on completion

---

#### Method 2: Shake Gesture

**What it does:** User shakes phone to trigger SOS silently.

**Mechanics:**
- Uses DeviceMotion API
- Threshold: acceleration >25 m/s² on any axis
- Detected 3 times within 1.5 seconds
- Triggers once, then requires 5 second cooldown before next trigger

**Activation requirements:**
- User must have at least one confirmed buddy
- Night mode must be active

**iOS-specific:** Requires motion permission request on first use. Message: "Allow motion detection so you can silently trigger an SOS by shaking your phone."

**Feedback:**
- No sound (silent)
- No visual change (silent)
- Single 200ms vibration to confirm sent

**Acceptance criteria:**
- [ ] Shake detection works on iPhone SE and Tecno Spark (lowest-end devices)
- [ ] Permission request appears once
- [ ] False positives <1% (test with opening notification drawer, receiving call, screen timeout)

---

#### Method 3: Power Button Pattern (Android Only)

**What it does:** Rapid power button presses trigger SOS.

**Mechanics:**
- Android: Listen for visibilitychange events (screen off/on)
- Pattern: 5 rapid cycles (off→on→off→on→off→on) within 4 seconds
- iOS: Not reliable in PWA, so use lower shake threshold (18 m/s²) instead

**Feedback:**
- Silent (no sound, no visual change)
- Single vibration to confirm

**Note:** This method has high false-positive risk (pulling notification drawer, screen timeout). Feature is off by default. User opt-in setting required.

**Acceptance criteria:**
- [ ] Setting clearly explains false-positive risk
- [ ] False positives monitored via analytics
- [ ] Disable button is always visible (one tap to turn off)

---

#### Offline Queue (All Methods)

**If no internet when SOS fires:**
- Alert stored in IndexedDB (browser-local database)
- Service Worker registers background sync event
- When connection returns, queued alert sends automatically
- User sees banner: "SOS queued — will send when signal returns" (pulsing indicator)

**Acceptance criteria:**
- [ ] Offline queue visible to user
- [ ] Alert sends within 30 seconds of reconnection
- [ ] User cannot trigger duplicate alerts while queued

---

### Layer 5: Redundant Alert Delivery

**Goal:** Alert reaches buddy via THREE channels simultaneously. Fail-safe redundancy.

**When alert fires (SOS or missed check-in):**

#### Channel 1: SMS (Primary)

**To:** All confirmed buddies via phone number

**Message:**
"URGENT: [UserName] has triggered a safety alert. Last location: [VenueName], [FullAddress]. Open their location: [MapsLink]. Call them: [PhoneNumber]."

**Routing:**
- UK numbers (+44): Twilio
- Nigeria numbers (+234): Termii
- Confirmation via webhook: SMS delivered, not just sent

**Retry logic:** If SMS fails for buddy 1, attempt buddy 2 and 3 independently

**Acceptance criteria:**
- [ ] SMS delivered within 5 seconds
- [ ] Delivery confirmed via provider webhook
- [ ] Failed SMS logged with reason
- [ ] Fallback: if Termii fails, retry with Twilio

---

#### Channel 2: Firebase FCM Push (Secondary)

**To:** Each buddy's registered device(s)

**Title:** "SAFETY ALERT — [UserName] needs help"

**Body:** "Tap to see their location"

**Properties:**
- High priority (bypasses Do Not Disturb where possible)
- Deep link to buddy dashboard
- Locked-screen delivery

**Retry:** Firebase retries 3 times over 5 minutes if device unreachable

**Acceptance criteria:**
- [ ] Push arrives within 5 seconds if device online
- [ ] Locked-screen delivery working on iOS and Android
- [ ] Deep link opens buddy dashboard with correct alert

---

#### Channel 3: WebSocket (Tertiary)

**To:** Buddy if app is open on their device

**Purpose:** Real-time location updates once buddy has dashboard open

**Payload:**
```json
{
  "type": "safety_alert",
  "alert_id": "uuid",
  "user_id": "uuid",
  "trigger_method": "button|shake|power_pattern|timer",
  "coordinates": { "lat": 51.5074, "lng": -0.1278 },
  "accuracy_metres": 15,
  "timestamp": "2025-09-14T23:47:00Z",
  "battery_level": 45,
  "venue_id": "uuid",
  "venue_name": "Fabric London"
}
```

**Acceptance criteria:**
- [ ] Location updates stream every 2 seconds while dashboard open
- [ ] Connection auto-reconnects on network change

---

### Layer 6: Buddy Dashboard

**Goal:** Buddy can help in <30 seconds from alert.

#### Version A: In-App (Buddy has Vib3Pulse)

**Layout:**
1. **Header:** Friend's name and profile photo (large, tap to call)
2. **Alert type:** "SOS ALERT" (red) or "MISSED CHECK-IN" (amber)
3. **Elapsed time:** "Alert sent 2 minutes ago" (updates every second)
4. **Map:** Full-width Leaflet.js with:
   - Pulsing location marker
   - GPS accuracy circle (blue ring around marker)
   - Venue name and address below map
   - Zoom in/out controls
5. **Context:**
   - Event name and start time
   - Last active in app: "2 minutes ago"
   - Battery level (with warning if <20%)
   - Trigger method: "Triggered manually" / "Missed check-in" / "Shake gesture detected"
6. **Action buttons (large, thumb-friendly):**
   - CALL [Name] → opens phone dialler
   - I HAVE REACHED THEM → resolves alert, sends SMS to user
   - FALSE ALARM → resolves without notifying user
   - CALL 999 → opens dialler with 999 pre-filled + auto-copies to clipboard: "My friend needs help at [address], coordinates [lat],[lng]"
7. **Breadcrumb timeline:**
   - "Arrived at [venue] 23:04 · Last active 01:23"

**Real-time updates:**
- Location refreshes every 2 seconds
- Elapsed time updates every second
- If alert resolves, dashboard shows "Alert resolved" and closes in 5 seconds

**Acceptance criteria:**
- [ ] Dashboard loads in <2 seconds
- [ ] Location marker updates smoothly
- [ ] CALL button opens native dialler with number pre-filled
- [ ] Clipboard copy works on iOS and Android
- [ ] Dashboard persists if buddy locks phone (no auto-close)

---

#### Version B: No-Auth Web Page (Buddy without App)

**URL:** `vib3pulse.com/safety/alert/[token]`

**Requirements:** No login, no account creation

**Layout:**
1. Friend's name and photo
2. Pulsing map marker with location
3. Venue name and address
4. Elapsed time countdown
5. Two buttons:
   - CALL [Name]
   - CALL 999 (with location pre-filled in clipboard)

**Design:** Minimal, mobile-optimized, single purpose: help them help their friend.

**Acceptance criteria:**
- [ ] Page loads in <3 seconds on 3G
- [ ] No popup or account creation prompts
- [ ] Token expires after 7 days
- [ ] Each token single-use (after one view, becomes read-only)

---

### Layer 7: Venue Safety Network

**Goal:** Turn personal safety into community safety infrastructure.

**Detection logic:**

When an SOS or missed check-in alert fires:
1. Get coordinates from alert
2. Query for all verified venues within 200 metres
3. If venue matched, tag alert with venue_id
4. Count SOS alerts tagged to this venue in last 20 minutes
5. If count = 3: create incident, trigger elevated response
6. If count = 5: trigger maximum response, admin escalation

**Elevated response (3+ alerts in 20 min):**

- SMS to ALL buddies of ALL affected users:
  - "VENUE ALERT: Multiple safety alerts at [VenueName] in the last 20 minutes. [UserName] is one of those users. Please check on them immediately."
  
- In-app notification to every user currently at venue:
  - "Multiple safety alerts at your current venue. Are you okay?"
  - Buttons: "I AM FINE" / "I NEED HELP"
  
- If venue has safety contact on file:
  - Email + SMS: "[VenueName] has received 3+ safety alerts in last 20 minutes. Incident details: [link]"

**Maximum response (5+ alerts in 20 min):**
- Everything above
- Create priority incident in admin panel with map view of all affected users
- Auto-escalate to Safety team for human review

**Venue setup:**

Venue can opt-in to receive alerts:
- Add safety contact: name, email, phone
- Checkbox: "Receive alerts when guests use Vib3Pulse safety features"
- Framed as benefit: "Be first to know if guests need help"

**Privacy rules:**
- Buddy SMS never names other affected users
- Venue notification never includes user names
- Admin panel shows user IDs not names by default

**Acceptance criteria:**
- [ ] Venue proximity detection accurate within 50 metres
- [ ] Incident count correct (deduped on alert_id)
- [ ] All three channels fire simultaneously (SMS + in-app + email)
- [ ] Venue can opt-out of alerts anytime
- [ ] Incidents logged for 90 days

---

## TECHNICAL REQUIREMENTS

### Frontend

**Performance targets:**
- App shell loads in <2 seconds (3G)
- Event list loads in <2 seconds (3G)
- Payment flow completes in <60 seconds
- Image lazy-loads (no blocking)
- Bundle size: <500KB gzipped

**Device profiles to test:**
- UK: iPhone 12–15, Samsung Galaxy S20–S24
- Nigeria: Tecno Spark, Infinix Hot, Itel phones (3GB RAM, older processors)

**Offline capability:**
- Service Worker caches app shell
- Offline user sees cached content + "No connection" banner
- SOS queue works offline (IndexedDB + Background Sync)

**Accessibility:**
- WCAG 2.1 AA minimum
- All buttons ≥48px touch target on mobile
- Colour contrast ≥4.5:1 for text
- All images have alt text

---

### Backend

**Uptime target:** 99.5%

**Latency targets:**
- API response: <200ms (p95)
- Database query: <50ms (p95)
- SMS delivery: <5 seconds
- Push delivery: <5 seconds

**Scaling:**
- Database: Read replicas if needed
- API: Horizontal scaling on Railway
- WebSocket: Sticky sessions or shared message broker (Redis)

**Security:**
- HTTPS only
- HTTPS everywhere (no mixed content)
- CSRF protection on all POST routes
- Rate limiting: 100 requests/minute per IP
- SQL injection prevention: parameterized queries
- XSS prevention: output escaping

**Data retention:**
- User location: 7 days (deleted automatically)
- Chat messages: indefinite (user-deletable)
- Event tickets: indefinite
- Failed payments: 90 days
- Logs: 30 days

---

### Database

**PostgreSQL 14+**

**Key tables:**
- users (authentication, profile, location)
- events (organiser-created)
- tickets (purchase records)
- posts (social feed)
- safety_buddies (SMS-based buddy assignment)
- check_in_timers (graduated timers)
- distress_alerts (SOS history)
- delivery_log (SMS/push delivery confirmation)
- communities (user groups)
- conversations (DMs)

**Indexing strategy:**
- B-tree on user_id, event_id, created_at
- GiST on location coordinates (for venue proximity)
- Full-text search on event names

---

## MARKET-SPECIFIC VARIATIONS

### United Kingdom

| Aspect | Implementation |
|--------|-----------------|
| Currency | GBP (£) |
| Payment | Stripe |
| SMS | Twilio (UK numbers) |
| Emergency | 999, 112 |
| Venue sample | Fabric London, Ministry of Sound, Phonogram |
| Language | English (UK spelling) |
| Legal | GDPR, Data Protection Act 2018 |
| Compliance | ICO consent, right to deletion |

### Nigeria

| Aspect | Implementation |
|--------|-----------------|
| Currency | NGN (₦) |
| Payment | Paystack |
| SMS | Termii (Nigerian carriers) |
| Emergency | 199 (police), 767 (LASEMA Lagos) |
| Venue sample | Lekki venues, Ikoyi clubs, Gbagada nightlife |
| Language | English, Pidgin in social (UGC) |
| Legal | NDPR (Nigeria Data Protection Regulation) |
| Compliance | NCC, NITDA, FCCPC |
| Device optimisation | Image compression, lazy loading, bandwidth-aware |

---

## SUCCESS METRICS

### User Engagement

| Metric | Target (UK) | Target (Nigeria) | Measured |
|--------|------------|------------------|----------|
| Monthly Active Users | 50,000 | 30,000 | In-app event tracking |
| Event Page Views | 500,000 | 300,000 | Page view analytics |
| Ticket Sales | 5,000 | 2,000 | Stripe + Paystack |
| Social Posts/Week | 20,000 | 10,000 | Post table count |
| Safety Buddy Confirmations | 70% of signups | 65% of signups | SMS reply tracking |
| Check-in Completion | 80% | 75% | Timer status tracking |

### Safety System Usage

| Metric | Target | Measured |
|--------|--------|----------|
| SOS triggers per month | <5 per 100,000 users (low false-alarm rate) | Alert table |
| SMS delivery success | 98% | Delivery log |
| Alert resolution time | <2 minutes (buddy reaches out) | Dashboard timestamp diff |
| Venue incidents per month | <2 per 1,000 users | Incident table |

### Business Metrics

| Metric | Target (Month 1) | Measured |
|--------|-----------------|----------|
| Ticket commission revenue | £5,000–10,000 | Stripe payout |
| Organiser subscriptions | 10 | Stripe subscription |
| Chargeback rate | <1% | Stripe disputes |
| User retention (D7) | 40% | Cohort analysis |
| User retention (D30) | 25% | Cohort analysis |

---

## FUTURE FEATURES (OUT OF SCOPE)

### Near term (post-launch, Q4 2025+)

- **Night Timeline:** Collaborative 24-hour story of a night out, shareable
- **Group split payments:** Multiple people splitting one ticket purchase
- **Venue Safety Score:** 0–100 rating based on incident density
- **After-Hours feed:** Midnight–5am location-based, event-unrelated feed

### Medium term (Series A+)

- **White-label safety:** Universities, festivals, corporate HR buy the system
- **Artist profiles:** DJs and producers can post, sell merch
- **Festival integrations:** Official partnerships with major festivals
- **Relik + Vib3Pulse:** Buy merch during events

### Long term (not prioritised)

- **Data/insights:** Sell anonymised event data to councils, researchers
- **Brand sponsorships:** Brands pay for placement in Discover feed
- **Advertising:** In-feed ads (non-intrusive, clearly marked)

---

## SIGN-OFF

**Product Manager:** [TBD]  
**Engineering Lead:** Founder 2 (CTO)  
**Design Lead:** Founder 3 (Creative Director)  
**Approved by:** Founder 1 (CEO)

**Approval date:** May 2026

---

**This PRD is a living document. Changes must be approved by the product manager and CTO before implementation.**

