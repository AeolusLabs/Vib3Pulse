# VibePulse Design Guidelines

## Design Approach
**Reference-Based Approach**: Drawing inspiration from modern event platforms (Eventbrite, Meetup) and social platforms (Instagram feed patterns) while maintaining originality through the distinctive purple brand palette.

## Design Principles
- **Purple-Forward Identity**: Embrace the #D0BFFF primary purple as the defining visual element
- **Social-First**: Prioritize discoverability and user connections
- **Event Clarity**: Make event details scannable and actionable

---

## Core Design Elements

### Typography System
**Fonts**: PT Sans (body), Playfair (headlines) via Google Fonts CDN

**Hierarchy**:
- Hero Headlines: Playfair, 48px (desktop) / 32px (mobile), font-weight 700
- Section Titles: Playfair, 36px / 28px, font-weight 600
- Card Titles: PT Sans, 20px, font-weight 600
- Body Text: PT Sans, 16px, font-weight 400
- Supporting Text: PT Sans, 14px, font-weight 400

### Layout System
**Spacing Units**: Use theme spacing (8px, 16px, 24px) consistently
- Component gaps: 16px (medium)
- Section padding: 24px (large)
- Card internal spacing: 16px (medium)
- Tight spacing (badges, tags): 8px (small)

**Grid Structure**:
- Max content width: 1200px centered
- Event cards: 3-column grid (desktop), 2-column (tablet), 1-column (mobile)
- Profile sections: 2-column split (desktop), stacked (mobile)

### Color Application
**User-Provided Palette** (must be used):
- Primary (#D0BFFF): Primary CTAs, active states, key UI elements
- Background (#F5F5F5): Page backgrounds
- Accent (#B0D0FF): Secondary buttons, highlights, borders on hover
- Text Default (#333333): Body text, headings
- Error (#FF4136): Validation errors, destructive actions
- Success (#2ECC40): Confirmations, successful RSVPs
- Border (#D0D0D0): Card borders, dividers, input borders

---

## Component Library

### Core Components (User-Specified)
**Button**: Primary background (#D0BFFF), white text, medium padding (16px), rounded corners (8px), accent hover (#B0D0FF)

**Input**: Background (#F5F5F5), text default color (#333333), subtle border (#D0D0D0), accent border (#B0D0FF) on focus

**Card**: Background white, medium padding (16px), rounded corners (12px), border (#D0D0D0)

### Extended Components

**Event Card**:
- Event image (16:9 ratio, rounded top corners)
- Event title (PT Sans 20px bold)
- Date/time badge (primary background, white text, positioned absolute top-right)
- Organizer avatar + name
- Location indicator
- Ticket price or "Free" label
- RSVP count indicator
- Action button (primary or accent based on status)

**Navigation Bar**:
- Logo/wordmark (Playfair, primary color)
- Search bar (full-width on mobile, 400px max desktop)
- User avatar + dropdown
- Create Event button (Event Organizers only) - primary background

**User Profile Card**:
- Cover image area (optional, 200px height)
- Avatar (80px, overlapping cover)
- Username (Playfair 24px)
- Bio (PT Sans 14px)
- Follow/Following counts
- Follow button (accent background for unfollowed, border-only for following)

**Ticket Selection Component**:
- Ticket tier name (PT Sans 18px bold)
- Price (Playfair 24px, primary color)
- Quantity selector (border buttons, +/- controls)
- Available count indicator
- Description (PT Sans 14px, muted)

**Feed/Discovery Layout**:
- Filter bar: Category chips (border-style, primary fill when active)
- Sort dropdown (date, popularity, proximity)
- Masonry-style event grid with varying card heights based on content

---

## Page Specifications

### Discover Page (Landing/Home)
**Hero Section** (400px height):
- Background: Gradient overlay on event imagery (purple tint from primary color)
- Headline: "Discover Events That Match Your Vibe" (Playfair 48px, white)
- Search bar (large, white background, blurred backdrop)
- Category quick filters (horizontal scroll on mobile)

**Event Grid**:
- 3-column responsive grid
- Each event card with hover elevation effect
- Infinite scroll or pagination

### Event Detail Page
**Layout**:
- Full-width hero image (500px height, gradient overlay)
- Breadcrumb navigation
- 2-column layout: 
  - Left (60%): Event details, description, organizer info
  - Right (40%): Sticky ticket selection card or RSVP button

**Components**:
- Event header with title (Playfair 36px), date/time, location
- Share buttons (icon-only, accent color)
- Ticket tiers (if applicable) in Card components
- Simulated payment form for demo purchases
- Similar events carousel at bottom

### User Profile Page
**Layout**:
- Profile header (cover + avatar + follow button)
- Tabs: Events Created (organizers) / RSVPs (social users) / Following
- Grid of relevant cards below tabs

---

## Icons
Use **Heroicons** via CDN (outline style for consistency)

## Images
**Event Imagery**: High-quality event photos, 16:9 aspect ratio
**Hero Sections**: Use vibrant event photography with purple gradient overlays
**Avatars**: Circular, 40-80px depending on context
**Placeholder**: Subtle pattern or primary color wash for missing images

## Interactions
- Card hover: Subtle elevation (shadow increase)
- Button hover: Implemented via Button component (accent background)
- Link hover: Underline decoration
- Minimize complex animations - focus on smooth transitions (200-300ms)