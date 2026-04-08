# VibePulse — Business Brief

---

## What Is VibePulse?

VibePulse is a **social events platform** purpose-built for the nightlife and live experience economy. It combines two things that have historically lived in separate apps — **event discovery and ticketing** (think Eventbrite) with **social networking** (think Instagram) — into a single, cohesive product.

The result is a platform where going out is social from start to finish: users discover events through their social feed, buy tickets without leaving the app, plan the night with friends in group chats, share stories from the event, and have a safety net built in for when they're out.

VibePulse is built as a web app (with full PWA support) and is architected specifically to wrap into native iOS and Android apps via Median.co with minimal additional work.

---

## The Problem It Solves

The event and nightlife space is currently fragmented across too many apps. A person planning a night out today has to:
- Browse Eventbrite or Dice for events
- Text friends via WhatsApp to coordinate
- Post stories on Instagram afterwards
- Hope someone notices if something goes wrong

VibePulse collapses all of this into one destination — and adds a layer that no major competitor has: **built-in personal safety**.

---

## Who Uses It

VibePulse has three distinct user types, each with their own experience:

### 1. Social Users (consumers)
Regular people who want to discover events, follow friends, and plan nights out. They create posts, share 24-hour stories, follow each other, attend events, and use the safety features when going out alone.

### 2. Event Organisers
Promoters, venues, and brands who create and manage events. They sell tickets, track RSVPs and revenue, manage check-ins at the door, and promote their events through the platform's social layer. Only verified/official organiser accounts can list external ticketing links or access analytics.

### 3. Venue Operators
Owners and managers of clubs, pubs, lounges, and rooftop bars. They create a venue profile with a photo gallery, promote weekly entry nights (with cover charge ticketing), and appear in the Discover feed and search results.

---

## Core Feature Set

### Event Management & Ticketing
- Organisers create events with full details, images, location, and pricing
- Multiple ticket tiers per event (e.g., Early Bird, VIP, General)
- Integrated Stripe payments for ticket purchases
- QR-code ticket wallet for attendees (scannable at the door)
- Door check-in system for organisers to validate tickets on the night
- RSVP tracking, event analytics (views, RSVPs, tickets sold)

### Social Networking
- Instagram-style feed (posts with text, images, and video)
- 24-hour disappearing Stories (with video support)
- Follow/following graph, likes, comments, reposts
- Hashtags and @mentions
- Communities — topic-based groups with their own feed tabs
- Universal search across users, events, venues, and posts

### Direct Messaging & Group Planning
- One-to-one DMs and group chats (named groups with admin/member roles)
- Share events, venues, or posts directly inside a conversation
- In-chat polls for group decisions ("which venue tonight?")
- Last-admin protection ensures group ownership is never left unmanaged

### Venue Profiles
- Rich venue pages with up to 6 photos (lightbox gallery), description, location, and category
- Entry Nights — recurring nights with cover charges and ticketing built in
- Venue analytics tracking views and clicks over time

### Safety System (unique differentiator)
- Users assign a trusted contact as their **Safety Buddy**
- One-tap emergency alert with real-time GPS location, delivered instantly via push and in-app
- Reverse-geocoded location descriptions ("near Oxford Street") in alerts
- **Check-In Timer** — set a countdown before going somewhere; if you don't check in by the time it expires, your buddy is alerted automatically
- Alert history with "I'm Safe" and "False Alarm" resolution flow
- All of this is planned to expand to **multiple buddies** (up to 5) and a **buddy-side monitoring dashboard**

### Discovery & Trending
- Discover page with featured events, trending venues, and suggested people to follow
- Trending algorithm factors in likes, RSVPs, tickets sold, and views, with time-decay weighting so fresh content surfaces first
- Personalised suggestions based on social graph

### Admin & Moderation Panel
- Separate, secure staff panel with distinct login credentials
- Six-level role hierarchy (owner → support)
- Content moderation: review and act on user reports, suspend accounts, remove posts/stories
- Event moderation with override capability
- Finance tracking across ticket sales
- Full activity log of all admin actions

