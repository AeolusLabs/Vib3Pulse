# VibePulse - Event Discovery & Social Platform

## Overview

VibePulse is a modern event discovery and social networking platform that combines the functionality of event management systems (like Eventbrite) with social features (like Instagram). The platform enables users to discover events, connect with organizers and attendees, share stories and posts, and manage event ticketing.

The application is built as a full-stack TypeScript project with a React frontend and Express backend, designed for deployment on Replit with PostgreSQL database support.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework & Build System:**
- React 18 with TypeScript for type safety
- Vite as the build tool and development server
- Wouter for lightweight client-side routing
- Single-page application (SPA) architecture

**UI Component System:**
- shadcn/ui component library with Radix UI primitives
- Tailwind CSS for styling with custom design tokens
- Custom theme system supporting light/dark modes
- Purple-forward brand identity (#D0BFFF primary color)
- Typography: PT Sans (body), Playfair Display (headings)

**State Management:**
- TanStack Query (React Query) for server state management
- Local component state with React hooks
- No global state management library (relies on React Query cache)

**Design Pattern:**
- Component-based architecture with reusable UI components
- Page-level components in `/pages` directory
- Shared components in `/components` directory
- Mobile-first responsive design with bottom navigation for mobile devices

### Backend Architecture

**Server Framework:**
- Express.js for HTTP server and API routing
- TypeScript for type safety across the stack
- Session-based architecture (using connect-pg-simple for session storage)

**API Design:**
- RESTful API pattern (routes prefixed with `/api`)
- Currently minimal implementation with storage interface defined
- Designed for CRUD operations through storage abstraction layer

**Development Setup:**
- Vite middleware integration for development
- Hot module replacement (HMR) support
- Custom logging middleware for API requests

### Data Storage Solutions

**Database:**
- PostgreSQL as the primary database (via Neon serverless)
- Drizzle ORM for type-safe database queries
- Schema-first approach with migrations in `/migrations` directory

**Current Schema:**
- Users table with UUID primary keys, username, and password fields
- Extensible schema design for future event, ticket, and social features

**Storage Abstraction:**
- `IStorage` interface pattern for database operations
- `MemStorage` in-memory implementation for development/testing
- Designed to swap between in-memory and PostgreSQL implementations

**Session Management:**
- PostgreSQL-backed sessions via connect-pg-simple
- Session data stored in database for persistence

### Authentication & Authorization

**Implementation Status:** ✅ Complete

**Backend Authentication:**
- Passport Local Strategy with bcrypt password hashing (12 rounds)
- PostgreSQL session store with auto-creation enabled
- Secure session cookies (HttpOnly, SameSite=lax)
- Email and username uniqueness validation
- Auth middleware: `requireAuth` and `requireOrganizer`
- All protected routes use `req.user.id` from authenticated session

**API Routes:**
- `POST /api/auth/signup` - Create account with email/username/password
- `POST /api/auth/login` - Authenticate user and create session
- `POST /api/auth/logout` - Destroy session
- `GET /api/auth/session` - Get current authenticated user

**Frontend Authentication:**
- `useAuth` hook provides global authentication state
- `AuthenticatedLayout` component for centralized route protection
- Login page with redirect parameter support for post-login navigation
- Redirect preserves full URL (pathname + query + hash)
- All authenticated queries include `credentials: 'include'`

**Security Features:**
- Bcrypt password hashing with salt (12 rounds)
- HttpOnly cookies prevent XSS attacks
- SameSite=lax prevents CSRF attacks
- Unique email/username constraints prevent duplicates
- Session secret rotation support

**Design Pattern:**
- Session-based authentication (not JWT)
- Credentials flow with secure password storage
- Type-safe user operations through Drizzle schema
- Centralized auth guard via `AuthenticatedLayout`

**Follow-up Work Needed:**
- Some pages (FeedPage, ManageEventsPage, MyEventsPage) may need credential verification
- Chat mutations should be updated to remove client-provided `senderId`
- All queries using custom queryFn should verify they include `credentials: 'include'`

### Stories Feature

**Implementation Status:** ✅ Complete

**Backend Implementation:**
- Database schema: `stories` table with fields (id, userId, imageUrl, type, createdAt)
- Storage methods: `createStory`, `getActiveStories`, `getUserStories`, `deleteStory`
- 24-hour auto-expiration via SQL filtering: `WHERE createdAt >= NOW() - INTERVAL '24 hours'`
- API routes:
  - `POST /api/stories` - Create new story (authenticated)
  - `GET /api/stories` - Get all active stories with user data
  - `DELETE /api/stories/:id` - Delete own story (owner authorization)

**Frontend Implementation:**
- **CreateStoryModal**: Camera/upload interface for posting image stories
  - Supports both camera capture and file upload
  - Posts to `/api/stories` API with cache invalidation
  - Shows loading state while posting
- **FeedPage**: Displays stories bar with real data from API
  - Fetches stories from `/api/stories`
  - Groups stories by user (multiple stories per user become slides)
  - Passes owner ID to StoryViewer for delete authorization
- **StoryViewer**: Full-screen story viewer with auto-progression
  - Shows delete button only for user's own stories
  - Deletes via `/api/stories/:id` with confirmation dialog
  - Auto-advances through slides with progress indicators

**Features:**
- 24-hour automatic expiration (no background job needed - server-side filtering)
- Users can post image stories
- Stories grouped by user in feed
- Delete own stories with confirmation
- Real-time cache updates via TanStack Query invalidation
- Full authentication and authorization

### Buddy System (Safety Feature)

**Implementation Status:** ✅ Complete

**Overview:**
Safety feature that allows social users to designate a trusted friend as their "buddy" (emergency contact) and send distress alerts with location sharing.

**Backend Implementation:**
- **Database schema:**
  - `buddies` table: (id, userId, buddyId, createdAt) with unique constraint on userId
  - `distress_messages` table: (id, userId, message, updatedAt) with unique userId
  - `distress_alerts` table: (id, userId, buddyId, message, latitude, longitude, createdAt)
- **Storage methods:** `setBuddy`, `getBuddy`, `removeBuddy`, `setDistressMessage`, `getDistressMessage`, `logDistressAlert`, `getDistressAlerts`
- **API routes with Zod validation:**
  - `POST /api/buddy/set` - Set a buddy (validates buddyId, prevents self-selection)
  - `GET /api/buddy` - Get current buddy
  - `DELETE /api/buddy` - Remove buddy
  - `POST /api/buddy/distress-message` - Save custom distress message (max 500 chars)
  - `GET /api/buddy/distress-message` - Get current distress message
  - `POST /api/buddy/trigger-alert` - Trigger emergency alert (validates coordinates: lat [-90,90], lng [-180,180])
  - `GET /api/buddy/alerts` - Get alert history (sent and received)

**Frontend Implementation:**
- **BuddySettings component:** 
  - Select buddy from social users via UserSearch
  - Configure custom distress message
  - View and remove current buddy
  - Embedded in ProfilePage
- **EmergencyButton component:**
  - Always visible in Navigation header (social users only)
  - Requests geolocation permission
  - Captures GPS coordinates
  - Sends alert with confirmation dialog
- **BuddySettingsPage:** Dedicated page for buddy configuration (accessible via user menu)
- **DistressAlertsPage:** View history of sent/received alerts with location links
- **UserSearch component:** Authenticated user search with 2-char minimum query

**Security Features:**
- All endpoints require authentication (`requireAuth`)
- Zod validation on all inputs (buddyId, message length, coordinate ranges)
- User search protected to prevent enumeration
- Self-selection prevented (cannot set yourself as buddy)
- Coordinate validation: latitude [-90, 90], longitude [-180, 180]

**Real-time Features:**
- WebSocket integration for instant in-app alerts
- When user triggers alert, buddy receives:
  - Distress message
  - Current GPS location with Google Maps link
  - Real-time WebSocket notification
  - Alert logged to database for safety records

**User Experience:**
1. Social users set a trusted friend as their buddy
2. Optionally customize distress message
3. Emergency button always accessible in navigation
4. One-click alert triggers:
   - Location capture via browser Geolocation API
   - Message sent to buddy via WebSocket
   - Alert logged in database
5. Both parties can view alert history with timestamps and locations

**Note:** Architecture is ready for SMS notifications via Twilio when credentials are added

### External Dependencies

**UI & Styling:**
- Radix UI component primitives (@radix-ui/react-*)
- Tailwind CSS with PostCSS for processing
- class-variance-authority for component variants
- Google Fonts CDN (PT Sans, Playfair Display)

**Data & State:**
- @tanstack/react-query for server state
- drizzle-orm for database queries
- drizzle-zod for schema validation
- zod for runtime type validation

**Database:**
- @neondatabase/serverless for PostgreSQL connection
- connect-pg-simple for session storage
- Drizzle Kit for schema migrations

**Development Tools:**
- Vite with React plugin
- tsx for TypeScript execution
- esbuild for production builds
- Custom Replit plugins (cartographer, dev-banner, runtime-error-modal)

**Utilities:**
- date-fns for date manipulation
- clsx & tailwind-merge for className management
- embla-carousel-react for carousels
- lucide-react for icons
- wouter for routing
- react-hook-form with @hookform/resolvers for forms

**Build & Deployment:**
- Deployment target: Replit environment
- Environment variables: DATABASE_URL for PostgreSQL connection
- Build outputs to `/dist` directory
- Static assets served from Vite build