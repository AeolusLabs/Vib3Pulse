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

**Current Implementation:**
- Basic user schema with username/password fields
- Zod validation schemas for user input (drizzle-zod integration)
- Session-based authentication infrastructure in place
- No active authentication routes implemented yet

**Design Pattern:**
- Credential-based authentication planned
- Session cookies for maintaining user state
- Type-safe user operations through Drizzle schema

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