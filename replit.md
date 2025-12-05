# VibePulse - Event Discovery & Social Platform

## Overview
VibePulse is an event discovery and social networking platform. It combines event management features (like Eventbrite) with social functionalities (like Instagram), allowing users to discover events, connect with others, share content, and manage ticketing. Built as a full-stack TypeScript project using React for the frontend and Express for the backend, it's designed for deployment on Replit with PostgreSQL. The platform aims to capture market potential in the social event space.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework:** React 18 with TypeScript, Vite for bundling.
- **UI:** shadcn/ui with Radix UI, Tailwind CSS for styling, custom theme with purple-forward identity, PT Sans and Playfair Display fonts.
- **State Management:** TanStack Query for server state; local component state via React hooks.
- **Design:** Component-based, mobile-first responsive design with bottom navigation.

### Backend
- **Framework:** Express.js with TypeScript.
- **API:** RESTful pattern (`/api` prefix), designed for CRUD operations via a storage abstraction layer.
- **Authentication:** Session-based (Passport Local Strategy with bcrypt, PostgreSQL session store), secure cookies (HttpOnly, SameSite=lax), role-based authorization (e.g., `requireAuth`, `requireOrganizer`).
- **Features:**
    - **Stories:** Image stories with 24-hour expiration, user grouping, and deletion, real-time cache updates.
    - **Buddy System (Safety Feature):** Users designate a trusted friend as an emergency contact. Allows sending distress alerts with location sharing, real-time WebSocket notifications, and alert history.
    - **Venues:** Event Organizers manage clubs, pubs, and lounges. Includes venue promotion, entry ticket sales (simulated for demo), and analytics tracking.
    - **Search & Discovery:** Universal search across users, events, venues, and posts with type filter chips. Trending sections show popular content based on engagement metrics (likes, RSVPs, tickets sold, views) with time decay algorithm. Suggested users section helps users discover new people to follow.
    - **Admin Panel:** Separate, secure staff-only panel with distinct authentication, role-based access control (6 levels), activity logging, and moderation capabilities for users, events, stories, and content reports. Visual design uses a dark slate color scheme distinct from the main app.

### Data Storage
- **Database:** PostgreSQL (via Neon serverless) as the primary database.
- **ORM:** Drizzle ORM for type-safe queries, schema-first approach with migrations.
- **Schema:** Users, stories, buddies, distress messages, distress alerts, venues, venue entry nights, venue tickets, venue analytics, admin users, admin activity logs, content reports, user suspensions, event moderations.
- **Abstraction:** `IStorage` interface for database operations, allowing interchangeability (e.g., `MemStorage` for development).
- **Session Management:** PostgreSQL-backed sessions.

## External Dependencies

### UI & Styling
- Radix UI component primitives (`@radix-ui/react-*`)
- Tailwind CSS with PostCSS
- `class-variance-authority`
- Google Fonts CDN

### Data & State
- `@tanstack/react-query`
- `drizzle-orm`
- `drizzle-zod`
- `zod`

### Database
- `@neondatabase/serverless`
- `connect-pg-simple`
- Drizzle Kit

### Development Tools
- Vite with React plugin
- `tsx`
- `esbuild`

### Utilities
- `date-fns`
- `clsx`, `tailwind-merge`
- `embla-carousel-react`
- `lucide-react`
- `wouter`
- `react-hook-form` with `@hookform/resolvers`

### Build & Deployment
- Replit environment
- Simulated payments for demo purposes

### Payment System
The payment system is fully simulated for demo purposes. No real payment processing occurs.

**Simulated Payment Features:**
- All payments are simulated - no real charges
- Checkout sessions auto-complete with success status
- Payment intents return mock client secrets
- UI shows a "Demo Mode" indicator in payment forms
- Ticket purchases are confirmed instantly

The payment abstraction layer is in `server/paymentService.ts` and provides:
- `createCheckoutSession()` - For event ticket purchases (simulated)
- `retrieveCheckoutSession()` - For payment verification (simulated)
- `createPaymentIntent()` - For venue entry tickets (simulated)
- All functions return mock data suitable for testing and demos

## Development Patterns

### Authentication in Frontend Components
- Use the `useAuth()` hook from `@/hooks/useAuth.ts` to access the current user session
- The hook returns `{ data: User | null, isLoading, error }` - the `data` is the User object directly (not wrapped in `{ user: User }`)
- Pattern: `const { data: currentUser } = useAuth();` then access `currentUser?.id`, `currentUser?.username`, etc.
- The hook includes built-in 401 handling and redirects to login when unauthenticated

### API Route Patterns
- User lookup routes accept both UUID and username via `/api/users/:identifier` pattern
- UUID detection regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
- Following list endpoint: `GET /api/follows/me/following` (requires auth, returns User[])

### Known Development Environment Issues
- Vite HMR WebSocket error (`wss://localhost:undefined`) appears in browser console in Replit environment - this is a known Replit development issue that does not affect app functionality