---

## Business Model

### Current Revenue Mechanisms
1. **Ticket Sales Commission** — VibePulse takes a platform fee on every ticket sold through the app. Stripe processes payments; the platform keeps a percentage before paying out to the organiser.
2. **Venue Entry Night Tickets** — Same commission model for cover-charge entry nights sold through venue profiles.

### Near-Term Revenue Opportunities
3. **Promoted Events & Venues** — Paid placement in the Discover feed and search results, similar to Instagram's sponsored posts model.
4. **Organiser Subscriptions** — Tiered plans giving organisers access to advanced analytics, unlimited events, priority support, and the verified badge.
5. **Native App Distribution** — Once wrapped into iOS/Android apps via Median.co, in-app purchase and subscription revenue becomes available through the App Store and Google Play.

### Longer-Term Opportunities
6. **White-Label Safety Features** — The buddy safety system is a standalone product. It can be licensed to universities, festival operators, corporate HR teams, or travel platforms.
7. **Brand & Sponsor Integration** — Branded events, sponsored communities, and in-story promotions from nightlife brands (alcohol, fashion, etc.).
8. **Data & Insights** — Aggregated nightlife trend data sold to venue operators, local councils, or urban planning firms.

---

## Competitive Positioning

| | VibePulse | Eventbrite | Instagram | Dice |
|---|---|---|---|---|
| Event ticketing | ✓ | ✓ | — | ✓ |
| Social feed & stories | ✓ | — | ✓ | — |
| Group planning & DMs | ✓ | — | Partial | — |
| Venue profiles | ✓ | — | — | Partial |
| Built-in safety system | ✓ | — | — | — |
| Native app ready | ✓ | ✓ | ✓ | ✓ |

VibePulse's deepest moat is the combination of **social graph + safety** in the nightlife context. No major competitor owns both.

---

## Technical Readiness

- **Stack:** React + TypeScript frontend, Express.js backend, PostgreSQL database, Stripe payments, WebSockets for real-time features
- **Deployment:** Hosted on Replit; production-ready deployment pipeline included
- **PWA:** Full Progressive Web App support with offline fallback, home screen install, and service worker caching
- **Mobile Apps:** Architecture and tech stack are pre-optimised for Median.co wrapping → publish to App Store and Google Play without a full native rebuild
- **Scalability:** Stateless Express API with a PostgreSQL-backed session store; ready for horizontal scaling or migration to a managed cloud backend

---

## Current Stage

VibePulse is a **fully functional web application** with all core systems built and operational:

- ✓ User authentication (social + organiser + admin accounts)
- ✓ Event creation, ticketing, and door check-in
- ✓ Venue management with gallery and entry nights
- ✓ Full social layer (posts, stories, video, communities, DMs, groups)
- ✓ Stripe payment integration
- ✓ Real-time notifications via WebSockets
- ✓ Safety buddy system with check-in timers and alert history
- ✓ Admin moderation panel with six-level roles
- ✓ PWA (installable, offline-capable)

**In active development:**
- Multiple safety buddies per user
- Buddy-side monitoring dashboard
- Emergency button gesture redesign for mobile

---

## The Opportunity

The global live events market is valued at over **$1.5 trillion** and recovering strongly. The nightlife economy — clubs, bars, festivals, venue nights — is a high-frequency, high-engagement vertical that is chronically underserved by social platforms. VibePulse sits at the intersection of going out, staying connected, and staying safe.

The safety angle is not just a feature — in the current cultural climate around nightlife safety (spiking concerns, lone traveller risk, festival incidents), it is a **genuine societal need** that creates meaningful press coverage, word-of-mouth, and institutional partnership opportunities (universities, local councils, event safety bodies).

---

*Prepared for business development review. Technical questions can be directed to the development team.*
