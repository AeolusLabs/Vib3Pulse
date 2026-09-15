import { 
  type User, 
  type InsertUser,
  type Event,
  type InsertEvent,
  type Ticket,
  type InsertTicket,
  type TicketTier,
  type InsertTicketTier,
  type Rsvp,
  type InsertRsvp,
  type Post,
  type InsertPost,
  type Story,
  type InsertStory,
  type StoryLike,
  type InsertStoryLike,
  type StoryView,
  type InsertStoryView,
  type StoryAllowedViewer,
  type InsertStoryAllowedViewer,
  type Follow,
  type InsertFollow,
  type Message,
  type InsertMessage,
  type Like,
  type InsertLike,
  type Comment,
  type InsertComment,
  type CommentLike,
  type InsertCommentLike,
  type CommentReply,
  type InsertCommentReply,
  type CommentRepost,
  type InsertCommentRepost,
  type Bookmark,
  type InsertBookmark,
  type Repost,
  type InsertRepost,
  type Hashtag,
  type InsertHashtag,
  type PostHashtag,
  type InsertPostHashtag,
  type PostMention,
  type InsertPostMention,
  type SafetyBuddy,
  type InsertSafetyBuddy,
  type SafetyAlert,
  type SafetyTimer,
  type SafetyAlertShare,
  type DeliveryLog,
  type DistressMessage,
  type InsertDistressMessage,
  type EventAnalytics,
  type InsertEventAnalytics,
  type Venue,
  type InsertVenue,
  type VenueEntryNight,
  type InsertVenueEntryNight,
  type VenueTicket,
  type InsertVenueTicket,
  type VenueAnalytics,
  type InsertVenueAnalytics,
  type AdminUser,
  type InsertAdminUser,
  type AdminActivityLog,
  type InsertAdminActivityLog,
  type ContentReport,
  type InsertContentReport,
  type UserSuspension,
  type InsertUserSuspension,
  type EventModeration,
  type InsertEventModeration,
  type Notification,
  type InsertNotification,
  type Community,
  type InsertCommunity,
  type CommunityMembership,
  type InsertCommunityMembership,
  type Conversation,
  type InsertConversation,
  type ConversationParticipant,
  type InsertConversationParticipant,
  type ConversationMessage,
  type InsertConversationMessage,
  type Poll,
  type InsertPoll,
  type PollOption,
  type InsertPollOption,
  type PollVote,
  type InsertPollVote,
  type PushSubscription,
  type InsertPushSubscription,
  type EventStaffAccessCode,
  type VenueStaffAccessCode,
  users,
  events,
  tickets,
  ticketTiers,
  rsvps,
  posts,
  stories,
  storyLikes,
  storyViews,
  storyAllowedViewers,
  follows,
  messages,
  likes,
  comments,
  commentLikes,
  commentReplies,
  commentReposts,
  bookmarks,
  reposts,
  hashtags,
  postHashtags,
  postMentions,
  safetyBuddies,
  distressMessages,
  safetyAlerts,
  safetyTimers,
  safetyAlertShares,
  deliveryLogs,
  eventAnalytics,
  venues,
  venueEntryNights,
  venueTickets,
  venueAnalytics,
  adminUsers,
  adminActivityLogs,
  contentReports,
  userSuspensions,
  eventModerations,
  notifications,
  communities,
  communityMemberships,
  conversations,
  conversationParticipants,
  conversationMessages,
  polls,
  pollOptions,
  pollVotes,
  pushSubscriptions,
  eventStaffAccessCodes,
  venueStaffAccessCodes,
  type EventRating,
  type VenueRating,
  eventRatings,
  venueRatings,
  connectedSocials,
  socialPosts,
  type ConnectedSocial,
  type SocialPost,
  paymentIssues,
  type PaymentIssue,
  type InsertPaymentIssue,
  platformSettings,
  type PlatformSettings,
  organizerPaymentAccounts,
  type OrganizerPaymentAccount,
  type InsertOrganizerPaymentAccount,
  paymentTransactions,
  type PaymentTransaction,
  type InsertPaymentTransaction,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, gte, gt, lt, or, ilike, desc, sql, count, inArray, notInArray, isNull, isNotNull } from "drizzle-orm";
import crypto from "crypto";
import { cached, postsCache, eventsCache, storiesCache, invalidateCache } from "./cache";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const db = drizzle(pool);

// Idempotent schema migration — runs at server startup to add new columns safely
export async function ensureSchema() {
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP'
  `);
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true
  `);
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending'
  `);
  // Backfill: existing published events are already live — mark them approved
  await pool.query(`
    UPDATE events SET moderation_status = 'approved'
    WHERE is_published = true AND moderation_status = 'pending'
  `);
  await pool.query(`
    ALTER TABLE venue_entry_nights ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending'
  `);
  // Backfill: existing active venue entry nights are already live — mark them approved
  await pool.query(`
    UPDATE venue_entry_nights SET moderation_status = 'approved'
    WHERE is_active = true AND moderation_status = 'pending'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_staff_access_codes (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id VARCHAR NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      organizer_id VARCHAR NOT NULL REFERENCES users(id),
      code VARCHAR(6) NOT NULL,
      scanner_token VARCHAR UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMP NOT NULL,
      validated_by VARCHAR,
      validated_device_ip VARCHAR,
      validated_device_ua TEXT,
      redeemed_at TIMESTAMP,
      scan_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_staff_access_codes (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      venue_entry_night_id VARCHAR NOT NULL REFERENCES venue_entry_nights(id) ON DELETE CASCADE,
      organizer_id VARCHAR NOT NULL REFERENCES users(id),
      code VARCHAR(6) NOT NULL,
      scanner_token VARCHAR UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMP NOT NULL,
      validated_by VARCHAR,
      validated_device_ip VARCHAR,
      validated_device_ua TEXT,
      redeemed_at TIMESTAMP,
      scan_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_views (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      story_id VARCHAR NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      user_id VARCHAR NOT NULL REFERENCES users(id),
      viewed_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(story_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_ratings (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id VARCHAR NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP,
      UNIQUE(event_id, user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_event_ratings_event_id ON event_ratings(event_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_event_ratings_user_id ON event_ratings(user_id)
  `);
  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS direct_key VARCHAR UNIQUE
  `);
  await pool.query(`
    DROP TABLE IF EXISTS story_replies
  `);
  await pool.query(`
    ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS story_id VARCHAR REFERENCES stories(id) ON DELETE SET NULL
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE
  `);
  await pool.query(`
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL
  `);

  // ── Zernio Social Media Integration ─────────────────────────────────────────

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS zernio_profile_id VARCHAR(255) UNIQUE
  `);

  // oauth_state / oauth_state_expires_at columns track the pending OAuth flow
  // per-organizer per-platform so the callback can verify state and prevent CSRF.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connected_socials (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL,
      zernio_account_id VARCHAR(255) NOT NULL,
      handle VARCHAR(255),
      connected_at TIMESTAMP NOT NULL DEFAULT now(),
      disconnected_at TIMESTAMP,
      oauth_state VARCHAR(128),
      oauth_state_expires_at TIMESTAMP,
      UNIQUE(user_id, platform)
    )
  `);

  // zernio_post_id is UNIQUE but nullable — failed posts have no Zernio ID and
  // NULLs do not collide in a UNIQUE constraint, so retries insert new rows cleanly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id VARCHAR NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL,
      zernio_post_id VARCHAR(255) UNIQUE,
      content TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'posted',
      error_message TEXT,
      posted_at TIMESTAMP NOT NULL DEFAULT now(),
      cost_usd DECIMAL(10,2) NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_connected_socials_user
      ON connected_socials(user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_social_posts_user
      ON social_posts(user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_social_posts_event
      ON social_posts(event_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_social_posts_platform
      ON social_posts(platform)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_social_posts_posted_at
      ON social_posts(posted_at)
  `);

  // Event ticket oversell guard + soft-cancellation (payment system Phase 1 fixes)
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS tickets_sold INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP
  `);
  await pool.query(`
    ALTER TABLE ticket_tiers ADD COLUMN IF NOT EXISTS sold INTEGER NOT NULL DEFAULT 0
  `);
  // Refund failures that previously only went to console.error — now queryable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_issues (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id VARCHAR,
      provider_payment_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'refund_failed',
      error_message TEXT,
      resolved_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  // Payout architecture foundation (Phase 2): commission rate, organizer payout
  // accounts, and the money-movement ledger.
  await pool.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS fee_passthrough_to_buyer BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE venue_entry_nights ADD COLUMN IF NOT EXISTS fee_passthrough_to_buyer BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id VARCHAR PRIMARY KEY DEFAULT 'default',
      commission_bps INTEGER NOT NULL DEFAULT 1000,
      updated_by VARCHAR,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizer_payment_accounts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      stripe_account_id VARCHAR(255),
      paystack_subaccount_code VARCHAR(255),
      details_submitted BOOLEAN NOT NULL DEFAULT false,
      payouts_enabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(user_id, provider)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_payment_id TEXT,
      currency TEXT NOT NULL,
      buyer_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
      organizer_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
      event_id VARCHAR REFERENCES events(id) ON DELETE SET NULL,
      venue_id VARCHAR REFERENCES venues(id) ON DELETE SET NULL,
      venue_entry_night_id VARCHAR REFERENCES venue_entry_nights(id) ON DELETE SET NULL,
      ticket_id VARCHAR,
      gross_amount INTEGER NOT NULL,
      platform_fee_amount INTEGER NOT NULL DEFAULT 0,
      net_to_organizer_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'succeeded',
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_transactions_organizer
      ON payment_transactions(organizer_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at
      ON payment_transactions(created_at)
  `);

  // Currency correctness (Phase 3): `currency` is now the sole, explicit,
  // organizer-chosen source of truth for what a charge is made in — it is no
  // longer re-derived from free-text city at checkout time. `venues` never had
  // a currency column at all; add it, then run a ONE-TIME backfill using the
  // exact same 10-city heuristic the old resolveCurrency(city) used, so an
  // already-live Nigerian event/venue doesn't silently revert to GBP the
  // moment the code stops re-deriving currency from its city on every request.
  // This UPDATE is safe to run on every boot — it only ever touches rows still
  // sitting on the column's untouched 'GBP' default, so it can never overwrite
  // a currency an organizer (or a prior run of this same backfill) already set.
  await pool.query(`
    ALTER TABLE venues ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP'
  `);
  const NG_CITY_PATTERN = "(lagos|abuja|port harcourt|ibadan|kano|kaduna|benin|enugu|calabar|owerri)";
  await pool.query(`
    UPDATE events SET currency = 'NGN'
    WHERE currency = 'GBP' AND city ~* $1
  `, [NG_CITY_PATTERN]);
  await pool.query(`
    UPDATE venues SET currency = 'NGN'
    WHERE currency = 'GBP' AND city ~* $1
  `, [NG_CITY_PATTERN]);
  await pool.query(`
    UPDATE ticket_tiers SET currency = 'NGN'
    FROM events
    WHERE ticket_tiers.event_id = events.id
      AND ticket_tiers.currency = 'GBP' AND events.currency = 'NGN'
  `);

  // Recurring venue events — see the recurrence/recurrenceParentId comment
  // on venueEntryNights in shared/schema.ts.
  await pool.query(`
    ALTER TABLE venue_entry_nights ADD COLUMN IF NOT EXISTS recurrence TEXT NOT NULL DEFAULT 'none'
  `);
  await pool.query(`
    ALTER TABLE venue_entry_nights ADD COLUMN IF NOT EXISTS recurrence_parent_id VARCHAR
  `);

  // Messaging/Communities pass — read receipts, event-linked group chats,
  // community types/rules, pinned posts, and generalizing `comments` to
  // cover story comments too (see the commentTargetCheck comment on
  // comments in shared/schema.ts).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts_enabled BOOLEAN NOT NULL DEFAULT true
  `);
  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS event_id VARCHAR REFERENCES events(id) ON DELETE SET NULL
  `);
  await pool.query(`
    ALTER TABLE communities ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'general'
  `);
  await pool.query(`
    ALTER TABLE communities ADD COLUMN IF NOT EXISTS rules TEXT
  `);
  await pool.query(`
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    ALTER TABLE comments ALTER COLUMN post_id DROP NOT NULL
  `);
  await pool.query(`
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS story_id VARCHAR REFERENCES stories(id) ON DELETE CASCADE
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'comment_target_check' AND table_name = 'comments'
      ) THEN
        ALTER TABLE comments ADD CONSTRAINT comment_target_check
          CHECK ((post_id IS NOT NULL AND story_id IS NULL) OR (post_id IS NULL AND story_id IS NOT NULL));
      END IF;
    END $$;
  `);
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUsersByUsernames(usernames: string[]): Promise<User[]>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createUserFromGoogle(data: { email: string; googleId: string; displayName: string; avatarUrl?: string }): Promise<User>;
  linkGoogleId(userId: string, googleId: string): Promise<void>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User>;
  updateUserPassword(userId: string, hashedPassword: string): Promise<void>;
  updateUsername(userId: string, newUsername: string): Promise<User>;
  setPasswordResetToken(userId: string, token: string, expires: Date): Promise<void>;
  getUserByPasswordResetToken(token: string): Promise<User | undefined>;
  clearPasswordResetToken(userId: string): Promise<void>;
  setEmailVerificationToken(userId: string, tokenHash: string, expires: Date): Promise<void>;
  getUserByEmailVerificationToken(tokenHash: string): Promise<User | undefined>;
  clearEmailVerificationToken(userId: string): Promise<void>;
  setUserVerified(userId: string): Promise<void>;
  
  getEvents(): Promise<(Event & { minPrice: number; maxPrice: number })[]>;
  getEventsByCategory(category: string): Promise<(Event & { minPrice: number; maxPrice: number })[]>;
  // eventId -> weighted rsvpCount*2 + ticketCount*3, for feed ranking and trending-in-city.
  getEventEngagementCounts(): Promise<Map<string, number>>;
  getBulkEventTicketTiers(eventIds: string[]): Promise<TicketTier[]>;
  getEvent(id: string): Promise<(Event & { organizer: User; community: (Community & { memberCount: number }) | null }) | undefined>;
  getUserEvents(userId: string): Promise<Event[]>;
  getEventsByOrganizer(organizerId: string): Promise<Event[]>;
  createEvent(event: InsertEvent): Promise<Event>;
  updateEvent(id: string, event: Partial<InsertEvent>): Promise<Event>;
  setEventPublished(id: string, published: boolean): Promise<Event>;
  
  getUserTickets(userId: string): Promise<Array<Ticket & { event: Event }>>;
  getTicket(id: string): Promise<Ticket | undefined>;
  getTicketByPaymentIntent(paymentIntentId: string): Promise<Ticket | undefined>;
  // Plural counterpart for multi-ticket (quantity > 1) purchases, which all share
  // one providerPaymentId — used to detect a fully-issued order for idempotency.
  getTicketsByPaymentIntent(paymentIntentId: string): Promise<Ticket[]>;
  getTicketByValidationCode(validationCode: string): Promise<Ticket | undefined>;
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  checkInTicket(ticketId: string, organizerId: string): Promise<Ticket>;
  getEventCheckIns(eventId: string): Promise<Array<Ticket & { user: User }>>;
  // Public "who's going" sample for the Event Detail page — union of RSVP'd
  // and confirmed-ticket-holding users, deduped, capped at `limit` rows
  // returned but totalCount reflects the full distinct attendee count.
  getEventAttendeesSample(eventId: string, limit?: number): Promise<{ users: Array<Pick<User, "id" | "username" | "displayName" | "avatarUrl">>; totalCount: number }>;
  getAllEventAttendeeIds(eventId: string): Promise<string[]>;
  // Single grouped query (not N+1) — real revenue per event for an event-list
  // view like Manage Events, as opposed to getOrganizerDemographics's heavier
  // per-event breakdown used by the full analytics dashboard.
  getEventRevenueByIds(eventIds: string[]): Promise<Map<string, number>>;
  // Atomic oversell guard for event tickets — mirrors claimVenueTicketSlot.
  // Pass ticketTierId when the purchase was for a specific tier, null for a plain event ticket.
  // quantity claims multiple slots in a single atomic check (all-or-nothing).
  claimEventTicketSlot(eventId: string, ticketTierId: string | null, quantity?: number): Promise<boolean>;
  // Event cancellation with refunds — orchestration (calling the payment provider) lives
  // in the route handler; storage only provides the DB primitives it needs.
  getConfirmedTicketsForEvent(eventId: string): Promise<Ticket[]>;
  markEventCancelled(eventId: string): Promise<Event>;
  markTicketRefunded(ticketId: string): Promise<void>;
  createPaymentIssue(issue: InsertPaymentIssue): Promise<PaymentIssue>;

  // Platform commission rate — admin-adjustable, defaults to 10% (1000 bps) if
  // no row exists yet. See PATCH /api/admin/finance/commission-rate.
  getPlatformCommissionBps(): Promise<number>;
  setPlatformCommissionBps(commissionBps: number, updatedBy: string): Promise<PlatformSettings>;

  // Organizer payout accounts (Stripe Connect Express / Paystack Subaccounts).
  getOrganizerPaymentAccount(userId: string, provider: "stripe" | "paystack"): Promise<OrganizerPaymentAccount | undefined>;
  upsertOrganizerPaymentAccount(account: InsertOrganizerPaymentAccount): Promise<OrganizerPaymentAccount>;

  // The money-movement ledger — see server/payments/ledger.ts recordTransaction(),
  // which is the only code that should call this.
  createPaymentTransaction(tx: InsertPaymentTransaction): Promise<PaymentTransaction>;
  getOrganizerTransactions(organizerId: string, limit?: number, offset?: number): Promise<PaymentTransaction[]>;

  getEventTicketTiers(eventId: string): Promise<TicketTier[]>;
  getTicketTier(id: string): Promise<TicketTier | undefined>;
  createTicketTier(tier: InsertTicketTier): Promise<TicketTier>;
  createTicketTiers(tiers: InsertTicketTier[]): Promise<TicketTier[]>;
  updateTicketTier(id: string, tier: Partial<InsertTicketTier>): Promise<TicketTier>;
  deleteTicketTier(id: string): Promise<void>;
  deleteEventTicketTiers(eventId: string): Promise<void>;
  
  getUserRsvps(userId: string): Promise<Array<Rsvp & { event: Event }>>;
  getRsvp(userId: string, eventId: string): Promise<Rsvp | undefined>;
  createRsvp(rsvp: InsertRsvp): Promise<Rsvp>;
  cancelRsvp(userId: string, eventId: string): Promise<void>;
  
  getPosts(): Promise<Array<Post & { user: User }>>;
  getAllPosts(): Promise<Post[]>;
  getPost(id: string): Promise<Post | undefined>;
  getUserPosts(userId: string): Promise<Post[]>;
  getUserLikedPosts(userId: string): Promise<Array<Post & { user: User }>>;
  getUserRepostedPosts(userId: string): Promise<Array<Post & { user: User }>>;
  createPost(post: InsertPost): Promise<Post>;
  updatePost(id: string, userId: string, content: string): Promise<{ post?: Post; error?: "NOT_FOUND" | "FORBIDDEN" | "EDIT_WINDOW_PASSED" }>;
  deletePost(id: string): Promise<void>;
  
  createStory(story: InsertStory, allowedViewerIds?: string[]): Promise<Story>;
  getActiveStories(viewerId?: string): Promise<Array<Story & { user: User; likeCount: number; viewCount: number; isLiked?: boolean; isReshare?: boolean }>>;
  getStory(id: string): Promise<Story | undefined>;
  getUserStories(userId: string, viewerId?: string): Promise<Story[]>;
  deleteStory(id: string): Promise<void>;

  // Story likes
  likeStory(userId: string, storyId: string): Promise<void>;
  unlikeStory(userId: string, storyId: string): Promise<void>;
  hasUserLikedStory(userId: string, storyId: string): Promise<boolean>;
  getStoryLikeCount(storyId: string): Promise<number>;

  // Story views
  recordStoryView(storyId: string, userId: string): Promise<void>;
  getStoryViewCount(storyId: string): Promise<number>;
  getStoryViewersWithLikeStatus(storyId: string): Promise<Array<{ user: User; viewedAt: Date; hasLiked: boolean }>>;

  // Story reshares
  reshareStory(userId: string, originalStoryId: string): Promise<Story>;

  // Story allowed viewers
  setStoryAllowedViewers(storyId: string, viewerIds: string[]): Promise<void>;
  getStoryAllowedViewers(storyId: string): Promise<string[]>;
  canViewStory(viewerId: string, storyId: string): Promise<boolean>;
  canViewStoryNow(viewerId: string, storyId: string): Promise<boolean>;

  followUser(followerId: string, followingId: string): Promise<Follow>;
  unfollowUser(followerId: string, followingId: string): Promise<void>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  getFollowers(userId: string): Promise<Array<Follow & { follower: User }>>;
  getFollowing(userId: string): Promise<Array<Follow & { following: User }>>;
  // Lightweight counterpart — ids only, no user join — for set-membership checks like event ranking.
  getFollowingIds(userId: string): Promise<string[]>;
  
  getUserProfile(userId: string): Promise<{ user: User; posts: Post[]; events: Array<Rsvp & { event: Event }> } | undefined>;
  searchUsers(query: string): Promise<User[]>;
  
  // Universal search methods
  universalSearch(query: string, types?: string[]): Promise<{
    users: User[];
    events: Array<Event & { organizer: User }>;
    venueEvents: Array<VenueEntryNight & { venue: Venue }>;
    venues: Venue[];
    posts: Array<Post & { user: User }>;
  }>;
  searchEvents(query: string): Promise<Array<Event & { organizer: User }>>;
  searchVenueEvents(query: string): Promise<Array<VenueEntryNight & { venue: Venue }>>;
  searchVenues(query: string): Promise<Venue[]>;
  searchPosts(query: string): Promise<Array<Post & { user: User }>>;

  // Trending methods
  getTrendingPosts(limit?: number): Promise<Array<Post & { user: User; likeCount: number; commentCount: number }>>;
  getTrendingEvents(limit?: number): Promise<Array<Event & { organizer: User; rsvpCount: number; ticketCount: number }>>;
  getTrendingVenues(limit?: number): Promise<Array<Venue & { viewCount: number }>>;
  getTrendingStories(limit?: number): Promise<Array<Story & { user: User; likeCount: number }>>;
  getSuggestedUsers(userId: string, limit?: number): Promise<User[]>;
  getRecommendedUsers(userId: string, limit?: number): Promise<User[]>;
  
  likePost(userId: string, postId: string): Promise<Like>;
  unlikePost(userId: string, postId: string): Promise<void>;
  getPostLikes(postId: string): Promise<number>;
  hasUserLikedPost(userId: string, postId: string): Promise<boolean>;
  
  getComment(id: string): Promise<Comment | undefined>;
  addComment(comment: InsertComment): Promise<Comment>;
  deleteComment(id: string, userId: string): Promise<Comment | undefined>;
  getPostComments(postId: string, limit?: number): Promise<Array<Comment & { user: User }>>;
  getStoryComments(storyId: string, viewerId?: string): Promise<Array<Comment & { user: User; likeCount: number; isLiked: boolean }>>;
  getCommentThread(topLevelCommentId: string, viewerId?: string): Promise<Array<Comment & { user: User; likeCount: number; isLiked: boolean }>>;
  getCommentCount(postId: string): Promise<number>;

  // Comment interactions
  likeComment(userId: string, commentId: string): Promise<CommentLike>;
  unlikeComment(userId: string, commentId: string): Promise<void>;
  hasUserLikedComment(userId: string, commentId: string): Promise<boolean>;
  getCommentLikeCount(commentId: string): Promise<number>;

  addCommentReply(userId: string, commentId: string, content: string): Promise<Comment>;
  getCommentReplies(commentId: string): Promise<Array<Comment & { user: User }>>;
  getCommentReplyCount(commentId: string): Promise<number>;
  
  repostComment(userId: string, commentId: string): Promise<CommentRepost>;
  unrepostComment(userId: string, commentId: string): Promise<void>;
  hasUserRepostedComment(userId: string, commentId: string): Promise<boolean>;
  getCommentRepostCount(commentId: string): Promise<number>;
  
  bookmarkPost(userId: string, postId: string): Promise<Bookmark>;
  unbookmarkPost(userId: string, postId: string): Promise<void>;
  hasUserBookmarkedPost(userId: string, postId: string): Promise<boolean>;

  // Repost methods
  repostPost(userId: string, postId: string): Promise<Repost>;
  unrepostPost(userId: string, postId: string): Promise<void>;
  hasUserRepostedPost(userId: string, postId: string): Promise<boolean>;
  getPostRepostCount(postId: string): Promise<number>;
  getPostsWithReposts(): Promise<Array<(Post | { repostedBy: User; originalPost: Post & { user: User }; createdAt: Date }) & { user: User }>>;

  // Hashtag methods
  getOrCreateHashtag(tag: string): Promise<Hashtag>;
  addHashtagToPost(postId: string, hashtagId: string): Promise<void>;
  getPostHashtags(postId: string): Promise<Hashtag[]>;
  getPostsByHashtag(tag: string): Promise<Array<Post & { user: User }>>;
  getTrendingHashtags(limit?: number): Promise<Hashtag[]>;

  // Mention methods
  addMentionToPost(postId: string, mentionedUserId: string): Promise<void>;
  getPostMentions(postId: string): Promise<User[]>;
  getUserMentions(userId: string): Promise<Array<Post & { user: User }>>;

  // Safety buddy system (SMS-based, no app required for buddies)
  createBuddy(params: Omit<InsertSafetyBuddy, "id">): Promise<SafetyBuddy>;
  getBuddy(buddyId: string): Promise<SafetyBuddy | undefined>;
  updateBuddy(buddyId: string, updates: Partial<SafetyBuddy>): Promise<SafetyBuddy>;
  deleteBuddy(buddyId: string): Promise<void>;
  getBuddiesByUser(userId: string): Promise<SafetyBuddy[]>;
  getConfirmedBuddies(userId: string): Promise<SafetyBuddy[]>;
  getPendingBuddyByPhone(userId: string, phone: string): Promise<SafetyBuddy | undefined>;
  getPendingBuddyByPhoneGlobal(phone: string): Promise<SafetyBuddy | undefined>;
  getBuddyByToken(token: string): Promise<SafetyBuddy | undefined>;
  getExpiredPendingBuddies(): Promise<SafetyBuddy[]>;
  setDistressMessage(userId: string, message: string): Promise<void>;
  getDistressMessage(userId: string): Promise<string | undefined>;
  createSafetyAlert(params: { userId: string; buddyId: string; alertType: string; message: string; latitude?: number; longitude?: number; locationText?: string; timerId?: string }): Promise<SafetyAlert>;
  getSafetyAlerts(userId: string): Promise<any[]>;
  getAllSafetyAlerts(limit: number): Promise<any[]>;
  resolveSafetyAlert(alertId: string, userId: string, status: string): Promise<SafetyAlert | undefined>;
  createSafetyTimer(params: { userId: string; durationMinutes: number; eventId?: string }): Promise<SafetyTimer>;
  snoozeSafetyTimer(userId: string): Promise<SafetyTimer | undefined>;
  extendSafetyTimer(userId: string, hours: number): Promise<SafetyTimer | undefined>;
  getActiveSafetyTimer(userId: string): Promise<SafetyTimer | null>;
  checkInSafetyTimer(userId: string): Promise<void>;
  cancelSafetyTimer(userId: string): Promise<void>;
  getTimersNeedingAlert(): Promise<SafetyTimer[]>;
  getTimersForStageCheck(): Promise<SafetyTimer[]>;
  updateTimerStageNotified(timerId: string, stage: number): Promise<void>;
  markTimerAlerted(timerId: string): Promise<void>;
  createSafetyAlertShare(params: { userId: string; alertType: string; message: string; latitude?: number | null; longitude?: number | null; locationText?: string | null }): Promise<SafetyAlertShare>;
  getSafetyAlertShareByToken(token: string): Promise<SafetyAlertShare | undefined>;
  getWatchingOver(userId: string): Promise<Array<{
    buddyRecord: SafetyBuddy;
    protectedUser: Omit<User, "passwordHash">;
    activeTimer: SafetyTimer | null;
    recentAlerts: SafetyAlert[];
  }>>;
  getFollowingForBuddy(userId: string): Promise<Array<{
    user: Omit<User, "passwordHash">;
    existingBuddy: SafetyBuddy | null;
  }>>;
  getPendingIncomingBuddyRequests(userId: string): Promise<Array<SafetyBuddy & {
    requester: Omit<User, "passwordHash">;
  }>>;
  getPhoneBuddyCount(userId: string): Promise<number>;
  getAppBuddyCount(userId: string): Promise<number>;

  trackEventView(eventId: string, userId?: string): Promise<void>;
  trackEventClick(eventId: string, actionType: string, userId?: string): Promise<void>;
  getEventAnalytics(eventId: string): Promise<{ views: number; clicks: number; rsvps: number; ticketsSold: number }>;
  promoteEvent(eventId: string, durationDays: number): Promise<Event>;
  getPromotedEvents(): Promise<Event[]>;
  createEventPost(userId: string, eventId: string, content: string, imageUrl?: string): Promise<Post>;
  getFollowerIds(userId: string): Promise<string[]>;

  // Venue methods
  getVenues(): Promise<Venue[]>;
  getVenue(id: string): Promise<(Venue & { owner: User }) | undefined>;
  getVenuesByOwner(ownerId: string): Promise<Venue[]>;
  createVenue(venue: InsertVenue): Promise<Venue>;
  updateVenue(id: string, venue: Partial<InsertVenue>): Promise<Venue>;
  verifyVenue(id: string, isVerified: boolean): Promise<Venue>;
  deleteVenue(id: string): Promise<void>;
  getPromotedVenues(): Promise<Venue[]>;
  promoteVenue(venueId: string, durationDays: number): Promise<Venue>;

  // Free promotion credits (admin-granted) — event and venue promotion share the pool
  claimFreePromotionCredit(userId: string): Promise<boolean>;
  setUserPromotionCredits(userId: string, credits: number): Promise<User>;

  // Venue events methods (formerly "entry nights")
  getVenueEntryNights(venueId: string): Promise<VenueEntryNight[]>;
  getUpcomingVenueEntryNights(venueId: string): Promise<VenueEntryNight[]>;
  getVenueEntryNight(id: string): Promise<VenueEntryNight | undefined>;
  getVenueEventWithVenue(id: string): Promise<(VenueEntryNight & { venue: Venue }) | undefined>;
  getUpcomingAllVenueEvents(): Promise<Array<VenueEntryNight & { venue: Venue }>>;
  createVenueEntryNight(entryNight: InsertVenueEntryNight): Promise<VenueEntryNight>;
  updateVenueEntryNight(id: string, entryNight: Partial<InsertVenueEntryNight>): Promise<VenueEntryNight>;
  deleteVenueEntryNight(id: string): Promise<void>;

  // Venue tickets methods
  getUserVenueTickets(userId: string): Promise<Array<VenueTicket & { entryNight: VenueEntryNight; venue: Venue }>>;
  getVenueTicket(id: string): Promise<VenueTicket | undefined>;
  getVenueTicketByValidationCode(validationCode: string): Promise<VenueTicket | undefined>;
  createVenueTicket(ticket: InsertVenueTicket): Promise<VenueTicket>;
  checkInVenueTicket(ticketId: string, organizerId: string): Promise<VenueTicket | null>;
  incrementVenueEntryNightTicketsSold(entryNightId: string): Promise<void>;
  claimVenueTicketSlot(entryNightId: string): Promise<boolean>;
  getVenueEventCheckIns(venueEntryNightId: string): Promise<Array<VenueTicket & { user: User }>>;

  // Venue staff access codes
  createVenueStaffCode(venueEntryNightId: string, organizerId: string, expiresAt: Date): Promise<VenueStaffAccessCode>;
  getVenueStaffCodeByCode(code: string): Promise<VenueStaffAccessCode | undefined>;
  redeemVenueStaffCode(id: string, staffName: string, ip: string, ua: string, scannerToken: string): Promise<VenueStaffAccessCode>;
  getVenueStaffCodeByScannerToken(token: string): Promise<VenueStaffAccessCode | undefined>;
  getVenueEntryNightStaffCodes(venueEntryNightId: string, organizerId: string): Promise<VenueStaffAccessCode[]>;
  revokeVenueStaffCode(id: string, organizerId: string): Promise<void>;
  incrementVenueStaffCodeScanCount(id: string): Promise<void>;

  // Venue analytics methods
  trackVenueView(venueId: string, userId?: string): Promise<void>;
  trackVenueClick(venueId: string, actionType: string, userId?: string): Promise<void>;
  getVenueAnalytics(venueId: string): Promise<{ views: number; clicks: number; ticketsSold: number }>;

  // Organizer demographics analytics
  getOrganizerDemographics(organizerId: string, options?: { startDate?: Date; endDate?: Date }): Promise<{
    totalEvents: number;
    totalRsvps: number;
    totalTicketsSold: number;
    totalViews: number;
    totalRevenue: number;
    ageDistribution: { ageGroup: string; count: number; percentage: number }[];
    genderDistribution: { gender: string; count: number; percentage: number }[];
    eventBreakdown: {
      eventId: string;
      title: string;
      rsvps: number;
      tickets: number;
      views: number;
      revenue: number;
      currency: string;
      ticketPrice: number;
      capacity: number;
      eventDate: string;
      isFree: boolean;
    }[];
    ticketSalesByAge: { ageGroup: string; tickets: number; revenue: number; percentage: number }[];
    ticketSalesByGender: { gender: string; tickets: number; revenue: number; percentage: number }[];
    averageTicketPrice: number;
    bestSellingEvent: { title: string; tickets: number; revenue: number; currency: string } | null;
    conversionRate: number;
  }>;

  // ============================================
  // ADMIN PANEL METHODS
  // ============================================
  
  // Admin users
  getAdminUser(id: string): Promise<AdminUser | undefined>;
  getAdminUserByUsername(username: string): Promise<AdminUser | undefined>;
  getAdminUserByEmail(email: string): Promise<AdminUser | undefined>;
  getAllAdminUsers(): Promise<AdminUser[]>;
  createAdminUser(admin: InsertAdminUser): Promise<AdminUser>;
  updateAdminUser(id: string, updates: Partial<InsertAdminUser>): Promise<AdminUser>;
  deactivateAdminUser(id: string): Promise<AdminUser>;
  updateAdminLastLogin(id: string): Promise<void>;

  // Admin activity logs
  logAdminActivity(log: InsertAdminActivityLog): Promise<AdminActivityLog>;
  getAdminActivityLogs(limit?: number): Promise<Array<AdminActivityLog & { admin: AdminUser }>>;
  getAdminUserActivityLogs(adminId: string, limit?: number): Promise<AdminActivityLog[]>;

  // Content reports
  createContentReport(report: InsertContentReport): Promise<ContentReport>;
  createPostReport(postId: string, reporterId: string, reason: string, description: string | null): Promise<ContentReport>;
  createCommentReport(commentId: string, reporterId: string, reason: string, description: string | null): Promise<ContentReport>;
  getContentReports(status?: string, limit?: number, offset?: number): Promise<Array<ContentReport & { reporter: User }>>;
  getContentReport(id: string): Promise<ContentReport | undefined>;
  updateContentReport(id: string, updates: { status: string; reviewedBy: string; resolution?: string }): Promise<ContentReport>;

  // User suspensions
  suspendUser(suspension: InsertUserSuspension): Promise<UserSuspension>;
  getUserSuspensions(userId: string): Promise<UserSuspension[]>;
  getActiveSuspension(userId: string): Promise<UserSuspension | undefined>;
  getBulkActiveSuspensions(userIds: string[]): Promise<UserSuspension[]>;
  liftSuspension(suspensionId: string): Promise<UserSuspension>;
  getAllSuspensions(): Promise<Array<UserSuspension & { user: User; admin: AdminUser }>>;

  // Event moderation
  moderateEvent(moderation: InsertEventModeration): Promise<EventModeration>;
  getEventModerations(eventId: string): Promise<Array<EventModeration & { admin: AdminUser }>>;
  getAllEventModerations(): Promise<Array<EventModeration & { event: Event; admin: AdminUser }>>;

  // Platform stats for admin dashboard
  getPlatformStats(): Promise<{
    totalUsers: number;
    totalEvents: number;
    totalTicketsSold: number;
    totalVenueTicketsSold: number;
    // Revenue split by currency — GBP pence and NGN kobo must never be summed together.
    revenueByCurrency: Array<{
      currency: string;
      ticketsSold: number;
      ticketRevenue: number;
      venueTicketsSold: number;
      venueRevenue: number;
      totalRevenue: number;
    }>;
    activeUsers: number;
    newUsersToday: number;
    pendingReports: number;
    activeOrganizers: number;
  }>;

  // User management for admins
  getAllUsers(limit?: number, offset?: number): Promise<User[]>;
  getUserCount(): Promise<number>;
  deleteUser(id: string): Promise<void>;

  // Event management for admins
  getAllEventsAdmin(limit?: number, offset?: number): Promise<Array<Event & { organizer: User; moderationStatus: string; sourceType: 'event' | 'venue_entry' }>>;
  deleteEvent(id: string): Promise<void>;
  moderateVenueEvent(venueEntryNightId: string, action: string): Promise<void>;

  // Story management for admins
  getAllStoriesAdmin(limit?: number): Promise<Array<Story & { user: User }>>;
  deleteStoryAdmin(id: string): Promise<void>;

  // ============================================
  // NOTIFICATIONS
  // ============================================
  createNotification(notification: InsertNotification): Promise<Notification>;
  getUserNotifications(userId: string, limit?: number): Promise<Array<Notification & { relatedUser: User | null }>>;
  getUnreadNotificationCount(userId: string): Promise<number>;
  markNotificationAsRead(id: string): Promise<Notification>;
  markAllNotificationsAsRead(userId: string): Promise<void>;
  deleteNotification(id: string): Promise<void>;

  // ============================================
  // COMMUNITIES
  // ============================================
  createCommunity(community: InsertCommunity): Promise<Community>;
  getCommunity(id: string): Promise<Community | undefined>;
  getCommunityBySlug(slug: string): Promise<Community | undefined>;
  getCommunityWithDetails(id: string): Promise<(Community & { memberCount: number; creator: User }) | undefined>;
  getCommunities(): Promise<Array<Community & { memberCount: number; creator: User }>>;
  getUserCommunities(userId: string): Promise<Array<Community & { memberCount: number; role: string }>>;
  updateCommunity(id: string, updates: Partial<InsertCommunity>): Promise<Community>;
  deleteCommunity(id: string): Promise<void>;
  getCommunityEvents(communityId: string): Promise<Event[]>;

  // Community membership
  joinCommunity(userId: string, communityId: string, role?: string): Promise<CommunityMembership>;
  leaveCommunity(userId: string, communityId: string): Promise<void>;
  isCommunityMember(userId: string, communityId: string): Promise<boolean>;
  getCommunityMembers(communityId: string, limit?: number, offset?: number): Promise<Array<CommunityMembership & { user: User }>>;
  getCommunityMemberIds(communityId: string): Promise<string[]>;
  getCommunityMembership(userId: string, communityId: string): Promise<CommunityMembership | undefined>;
  updateCommunityMemberRole(userId: string, communityId: string, role: string): Promise<CommunityMembership>;
  removeCommunityMember(userId: string, communityId: string): Promise<void>;
  setCommunityNotifications(userId: string, communityId: string, enabled: boolean): Promise<void>;

  // Community posts
  getCommunityPosts(communityId: string, limit?: number, offset?: number, postType?: string): Promise<Array<Post & { user: User; community: Community }>>;
  getCommunityMemberCount(communityId: string): Promise<number>;
  setCommunityPostPinned(postId: string, pinned: boolean): Promise<Post>;
  moderateRemoveCommunityPost(postId: string): Promise<void>;
  getTrendingCommunities(limit?: number): Promise<Array<Community & { memberCount: number; creator: User; trendingScore: number }>>;
  getPostsWithCommunity(): Promise<Array<Post & { user: User; community: Community | null }>>;
  getFeedPosts(cursor?: string, limit?: number): Promise<{ posts: any[]; nextCursor: string | null }>;

  // ============================================
  // GROUP CHATS / CONVERSATIONS
  // ============================================
  
  // Conversations
  createConversation(data: InsertConversation, participantIds: string[]): Promise<Conversation>;
  getConversationById(id: string): Promise<(Conversation & { participants: Array<ConversationParticipant & { user: User }> }) | undefined>;
  getUserConversations(userId: string): Promise<Array<Conversation & {
    participants: Array<ConversationParticipant & { user: User }>;
    unreadCount: number;
  }>>;
  updateConversation(id: string, updates: Partial<InsertConversation>): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  getOrCreateDirectConversation(userId1: string, userId2: string): Promise<Conversation>;
  
  // Invite codes
  generateInviteCode(conversationId: string): Promise<string>;
  getConversationByInviteCode(inviteCode: string): Promise<Conversation | undefined>;
  getConversationByEventId(eventId: string): Promise<Conversation | undefined>;
  getDissolvableEventGroupConversationIds(): Promise<string[]>;
  addConversationParticipantIfRoom(conversationId: string, userId: string, maxMembers: number): Promise<boolean>;
  
  // Conversation participants
  addConversationParticipant(conversationId: string, userId: string, role?: string): Promise<ConversationParticipant>;
  removeConversationParticipant(conversationId: string, userId: string): Promise<void>;
  updateParticipantRole(conversationId: string, userId: string, role: string): Promise<ConversationParticipant>;
  isConversationParticipant(conversationId: string, userId: string): Promise<boolean>;
  getConversationParticipants(conversationId: string): Promise<Array<ConversationParticipant & { user: User }>>;
  getParticipantRole(conversationId: string, userId: string): Promise<string | undefined>;
  updateLastReadAt(conversationId: string, userId: string): Promise<void>;
  getUnreadMessageCount(userId: string): Promise<number>;

  // Conversation messages
  sendConversationMessage(message: InsertConversationMessage): Promise<ConversationMessage>;
  getConversationMessages(conversationId: string, limit?: number, before?: string): Promise<Array<ConversationMessage & { sender: User; replyTo?: ConversationMessage & { sender: User }; story?: Story & { user: User } }>>;
  getConversationMessage(messageId: string): Promise<ConversationMessage | undefined>;
  searchConversationMessages(conversationId: string, query: string, limit?: number): Promise<Array<ConversationMessage & { sender: User }>>;
  deleteConversationMessage(messageId: string): Promise<void>;
  
  // Polls
  createPoll(poll: InsertPoll, options: Array<{ text: string; eventId?: string; venueId?: string }>): Promise<Poll & { options: PollOption[] }>;
  getPoll(id: string): Promise<(Poll & { options: Array<PollOption & { voteCount: number; voters: User[] }>; creator: User }) | undefined>;
  votePoll(pollId: string, optionId: string, userId: string): Promise<PollVote>;
  unvotePoll(pollId: string, optionId: string, userId: string): Promise<void>;
  getUserPollVotes(pollId: string, userId: string): Promise<PollVote[]>;
  closePoll(pollId: string): Promise<Poll>;

  // Media storage (Railway-compatible DB-backed)
  ensureMediaUploadsTable(): Promise<void>;
  ensureBannerColumns(): Promise<void>;
  ensureTicketTiersTable(): Promise<void>;
  ensureEventModerationsTable(): Promise<void>;
  ensureLoginAttemptsTable(): Promise<void>;
  ensureSafetyTimerStageColumns(): Promise<void>;
  ensureSafetyAlertSharesTable(): Promise<void>;
  ensureDeliveryLogsTable(): Promise<void>;
  createDeliveryLog(params: { provider: string; providerMessageId: string; phoneNumber: string; context: string; status?: string }): Promise<DeliveryLog>;
  updateDeliveryLogStatus(provider: string, providerMessageId: string, status: string): Promise<void>;
  getLoginAttempt(key: string): Promise<{ count: number; lastAttempt: Date; lockedUntil: Date | null } | null>;
  upsertLoginAttempt(key: string, count: number, lastAttempt: Date, lockedUntil: Date | null): Promise<void>;
  deleteLoginAttempt(key: string): Promise<void>;
  cleanupExpiredLoginAttempts(): Promise<void>;
  saveMedia(data: string, contentType: string, ownerId?: string): Promise<string>;
  getMedia(id: string): Promise<{ data: string; contentType: string } | null>;
  deleteMedia(id: string): Promise<void>;
  deleteMediaByUrls(urls: string[]): Promise<void>;

  // ============================================
  // PUSH SUBSCRIPTIONS
  // ============================================
  upsertPushSubscription(sub: InsertPushSubscription): Promise<PushSubscription>;
  getPushSubscriptionsByUserId(userId: string): Promise<PushSubscription[]>;
  deletePushSubscription(endpoint: string): Promise<void>;

  // Event ratings
  createEventRating(eventId: string, userId: string, rating: number, reviewText?: string | null): Promise<EventRating>;
  getUserEventRating(eventId: string, userId: string): Promise<EventRating | null>;
  getEventRatingStats(eventId: string): Promise<{ averageRating: number | null; totalRatings: number; distribution: Record<number, number> }>;
  getOrganizerRating(organizerId: string): Promise<{ averageRating: number | null; totalRatings: number; eventsRated: number }>;

  // Venue ratings — same shape as event ratings, eligibility checked one join
  // deeper (venueTickets -> venueEntryNights.venueId) in the routes layer.
  createVenueRating(venueId: string, userId: string, rating: number, reviewText?: string | null): Promise<VenueRating>;
  getUserVenueRating(venueId: string, userId: string): Promise<VenueRating | null>;
  getVenueRatingStats(venueId: string): Promise<{ averageRating: number | null; totalRatings: number; distribution: Record<number, number> }>;
  hasAttendedVenue(userId: string, venueId: string): Promise<boolean>;

  // ============================================
  // ZERNIO SOCIAL MEDIA
  // ============================================

  // Persist the Zernio profile ID on first connect; never exposed to the user
  setZernioProfileId(userId: string, profileId: string): Promise<void>;

  // Active connected accounts for a given organizer (disconnected_at IS NULL)
  getConnectedSocials(userId: string): Promise<ConnectedSocial[]>;

  // Single active account for one platform — used by the promote route
  getConnectedSocial(userId: string, platform: string): Promise<ConnectedSocial | undefined>;

  // Insert or reactivate: ON CONFLICT (user_id, platform) DO UPDATE resets
  // disconnected_at = NULL so reconnecting the same platform works cleanly
  upsertConnectedSocial(data: {
    userId: string;
    platform: string;
    zernioAccountId: string;
    handle: string | null;
  }): Promise<ConnectedSocial>;

  // Soft-delete: sets disconnected_at, keeps the row for audit history
  disconnectSocial(userId: string, platform: string): Promise<void>;

  // Record one platform's post attempt (status = 'posted' | 'failed')
  insertSocialPost(data: {
    eventId: string;
    userId: string;
    platform: string;
    zernioPostId?: string | null;
    content: string;
    status: string;
    errorMessage?: string | null;
    costUsd: string;
  }): Promise<SocialPost>;

  // Idempotency guard — returns the most recent successful post for this
  // event+platform within the given window so double-clicks are rejected
  getRecentSocialPost(
    eventId: string,
    platform: string,
    windowMinutes: number,
  ): Promise<SocialPost | undefined>;

  // ── Admin analytics (aggregate only, no PII) ──────────────────────────────

  getSocialDashboardStats(dateFrom: Date): Promise<{
    totalPosts: number;
    totalCostUsd: string;
    failedPosts: number;
    platformsUsed: number;
  }>;

  getSocialDailyBreakdown(
    dateFrom: Date,
  ): Promise<Array<{ date: string; count: number; costUsd: string }>>;

  getSocialPlatformBreakdown(
    dateFrom: Date,
  ): Promise<Array<{ platform: string; posts: number; costUsd: string }>>;

  getSocialOrganizerStats(
    limit: number,
    offset: number,
  ): Promise<Array<{
    userId: string;
    orgName: string | null;
    connectedAccounts: number;
    postsThisMonth: number;
    costThisMonth: string;
  }>>;
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUsersByUsernames(usernames: string[]): Promise<User[]> {
    if (usernames.length === 0) return [];
    const lowerUsernames = usernames.map(u => u.toLowerCase());
    const result = await db.select().from(users).where(
      sql`LOWER(${users.username}) IN (${sql.join(lowerUsernames.map(u => sql`${u}`), sql`, `)})`
    );
    return result;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      sql`LOWER(${users.username}) = LOWER(${username})`
    );
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.googleId, googleId));
    return result[0];
  }

  async createUserFromGoogle(data: { email: string; googleId: string; displayName: string; avatarUrl?: string }): Promise<User> {
    const base = (data.displayName || data.email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .slice(0, 20);
    const suffix = crypto.randomBytes(3).toString('hex');
    const username = `${base}_${suffix}`;

    const result = await db.insert(users).values({
      email: data.email,
      googleId: data.googleId,
      username,
      passwordHash: null,
      displayName: data.displayName,
      avatarUrl: data.avatarUrl ?? null,
      userType: 'social',
      isVerified: true, // Google has already verified the email address
    } as any).returning();
    return result[0];
  }

  async linkGoogleId(userId: string, googleId: string): Promise<void> {
    await db.update(users).set({ googleId } as any).where(eq(users.id, userId));
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User> {
    // If gender is being updated, set genderEditedAt timestamp
    const updatesWithTimestamp = { ...updates } as any;
    if (updates.gender !== undefined) {
      updatesWithTimestamp.genderEditedAt = new Date();
    }
    const result = await db.update(users).set(updatesWithTimestamp).where(eq(users.id, id)).returning();
    return result[0];
  }

  async updateUserPassword(userId: string, hashedPassword: string): Promise<void> {
    await db.update(users).set({ passwordHash: hashedPassword }).where(eq(users.id, userId));
  }

  async updateUsername(userId: string, newUsername: string): Promise<User> {
    const result = await db.update(users).set({ 
      username: newUsername,
      usernameChangesRemaining: sql`${users.usernameChangesRemaining} - 1`
    }).where(eq(users.id, userId)).returning();
    return result[0];
  }

  async setPasswordResetToken(userId: string, token: string, expires: Date): Promise<void> {
    await db.update(users).set({ 
      passwordResetToken: token,
      passwordResetExpires: expires
    }).where(eq(users.id, userId));
  }

  async getUserByPasswordResetToken(token: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      and(
        eq(users.passwordResetToken, token),
        gte(users.passwordResetExpires, new Date())
      )
    );
    return result[0];
  }

  async clearPasswordResetToken(userId: string): Promise<void> {
    await db.update(users).set({
      passwordResetToken: null,
      passwordResetExpires: null
    }).where(eq(users.id, userId));
  }

  async setEmailVerificationToken(userId: string, tokenHash: string, expires: Date): Promise<void> {
    await db.update(users).set({
      emailVerificationToken: tokenHash,
      emailVerificationExpires: expires,
    }).where(eq(users.id, userId));
  }

  async getUserByEmailVerificationToken(tokenHash: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      and(
        eq(users.emailVerificationToken, tokenHash),
        gte(users.emailVerificationExpires, new Date()),
      )
    );
    return result[0];
  }

  async clearEmailVerificationToken(userId: string): Promise<void> {
    await db.update(users).set({
      emailVerificationToken: null,
      emailVerificationExpires: null,
    }).where(eq(users.id, userId));
  }

  async setUserVerified(userId: string): Promise<void> {
    await db.update(users).set({ isVerified: true }).where(eq(users.id, userId));
  }

  async getEvents(): Promise<(Event & { minPrice: number; maxPrice: number })[]> {
    return cached(
      'events',
      async () => {
        const rows = await db
          .select({
            event: events,
            minPrice: sql<number>`COALESCE(MIN(${ticketTiers.priceSmallestUnit}), ${events.ticketPrice})::int`,
            maxPrice: sql<number>`COALESCE(MAX(${ticketTiers.priceSmallestUnit}), ${events.ticketPrice})::int`,
          })
          .from(events)
          .leftJoin(ticketTiers, eq(ticketTiers.eventId, events.id))
          .where(and(eq(events.isPublished, true), eq(events.moderationStatus, 'approved')))
          .groupBy(events.id)
          .orderBy(events.eventDate);

        return rows.map(r => ({ ...r.event, minPrice: r.minPrice, maxPrice: r.maxPrice }));
      },
      eventsCache,
    );
  }

  // Weighted RSVP+ticket engagement count per event, for the discovery feed's
  // ranking algorithm (rankEvents() in server/utils/eventRanking.ts) and for
  // /api/events/trending-in-city. Same rsvpCount*2 + ticketCount*3 formula as
  // getTrendingEvents(), kept as its own cached query (rather than folded
  // into getEvents()'s join) so getEvents()'s existing shape/consumers stay
  // untouched — this is deliberately allowed to run up to eventsCache's TTL
  // stale, same tradeoff getTrendingEvents() already makes.
  async getEventEngagementCounts(): Promise<Map<string, number>> {
    return cached(
      'event-engagement',
      async () => {
        const rows = await db
          .select({
            eventId: events.id,
            rsvpCount: sql<number>`count(distinct ${rsvps.id})::int`,
            ticketCount: sql<number>`count(distinct ${tickets.id})::int`,
          })
          .from(events)
          .leftJoin(rsvps, eq(rsvps.eventId, events.id))
          .leftJoin(tickets, and(eq(tickets.eventId, events.id), eq(tickets.status, 'confirmed')))
          .groupBy(events.id);

        return new Map(rows.map(r => [r.eventId, r.rsvpCount * 2 + r.ticketCount * 3]));
      },
      eventsCache,
    );
  }

  async getEventsByCategory(category: string): Promise<(Event & { minPrice: number; maxPrice: number })[]> {
    const rows = await db
      .select({
        event: events,
        minPrice: sql<number>`COALESCE(MIN(${ticketTiers.priceSmallestUnit}), ${events.ticketPrice})::int`,
        maxPrice: sql<number>`COALESCE(MAX(${ticketTiers.priceSmallestUnit}), ${events.ticketPrice})::int`,
      })
      .from(events)
      .leftJoin(ticketTiers, eq(ticketTiers.eventId, events.id))
      .where(and(
        eq(events.isPublished, true),
        eq(events.moderationStatus, 'approved'),
        ilike(events.category, category),
      ))
      .groupBy(events.id)
      .orderBy(events.eventDate);
    return rows.map(r => ({ ...r.event, minPrice: r.minPrice, maxPrice: r.maxPrice }));
  }

  async getBulkEventTicketTiers(eventIds: string[]): Promise<TicketTier[]> {
    if (eventIds.length === 0) return [];
    return db.select().from(ticketTiers).where(inArray(ticketTiers.eventId, eventIds));
  }

  async getEvent(id: string): Promise<(Event & { organizer: User; community: (Community & { memberCount: number }) | null }) | undefined> {
    const result = await db
      .select({
        event: events,
        organizer: users,
        community: communities,
        memberCount: sql<number>`COALESCE((SELECT COUNT(*)::int FROM community_memberships WHERE community_id = ${communities.id}), 0)`,
      })
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .leftJoin(communities, eq(events.communityId, communities.id))
      .where(eq(events.id, id));

    if (!result[0]) return undefined;

    const { passwordHash, ...organizerWithoutPassword } = result[0].organizer;
    return {
      ...result[0].event,
      organizer: organizerWithoutPassword as User,
      community: result[0].community
        ? { ...result[0].community, memberCount: result[0].memberCount }
        : null,
    };
  }

  async getUserEvents(userId: string): Promise<Event[]> {
    return await db.select().from(events).where(eq(events.organizerId, userId));
  }

  async getEventsByOrganizer(organizerId: string): Promise<Event[]> {
    return await db.select().from(events).where(eq(events.organizerId, organizerId)).orderBy(events.eventDate);
  }

  async createEvent(insertEvent: InsertEvent): Promise<Event> {
    const result = await db.insert(events).values(insertEvent).returning();
    invalidateCache.events();
    return result[0];
  }

  async updateEvent(id: string, eventUpdate: Partial<InsertEvent>): Promise<Event> {
    const result = await db.update(events).set(eventUpdate).where(eq(events.id, id)).returning();
    invalidateCache.events();
    return result[0];
  }

  async setEventPublished(id: string, published: boolean): Promise<Event> {
    const result = await db.update(events).set({ isPublished: published }).where(eq(events.id, id)).returning();
    return result[0];
  }

  async getUserTickets(userId: string): Promise<Array<Ticket & { event: Event }>> {
    const result = await db
      .select()
      .from(tickets)
      .innerJoin(events, eq(tickets.eventId, events.id))
      .where(eq(tickets.userId, userId));
    
    return result.map(row => ({
      ...row.tickets,
      event: row.events,
    }));
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    const result = await db.select().from(tickets).where(eq(tickets.id, id));
    return result[0];
  }

  async getTicketByPaymentIntent(paymentIntentId: string): Promise<Ticket | undefined> {
    const result = await db.select().from(tickets).where(eq(tickets.providerPaymentId, paymentIntentId));
    return result[0];
  }

  async getTicketsByPaymentIntent(paymentIntentId: string): Promise<Ticket[]> {
    return await db.select().from(tickets).where(eq(tickets.providerPaymentId, paymentIntentId));
  }

  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const result = await db.insert(tickets).values(insertTicket).returning();
    return result[0];
  }

  async getTicketByValidationCode(validationCode: string): Promise<Ticket | undefined> {
    const result = await db.select().from(tickets).where(eq(tickets.validationCode, validationCode));
    return result[0];
  }

  async checkInTicket(ticketId: string, scannerId: string): Promise<Ticket | null> {
    const result = await db
      .update(tickets)
      .set({
        checkedInAt: new Date(),
        checkedInBy: scannerId,
      })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.checkedInAt)))
      .returning();
    return result[0] ?? null;
  }

  async getEventCheckIns(eventId: string): Promise<Array<Ticket & { user: User }>> {
    const result = await db
      .select()
      .from(tickets)
      .innerJoin(users, eq(tickets.userId, users.id))
      .where(eq(tickets.eventId, eventId));
    
    return result.map(row => ({ ...row.tickets, user: row.users }));
  }

  async getEventAttendeesSample(eventId: string, limit: number = 12): Promise<{ users: Array<Pick<User, "id" | "username" | "displayName" | "avatarUrl">>; totalCount: number }> {
    const [rsvpRows, ticketRows] = await Promise.all([
      db.select({ userId: rsvps.userId }).from(rsvps).where(eq(rsvps.eventId, eventId)),
      db.select({ userId: tickets.userId }).from(tickets).where(and(eq(tickets.eventId, eventId), eq(tickets.status, "confirmed"))),
    ]);

    const attendeeIds = new Set<string>();
    rsvpRows.forEach(r => attendeeIds.add(r.userId));
    ticketRows.forEach(t => attendeeIds.add(t.userId));
    const totalCount = attendeeIds.size;
    if (totalCount === 0) return { users: [], totalCount: 0 };

    const sampleIds = Array.from(attendeeIds).slice(0, limit);
    const attendeeRows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, sampleIds));

    return { users: attendeeRows, totalCount };
  }

  // Full (uncapped) distinct RSVP'd + confirmed-ticket-holding user id list —
  // used to seed an event group chat with every current attendee at once.
  async getAllEventAttendeeIds(eventId: string): Promise<string[]> {
    const [rsvpRows, ticketRows] = await Promise.all([
      db.select({ userId: rsvps.userId }).from(rsvps).where(eq(rsvps.eventId, eventId)),
      db.select({ userId: tickets.userId }).from(tickets).where(and(eq(tickets.eventId, eventId), eq(tickets.status, "confirmed"))),
    ]);
    const attendeeIds = new Set<string>();
    rsvpRows.forEach(r => attendeeIds.add(r.userId));
    ticketRows.forEach(t => attendeeIds.add(t.userId));
    return Array.from(attendeeIds);
  }

  async getEventRevenueByIds(eventIds: string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const rows = await db
      .select({
        eventId: tickets.eventId,
        total: sql<number>`coalesce(sum(${tickets.amountPaid}), 0)::int`,
      })
      .from(tickets)
      .where(and(inArray(tickets.eventId, eventIds), eq(tickets.status, "confirmed")))
      .groupBy(tickets.eventId);
    return new Map(rows.map(r => [r.eventId, Number(r.total)]));
  }

  async getEventTicketTiers(eventId: string): Promise<TicketTier[]> {
    const result = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.eventId, eventId));
    return result;
  }

  async getTicketTier(id: string): Promise<TicketTier | undefined> {
    const result = await db
      .select()
      .from(ticketTiers)
      .where(eq(ticketTiers.id, id));
    return result[0];
  }

  async createTicketTier(tier: InsertTicketTier): Promise<TicketTier> {
    const result = await db.insert(ticketTiers).values(tier).returning();
    return result[0];
  }

  async createTicketTiers(tiers: InsertTicketTier[]): Promise<TicketTier[]> {
    if (tiers.length === 0) return [];
    const result = await db.insert(ticketTiers).values(tiers).returning();
    return result;
  }

  async updateTicketTier(id: string, tier: Partial<InsertTicketTier>): Promise<TicketTier> {
    const result = await db
      .update(ticketTiers)
      .set(tier)
      .where(eq(ticketTiers.id, id))
      .returning();
    return result[0];
  }

  async deleteTicketTier(id: string): Promise<void> {
    await db.delete(ticketTiers).where(eq(ticketTiers.id, id));
  }

  async deleteEventTicketTiers(eventId: string): Promise<void> {
    await db.delete(ticketTiers).where(eq(ticketTiers.eventId, eventId));
  }

  async getUserRsvps(userId: string): Promise<Array<Rsvp & { event: Event }>> {
    const result = await db
      .select()
      .from(rsvps)
      .innerJoin(events, eq(rsvps.eventId, events.id))
      .where(eq(rsvps.userId, userId));
    
    return result.map(row => ({
      ...row.rsvps,
      event: row.events,
    }));
  }

  async getRsvp(userId: string, eventId: string): Promise<Rsvp | undefined> {
    const result = await db
      .select()
      .from(rsvps)
      .where(and(eq(rsvps.userId, userId), eq(rsvps.eventId, eventId)));
    return result[0];
  }

  async createRsvp(insertRsvp: InsertRsvp): Promise<Rsvp> {
    const result = await db.insert(rsvps).values(insertRsvp).returning();
    return result[0];
  }

  async cancelRsvp(userId: string, eventId: string): Promise<void> {
    await db
      .delete(rsvps)
      .where(and(eq(rsvps.userId, userId), eq(rsvps.eventId, eventId)));
  }

  async getPosts(): Promise<Array<Post & { user: User }>> {
    const result = await db
      .select()
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .orderBy(desc(posts.createdAt));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.posts,
        user: userWithoutPassword as User,
      };
    });
  }

  async getAllPosts(): Promise<Post[]> {
    return await db.select().from(posts).orderBy(desc(posts.createdAt));
  }

  async getPost(id: string): Promise<Post | undefined> {
    const result = await db.select().from(posts).where(eq(posts.id, id));
    return result[0];
  }

  async getUserPosts(userId: string): Promise<Post[]> {
    return await db
      .select()
      .from(posts)
      .where(eq(posts.userId, userId))
      .orderBy(desc(posts.createdAt));
  }

  async getUserLikedPosts(userId: string): Promise<Array<Post & { user: User }>> {
    const likedPosts = await db
      .select({
        post: posts,
        user: users,
      })
      .from(likes)
      .innerJoin(posts, eq(likes.postId, posts.id))
      .innerJoin(users, eq(posts.userId, users.id))
      .where(eq(likes.userId, userId))
      .orderBy(desc(likes.createdAt));
    
    return likedPosts.map(row => ({
      ...row.post,
      user: row.user,
    }));
  }

  async getUserRepostedPosts(userId: string): Promise<Array<Post & { user: User }>> {
    const repostedPosts = await db
      .select({
        post: posts,
        user: users,
      })
      .from(reposts)
      .innerJoin(posts, eq(reposts.postId, posts.id))
      .innerJoin(users, eq(posts.userId, users.id))
      .where(eq(reposts.userId, userId))
      .orderBy(desc(reposts.createdAt));
    
    return repostedPosts.map(row => ({
      ...row.post,
      user: row.user,
    }));
  }

  async createPost(insertPost: InsertPost): Promise<Post> {
    const result = await db.insert(posts).values(insertPost).returning();
    invalidateCache.posts();
    return result[0];
  }

  async updatePost(id: string, userId: string, content: string): Promise<{ post?: Post; error?: "NOT_FOUND" | "FORBIDDEN" | "EDIT_WINDOW_PASSED" }> {
    const [existing] = await db.select().from(posts).where(eq(posts.id, id));
    if (!existing) return { error: "NOT_FOUND" };
    if (existing.userId !== userId) return { error: "FORBIDDEN" };
    if (Date.now() - existing.createdAt.getTime() > 5 * 60_000) return { error: "EDIT_WINDOW_PASSED" };

    const [post] = await db.update(posts)
      .set({ content, updatedAt: new Date() })
      .where(eq(posts.id, id))
      .returning();
    invalidateCache.posts();
    return { post };
  }

  async deletePost(id: string): Promise<void> {
    await db.delete(posts).where(eq(posts.id, id));
    invalidateCache.posts();
  }

  async createStory(insertStory: InsertStory, allowedViewerIds?: string[]): Promise<Story> {
    const result = await db.insert(stories).values(insertStory).returning();
    const story = result[0];

    if (insertStory.privacy === 'private' && allowedViewerIds && allowedViewerIds.length > 0) {
      await this.setStoryAllowedViewers(story.id, allowedViewerIds);
    }

    invalidateCache.stories();
    return story;
  }

  async getActiveStories(viewerId?: string): Promise<Array<Story & { user: User; likeCount: number; viewCount: number; isLiked?: boolean; isReshare?: boolean }>> {
    return cached(
      `active-stories:${viewerId ?? 'anon'}`,
      async () => {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Privacy collapsed into WHERE: no per-row canViewStory() calls.
        // Public stories visible to all; private only to owner or explicit allowed viewers.
        const privacyFilter = viewerId
          ? or(
              eq(stories.privacy, 'public'),
              eq(stories.userId, viewerId),
              sql`EXISTS (
                SELECT 1 FROM ${storyAllowedViewers}
                WHERE ${storyAllowedViewers.storyId} = ${stories.id}
                  AND ${storyAllowedViewers.viewerId} = ${viewerId}
              )`
            )
          : eq(stories.privacy, 'public');

        // Single query: counts + isLiked via aggregates, privacy via WHERE
        const rows = await db
          .select({
            story: stories,
            user: users,
            likeCount: sql<number>`count(distinct ${storyLikes.id})::int`,
            viewCount: sql<number>`count(distinct ${storyViews.id})::int`,
            isLiked: viewerId
              ? sql<boolean>`(coalesce(max(case when ${storyLikes.userId} = ${viewerId} then 1 else 0 end), 0) = 1)`
              : sql<boolean>`false`,
          })
          .from(stories)
          .innerJoin(users, eq(stories.userId, users.id))
          .leftJoin(storyLikes, eq(storyLikes.storyId, stories.id))
          .leftJoin(storyViews, eq(storyViews.storyId, stories.id))
          .where(and(gte(stories.createdAt, twentyFourHoursAgo), privacyFilter))
          .groupBy(stories.id, users.id)
          .orderBy(desc(stories.createdAt))
          .limit(100);

        return rows.map(row => {
          const { passwordHash, ...userWithoutPassword } = row.user;
          return {
            ...row.story,
            user: userWithoutPassword as User,
            likeCount: row.likeCount,
            viewCount: row.viewCount,
            isLiked: row.isLiked,
            isReshare: !!row.story.originalStoryId,
          };
        });
      },
      storiesCache,
    );
  }

  async getStory(id: string): Promise<Story | undefined> {
    const result = await db.select().from(stories).where(eq(stories.id, id));
    return result[0];
  }

  // Snapchat-style: a story disappears from PUBLIC view after 24h (the
  // gte(createdAt, ...) filter below), but the poster can still see their own
  // full history — pass viewerId === userId (e.g. from the /api/stories/archive
  // route) to skip that filter entirely. Nothing is ever deleted.
  async getUserStories(userId: string, viewerId?: string): Promise<Story[]> {
    const isOwnerViewing = viewerId === userId;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return await db
      .select()
      .from(stories)
      .where(isOwnerViewing
        ? eq(stories.userId, userId)
        : and(eq(stories.userId, userId), gte(stories.createdAt, twentyFourHoursAgo)))
      .orderBy(desc(stories.createdAt));
  }

  async deleteStory(id: string): Promise<void> {
    await db.delete(stories).where(eq(stories.id, id));
    invalidateCache.stories();
  }

  // Story likes
  async likeStory(userId: string, storyId: string): Promise<void> {
    await db.insert(storyLikes).values({ storyId, userId }).onConflictDoNothing();
    storiesCache.delete(`active-stories:${userId}`);
  }

  async unlikeStory(userId: string, storyId: string): Promise<void> {
    await db.delete(storyLikes).where(
      and(
        eq(storyLikes.storyId, storyId),
        eq(storyLikes.userId, userId)
      )
    );
    storiesCache.delete(`active-stories:${userId}`);
  }

  async hasUserLikedStory(userId: string, storyId: string): Promise<boolean> {
    const result = await db.select().from(storyLikes).where(
      and(
        eq(storyLikes.storyId, storyId),
        eq(storyLikes.userId, userId)
      )
    );
    return result.length > 0;
  }

  async getStoryLikeCount(storyId: string): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(storyLikes)
      .where(eq(storyLikes.storyId, storyId));
    return result[0]?.count || 0;
  }

  // Story views
  async recordStoryView(storyId: string, userId: string): Promise<void> {
    await db.insert(storyViews).values({ storyId, userId }).onConflictDoNothing();
  }

  async getStoryViewCount(storyId: string): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(storyViews)
      .where(eq(storyViews.storyId, storyId));
    return result[0]?.count || 0;
  }

  async getStoryViewersWithLikeStatus(storyId: string): Promise<Array<{ user: User; viewedAt: Date; hasLiked: boolean }>> {
    const viewers = await db
      .select()
      .from(storyViews)
      .innerJoin(users, eq(storyViews.userId, users.id))
      .where(eq(storyViews.storyId, storyId))
      .orderBy(desc(storyViews.viewedAt));

    return Promise.all(viewers.map(async (row) => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      const hasLiked = await this.hasUserLikedStory(row.users.id, storyId);
      return {
        user: userWithoutPassword as User,
        viewedAt: row.story_views.viewedAt,
        hasLiked,
      };
    }));
  }

  // Story reshares
  async reshareStory(userId: string, originalStoryId: string): Promise<Story> {
    const originalStory = await this.getStory(originalStoryId);
    if (!originalStory) {
      throw new Error('Original story not found');
    }
    
    const result = await db.insert(stories).values({
      userId,
      imageUrl: originalStory.imageUrl,
      type: originalStory.type,
      privacy: 'public', // Reshares are always public
      originalStoryId,
    }).returning();
    
    return result[0];
  }

  // Story allowed viewers
  async setStoryAllowedViewers(storyId: string, viewerIds: string[]): Promise<void> {
    // Delete existing viewers
    await db.delete(storyAllowedViewers).where(eq(storyAllowedViewers.storyId, storyId));
    
    // Insert new viewers
    if (viewerIds.length > 0) {
      await db.insert(storyAllowedViewers).values(
        viewerIds.map(viewerId => ({ storyId, viewerId }))
      );
    }
  }

  async getStoryAllowedViewers(storyId: string): Promise<string[]> {
    const result = await db
      .select({ viewerId: storyAllowedViewers.viewerId })
      .from(storyAllowedViewers)
      .where(eq(storyAllowedViewers.storyId, storyId));
    return result.map(r => r.viewerId);
  }

  async canViewStory(viewerId: string, storyId: string): Promise<boolean> {
    const story = await this.getStory(storyId);
    if (!story) return false;

    // Story owner can always view
    if (story.userId === viewerId) return true;

    // Public stories can be viewed by anyone
    if (story.privacy === 'public') return true;

    // Private stories require viewer to be in allowed list
    const allowedViewers = await this.getStoryAllowedViewers(storyId);
    return allowedViewers.includes(viewerId);
  }

  // canViewStory() alone doesn't account for the story's own 24h public
  // window (that lives in getUserStories' inline filter) — this combines
  // both so story comments genuinely "follow the story's lifecycle": once a
  // story exits public view, only the owner can still see (and comment on)
  // it via their Archive, exactly like the story content itself.
  async canViewStoryNow(viewerId: string, storyId: string): Promise<boolean> {
    const story = await this.getStory(storyId);
    if (!story) return false;
    if (story.userId === viewerId) return true;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (new Date(story.createdAt) < twentyFourHoursAgo) return false;

    return this.canViewStory(viewerId, storyId);
  }

  async followUser(followerId: string, followingId: string): Promise<Follow> {
    const result = await db.insert(follows).values({
      followerId,
      followingId,
    }).returning();
    return result[0];
  }

  async unfollowUser(followerId: string, followingId: string): Promise<void> {
    await db.delete(follows).where(
      and(
        eq(follows.followerId, followerId),
        eq(follows.followingId, followingId)
      )
    );
  }

  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const result = await db.select().from(follows).where(
      and(
        eq(follows.followerId, followerId),
        eq(follows.followingId, followingId)
      )
    );
    return result.length > 0;
  }

  async getFollowers(userId: string): Promise<Array<Follow & { follower: User }>> {
    const result = await db
      .select()
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .where(eq(follows.followingId, userId));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.follows,
        follower: userWithoutPassword as User,
      };
    });
  }

  // Lightweight counterpart to getFollowing() — just the ids, no user join,
  // for callers (like event ranking) that only need set-membership checks.
  async getFollowingIds(userId: string): Promise<string[]> {
    const result = await db
      .select({ followingId: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, userId));
    return result.map(r => r.followingId);
  }

  async getFollowing(userId: string): Promise<Array<Follow & { following: User }>> {
    const result = await db
      .select()
      .from(follows)
      .innerJoin(users, eq(follows.followingId, users.id))
      .where(eq(follows.followerId, userId));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.follows,
        following: userWithoutPassword as User,
      };
    });
  }

  async getUserProfile(userId: string): Promise<{ user: User; posts: Post[]; events: Array<Rsvp & { event: Event }> } | undefined> {
    const user = await this.getUser(userId);
    if (!user) return undefined;
    
    const userPosts = await this.getUserPosts(userId);
    const userEvents = await this.getUserRsvps(userId);
    
    const { passwordHash, ...userWithoutPassword } = user;
    
    return {
      user: userWithoutPassword as User,
      posts: userPosts,
      events: userEvents,
    };
  }

  async searchUsers(query: string): Promise<User[]> {
    const result = await db
      .select()
      .from(users)
      .where(
        or(
          ilike(users.username, `%${query}%`),
          ilike(users.displayName, `%${query}%`),
          ilike(users.organizationName, `%${query}%`)
        )
      );
    
    return result.map(user => {
      const { passwordHash, ...userWithoutPassword } = user;
      return userWithoutPassword as User;
    });
  }

  async searchEvents(query: string): Promise<Array<Event & { organizer: User }>> {
    const result = await db
      .select()
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .where(
        or(
          ilike(events.title, `%${query}%`),
          ilike(events.description, `%${query}%`),
          ilike(events.location, `%${query}%`),
          ilike(events.category, `%${query}%`)
        )
      )
      .orderBy(desc(events.eventDate));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.events,
        organizer: userWithoutPassword as User,
      };
    });
  }

  async searchVenues(query: string): Promise<Venue[]> {
    return await db
      .select()
      .from(venues)
      .where(
        or(
          ilike(venues.name, `%${query}%`),
          ilike(venues.description, `%${query}%`),
          ilike(venues.location, `%${query}%`),
          ilike(venues.city, `%${query}%`),
          ilike(venues.category, `%${query}%`)
        )
      )
      .orderBy(desc(venues.createdAt));
  }

  async searchPosts(query: string): Promise<Array<Post & { user: User }>> {
    const result = await db
      .select()
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(ilike(posts.content, `%${query}%`))
      .orderBy(desc(posts.createdAt));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.posts,
        user: userWithoutPassword as User,
      };
    });
  }

  async searchVenueEvents(query: string): Promise<Array<VenueEntryNight & { venue: Venue }>> {
    const result = await db
      .select()
      .from(venueEntryNights)
      .innerJoin(venues, eq(venueEntryNights.venueId, venues.id))
      .where(
        or(
          ilike(venueEntryNights.name, `%${query}%`),
          ilike(venueEntryNights.description, `%${query}%`)
        )
      )
      .orderBy(desc(venueEntryNights.date));
    return result.map(r => ({ ...r.venue_entry_nights, venue: r.venues }));
  }

  async universalSearch(query: string, types?: string[]): Promise<{
    users: User[];
    events: Array<Event & { organizer: User }>;
    venueEvents: Array<VenueEntryNight & { venue: Venue }>;
    venues: Venue[];
    posts: Array<Post & { user: User }>;
  }> {
    const searchTypes = types && types.length > 0 ? types : ['users', 'events', 'venueEvents', 'venues', 'posts'];

    const [userResults, eventResults, venueEventResults, venueResults, postResults] = await Promise.all([
      searchTypes.includes('users') ? this.searchUsers(query) : Promise.resolve([]),
      searchTypes.includes('events') ? this.searchEvents(query) : Promise.resolve([]),
      searchTypes.includes('venueEvents') ? this.searchVenueEvents(query) : Promise.resolve([]),
      searchTypes.includes('venues') ? this.searchVenues(query) : Promise.resolve([]),
      searchTypes.includes('posts') ? this.searchPosts(query) : Promise.resolve([]),
    ]);

    return {
      users: userResults.slice(0, 10),
      events: eventResults.slice(0, 10),
      venueEvents: venueEventResults.slice(0, 10),
      venues: venueResults.slice(0, 10),
      posts: postResults.slice(0, 10),
    };
  }

  // Hacker-News-style gravity decay instead of a flat score over a fixed
  // recency window — a genuinely high-engagement post from 2 days ago can now
  // outrank a mediocre 1-hour-old one, which a "newest 50, then sort" query
  // structurally can never do (the older post never even makes the candidate
  // pool). Candidate pool widened to 14 days so decay has real room to work
  // with. Flagged posts (3+ distinct reports, see createPostReport) are
  // excluded — a flagged post shouldn't be able to trend its way back into
  // visibility while under review. The existing postsCache 5-minute TTL
  // already re-runs this periodically, so the decay term visibly moves over
  // time even with zero new engagement, not just on cache invalidation.
  async getTrendingPosts(limit: number = 10): Promise<Array<Post & { user: User; likeCount: number; commentCount: number }>> {
    const all = await cached(
      'trending-posts',
      async () => {
        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const rows = await db
          .select({
            post: posts,
            user: users,
            likeCount: sql<number>`count(distinct ${likes.id})::int`,
            commentCount: sql<number>`count(distinct ${comments.id})::int`,
          })
          .from(posts)
          .innerJoin(users, eq(posts.userId, users.id))
          .leftJoin(likes, eq(likes.postId, posts.id))
          .leftJoin(comments, eq(comments.postId, posts.id))
          .where(and(gte(posts.createdAt, fourteenDaysAgo), eq(posts.moderationStatus, "approved")))
          .groupBy(posts.id, users.id)
          .orderBy(desc(posts.createdAt))
          .limit(200);

        const now = Date.now();
        return rows
          .map(row => {
            const { passwordHash, ...userWithoutPassword } = row.user;
            const ageHours = (now - row.post.createdAt.getTime()) / 3_600_000;
            const rawEngagement = row.likeCount * 2 + row.commentCount * 3;
            return {
              ...row.post,
              user: userWithoutPassword as User,
              likeCount: row.likeCount,
              commentCount: row.commentCount,
              decayScore: rawEngagement / Math.pow(ageHours + 2, 1.8),
            };
          })
          .sort((a, b) => b.decayScore - a.decayScore)
          .map(({ decayScore, ...rest }) => rest);
      },
      postsCache,
    );
    return all.slice(0, limit);
  }

  async getTrendingEvents(limit: number = 10): Promise<Array<Event & { organizer: User; rsvpCount: number; ticketCount: number }>> {
    const all = await cached(
      'trending-events',
      async () => {
        // 101 queries + bulk row fetches → 1: LEFT JOIN rsvps + tickets with COUNT(DISTINCT) aggregates
        const rows = await db
          .select({
            event: events,
            user: users,
            rsvpCount: sql<number>`count(distinct ${rsvps.id})::int`,
            ticketCount: sql<number>`count(distinct ${tickets.id})::int`,
          })
          .from(events)
          .innerJoin(users, eq(events.organizerId, users.id))
          .leftJoin(rsvps, eq(rsvps.eventId, events.id))
          .leftJoin(tickets, eq(tickets.eventId, events.id))
          .where(gte(events.eventDate, new Date()))
          .groupBy(events.id, users.id)
          .orderBy(desc(events.eventDate))
          .limit(50);

        return rows
          .map(row => {
            const { passwordHash, ...userWithoutPassword } = row.user;
            return {
              ...row.event,
              organizer: userWithoutPassword as User,
              rsvpCount: row.rsvpCount,
              ticketCount: row.ticketCount,
              engagementScore: row.rsvpCount * 2 + row.ticketCount * 3 + (row.event.isPromoted ? 10 : 0),
            };
          })
          .sort((a, b) => b.engagementScore - a.engagementScore)
          .map(({ engagementScore, ...rest }) => rest);
      },
      eventsCache,
    );
    return all.slice(0, limit);
  }

  async getTrendingVenues(limit: number = 10): Promise<Array<Venue & { viewCount: number }>> {
    const allVenues = await db
      .select()
      .from(venues)
      .orderBy(desc(venues.createdAt))
      .limit(50);
    
    const venuesWithViews = await Promise.all(
      allVenues.map(async (venue) => {
        const analytics = await this.getVenueAnalytics(venue.id);
        return {
          ...venue,
          viewCount: analytics.views,
          engagementScore: analytics.views + analytics.clicks * 2 + analytics.ticketsSold * 5 + (venue.isPromoted ? 10 : 0),
        };
      })
    );
    
    return venuesWithViews
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, limit)
      .map(({ engagementScore, ...rest }) => rest);
  }

  async getTrendingStories(limit: number = 10): Promise<Array<Story & { user: User; likeCount: number }>> {
    const activeStories = await this.getActiveStories();
    
    return activeStories
      .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
      .slice(0, limit)
      .map(({ isLiked, isReshare, ...rest }) => rest);
  }

  async getSuggestedUsers(userId: string, limit: number = 10): Promise<User[]> {
    const following = await db
      .select({ id: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, userId));
    
    const followingIds = following.map(f => f.id);
    followingIds.push(userId);
    
    const suggested = await db
      .select()
      .from(users)
      .where(notInArray(users.id, followingIds))
      .limit(limit);
    
    return suggested.map(user => {
      const { passwordHash, ...userWithoutPassword } = user;
      return userWithoutPassword as User;
    });
  }

  async getRecommendedUsers(userId: string, limit: number = 10): Promise<User[]> {
    // Get current user's interests and location
    const currentUser = await this.getUser(userId);
    if (!currentUser) {
      return [];
    }
    
    // Get users the current user is already following
    const following = await db
      .select({ id: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, userId));
    
    const excludeIds = [userId, ...following.map(f => f.id)];
    
    // Get all eligible users (not following and not self)
    const allUsers = await db
      .select()
      .from(users)
      .where(notInArray(users.id, excludeIds));
    
    // Calculate match score for each user based on interests and location
    const scoredUsers = allUsers.map(user => {
      let score = 0;
      
      // Interest matching (each shared interest = +2 points)
      const currentInterests = currentUser.interests || [];
      const userInterests = user.interests || [];
      const sharedInterests = currentInterests.filter((i: string | null) => 
        userInterests.some((ui: string | null) => ui?.toLowerCase() === i?.toLowerCase())
      );
      score += sharedInterests.length * 2;
      
      // Location matching (+3 points for same location)
      if (currentUser.location && user.location) {
        const currentLoc = currentUser.location.toLowerCase().trim();
        const userLoc = user.location.toLowerCase().trim();
        if (currentLoc === userLoc) {
          score += 3;
        } else if (currentLoc.includes(userLoc) || userLoc.includes(currentLoc)) {
          score += 1;
        }
      }
      
      // Bonus for verified/official users (+1 point)
      if (user.isVerified || user.isOfficial) {
        score += 1;
      }
      
      const { passwordHash, ...userWithoutPassword } = user;
      return {
        ...userWithoutPassword as User,
        matchScore: score,
        sharedInterestsCount: sharedInterests.length,
        sameLocation: currentUser.location && user.location && 
          currentUser.location.toLowerCase().trim() === user.location?.toLowerCase().trim(),
      };
    });
    
    // Sort by score (highest first), then filter to only those with some match
    const sortedUsers = scoredUsers
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit);
    
    // Return users without the extra fields (matchScore etc are just for sorting)
    return sortedUsers.map(({ matchScore, sharedInterestsCount, sameLocation, ...user }) => user);
  }

  async likePost(userId: string, postId: string): Promise<Like> {
    const result = await db.insert(likes).values({
      userId,
      postId,
    }).returning();
    return result[0];
  }

  async unlikePost(userId: string, postId: string): Promise<void> {
    await db.delete(likes).where(
      and(
        eq(likes.userId, userId),
        eq(likes.postId, postId)
      )
    );
  }

  async getPostLikes(postId: string): Promise<number> {
    const result = await db.select().from(likes).where(eq(likes.postId, postId));
    return result.length;
  }

  async hasUserLikedPost(userId: string, postId: string): Promise<boolean> {
    const result = await db.select().from(likes).where(
      and(
        eq(likes.userId, userId),
        eq(likes.postId, postId)
      )
    );
    return result.length > 0;
  }

  async getComment(id: string): Promise<Comment | undefined> {
    const [result] = await db.select().from(comments).where(eq(comments.id, id));
    return result;
  }

  // Generic insert — works for a top-level comment (parentCommentId: null) or
  // a reply at any depth (parentCommentId: the parent's id), since replies are
  // now just comments rows. Keeps posts.commentCount in sync so feed/trending
  // never need a live COUNT(*).
  async addComment(insertComment: InsertComment): Promise<Comment> {
    const [result] = await db.insert(comments).values(insertComment).returning();
    // Story comments (postId null, storyId set) skip this — posts.commentCount
    // has nothing to do with them.
    if (insertComment.postId) {
      await db.update(posts)
        .set({ commentCount: sql`${posts.commentCount} + 1` })
        .where(eq(posts.id, insertComment.postId));
      invalidateCache.posts();
    }
    return result;
  }

  // Soft delete — replies underneath stay attached and visible under a
  // "[comment deleted]" placeholder, matching X/Reddit/HN instead of cascading
  // the delete through the whole subtree.
  async deleteComment(id: string, userId: string): Promise<Comment | undefined> {
    const [existing] = await db.select().from(comments).where(eq(comments.id, id));
    if (!existing || existing.userId !== userId || existing.isDeleted) return undefined;

    const [result] = await db.update(comments)
      .set({ isDeleted: true, deletedAt: new Date(), content: "" })
      .where(eq(comments.id, id))
      .returning();

    if (existing.postId) {
      await db.update(posts)
        .set({ commentCount: sql`GREATEST(${posts.commentCount} - 1, 0)` })
        .where(eq(posts.id, existing.postId));
      invalidateCache.posts();
    }
    return result;
  }

  // Top-level comments only (parentCommentId IS NULL) — soft-deleted rows are
  // still included so their replies stay legible under a placeholder. Nested
  // replies are fetched lazily per-thread via getCommentThread, not here.
  async getPostComments(postId: string, limit: number = 100): Promise<Array<Comment & { user: User }>> {
    const result = await db
      .select()
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(eq(comments.postId, postId), isNull(comments.parentCommentId)))
      .orderBy(comments.createdAt)
      .limit(limit);

    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comments,
        user: userWithoutPassword as User,
      };
    });
  }

  // Story comments — a flat list (no lazy per-thread expansion like
  // getPostComments/getCommentThread) since a story's comment volume is
  // small and ephemeral; loading everything for the story at once is simpler
  // and correct at this scale. Soft-deleted rows stay included so any reply
  // chain under them keeps its "[comment deleted]" placeholder — same reason
  // getPostComments keeps them too.
  async getStoryComments(storyId: string, viewerId?: string): Promise<Array<Comment & { user: User; likeCount: number; isLiked: boolean }>> {
    const result = await db
      .select()
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.storyId, storyId))
      .orderBy(comments.createdAt);

    if (result.length === 0) return [];
    const commentIds = result.map(r => r.comments.id);

    const likeCountRows = await db
      .select({ commentId: commentLikes.commentId, count: sql<number>`count(*)::int` })
      .from(commentLikes)
      .where(inArray(commentLikes.commentId, commentIds))
      .groupBy(commentLikes.commentId);
    const likeCountMap = new Map(likeCountRows.map(r => [r.commentId, r.count]));

    let viewerLikedSet = new Set<string>();
    if (viewerId) {
      const viewerLikes = await db
        .select({ commentId: commentLikes.commentId })
        .from(commentLikes)
        .where(and(inArray(commentLikes.commentId, commentIds), eq(commentLikes.userId, viewerId)));
      viewerLikedSet = new Set(viewerLikes.map(r => r.commentId));
    }

    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comments,
        user: userWithoutPassword as User,
        likeCount: likeCountMap.get(row.comments.id) ?? 0,
        isLiked: viewerLikedSet.has(row.comments.id),
      };
    });
  }

  // Everything nested under one top-level comment, in a single recursive
  // query — fetched lazily when a user taps "view replies" on that specific
  // comment, not for the whole post at once. This is what makes unlimited
  // depth scale instead of shipping the entire thread graph in one payload.
  // Two-step (recursive CTE for ids, then a normal Drizzle join for row
  // hydration) rather than selecting c.*, u.* in one raw query — the latter
  // silently lets users.id clobber comments.id when the driver flattens both
  // tables' columns into one object.
  async getCommentThread(topLevelCommentId: string, viewerId?: string): Promise<Array<Comment & { user: User; likeCount: number; isLiked: boolean }>> {
    const idRows = await db.execute(sql`
      WITH RECURSIVE thread AS (
        SELECT id FROM comments WHERE parent_comment_id = ${topLevelCommentId}
        UNION ALL
        SELECT c.id FROM comments c
        INNER JOIN thread t ON c.parent_comment_id = t.id
      )
      SELECT id FROM thread
    `);
    const threadIds = (idRows.rows as any[]).map((r) => r.id as string);
    if (threadIds.length === 0) return [];

    const result = await db
      .select()
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(inArray(comments.id, threadIds))
      .orderBy(comments.createdAt);

    // Bounded to a handful of extra queries regardless of subtree size — keeps
    // per-node like state out of an N-query fan-out when a deep thread renders.
    const likeCountRows = await db
      .select({ commentId: commentLikes.commentId, count: sql<number>`count(*)::int` })
      .from(commentLikes)
      .where(inArray(commentLikes.commentId, threadIds))
      .groupBy(commentLikes.commentId);
    const likeCountMap = new Map(likeCountRows.map(r => [r.commentId, r.count]));

    let viewerLikedSet = new Set<string>();
    if (viewerId) {
      const viewerLikes = await db
        .select({ commentId: commentLikes.commentId })
        .from(commentLikes)
        .where(and(inArray(commentLikes.commentId, threadIds), eq(commentLikes.userId, viewerId)));
      viewerLikedSet = new Set(viewerLikes.map(r => r.commentId));
    }

    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comments,
        user: userWithoutPassword as User,
        likeCount: likeCountMap.get(row.comments.id) ?? 0,
        isLiked: viewerLikedSet.has(row.comments.id),
      };
    });
  }

  async getCommentCount(postId: string): Promise<number> {
    const result = await db.select().from(comments).where(eq(comments.postId, postId));
    return result.length;
  }

  // ============================================
  // COMMENT INTERACTION METHODS
  // ============================================

  async likeComment(userId: string, commentId: string): Promise<CommentLike> {
    const result = await db.insert(commentLikes).values({
      userId,
      commentId,
    }).returning();
    return result[0];
  }

  async unlikeComment(userId: string, commentId: string): Promise<void> {
    await db.delete(commentLikes).where(
      and(
        eq(commentLikes.userId, userId),
        eq(commentLikes.commentId, commentId)
      )
    );
  }

  async hasUserLikedComment(userId: string, commentId: string): Promise<boolean> {
    const result = await db.select().from(commentLikes).where(
      and(
        eq(commentLikes.userId, userId),
        eq(commentLikes.commentId, commentId)
      )
    );
    return result.length > 0;
  }

  async getCommentLikeCount(commentId: string): Promise<number> {
    const result = await db.select().from(commentLikes).where(eq(commentLikes.commentId, commentId));
    return result.length;
  }

  // A "reply" is now just a comment with parentCommentId set — works at any
  // depth, since :commentId can itself be a top-level comment OR an existing
  // reply. This is what gives unlimited-depth threading.
  async addCommentReply(userId: string, commentId: string, content: string): Promise<Comment> {
    const [parent] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!parent) throw new Error("Parent comment not found");
    return this.addComment({ userId, postId: parent.postId, parentCommentId: commentId, content } as InsertComment);
  }

  // Direct children only (one level) — kept for any caller that still wants a
  // shallow reply list. getCommentThread (above) returns the full recursive
  // subtree and is what the client actually uses for rendering.
  async getCommentReplies(commentId: string): Promise<Array<Comment & { user: User }>> {
    const result = await db
      .select()
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.parentCommentId, commentId))
      .orderBy(comments.createdAt);

    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comments,
        user: userWithoutPassword as User,
      };
    });
  }

  async getCommentReplyCount(commentId: string): Promise<number> {
    const result = await db.select().from(comments).where(eq(comments.parentCommentId, commentId));
    return result.length;
  }

  async repostComment(userId: string, commentId: string): Promise<CommentRepost> {
    const result = await db.insert(commentReposts).values({
      userId,
      commentId,
    }).returning();
    return result[0];
  }

  async unrepostComment(userId: string, commentId: string): Promise<void> {
    await db.delete(commentReposts).where(
      and(
        eq(commentReposts.userId, userId),
        eq(commentReposts.commentId, commentId)
      )
    );
  }

  async hasUserRepostedComment(userId: string, commentId: string): Promise<boolean> {
    const result = await db.select().from(commentReposts).where(
      and(
        eq(commentReposts.userId, userId),
        eq(commentReposts.commentId, commentId)
      )
    );
    return result.length > 0;
  }

  async getCommentRepostCount(commentId: string): Promise<number> {
    const result = await db.select().from(commentReposts).where(eq(commentReposts.commentId, commentId));
    return result.length;
  }

  async bookmarkPost(userId: string, postId: string): Promise<Bookmark> {
    const result = await db.insert(bookmarks).values({
      userId,
      postId,
    }).returning();
    return result[0];
  }

  async unbookmarkPost(userId: string, postId: string): Promise<void> {
    await db.delete(bookmarks).where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.postId, postId)
      )
    );
  }

  async hasUserBookmarkedPost(userId: string, postId: string): Promise<boolean> {
    const result = await db.select().from(bookmarks).where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.postId, postId)
      )
    );
    return result.length > 0;
  }

  // ============================================
  // REPOST METHODS
  // ============================================

  async repostPost(userId: string, postId: string): Promise<Repost> {
    const result = await db.transaction(async (tx) => {
      return tx.insert(reposts).values({ userId, postId }).returning();
    });
    invalidateCache.posts();
    return result[0];
  }

  async unrepostPost(userId: string, postId: string): Promise<void> {
    await db.delete(reposts).where(
      and(eq(reposts.userId, userId), eq(reposts.postId, postId))
    );
    invalidateCache.posts();
  }

  async hasUserRepostedPost(userId: string, postId: string): Promise<boolean> {
    const result = await db.select().from(reposts).where(
      and(eq(reposts.userId, userId), eq(reposts.postId, postId))
    );
    return result.length > 0;
  }

  async getPostRepostCount(postId: string): Promise<number> {
    const result = await db.select({ count: count() })
      .from(reposts)
      .where(eq(reposts.postId, postId));
    return result[0]?.count || 0;
  }

  async getPostsWithReposts(): Promise<Array<any>> {
    // Get all original posts with user info
    const originalPosts = await db.select({
      post: posts,
      user: users,
    })
    .from(posts)
    .innerJoin(users, eq(posts.userId, users.id))
    .orderBy(desc(posts.createdAt));

    // Get all reposts with reposting user info and original post info
    const repostsList = await db.select({
      repost: reposts,
      repostingUser: users,
    })
    .from(reposts)
    .innerJoin(users, eq(reposts.userId, users.id))
    .orderBy(desc(reposts.createdAt));

    // Create a combined feed with original posts and reposts
    const feed: any[] = [];

    // Add original posts
    for (const row of originalPosts) {
      feed.push({
        ...row.post,
        user: row.user,
        isRepost: false,
      });
    }

    // Add reposts with reference to original post
    for (const row of repostsList) {
      const originalPost = originalPosts.find(p => p.post.id === row.repost.postId);
      if (originalPost) {
        feed.push({
          id: `repost-${row.repost.id}`,
          isRepost: true,
          repostedBy: row.repostingUser,
          originalPost: {
            ...originalPost.post,
            user: originalPost.user,
          },
          createdAt: row.repost.createdAt,
          user: row.repostingUser,
        });
      }
    }

    // Sort by createdAt descending
    feed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return feed;
  }

  // ============================================
  // HASHTAG METHODS
  // ============================================

  async getOrCreateHashtag(tag: string): Promise<Hashtag> {
    const normalizedTag = tag.toLowerCase().replace(/^#/, '');
    
    // Try to find existing hashtag
    const existing = await db.select().from(hashtags).where(eq(hashtags.tag, normalizedTag));
    if (existing.length > 0) {
      return existing[0];
    }

    // Create new hashtag
    const result = await db.insert(hashtags).values({ tag: normalizedTag }).returning();
    return result[0];
  }

  async addHashtagToPost(postId: string, hashtagId: string): Promise<void> {
    await db.insert(postHashtags).values({ postId, hashtagId }).onConflictDoNothing();
    
    // Increment post count for the hashtag
    await db.update(hashtags)
      .set({ postCount: sql`${hashtags.postCount} + 1` })
      .where(eq(hashtags.id, hashtagId));
  }

  async getPostHashtags(postId: string): Promise<Hashtag[]> {
    const result = await db.select({ hashtag: hashtags })
      .from(postHashtags)
      .innerJoin(hashtags, eq(postHashtags.hashtagId, hashtags.id))
      .where(eq(postHashtags.postId, postId));
    return result.map(r => r.hashtag);
  }

  async getPostsByHashtag(tag: string): Promise<Array<Post & { user: User }>> {
    const normalizedTag = tag.toLowerCase().replace(/^#/, '');
    
    const result = await db.select({
      post: posts,
      user: users,
    })
    .from(posts)
    .innerJoin(users, eq(posts.userId, users.id))
    .innerJoin(postHashtags, eq(posts.id, postHashtags.postId))
    .innerJoin(hashtags, eq(postHashtags.hashtagId, hashtags.id))
    .where(eq(hashtags.tag, normalizedTag))
    .orderBy(desc(posts.createdAt));

    return result.map(r => ({ ...r.post, user: r.user }));
  }

  async getTrendingHashtags(limit: number = 10): Promise<Hashtag[]> {
    const result = await db.select()
      .from(hashtags)
      .orderBy(desc(hashtags.postCount))
      .limit(limit);
    return result;
  }

  // ============================================
  // MENTION METHODS
  // ============================================

  async addMentionToPost(postId: string, mentionedUserId: string): Promise<void> {
    await db.insert(postMentions).values({ postId, mentionedUserId }).onConflictDoNothing();
  }

  async getPostMentions(postId: string): Promise<User[]> {
    const result = await db.select({ user: users })
      .from(postMentions)
      .innerJoin(users, eq(postMentions.mentionedUserId, users.id))
      .where(eq(postMentions.postId, postId));
    return result.map(r => r.user);
  }

  async getUserMentions(userId: string): Promise<Array<Post & { user: User }>> {
    const result = await db.select({
      post: posts,
      user: users,
    })
    .from(posts)
    .innerJoin(users, eq(posts.userId, users.id))
    .innerJoin(postMentions, eq(posts.id, postMentions.postId))
    .where(eq(postMentions.mentionedUserId, userId))
    .orderBy(desc(posts.createdAt));

    return result.map(r => ({ ...r.post, user: r.user }));
  }

  // ==================== SAFETY SYSTEM ====================

  async createBuddy(params: Omit<InsertSafetyBuddy, "id">): Promise<SafetyBuddy> {
    const [result] = await db.insert(safetyBuddies).values(params as any).returning();
    return result;
  }

  async getBuddy(buddyId: string): Promise<SafetyBuddy | undefined> {
    const [result] = await db.select().from(safetyBuddies).where(eq(safetyBuddies.id, buddyId));
    return result;
  }

  async updateBuddy(buddyId: string, updates: Partial<SafetyBuddy>): Promise<SafetyBuddy> {
    const [result] = await db
      .update(safetyBuddies)
      .set({ ...updates, updatedAt: new Date() } as any)
      .where(eq(safetyBuddies.id, buddyId))
      .returning();
    if (!result) throw new Error(`Buddy ${buddyId} not found`);
    return result;
  }

  async deleteBuddy(buddyId: string): Promise<void> {
    await db.delete(safetyBuddies).where(eq(safetyBuddies.id, buddyId));
  }

  async getBuddiesByUser(userId: string): Promise<SafetyBuddy[]> {
    return db.select().from(safetyBuddies).where(eq(safetyBuddies.userId, userId));
  }

  async getConfirmedBuddies(userId: string): Promise<SafetyBuddy[]> {
    return db
      .select()
      .from(safetyBuddies)
      .where(and(eq(safetyBuddies.userId, userId), eq(safetyBuddies.confirmationStatus, "confirmed")));
  }

  async getPendingBuddyByPhone(userId: string, phone: string): Promise<SafetyBuddy | undefined> {
    const [result] = await db
      .select()
      .from(safetyBuddies)
      .where(
        and(
          eq(safetyBuddies.userId, userId),
          eq(safetyBuddies.phoneNumber, phone),
          eq(safetyBuddies.confirmationStatus, "pending")
        )
      );
    return result;
  }

  async getPendingBuddyByPhoneGlobal(phone: string): Promise<SafetyBuddy | undefined> {
    const [result] = await db
      .select()
      .from(safetyBuddies)
      .where(and(eq(safetyBuddies.phoneNumber, phone), eq(safetyBuddies.confirmationStatus, "pending")))
      .orderBy(desc(safetyBuddies.createdAt));
    return result;
  }

  async getBuddyByToken(token: string): Promise<SafetyBuddy | undefined> {
    const [result] = await db
      .select()
      .from(safetyBuddies)
      .where(eq(safetyBuddies.confirmationToken, token));
    return result;
  }

  async getExpiredPendingBuddies(): Promise<SafetyBuddy[]> {
    return db
      .select()
      .from(safetyBuddies)
      .where(
        and(
          eq(safetyBuddies.confirmationStatus, "pending"),
          lt(safetyBuddies.tokenExpiresAt, new Date())
        )
      );
  }

  async setDistressMessage(userId: string, message: string): Promise<void> {
    const existing = await db.select().from(distressMessages).where(eq(distressMessages.userId, userId));
    if (existing.length > 0) {
      await db.update(distressMessages)
        .set({ message, updatedAt: new Date() })
        .where(eq(distressMessages.userId, userId));
    } else {
      await db.insert(distressMessages).values({ userId, message });
    }
  }

  async getDistressMessage(userId: string): Promise<string | undefined> {
    const result = await db.select().from(distressMessages).where(eq(distressMessages.userId, userId));
    return result[0]?.message;
  }

  async createSafetyAlert(params: {
    userId: string;
    buddyId: string;
    alertType: string;
    message: string;
    latitude?: number;
    longitude?: number;
    locationText?: string;
    timerId?: string;
  }): Promise<SafetyAlert> {
    const [result] = await db.insert(safetyAlerts).values({
      userId: params.userId,
      buddyId: params.buddyId,
      alertType: params.alertType,
      message: params.message,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      locationText: params.locationText ?? null,
      timerId: params.timerId ?? null,
      status: "active",
    }).returning();
    return result;
  }

  async getSafetyAlerts(userId: string): Promise<any[]> {
    const sent = await db
      .select()
      .from(safetyAlerts)
      .innerJoin(users, eq(safetyAlerts.buddyId, users.id))
      .where(eq(safetyAlerts.userId, userId))
      .orderBy(desc(safetyAlerts.createdAt));

    const received = await db
      .select()
      .from(safetyAlerts)
      .innerJoin(users, eq(safetyAlerts.userId, users.id))
      .where(eq(safetyAlerts.buddyId, userId))
      .orderBy(desc(safetyAlerts.createdAt));

    const sentAlerts = sent.map(row => {
      const { passwordHash, ...buddyUser } = row.users;
      return { ...row.safety_alerts, type: "sent", buddy: buddyUser };
    });

    const receivedAlerts = received.map(row => {
      const { passwordHash, ...senderUser } = row.users;
      return { ...row.safety_alerts, type: "received", sender: senderUser };
    });

    return [...sentAlerts, ...receivedAlerts].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // Either the alert's own sender OR their confirmed buddy (the recipient) may
  // resolve it — a buddy who reaches the person, or the person themself, can
  // both mark it safe/false-alarm. The caller (safety-routes.ts) figures out
  // which side acted and notifies the other one accordingly.
  async resolveSafetyAlert(alertId: string, userId: string, status: string): Promise<SafetyAlert | undefined> {
    const [result] = await db.update(safetyAlerts)
      .set({ status, resolvedAt: new Date() })
      .where(and(eq(safetyAlerts.id, alertId), or(eq(safetyAlerts.userId, userId), eq(safetyAlerts.buddyId, userId))))
      .returning();
    return result;
  }

  // Grace period is fixed at 25 minutes — it's the T+25 "alerted" boundary of the
  // PRD's graduated escalation (T+0/T+10/T+20/T+25), not user-configurable.
  async createSafetyTimer(params: {
    userId: string;
    durationMinutes: number;
    eventId?: string;
  }): Promise<SafetyTimer> {
    const grace = 25;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.durationMinutes * 60_000);
    const gracePeriodEndsAt = new Date(expiresAt.getTime() + grace * 60_000);

    // Cancel any existing active timer for this user
    await db.update(safetyTimers)
      .set({ status: "cancelled" })
      .where(and(eq(safetyTimers.userId, params.userId), eq(safetyTimers.status, "active")));

    const [result] = await db.insert(safetyTimers).values({
      userId: params.userId,
      durationMinutes: params.durationMinutes,
      gracePeriodMinutes: grace,
      expiresAt,
      gracePeriodEndsAt,
      eventId: params.eventId ?? null,
      status: "active",
    }).returning();
    return result;
  }

  // Extends expiresAt by 30min (max 3 times per timer). On the 3rd snooze, the
  // final cycle skips stage 1's gentle copy and starts at stage 2 — see the
  // lastStageNotified comment on the safetyTimers table definition.
  async snoozeSafetyTimer(userId: string): Promise<SafetyTimer | undefined> {
    const timer = await this.getActiveSafetyTimer(userId);
    if (!timer) return undefined;
    if (timer.snoozeCount >= 3) {
      throw new Error("No more snoozes available for this timer");
    }

    const newSnoozeCount = timer.snoozeCount + 1;
    const newExpiresAt = new Date(timer.expiresAt.getTime() + 30 * 60_000);
    const newGracePeriodEndsAt = new Date(newExpiresAt.getTime() + 25 * 60_000);

    const [result] = await db.update(safetyTimers)
      .set({
        status: "active",
        expiresAt: newExpiresAt,
        gracePeriodEndsAt: newGracePeriodEndsAt,
        snoozeCount: newSnoozeCount,
        lastStageNotified: newSnoozeCount === 3 ? 1 : 0,
      })
      .where(eq(safetyTimers.id, timer.id))
      .returning();
    return result;
  }

  // Direct, uncapped edit — distinct from snoozeSafetyTimer's fixed 30min/max-3
  // mechanism. Resets the escalation cycle from the new expiry point.
  async extendSafetyTimer(userId: string, hours: number): Promise<SafetyTimer | undefined> {
    const timer = await this.getActiveSafetyTimer(userId);
    if (!timer) return undefined;

    const newExpiresAt = new Date(timer.expiresAt.getTime() + hours * 3_600_000);
    const newGracePeriodEndsAt = new Date(newExpiresAt.getTime() + 25 * 60_000);

    const [result] = await db.update(safetyTimers)
      .set({
        status: "active",
        expiresAt: newExpiresAt,
        gracePeriodEndsAt: newGracePeriodEndsAt,
        lastStageNotified: 0,
      })
      .where(eq(safetyTimers.id, timer.id))
      .returning();
    return result;
  }

  // All timers not yet in a terminal state — used by the 30s poll job's stage-1/2/3
  // self-notification pass. Terminal states (alerted/checked_in/cancelled) are excluded.
  async getTimersForStageCheck(): Promise<SafetyTimer[]> {
    return db
      .select()
      .from(safetyTimers)
      .where(or(eq(safetyTimers.status, "active"), eq(safetyTimers.status, "grace_period")));
  }

  async updateTimerStageNotified(timerId: string, stage: number): Promise<void> {
    await db.update(safetyTimers)
      .set({ lastStageNotified: stage })
      .where(eq(safetyTimers.id, timerId));
  }

  async getActiveSafetyTimer(userId: string): Promise<SafetyTimer | null> {
    const [result] = await db
      .select()
      .from(safetyTimers)
      .where(and(
        eq(safetyTimers.userId, userId),
        or(eq(safetyTimers.status, "active"), eq(safetyTimers.status, "grace_period"))
      ));
    return result ?? null;
  }

  async checkInSafetyTimer(userId: string): Promise<void> {
    await db.update(safetyTimers)
      .set({ status: "checked_in", checkedInAt: new Date() })
      .where(and(
        eq(safetyTimers.userId, userId),
        or(eq(safetyTimers.status, "active"), eq(safetyTimers.status, "grace_period"))
      ));
  }

  async cancelSafetyTimer(userId: string): Promise<void> {
    await db.update(safetyTimers)
      .set({ status: "cancelled" })
      .where(and(
        eq(safetyTimers.userId, userId),
        or(eq(safetyTimers.status, "active"), eq(safetyTimers.status, "grace_period"))
      ));
  }

  async getTimersNeedingAlert(): Promise<SafetyTimer[]> {
    const now = new Date();
    // Timers in active status where grace period has ended
    const activeExpired = await db
      .select()
      .from(safetyTimers)
      .where(and(eq(safetyTimers.status, "active"), lt(safetyTimers.expiresAt, now)));

    // Transition active → grace_period for timers that just expired
    for (const timer of activeExpired) {
      await db.update(safetyTimers)
        .set({ status: "grace_period" })
        .where(eq(safetyTimers.id, timer.id));
    }

    // Timers in grace_period where grace window has also ended
    return db
      .select()
      .from(safetyTimers)
      .where(and(eq(safetyTimers.status, "grace_period"), lt(safetyTimers.gracePeriodEndsAt, now)));
  }

  async markTimerAlerted(timerId: string): Promise<void> {
    await db.update(safetyTimers)
      .set({ status: "alerted", alertedAt: new Date() })
      .where(eq(safetyTimers.id, timerId));
  }

  // One share row per triggering event (SOS fire or timer expiry), reused across
  // every phone-only buddy notified by that same event — see the table comment
  // in shared/schema.ts for why this is a standalone snapshot, not a safetyAlerts row.
  async createSafetyAlertShare(params: {
    userId: string;
    alertType: string;
    message: string;
    latitude?: number | null;
    longitude?: number | null;
    locationText?: string | null;
  }): Promise<SafetyAlertShare> {
    const shareToken = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [result] = await db.insert(safetyAlertShares).values({
      userId: params.userId,
      shareToken,
      alertType: params.alertType,
      message: params.message,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      locationText: params.locationText ?? null,
      expiresAt,
    }).returning();
    return result;
  }

  async getSafetyAlertShareByToken(token: string): Promise<SafetyAlertShare | undefined> {
    const [result] = await db
      .select()
      .from(safetyAlertShares)
      .where(eq(safetyAlertShares.shareToken, token));
    return result;
  }

  async getWatchingOver(userId: string): Promise<Array<{
    buddyRecord: SafetyBuddy;
    protectedUser: Omit<User, "passwordHash">;
    activeTimer: SafetyTimer | null;
    recentAlerts: SafetyAlert[];
  }>> {
    const buddyRecords = await db
      .select()
      .from(safetyBuddies)
      .where(and(
        eq(safetyBuddies.buddyUserId, userId),
        eq(safetyBuddies.confirmationStatus, "confirmed")
      ));

    const results = [];
    for (const record of buddyRecords) {
      const [userRow] = await db.select().from(users).where(eq(users.id, record.userId)).limit(1);
      if (!userRow) continue;
      const { passwordHash, ...protectedUser } = userRow;

      const [activeTimer] = await db
        .select()
        .from(safetyTimers)
        .where(and(
          eq(safetyTimers.userId, record.userId),
          inArray(safetyTimers.status, ["active", "grace_period"])
        ))
        .limit(1);

      const recentAlerts = await db
        .select()
        .from(safetyAlerts)
        .where(and(
          eq(safetyAlerts.userId, record.userId),
          eq(safetyAlerts.buddyId, userId)
        ))
        .orderBy(desc(safetyAlerts.createdAt))
        .limit(3);

      results.push({ buddyRecord: record, protectedUser, activeTimer: activeTimer ?? null, recentAlerts });
    }
    return results;
  }

  async getFollowingForBuddy(userId: string): Promise<Array<{
    user: Omit<User, "passwordHash">;
    existingBuddy: SafetyBuddy | null;
  }>> {
    // People this user follows who have app accounts
    const following = await db
      .select()
      .from(follows)
      .innerJoin(users, eq(follows.followingId, users.id))
      .where(eq(follows.followerId, userId));

    // Existing buddy records for this user (any status)
    const existingBuddies = await db
      .select()
      .from(safetyBuddies)
      .where(eq(safetyBuddies.userId, userId));

    return following.map((row) => {
      const { passwordHash, ...user } = row.users;
      const existingBuddy = existingBuddies.find(
        (b) => b.buddyUserId === user.id
      ) ?? null;
      return { user, existingBuddy };
    });
  }

  async getPendingIncomingBuddyRequests(userId: string): Promise<Array<SafetyBuddy & {
    requester: Omit<User, "passwordHash">;
  }>> {
    const rows = await db
      .select()
      .from(safetyBuddies)
      .innerJoin(users, eq(safetyBuddies.userId, users.id))
      .where(and(
        eq(safetyBuddies.buddyUserId, userId),
        eq(safetyBuddies.confirmationStatus, "pending")
      ))
      .orderBy(desc(safetyBuddies.createdAt));

    return rows.map((row) => {
      const { passwordHash, ...requester } = row.users;
      return { ...row.safety_buddies, requester };
    });
  }

  async getPhoneBuddyCount(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(safetyBuddies)
      .where(and(
        eq(safetyBuddies.userId, userId),
        isNotNull(safetyBuddies.phoneNumber),
        eq(safetyBuddies.confirmationStatus, "confirmed")
      ));
    return result[0]?.count ?? 0;
  }

  async getAppBuddyCount(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(safetyBuddies)
      .where(and(
        eq(safetyBuddies.userId, userId),
        isNotNull(safetyBuddies.buddyUserId),
        isNull(safetyBuddies.phoneNumber),
        eq(safetyBuddies.confirmationStatus, "confirmed")
      ));
    return result[0]?.count ?? 0;
  }

  async trackEventView(eventId: string, userId?: string): Promise<void> {
    await db.insert(eventAnalytics).values({
      eventId,
      userId: userId || null,
      actionType: 'view',
    });
  }

  async trackEventClick(eventId: string, actionType: string, userId?: string): Promise<void> {
    await db.insert(eventAnalytics).values({
      eventId,
      userId: userId || null,
      actionType,
    });
  }

  async getEventAnalytics(eventId: string): Promise<{ views: number; clicks: number; rsvps: number; ticketsSold: number }> {
    const viewsResult = await db
      .select({ count: count() })
      .from(eventAnalytics)
      .where(and(eq(eventAnalytics.eventId, eventId), eq(eventAnalytics.actionType, 'view')));
    
    const clicksResult = await db
      .select({ count: count() })
      .from(eventAnalytics)
      .where(and(eq(eventAnalytics.eventId, eventId), eq(eventAnalytics.actionType, 'click')));
    
    const rsvpsResult = await db
      .select({ count: count() })
      .from(rsvps)
      .where(eq(rsvps.eventId, eventId));
    
    const ticketsResult = await db
      .select({ count: count() })
      .from(tickets)
      .where(eq(tickets.eventId, eventId));
    
    return {
      views: viewsResult[0]?.count || 0,
      clicks: clicksResult[0]?.count || 0,
      rsvps: rsvpsResult[0]?.count || 0,
      ticketsSold: ticketsResult[0]?.count || 0,
    };
  }

  async promoteEvent(eventId: string, durationDays: number): Promise<Event> {
    const promotedUntil = new Date();
    promotedUntil.setDate(promotedUntil.getDate() + durationDays);

    const result = await db
      .update(events)
      .set({ isPromoted: true, promotedUntil })
      .where(eq(events.id, eventId))
      .returning();

    invalidateCache.events();
    return result[0];
  }

  async getPromotedEvents(): Promise<Event[]> {
    const now = new Date();
    return await db
      .select()
      .from(events)
      .where(and(eq(events.isPromoted, true), gte(events.promotedUntil, now)))
      .orderBy(desc(events.promotedUntil));
  }

  async createEventPost(userId: string, eventId: string, content: string, imageUrl?: string): Promise<Post> {
    const result = await db.insert(posts).values({
      userId,
      eventId,
      content,
      imageUrl,
    }).returning();
    return result[0];
  }

  async getFollowerIds(userId: string): Promise<string[]> {
    const result = await db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(eq(follows.followingId, userId));
    
    return result.map(r => r.followerId);
  }

  // Venue methods
  async getVenues(): Promise<Venue[]> {
    return await db.select().from(venues).orderBy(desc(venues.createdAt));
  }

  async getVenue(id: string): Promise<(Venue & { owner: User }) | undefined> {
    const result = await db
      .select()
      .from(venues)
      .innerJoin(users, eq(venues.ownerId, users.id))
      .where(eq(venues.id, id));
    
    if (!result[0]) return undefined;
    
    const { passwordHash, ...userWithoutPassword } = result[0].users;
    return {
      ...result[0].venues,
      owner: userWithoutPassword as User,
    };
  }

  async getVenuesByOwner(ownerId: string): Promise<Venue[]> {
    return await db
      .select()
      .from(venues)
      .where(eq(venues.ownerId, ownerId))
      .orderBy(desc(venues.createdAt));
  }

  async createVenue(venue: InsertVenue): Promise<Venue> {
    const result = await db.insert(venues).values(venue).returning();
    return result[0];
  }

  async updateVenue(id: string, venueUpdate: Partial<InsertVenue>): Promise<Venue> {
    const result = await db.update(venues).set({
      ...venueUpdate,
      updatedAt: new Date(),
    }).where(eq(venues.id, id)).returning();
    return result[0];
  }

  async verifyVenue(id: string, isVerified: boolean): Promise<Venue> {
    const result = await db.update(venues).set({ isVerified, updatedAt: new Date() }).where(eq(venues.id, id)).returning();
    return result[0];
  }

  async deleteVenue(id: string): Promise<void> {
    await db.delete(venues).where(eq(venues.id, id));
  }

  async getPromotedVenues(): Promise<Venue[]> {
    const now = new Date();
    return await db
      .select()
      .from(venues)
      .where(and(eq(venues.isPromoted, true), gte(venues.promotedUntil, now)))
      .orderBy(desc(venues.promotedUntil));
  }

  async promoteVenue(venueId: string, durationDays: number): Promise<Venue> {
    const promotedUntil = new Date();
    promotedUntil.setDate(promotedUntil.getDate() + durationDays);
    
    const result = await db
      .update(venues)
      .set({ isPromoted: true, promotedUntil })
      .where(eq(venues.id, venueId))
      .returning();

    return result[0];
  }

  async claimFreePromotionCredit(userId: string): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ freePromotionCredits: sql`${users.freePromotionCredits} - 1` })
      .where(and(eq(users.id, userId), gt(users.freePromotionCredits, 0)))
      .returning({ id: users.id });
    return result.length > 0;
  }

  async setUserPromotionCredits(userId: string, credits: number): Promise<User> {
    const result = await db
      .update(users)
      .set({ freePromotionCredits: credits })
      .where(eq(users.id, userId))
      .returning();
    return result[0];
  }

  // Venue entry nights methods
  async getVenueEntryNights(venueId: string): Promise<VenueEntryNight[]> {
    return await db
      .select()
      .from(venueEntryNights)
      .where(eq(venueEntryNights.venueId, venueId))
      .orderBy(desc(venueEntryNights.date));
  }

  async getUpcomingVenueEntryNights(venueId: string): Promise<VenueEntryNight[]> {
    const now = new Date();
    return await db
      .select()
      .from(venueEntryNights)
      .where(and(
        eq(venueEntryNights.venueId, venueId),
        gte(venueEntryNights.date, now),
        eq(venueEntryNights.isActive, true)
      ))
      .orderBy(venueEntryNights.date);
  }

  async getVenueEntryNight(id: string): Promise<VenueEntryNight | undefined> {
    const result = await db.select().from(venueEntryNights).where(eq(venueEntryNights.id, id));
    return result[0];
  }

  async createVenueEntryNight(entryNight: InsertVenueEntryNight): Promise<VenueEntryNight> {
    const result = await db.insert(venueEntryNights).values(entryNight).returning();
    return result[0];
  }

  async updateVenueEntryNight(id: string, entryNight: Partial<InsertVenueEntryNight>): Promise<VenueEntryNight> {
    const result = await db.update(venueEntryNights).set(entryNight).where(eq(venueEntryNights.id, id)).returning();
    return result[0];
  }

  async deleteVenueEntryNight(id: string): Promise<void> {
    await db.delete(venueEntryNights).where(eq(venueEntryNights.id, id));
  }

  async getVenueEventWithVenue(id: string): Promise<(VenueEntryNight & { venue: Venue }) | undefined> {
    const result = await db
      .select()
      .from(venueEntryNights)
      .innerJoin(venues, eq(venueEntryNights.venueId, venues.id))
      .where(eq(venueEntryNights.id, id));
    if (!result[0]) return undefined;
    return { ...result[0].venue_entry_nights, venue: result[0].venues };
  }

  async getUpcomingAllVenueEvents(): Promise<Array<VenueEntryNight & { venue: Venue }>> {
    const now = new Date();
    const result = await db
      .select()
      .from(venueEntryNights)
      .innerJoin(venues, eq(venueEntryNights.venueId, venues.id))
      .where(and(
        gte(venueEntryNights.date, now),
        eq(venueEntryNights.isActive, true),
        eq(venueEntryNights.moderationStatus, 'approved')
      ))
      .orderBy(venueEntryNights.date)
      .limit(20);
    return result.map(r => ({ ...r.venue_entry_nights, venue: r.venues }));
  }

  // Venue tickets methods
  async getUserVenueTickets(userId: string): Promise<Array<VenueTicket & { entryNight: VenueEntryNight; venue: Venue }>> {
    const result = await db
      .select()
      .from(venueTickets)
      .innerJoin(venueEntryNights, eq(venueTickets.venueEntryNightId, venueEntryNights.id))
      .innerJoin(venues, eq(venueEntryNights.venueId, venues.id))
      .where(eq(venueTickets.userId, userId))
      .orderBy(desc(venueTickets.purchaseDate));
    
    return result.map(r => ({
      ...r.venue_tickets,
      entryNight: r.venue_entry_nights,
      venue: r.venues,
    }));
  }

  async getVenueTicket(id: string): Promise<VenueTicket | undefined> {
    const result = await db.select().from(venueTickets).where(eq(venueTickets.id, id));
    return result[0];
  }

  async getVenueTicketByValidationCode(validationCode: string): Promise<VenueTicket | undefined> {
    const result = await db.select().from(venueTickets).where(eq(venueTickets.validationCode, validationCode));
    return result[0];
  }

  async createVenueTicket(ticket: InsertVenueTicket): Promise<VenueTicket> {
    const result = await db.insert(venueTickets).values(ticket).returning();
    return result[0];
  }

  async checkInVenueTicket(ticketId: string, scannerId: string): Promise<VenueTicket | null> {
    const result = await db
      .update(venueTickets)
      .set({
        checkedInAt: new Date(),
        checkedInBy: scannerId,
        status: 'checked_in',
      })
      .where(and(eq(venueTickets.id, ticketId), isNull(venueTickets.checkedInAt)))
      .returning();
    return result[0] ?? null;
  }

  async incrementVenueEntryNightTicketsSold(entryNightId: string): Promise<void> {
    await db
      .update(venueEntryNights)
      .set({ ticketsSold: sql`${venueEntryNights.ticketsSold} + 1` })
      .where(eq(venueEntryNights.id, entryNightId));
  }

  async claimVenueTicketSlot(entryNightId: string): Promise<boolean> {
    const result = await db
      .update(venueEntryNights)
      .set({ ticketsSold: sql`${venueEntryNights.ticketsSold} + 1` })
      .where(and(
        eq(venueEntryNights.id, entryNightId),
        or(
          isNull(venueEntryNights.capacity),
          gt(venueEntryNights.capacity, venueEntryNights.ticketsSold)
        )
      ))
      .returning({ id: venueEntryNights.id });
    return result.length > 0;
  }

  // Atomic oversell guard for event tickets. Mirrors claimVenueTicketSlot exactly:
  // a single conditional UPDATE means two concurrent buyers racing for the last slot
  // can't both succeed. Tiered events track capacity on ticket_tiers.sold; events with
  // no tiers track it on events.tickets_sold.
  async claimEventTicketSlot(eventId: string, ticketTierId: string | null, quantity: number = 1): Promise<boolean> {
    if (ticketTierId) {
      const result = await db
        .update(ticketTiers)
        .set({ sold: sql`${ticketTiers.sold} + ${quantity}` })
        .where(and(
          eq(ticketTiers.id, ticketTierId),
          eq(ticketTiers.eventId, eventId),
          gte(ticketTiers.quantity, sql`${ticketTiers.sold} + ${quantity}`)
        ))
        .returning({ id: ticketTiers.id });
      return result.length > 0;
    }

    const result = await db
      .update(events)
      .set({ ticketsSold: sql`${events.ticketsSold} + ${quantity}` })
      .where(and(
        eq(events.id, eventId),
        gte(events.ticketsAvailable, sql`${events.ticketsSold} + ${quantity}`)
      ))
      .returning({ id: events.id });
    return result.length > 0;
  }

  async getVenueEventCheckIns(venueEntryNightId: string): Promise<Array<VenueTicket & { user: User }>> {
    const result = await db
      .select()
      .from(venueTickets)
      .innerJoin(users, eq(venueTickets.userId, users.id))
      .where(eq(venueTickets.venueEntryNightId, venueEntryNightId))
      .orderBy(desc(venueTickets.purchaseDate));
    return result.map(r => ({ ...r.venue_tickets, user: r.users }));
  }

  async createVenueStaffCode(venueEntryNightId: string, organizerId: string, expiresAt: Date): Promise<VenueStaffAccessCode> {
    const code = crypto.randomBytes(32).toString("hex");
    const result = await db
      .insert(venueStaffAccessCodes)
      .values({ venueEntryNightId, organizerId, code, expiresAt })
      .returning();
    return result[0];
  }

  async getVenueStaffCodeByCode(code: string): Promise<VenueStaffAccessCode | undefined> {
    const result = await db
      .select()
      .from(venueStaffAccessCodes)
      .where(eq(venueStaffAccessCodes.code, code));
    return result[0];
  }

  async redeemVenueStaffCode(id: string, staffName: string, ip: string, ua: string, scannerToken: string): Promise<VenueStaffAccessCode> {
    const result = await db
      .update(venueStaffAccessCodes)
      .set({
        status: "active",
        scannerToken,
        validatedBy: staffName,
        validatedDeviceIp: ip,
        validatedDeviceUa: ua,
        redeemedAt: new Date(),
      })
      .where(and(eq(venueStaffAccessCodes.id, id), eq(venueStaffAccessCodes.status, "pending")))
      .returning();
    if (!result[0]) throw new Error("Code already redeemed or revoked");
    return result[0];
  }

  async getVenueStaffCodeByScannerToken(token: string): Promise<VenueStaffAccessCode | undefined> {
    const result = await db
      .select()
      .from(venueStaffAccessCodes)
      .where(eq(venueStaffAccessCodes.scannerToken, token));
    return result[0];
  }

  async getVenueEntryNightStaffCodes(venueEntryNightId: string, organizerId: string): Promise<VenueStaffAccessCode[]> {
    return db
      .select()
      .from(venueStaffAccessCodes)
      .where(and(
        eq(venueStaffAccessCodes.venueEntryNightId, venueEntryNightId),
        eq(venueStaffAccessCodes.organizerId, organizerId),
      ))
      .orderBy(desc(venueStaffAccessCodes.createdAt));
  }

  async revokeVenueStaffCode(id: string, organizerId: string): Promise<void> {
    await db
      .update(venueStaffAccessCodes)
      .set({ status: "revoked" })
      .where(and(eq(venueStaffAccessCodes.id, id), eq(venueStaffAccessCodes.organizerId, organizerId)));
  }

  async incrementVenueStaffCodeScanCount(id: string): Promise<void> {
    await db
      .update(venueStaffAccessCodes)
      .set({ scanCount: sql`${venueStaffAccessCodes.scanCount} + 1` })
      .where(eq(venueStaffAccessCodes.id, id));
  }


  // Venue analytics methods
  async trackVenueView(venueId: string, userId?: string): Promise<void> {
    await db.insert(venueAnalytics).values({
      venueId,
      userId: userId || null,
      actionType: 'view',
    });
  }

  async trackVenueClick(venueId: string, actionType: string, userId?: string): Promise<void> {
    await db.insert(venueAnalytics).values({
      venueId,
      userId: userId || null,
      actionType,
    });
  }

  async getVenueAnalytics(venueId: string): Promise<{ views: number; clicks: number; ticketsSold: number }> {
    const viewsResult = await db
      .select({ count: count() })
      .from(venueAnalytics)
      .where(and(eq(venueAnalytics.venueId, venueId), eq(venueAnalytics.actionType, 'view')));
    
    const clicksResult = await db
      .select({ count: count() })
      .from(venueAnalytics)
      .where(and(eq(venueAnalytics.venueId, venueId), eq(venueAnalytics.actionType, 'click')));
    
    const ticketsResult = await db
      .select({ total: sql<number>`COALESCE(SUM(${venueEntryNights.ticketsSold}), 0)` })
      .from(venueEntryNights)
      .where(eq(venueEntryNights.venueId, venueId));
    
    return {
      views: viewsResult[0]?.count || 0,
      clicks: clicksResult[0]?.count || 0,
      ticketsSold: Number(ticketsResult[0]?.total) || 0,
    };
  }

  async getOrganizerDemographics(organizerId: string, options?: { startDate?: Date; endDate?: Date }): Promise<{
    totalEvents: number;
    totalRsvps: number;
    totalTicketsSold: number;
    totalViews: number;
    totalRevenue: number;
    ageDistribution: { ageGroup: string; count: number; percentage: number }[];
    genderDistribution: { gender: string; count: number; percentage: number }[];
    eventBreakdown: {
      eventId: string;
      title: string;
      rsvps: number;
      tickets: number;
      views: number;
      revenue: number;
      currency: string;
      ticketPrice: number;
      capacity: number;
      eventDate: string;
      isFree: boolean;
    }[];
    ticketSalesByAge: { ageGroup: string; tickets: number; revenue: number; percentage: number }[];
    ticketSalesByGender: { gender: string; tickets: number; revenue: number; percentage: number }[];
    averageTicketPrice: number;
    bestSellingEvent: { title: string; tickets: number; revenue: number; currency: string } | null;
    conversionRate: number;
  }> {
    const { startDate, endDate } = options ?? {};

    // Always return all organizer events regardless of date filter —
    // the date range applies to activity (views, RSVPs, ticket purchases), not event existence.
    const organizerEvents = await db.select().from(events).where(eq(events.organizerId, organizerId));

    if (organizerEvents.length === 0) {
      return {
        totalEvents: 0,
        totalRsvps: 0,
        totalTicketsSold: 0,
        totalViews: 0,
        totalRevenue: 0,
        ageDistribution: [],
        genderDistribution: [],
        eventBreakdown: [],
        ticketSalesByAge: [],
        ticketSalesByGender: [],
        averageTicketPrice: 0,
        bestSellingEvent: null,
        conversionRate: 0,
      };
    }

    const eventIds = organizerEvents.map(e => e.id);
    const now = new Date();

    // Build date conditions for each activity table
    const rsvpDateFilters = [
      ...(startDate ? [gte(rsvps.rsvpDate, startDate)] : []),
      ...(endDate ? [lt(rsvps.rsvpDate, endDate)] : []),
    ];
    const ticketDateFilters = [
      ...(startDate ? [gte(tickets.purchaseDate, startDate)] : []),
      ...(endDate ? [lt(tickets.purchaseDate, endDate)] : []),
    ];
    const analyticDateFilters = [
      ...(startDate ? [gte(eventAnalytics.createdAt, startDate)] : []),
      ...(endDate ? [lt(eventAnalytics.createdAt, endDate)] : []),
    ];

    // Attendees: union of RSVP + ticket user IDs within the date window
    const rsvpUsers = await db
      .select({ userId: rsvps.userId })
      .from(rsvps)
      .where(and(inArray(rsvps.eventId, eventIds), ...rsvpDateFilters));

    const ticketUsers = await db
      .select({ userId: tickets.userId })
      .from(tickets)
      .where(and(
        inArray(tickets.eventId, eventIds),
        eq(tickets.status, 'confirmed'),
        ...ticketDateFilters,
      ));

    const userIdSet = new Set<string>();
    rsvpUsers.forEach(r => userIdSet.add(r.userId));
    ticketUsers.forEach(t => userIdSet.add(t.userId));
    const allUserIds = Array.from(userIdSet);

    let userDemographics: { dateOfBirth: string | null; gender: string | null }[] = [];
    if (allUserIds.length > 0) {
      userDemographics = await db
        .select({ dateOfBirth: users.dateOfBirth, gender: users.gender })
        .from(users)
        .where(inArray(users.id, allUserIds));
    }

    // Age distribution across unique attendees
    const ageGroups: Record<string, number> = {
      'Under 18': 0,
      '18-25': 0,
      '26-35': 0,
      '36-45': 0,
      '45+': 0,
      'Unknown': 0,
    };

    userDemographics.forEach(user => {
      if (!user.dateOfBirth) { ageGroups['Unknown']++; return; }
      const age = Math.floor((now.getTime() - new Date(user.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 18) ageGroups['Under 18']++;
      else if (age <= 25) ageGroups['18-25']++;
      else if (age <= 35) ageGroups['26-35']++;
      else if (age <= 45) ageGroups['36-45']++;
      else ageGroups['45+']++;
    });

    const totalUsers = userDemographics.length;
    const ageDistribution = Object.entries(ageGroups)
      .filter(([, c]) => c > 0)
      .map(([ageGroup, c]) => ({
        ageGroup,
        count: c,
        percentage: totalUsers > 0 ? Math.round((c / totalUsers) * 100) : 0,
      }));

    // Gender distribution
    const genderGroups: Record<string, number> = { 'Male': 0, 'Female': 0, 'Rather not say': 0, 'Unknown': 0 };
    userDemographics.forEach(user => {
      const g = user.gender || 'Unknown';
      genderGroups[g] !== undefined ? genderGroups[g]++ : genderGroups['Unknown']++;
    });
    const genderDistribution = Object.entries(genderGroups)
      .filter(([, c]) => c > 0)
      .map(([gender, c]) => ({
        gender,
        count: c,
        percentage: totalUsers > 0 ? Math.round((c / totalUsers) * 100) : 0,
      }));

    const totalRsvps = rsvpUsers.length;
    const totalTicketsSold = ticketUsers.length;

    // Total views within date window
    const viewsResult = await db
      .select({ count: count() })
      .from(eventAnalytics)
      .where(and(
        inArray(eventAnalytics.eventId, eventIds),
        eq(eventAnalytics.actionType, 'view'),
        ...analyticDateFilters,
      ));
    const totalViews = viewsResult[0]?.count || 0;

    // Per-event breakdown — use actual amountPaid for accurate revenue
    const eventBreakdown = await Promise.all(
      organizerEvents.map(async (event) => {
        const [evtRsvps, evtTickets, evtRevenue, evtViews] = await Promise.all([
          db.select({ count: count() })
            .from(rsvps)
            .where(and(eq(rsvps.eventId, event.id), ...rsvpDateFilters)),

          db.select({ count: count() })
            .from(tickets)
            .where(and(eq(tickets.eventId, event.id), eq(tickets.status, 'confirmed'), ...ticketDateFilters)),

          db.select({ total: sql<number>`coalesce(sum(${tickets.amountPaid}), 0)` })
            .from(tickets)
            .where(and(eq(tickets.eventId, event.id), eq(tickets.status, 'confirmed'), ...ticketDateFilters)),

          db.select({ count: count() })
            .from(eventAnalytics)
            .where(and(
              eq(eventAnalytics.eventId, event.id),
              eq(eventAnalytics.actionType, 'view'),
              ...analyticDateFilters,
            )),
        ]);

        return {
          eventId: event.id,
          title: event.title,
          rsvps: evtRsvps[0]?.count || 0,
          tickets: evtTickets[0]?.count || 0,
          views: evtViews[0]?.count || 0,
          revenue: Number(evtRevenue[0]?.total) || 0,
          currency: event.currency,
          ticketPrice: event.ticketPrice || 0,
          capacity: event.ticketsAvailable || 0,
          eventDate: event.eventDate.toISOString(),
          isFree: (event.ticketPrice ?? 0) === 0,
        };
      })
    );

    // Ticket purchases joined with demographics for segmentation
    const ticketPurchasesWithDemos = await db
      .select({
        eventId: tickets.eventId,
        amountPaid: tickets.amountPaid,
        dateOfBirth: users.dateOfBirth,
        gender: users.gender,
      })
      .from(tickets)
      .innerJoin(users, eq(tickets.userId, users.id))
      .where(and(
        inArray(tickets.eventId, eventIds),
        eq(tickets.status, 'confirmed'),
        ...ticketDateFilters,
      ));

    // Ticket sales by age — use amountPaid per row for revenue accuracy
    const ticketsByAge: Record<string, { tickets: number; revenue: number }> = {
      'Under 18': { tickets: 0, revenue: 0 },
      '18-25': { tickets: 0, revenue: 0 },
      '26-35': { tickets: 0, revenue: 0 },
      '36-45': { tickets: 0, revenue: 0 },
      '45+': { tickets: 0, revenue: 0 },
      'Unknown': { tickets: 0, revenue: 0 },
    };

    ticketPurchasesWithDemos.forEach(p => {
      let ageGroup = 'Unknown';
      if (p.dateOfBirth) {
        const age = Math.floor((now.getTime() - new Date(p.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        if (age < 18) ageGroup = 'Under 18';
        else if (age <= 25) ageGroup = '18-25';
        else if (age <= 35) ageGroup = '26-35';
        else if (age <= 45) ageGroup = '36-45';
        else ageGroup = '45+';
      }
      ticketsByAge[ageGroup].tickets++;
      ticketsByAge[ageGroup].revenue += p.amountPaid ?? 0;
    });

    const totalTicketPurchases = ticketPurchasesWithDemos.length;
    const ticketSalesByAge = Object.entries(ticketsByAge)
      .filter(([, d]) => d.tickets > 0)
      .map(([ageGroup, d]) => ({
        ageGroup,
        tickets: d.tickets,
        revenue: d.revenue,
        percentage: totalTicketPurchases > 0 ? Math.round((d.tickets / totalTicketPurchases) * 100) : 0,
      }));

    // Ticket sales by gender
    const ticketsByGender: Record<string, { tickets: number; revenue: number }> = {
      'Male': { tickets: 0, revenue: 0 },
      'Female': { tickets: 0, revenue: 0 },
      'Rather not say': { tickets: 0, revenue: 0 },
      'Unknown': { tickets: 0, revenue: 0 },
    };

    ticketPurchasesWithDemos.forEach(p => {
      const g = p.gender || 'Unknown';
      const bucket = ticketsByGender[g] ?? ticketsByGender['Unknown'];
      bucket.tickets++;
      bucket.revenue += p.amountPaid ?? 0;
    });

    const ticketSalesByGender = Object.entries(ticketsByGender)
      .filter(([, d]) => d.tickets > 0)
      .map(([gender, d]) => ({
        gender,
        tickets: d.tickets,
        revenue: d.revenue,
        percentage: totalTicketPurchases > 0 ? Math.round((d.tickets / totalTicketPurchases) * 100) : 0,
      }));

    const calculatedRevenue = eventBreakdown.reduce((sum, e) => sum + e.revenue, 0);
    const paidEvents = eventBreakdown.filter(e => !e.isFree);
    const averageTicketPrice = paidEvents.length > 0
      ? Math.round(paidEvents.reduce((sum, e) => sum + e.ticketPrice, 0) / paidEvents.length)
      : 0;

    const sortedByTickets = [...eventBreakdown].sort((a, b) => b.tickets - a.tickets);
    const bestSellingEvent = sortedByTickets.length > 0 && sortedByTickets[0].tickets > 0
      ? { title: sortedByTickets[0].title, tickets: sortedByTickets[0].tickets, revenue: sortedByTickets[0].revenue, currency: sortedByTickets[0].currency }
      : null;

    // Conversion = (RSVPs + tickets) / views — ticket purchases already unique per user
    const conversionRate = totalViews > 0
      ? Math.round(((totalRsvps + totalTicketsSold) / totalViews) * 1000) / 10
      : 0;

    return {
      totalEvents: organizerEvents.length,
      totalRsvps,
      totalTicketsSold,
      totalViews,
      totalRevenue: calculatedRevenue,
      ageDistribution,
      genderDistribution,
      eventBreakdown,
      ticketSalesByAge,
      ticketSalesByGender,
      averageTicketPrice,
      bestSellingEvent,
      conversionRate,
    };
  }

  // ============================================
  // ADMIN PANEL METHODS
  // ============================================

  async getAdminUser(id: string): Promise<AdminUser | undefined> {
    const result = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
    return result[0];
  }

  async getAdminUserByUsername(username: string): Promise<AdminUser | undefined> {
    const result = await db.select().from(adminUsers).where(eq(adminUsers.username, username));
    return result[0];
  }

  async getAdminUserByEmail(email: string): Promise<AdminUser | undefined> {
    const result = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
    return result[0];
  }

  async getAllAdminUsers(): Promise<AdminUser[]> {
    return await db.select().from(adminUsers).orderBy(desc(adminUsers.createdAt));
  }

  async createAdminUser(admin: InsertAdminUser): Promise<AdminUser> {
    const result = await db.insert(adminUsers).values(admin).returning();
    return result[0];
  }

  async updateAdminUser(id: string, updates: Partial<InsertAdminUser>): Promise<AdminUser> {
    const result = await db.update(adminUsers).set(updates).where(eq(adminUsers.id, id)).returning();
    return result[0];
  }

  async deactivateAdminUser(id: string): Promise<AdminUser> {
    const result = await db.update(adminUsers).set({ isActive: false }).where(eq(adminUsers.id, id)).returning();
    return result[0];
  }

  async updateAdminLastLogin(id: string): Promise<void> {
    await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, id));
  }

  async logAdminActivity(log: InsertAdminActivityLog): Promise<AdminActivityLog> {
    const result = await db.insert(adminActivityLogs).values(log).returning();
    return result[0];
  }

  async getAdminActivityLogs(limit: number = 100): Promise<Array<AdminActivityLog & { admin: AdminUser }>> {
    const result = await db
      .select()
      .from(adminActivityLogs)
      .innerJoin(adminUsers, eq(adminActivityLogs.adminId, adminUsers.id))
      .orderBy(desc(adminActivityLogs.createdAt))
      .limit(limit);
    
    return result.map(r => ({
      ...r.admin_activity_logs,
      admin: r.admin_users,
    }));
  }

  async getAdminUserActivityLogs(adminId: string, limit: number = 50): Promise<AdminActivityLog[]> {
    return await db
      .select()
      .from(adminActivityLogs)
      .where(eq(adminActivityLogs.adminId, adminId))
      .orderBy(desc(adminActivityLogs.createdAt))
      .limit(limit);
  }

  async createContentReport(report: InsertContentReport): Promise<ContentReport> {
    const result = await db.insert(contentReports).values(report).returning();
    return result[0];
  }

  // Thin wrapper over createContentReport that also enforces the auto-flag
  // threshold — 3 DISTINCT reporters (the unique constraint on
  // (reporterId, contentType, contentId) already stops one account from
  // submitting more than one report on the same item, so a raw count here is
  // already a distinct-reporter count).
  async createPostReport(postId: string, reporterId: string, reason: string, description: string | null): Promise<ContentReport> {
    const report = await this.createContentReport({
      reporterId,
      contentType: "post",
      contentId: postId,
      reason,
      description: description ?? undefined,
    });

    const [{ count: reportCount }] = await db
      .select({ count: count() })
      .from(contentReports)
      .where(and(eq(contentReports.contentType, "post"), eq(contentReports.contentId, postId)));

    if (reportCount >= 3) {
      await db.update(posts).set({ moderationStatus: "flagged" }).where(eq(posts.id, postId));
      invalidateCache.posts();
    }

    return report;
  }

  async createCommentReport(commentId: string, reporterId: string, reason: string, description: string | null): Promise<ContentReport> {
    return this.createContentReport({
      reporterId,
      contentType: "comment",
      contentId: commentId,
      reason,
      description: description ?? undefined,
    });
  }

  async getContentReports(status?: string, limit = 50, offset = 0): Promise<Array<ContentReport & { reporter: User }>> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);

    const query = db
      .select()
      .from(contentReports)
      .innerJoin(users, eq(contentReports.reporterId, users.id))
      .orderBy(desc(contentReports.createdAt))
      .limit(safeLimit)
      .offset(safeOffset);

    const results = status
      ? await query.where(eq(contentReports.status, status))
      : await query;

    return results.map(r => ({
      ...r.content_reports,
      reporter: r.users,
    }));
  }

  async getContentReport(id: string): Promise<ContentReport | undefined> {
    const result = await db.select().from(contentReports).where(eq(contentReports.id, id));
    return result[0];
  }

  async updateContentReport(id: string, updates: { status: string; reviewedBy: string; resolution?: string }): Promise<ContentReport> {
    const result = await db
      .update(contentReports)
      .set({ ...updates, reviewedAt: new Date() })
      .where(eq(contentReports.id, id))
      .returning();
    return result[0];
  }

  async suspendUser(suspension: InsertUserSuspension): Promise<UserSuspension> {
    const result = await db.insert(userSuspensions).values(suspension).returning();
    return result[0];
  }

  async getUserSuspensions(userId: string): Promise<UserSuspension[]> {
    return await db
      .select()
      .from(userSuspensions)
      .where(eq(userSuspensions.userId, userId))
      .orderBy(desc(userSuspensions.createdAt));
  }

  async getActiveSuspension(userId: string): Promise<UserSuspension | undefined> {
    const now = new Date();
    const result = await db
      .select()
      .from(userSuspensions)
      .where(
        and(
          eq(userSuspensions.userId, userId),
          eq(userSuspensions.isActive, true),
          or(
            eq(userSuspensions.isPermanent, true),
            isNull(userSuspensions.suspendedUntil),
            gte(userSuspensions.suspendedUntil, now)
          )
        )
      );
    return result[0];
  }

  async getBulkActiveSuspensions(userIds: string[]): Promise<UserSuspension[]> {
    if (userIds.length === 0) return [];
    const now = new Date();
    return await db
      .select()
      .from(userSuspensions)
      .where(
        and(
          inArray(userSuspensions.userId, userIds),
          eq(userSuspensions.isActive, true),
          or(
            eq(userSuspensions.isPermanent, true),
            isNull(userSuspensions.suspendedUntil),
            gte(userSuspensions.suspendedUntil, now)
          )
        )
      );
  }

  async liftSuspension(suspensionId: string): Promise<UserSuspension> {
    const result = await db
      .update(userSuspensions)
      .set({ isActive: false })
      .where(eq(userSuspensions.id, suspensionId))
      .returning();
    return result[0];
  }

  async getAllSuspensions(): Promise<Array<UserSuspension & { user: User; admin: AdminUser }>> {
    const result = await db
      .select()
      .from(userSuspensions)
      .innerJoin(users, eq(userSuspensions.userId, users.id))
      .innerJoin(adminUsers, eq(userSuspensions.adminId, adminUsers.id))
      .orderBy(desc(userSuspensions.createdAt));
    
    return result.map(r => ({
      ...r.user_suspensions,
      user: r.users,
      admin: r.admin_users,
    }));
  }

  async moderateEvent(moderation: InsertEventModeration): Promise<EventModeration> {
    const result = await db.insert(eventModerations).values(moderation).returning();
    await db.update(events).set({ moderationStatus: moderation.action }).where(eq(events.id, moderation.eventId));
    return result[0];
  }

  async moderateVenueEvent(venueEntryNightId: string, action: string): Promise<void> {
    await db.update(venueEntryNights).set({ moderationStatus: action }).where(eq(venueEntryNights.id, venueEntryNightId));
  }

  async getEventModerations(eventId: string): Promise<Array<EventModeration & { admin: AdminUser }>> {
    const result = await db
      .select()
      .from(eventModerations)
      .innerJoin(adminUsers, eq(eventModerations.adminId, adminUsers.id))
      .where(eq(eventModerations.eventId, eventId))
      .orderBy(desc(eventModerations.createdAt));
    
    return result.map(r => ({
      ...r.event_moderations,
      admin: r.admin_users,
    }));
  }

  async getAllEventModerations(): Promise<Array<EventModeration & { event: Event; admin: AdminUser }>> {
    const result = await db
      .select()
      .from(eventModerations)
      .innerJoin(events, eq(eventModerations.eventId, events.id))
      .innerJoin(adminUsers, eq(eventModerations.adminId, adminUsers.id))
      .orderBy(desc(eventModerations.createdAt));
    
    return result.map(r => ({
      ...r.event_moderations,
      event: r.events,
      admin: r.admin_users,
    }));
  }

  async getPlatformStats(): Promise<{
    totalUsers: number;
    totalEvents: number;
    totalTicketsSold: number;
    totalVenueTicketsSold: number;
    revenueByCurrency: Array<{
      currency: string;
      ticketsSold: number;
      ticketRevenue: number;
      venueTicketsSold: number;
      venueRevenue: number;
      totalRevenue: number;
    }>;
    activeUsers: number;
    newUsersToday: number;
    pendingReports: number;
    activeOrganizers: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [userCount] = await db.select({ count: count() }).from(users);
    const [eventCount] = await db.select({ count: count() }).from(events);
    // "Sold" means actually paid and not refunded — count only confirmed tickets.
    const [ticketCount] = await db.select({ count: count() }).from(tickets).where(eq(tickets.status, 'confirmed'));
    const [venueTicketCount] = await db.select({ count: count() }).from(venueTickets).where(eq(venueTickets.status, 'confirmed'));
    const [pendingReportCount] = await db.select({ count: count() }).from(contentReports).where(eq(contentReports.status, 'pending'));
    const [newUserCount] = await db.select({ count: count() }).from(users).where(gte(users.createdAt, today));
    const [organizerCount] = await db.select({ count: count() }).from(users).where(eq(users.userType, 'organizer'));
    const [verifiedCount] = await db.select({ count: count() }).from(users).where(eq(users.isVerified, true));

    // Revenue must use what was actually charged (tickets.amountPaid), never the
    // event's current listed price — and GBP pence / NGN kobo can never be summed
    // together, so this is grouped by currency instead of collapsed to one number.
    const ticketRevenueByCurrency = await db
      .select({
        currency: tickets.currency,
        ticketsSold: sql<number>`count(*)::int`,
        ticketRevenue: sql<number>`coalesce(sum(${tickets.amountPaid}), 0)::int`,
      })
      .from(tickets)
      .where(eq(tickets.status, 'confirmed'))
      .groupBy(tickets.currency);

    const venueRevenueByCurrency = await db
      .select({
        currency: venueTickets.currency,
        venueTicketsSold: sql<number>`count(*)::int`,
        venueRevenue: sql<number>`coalesce(sum(${venueTickets.amountPaid}), 0)::int`,
      })
      .from(venueTickets)
      .where(eq(venueTickets.status, 'confirmed'))
      .groupBy(venueTickets.currency);

    const currencies = Array.from(new Set([
      ...ticketRevenueByCurrency.map(r => r.currency),
      ...venueRevenueByCurrency.map(r => r.currency),
    ]));

    const revenueByCurrency = currencies.map(currency => {
      const t = ticketRevenueByCurrency.find(r => r.currency === currency);
      const v = venueRevenueByCurrency.find(r => r.currency === currency);
      const ticketRevenue = Number(t?.ticketRevenue || 0);
      const venueRevenue = Number(v?.venueRevenue || 0);
      return {
        currency,
        ticketsSold: Number(t?.ticketsSold || 0),
        ticketRevenue,
        venueTicketsSold: Number(v?.venueTicketsSold || 0),
        venueRevenue,
        totalRevenue: ticketRevenue + venueRevenue,
      };
    });

    return {
      totalUsers: Number(userCount?.count || 0),
      totalEvents: Number(eventCount?.count || 0),
      totalTicketsSold: Number(ticketCount?.count || 0),
      totalVenueTicketsSold: Number(venueTicketCount?.count || 0),
      revenueByCurrency,
      activeUsers: Number(verifiedCount?.count || 0),
      newUsersToday: Number(newUserCount?.count || 0),
      pendingReports: Number(pendingReportCount?.count || 0),
      activeOrganizers: Number(organizerCount?.count || 0),
    };
  }

  async getAllUsers(limit: number = 50, offset: number = 0): Promise<User[]> {
    return await db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getUserCount(): Promise<number> {
    const [result] = await db.select({ count: count() }).from(users);
    return Number(result?.count || 0);
  }

  async deleteUser(id: string): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  async getAllEventsAdmin(limit: number = 50, offset: number = 0): Promise<Array<Event & { organizer: User; moderationStatus: string; sourceType: 'event' | 'venue_entry' }>> {
    const eventRows = await db
      .select()
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .orderBy(desc(events.eventDate))
      .limit(limit)
      .offset(offset);

    const venueRows = await db
      .select({
        venueEntry: venueEntryNights,
        venue: venues,
        organizer: users,
      })
      .from(venueEntryNights)
      .innerJoin(venues, eq(venueEntryNights.venueId, venues.id))
      .innerJoin(users, eq(venues.ownerId, users.id))
      .orderBy(desc(venueEntryNights.date))
      .limit(limit)
      .offset(offset);

    const mappedEvents = eventRows.map(r => ({
      ...r.events,
      organizer: r.users,
      moderationStatus: r.events.moderationStatus,
      sourceType: 'event' as const,
    }));

    const mappedVenueEntries = venueRows.map(r => ({
      id: r.venueEntry.id,
      organizerId: r.venue.ownerId,
      title: `[Venue] ${r.venueEntry.name}`,
      description: r.venueEntry.description || '',
      eventDate: r.venueEntry.date,
      eventEndDate: r.venueEntry.endTime ?? null,
      location: r.venue.address || r.venue.name,
      city: r.venue.city ?? null,
      latitude: null,
      longitude: null,
      category: 'venue',
      ticketPrice: r.venueEntry.coverPriceCents,
      currency: 'GBP',
      requiresRSVP: false,
      ticketsAvailable: r.venueEntry.capacity ?? 0,
      ticketsSold: r.venueEntry.ticketsSold,
      imageUrl: r.venueEntry.imageUrl ?? null,
      externalTicketUrl: null,
      isPromoted: false,
      promotedUntil: null,
      isPublished: r.venueEntry.isActive,
      moderationStatus: r.venueEntry.moderationStatus,
      isCancelled: false,
      cancelledAt: null,
      feePassthroughToBuyer: r.venueEntry.feePassthroughToBuyer,
      communityId: null,
      organizer: r.organizer,
      sourceType: 'venue_entry' as const,
    }));

    return [...mappedEvents, ...mappedVenueEntries].sort(
      (a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime()
    );
  }

  async deleteEvent(id: string): Promise<void> {
    // Null out nullable FK references so related records (posts, messages, etc.) survive
    await db.update(posts).set({ eventId: null }).where(eq(posts.eventId, id));
    await db.update(messages).set({ eventId: null }).where(eq(messages.eventId, id));
    await db.update(conversationMessages).set({ eventId: null }).where(eq(conversationMessages.eventId, id));
    await db.update(pollOptions).set({ eventId: null }).where(eq(pollOptions.eventId, id));
    // Delete NOT-NULL FK-constrained children (no cascade configured)
    await db.delete(eventModerations).where(eq(eventModerations.eventId, id));
    await db.delete(rsvps).where(eq(rsvps.eventId, id));
    await db.delete(tickets).where(eq(tickets.eventId, id));
    // Delete the event — ticket_tiers cascade automatically
    await db.delete(events).where(eq(events.id, id));
    invalidateCache.events();
  }

  // Confirmed (i.e. paid-and-not-yet-refunded) tickets for an event — used by the
  // cancel-event flow to know who needs a refund and a notification.
  async getConfirmedTicketsForEvent(eventId: string): Promise<Ticket[]> {
    return await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.eventId, eventId), eq(tickets.status, 'confirmed')));
  }

  // Soft-cancel: keeps the event row (and its tickets) so refunds and history survive.
  // Use instead of deleteEvent() whenever the event has confirmed tickets.
  async markEventCancelled(eventId: string): Promise<Event> {
    const result = await db
      .update(events)
      .set({ isCancelled: true, isPublished: false, cancelledAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();
    invalidateCache.events();
    return result[0];
  }

  async markTicketRefunded(ticketId: string): Promise<void> {
    await db.update(tickets).set({ status: 'refunded' }).where(eq(tickets.id, ticketId));
  }

  async createPaymentIssue(issue: InsertPaymentIssue): Promise<PaymentIssue> {
    const result = await db.insert(paymentIssues).values(issue).returning();
    return result[0];
  }

  async getPlatformCommissionBps(): Promise<number> {
    const result = await db.select().from(platformSettings).where(eq(platformSettings.id, "default"));
    return result[0]?.commissionBps ?? 1000;
  }

  async setPlatformCommissionBps(commissionBps: number, updatedBy: string): Promise<PlatformSettings> {
    const result = await db
      .insert(platformSettings)
      .values({ id: "default", commissionBps, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.id,
        set: { commissionBps, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return result[0];
  }

  async getOrganizerPaymentAccount(userId: string, provider: "stripe" | "paystack"): Promise<OrganizerPaymentAccount | undefined> {
    const result = await db
      .select()
      .from(organizerPaymentAccounts)
      .where(and(eq(organizerPaymentAccounts.userId, userId), eq(organizerPaymentAccounts.provider, provider)));
    return result[0];
  }

  async upsertOrganizerPaymentAccount(account: InsertOrganizerPaymentAccount): Promise<OrganizerPaymentAccount> {
    const result = await db
      .insert(organizerPaymentAccounts)
      .values(account)
      .onConflictDoUpdate({
        target: [organizerPaymentAccounts.userId, organizerPaymentAccounts.provider],
        set: { ...account, updatedAt: new Date() },
      })
      .returning();
    return result[0];
  }

  async createPaymentTransaction(tx: InsertPaymentTransaction): Promise<PaymentTransaction> {
    const result = await db.insert(paymentTransactions).values(tx).returning();
    return result[0];
  }

  // Payout history for the organizer payouts page — every ledger row for
  // this organizer regardless of provider (Stripe + Paystack together), most
  // recent first.
  async getOrganizerTransactions(organizerId: string, limit: number = 50, offset: number = 0): Promise<PaymentTransaction[]> {
    return await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.organizerId, organizerId))
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getAllStoriesAdmin(limit: number = 50): Promise<Array<Story & { user: User }>> {
    const result = await db
      .select()
      .from(stories)
      .innerJoin(users, eq(stories.userId, users.id))
      .orderBy(desc(stories.createdAt))
      .limit(limit);
    
    return result.map(r => ({
      ...r.stories,
      user: r.users,
    }));
  }

  async deleteStoryAdmin(id: string): Promise<void> {
    await db.delete(stories).where(eq(stories.id, id));
    invalidateCache.stories();
  }

  // ============================================
  // NOTIFICATIONS
  // ============================================

  async createNotification(notification: InsertNotification): Promise<Notification> {
    const result = await db.insert(notifications).values(notification).returning();
    return result[0];
  }

  async getUserNotifications(userId: string, limit: number = 50): Promise<Array<Notification & { relatedUser: User | null }>> {
    const result = await db
      .select()
      .from(notifications)
      .leftJoin(users, eq(notifications.relatedUserId, users.id))
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    
    return result.map(r => ({
      ...r.notifications,
      relatedUser: r.users || null,
    }));
  }

  async getUnreadNotificationCount(userId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      ));
    return Number(result?.count || 0);
  }

  async markNotificationAsRead(id: string): Promise<Notification> {
    const result = await db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.id, id))
      .returning();
    return result[0];
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.userId, userId));
  }

  async deleteNotification(id: string): Promise<void> {
    await db.delete(notifications).where(eq(notifications.id, id));
  }

  // ============================================
  // COMMUNITY METHODS
  // ============================================

  async createCommunity(community: InsertCommunity): Promise<Community> {
    const result = await db.insert(communities).values(community).returning();
    return result[0];
  }

  async getCommunity(id: string): Promise<Community | undefined> {
    const result = await db.select().from(communities).where(eq(communities.id, id));
    return result[0];
  }

  async getCommunityBySlug(slug: string): Promise<Community | undefined> {
    const result = await db.select().from(communities).where(eq(communities.slug, slug));
    return result[0];
  }

  async getCommunities(): Promise<Array<Community & { memberCount: number; creator: User }>> {
    const result = await db
      .select({
        community: communities,
        creator: users,
        memberCount: sql<number>`(SELECT COUNT(*) FROM community_memberships WHERE community_id = ${communities.id})::int`,
      })
      .from(communities)
      .innerJoin(users, eq(communities.createdByUserId, users.id))
      .orderBy(desc(communities.createdAt));
    
    // Pre-existing gap caught while testing this session's other community
    // work: this returned the full users row — passwordHash included — to
    // any caller of the public GET /api/communities endpoint. Strip it here
    // rather than trusting every route to remember to.
    return result.map(r => {
      const { passwordHash, ...creatorWithoutPassword } = r.creator;
      return {
        ...r.community,
        memberCount: r.memberCount,
        creator: creatorWithoutPassword as User,
      };
    });
  }

  async getUserCommunities(userId: string): Promise<Array<Community & { memberCount: number; role: string }>> {
    const result = await db
      .select({
        community: communities,
        membership: communityMemberships,
        memberCount: sql<number>`(SELECT COUNT(*) FROM community_memberships WHERE community_id = ${communities.id})::int`,
      })
      .from(communityMemberships)
      .innerJoin(communities, eq(communityMemberships.communityId, communities.id))
      .where(eq(communityMemberships.userId, userId))
      .orderBy(desc(communityMemberships.joinedAt));
    
    return result.map(r => ({
      ...r.community,
      memberCount: r.memberCount,
      role: r.membership.role,
    }));
  }

  async updateCommunity(id: string, updates: Partial<InsertCommunity>): Promise<Community> {
    const result = await db
      .update(communities)
      .set(updates)
      .where(eq(communities.id, id))
      .returning();
    return result[0];
  }

  async deleteCommunity(id: string): Promise<void> {
    await db.delete(communities).where(eq(communities.id, id));
  }

  async joinCommunity(userId: string, communityId: string, role: string = "member"): Promise<CommunityMembership> {
    const result = await db
      .insert(communityMemberships)
      .values({ userId, communityId, role })
      .returning();
    return result[0];
  }

  async leaveCommunity(userId: string, communityId: string): Promise<void> {
    await db
      .delete(communityMemberships)
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ));
  }

  async isCommunityMember(userId: string, communityId: string): Promise<boolean> {
    const result = await db
      .select()
      .from(communityMemberships)
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ));
    return result.length > 0;
  }

  async getCommunityMembers(communityId: string, limit: number = 50, offset: number = 0): Promise<Array<CommunityMembership & { user: User }>> {
    const result = await db
      .select({
        membership: communityMemberships,
        user: users,
      })
      .from(communityMemberships)
      .innerJoin(users, eq(communityMemberships.userId, users.id))
      .where(eq(communityMemberships.communityId, communityId))
      .orderBy(desc(communityMemberships.joinedAt))
      .limit(limit)
      .offset(offset);

    // Same passwordHash-leak class as getCommunities() above — this backs
    // the public GET /api/communities/:id/members endpoint.
    return result.map(r => {
      const { passwordHash, ...userWithoutPassword } = r.user;
      return {
        ...r.membership,
        user: userWithoutPassword as User,
      };
    });
  }

  async getCommunityMemberIds(communityId: string): Promise<string[]> {
    const result = await db
      .select({ userId: communityMemberships.userId })
      .from(communityMemberships)
      .where(and(
        eq(communityMemberships.communityId, communityId),
        eq(communityMemberships.notificationsEnabled, true)
      ));
    return result.map(r => r.userId);
  }

  async setCommunityNotifications(userId: string, communityId: string, enabled: boolean): Promise<void> {
    await db
      .update(communityMemberships)
      .set({ notificationsEnabled: enabled })
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ));
  }

  async getCommunityMembership(userId: string, communityId: string): Promise<CommunityMembership | undefined> {
    const result = await db
      .select()
      .from(communityMemberships)
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ));
    return result[0];
  }

  // postType is derived, not a stored column — matches the same "text unless
  // videoUrl/imageUrls/eventId/venueId says otherwise" logic used client-side
  // wherever a post's type badge is shown.
  async getCommunityPosts(communityId: string, limit: number = 30, offset: number = 0, postType?: string): Promise<Array<Post & { user: User; community: Community }>> {
    const typeFilter =
      postType === "photo" ? sql`array_length(${posts.imageUrls}, 1) > 0` :
      postType === "video" ? isNotNull(posts.videoUrl) :
      postType === "event" ? isNotNull(posts.eventId) :
      postType === "venue" ? isNotNull(posts.venueId) :
      postType === "text" ? and(isNull(posts.videoUrl), isNull(posts.eventId), isNull(posts.venueId), sql`coalesce(array_length(${posts.imageUrls}, 1), 0) = 0`) :
      undefined;

    const result = await db
      .select({
        post: posts,
        user: users,
        community: communities,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .innerJoin(communities, eq(posts.communityId, communities.id))
      .where(and(
        eq(posts.communityId, communityId),
        eq(posts.moderationStatus, "approved"),
        typeFilter,
      ))
      .orderBy(desc(posts.isPinned), desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    return result.map(r => ({
      ...r.post,
      user: r.user,
      community: r.community,
    }));
  }

  async getCommunityMemberCount(communityId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(communityMemberships)
      .where(eq(communityMemberships.communityId, communityId));
    return result?.count ?? 0;
  }

  // Pin/unpin and moderator post removal are both community-scoped: the
  // caller (route) is responsible for checking the post actually belongs to
  // this community and that the caller is owner/moderator — these just do
  // the write, matching the same division of responsibility as the rest of
  // this file's moderation methods.
  async setCommunityPostPinned(postId: string, pinned: boolean): Promise<Post> {
    const [result] = await db.update(posts).set({ isPinned: pinned }).where(eq(posts.id, postId)).returning();
    return result;
  }

  async moderateRemoveCommunityPost(postId: string): Promise<void> {
    await db.update(posts).set({ moderationStatus: "removed" }).where(eq(posts.id, postId));
  }

  // Trending communities — weighted recent activity (7d), same
  // weighted-engagement spirit as getTrendingEvents()/the discovery ranking.
  async getTrendingCommunities(limit: number = 10): Promise<Array<Community & { memberCount: number; creator: User; trendingScore: number }>> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await db
      .select({
        community: communities,
        creator: users,
        memberCount: sql<number>`(SELECT COUNT(*) FROM community_memberships WHERE community_id = ${communities.id})::int`,
        recentPosts: sql<number>`(SELECT COUNT(*) FROM posts WHERE community_id = ${communities.id} AND created_at >= ${sevenDaysAgo} AND moderation_status = 'approved')::int`,
        recentJoins: sql<number>`(SELECT COUNT(*) FROM community_memberships WHERE community_id = ${communities.id} AND joined_at >= ${sevenDaysAgo})::int`,
      })
      .from(communities)
      .innerJoin(users, eq(communities.createdByUserId, users.id));

    return result
      .map(r => {
        const { passwordHash, ...creatorWithoutPassword } = r.creator;
        return {
          ...r.community,
          memberCount: r.memberCount,
          creator: creatorWithoutPassword as User,
          trendingScore: r.recentPosts * 3 + r.recentJoins * 2,
        };
      })
      .sort((a, b) => b.trendingScore - a.trendingScore)
      .slice(0, limit);
  }

  async getCommunityWithDetails(id: string): Promise<(Community & { memberCount: number; creator: User }) | undefined> {
    const result = await db
      .select({
        community: communities,
        creator: users,
        memberCount: sql<number>`(SELECT COUNT(*) FROM community_memberships WHERE community_id = ${communities.id})::int`,
      })
      .from(communities)
      .innerJoin(users, eq(communities.createdByUserId, users.id))
      .where(eq(communities.id, id));

    if (!result[0]) return undefined;
    const { passwordHash, ...creatorWithoutPassword } = result[0].creator;
    return {
      ...result[0].community,
      memberCount: result[0].memberCount,
      creator: creatorWithoutPassword as User,
    };
  }

  async getCommunityEvents(communityId: string): Promise<Event[]> {
    return await db
      .select()
      .from(events)
      .where(eq(events.communityId, communityId))
      .orderBy(events.eventDate);
  }

  async updateCommunityMemberRole(userId: string, communityId: string, role: string): Promise<CommunityMembership> {
    const result = await db
      .update(communityMemberships)
      .set({ role })
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ))
      .returning();
    return result[0];
  }

  async removeCommunityMember(userId: string, communityId: string): Promise<void> {
    await db
      .delete(communityMemberships)
      .where(and(
        eq(communityMemberships.userId, userId),
        eq(communityMemberships.communityId, communityId)
      ));
  }

  async getPostsWithCommunity(): Promise<Array<any>> {
    return cached(
      'posts-with-community',
      async () => {
        // 1. Original posts with author + community (DB-level join)
        const postsResult = await db
          .select({ post: posts, user: users, community: communities })
          .from(posts)
          .innerJoin(users, eq(posts.userId, users.id))
          .leftJoin(communities, eq(posts.communityId, communities.id))
          .orderBy(desc(posts.createdAt));

        // O(1) lookup so reposts can find their original post without a nested scan
        const postMap = new Map<string, any>();
        const feed: any[] = [];

        for (const r of postsResult) {
          const item = { ...r.post, user: r.user, community: r.community, isRepost: false };
          postMap.set(r.post.id, item);
          feed.push(item);
        }

        // 2. Reposts with reposting-user info (DB-level join — no in-memory search)
        const repostsResult = await db
          .select({ repost: reposts, repostingUser: users })
          .from(reposts)
          .innerJoin(users, eq(reposts.userId, users.id));

        for (const r of repostsResult) {
          const originalPost = postMap.get(r.repost.postId);
          if (!originalPost) continue; // original was deleted
          feed.push({
            id: `repost-${r.repost.id}`,
            isRepost: true,
            repostedBy: r.repostingUser,
            originalPost,
            createdAt: r.repost.createdAt,
            user: r.repostingUser,
            postId: r.repost.postId,
          });
        }

        // 3. Sort combined feed chronologically
        feed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return feed;
      },
      postsCache,
    );
  }

  async getFeedPosts(cursor?: string, limit = 20): Promise<{ posts: any[]; nextCursor: string | null }> {
    const cursorDate = cursor ? new Date(cursor) : undefined;

    const [postsResult, repostsResult] = await Promise.all([
      db.select({ post: posts, user: users, community: communities })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .leftJoin(communities, eq(posts.communityId, communities.id))
        .where(cursorDate
          ? and(lt(posts.createdAt, cursorDate), eq(posts.moderationStatus, "approved"))
          : eq(posts.moderationStatus, "approved"))
        .orderBy(desc(posts.createdAt))
        .limit(limit * 2),
      db.select({ repost: reposts, repostingUser: users })
        .from(reposts)
        .innerJoin(users, eq(reposts.userId, users.id))
        .where(cursorDate ? lt(reposts.createdAt, cursorDate) : undefined)
        .orderBy(desc(reposts.createdAt))
        .limit(limit),
    ]);

    const postMap = new Map<string, any>();
    for (const r of postsResult) {
      postMap.set(r.post.id, { ...r.post, user: r.user, community: r.community });
    }

    // Fetch original posts for reposts not covered by the posts window
    const missingIds = [...new Set(
      repostsResult.map(r => r.repost.postId).filter(id => !postMap.has(id))
    )];
    if (missingIds.length > 0) {
      const missing = await db
        .select({ post: posts, user: users, community: communities })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .leftJoin(communities, eq(posts.communityId, communities.id))
        .where(inArray(posts.id, missingIds));
      for (const r of missing) {
        postMap.set(r.post.id, { ...r.post, user: r.user, community: r.community });
      }
    }

    const feed: any[] = [];
    for (const r of postsResult) {
      feed.push({ ...r.post, user: r.user, community: r.community, isRepost: false });
    }
    for (const r of repostsResult) {
      const originalPost = postMap.get(r.repost.postId);
      if (!originalPost) continue;
      feed.push({
        id: `repost-${r.repost.id}`,
        isRepost: true,
        repostedBy: r.repostingUser,
        originalPost,
        createdAt: r.repost.createdAt,
        user: r.repostingUser,
        postId: r.repost.postId,
      });
    }

    // Deduplicate: if the same post appears as both an original and a repost,
    // keep only the most recent entry (the repost wins, bumping it up the timeline).
    const deduped = new Map<string, any>();
    for (const item of feed) {
      const originalId = item.isRepost ? item.postId : item.id;
      const existing = deduped.get(originalId);
      if (!existing || new Date(item.createdAt) > new Date(existing.createdAt)) {
        deduped.set(originalId, item);
      }
    }
    const dedupedFeed = [...deduped.values()];

    dedupedFeed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const page = dedupedFeed.slice(0, limit);
    const overflow = dedupedFeed[limit];
    const nextCursor = overflow
      ? (overflow.createdAt instanceof Date
          ? overflow.createdAt.toISOString()
          : String(overflow.createdAt))
      : null;

    return { posts: page, nextCursor };
  }

  // ============================================
  // GROUP CHATS / CONVERSATIONS
  // ============================================

  async createConversation(data: InsertConversation, participantIds: string[]): Promise<Conversation> {
    const [conversation] = await db.insert(conversations).values(data).returning();
    
    // Add all participants
    const participantData = participantIds.map((userId, index) => ({
      conversationId: conversation.id,
      userId,
      role: data.createdById === userId ? 'admin' : 'member',
    }));
    
    if (participantData.length > 0) {
      await db.insert(conversationParticipants).values(participantData);
    }
    
    return conversation;
  }

  async getConversationById(id: string): Promise<(Conversation & { participants: Array<ConversationParticipant & { user: User }> }) | undefined> {
    const result = await db.select().from(conversations).where(eq(conversations.id, id));
    const conversation = result[0];
    
    if (!conversation) return undefined;
    
    const participants = await this.getConversationParticipants(id);
    
    return {
      ...conversation,
      participants,
    };
  }

  async getUserConversations(userId: string): Promise<Array<Conversation & {
    participants: Array<ConversationParticipant & { user: User }>;
    unreadCount: number;
  }>> {
    // Query 1: get the user's conversation memberships (includes their unreadCount)
    const userMemberships = await db
      .select({
        conversationId: conversationParticipants.conversationId,
        unreadCount: conversationParticipants.unreadCount,
      })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, userId));

    if (userMemberships.length === 0) return [];

    const conversationIds = userMemberships.map(m => m.conversationId);
    const unreadByConvId = new Map(userMemberships.map(m => [m.conversationId, m.unreadCount]));

    // Query 2: fetch all conversations ordered by most recent activity
    const convs = await db
      .select()
      .from(conversations)
      .where(inArray(conversations.id, conversationIds))
      .orderBy(desc(conversations.lastMessageAt));

    // Query 3: fetch all participants for all conversations in one shot
    const allParticipantRows = await db
      .select({ participant: conversationParticipants, user: users })
      .from(conversationParticipants)
      .innerJoin(users, eq(conversationParticipants.userId, users.id))
      .where(inArray(conversationParticipants.conversationId, conversationIds));

    const participantsByConvId = new Map<string, Array<ConversationParticipant & { user: User }>>();
    for (const row of allParticipantRows) {
      const list = participantsByConvId.get(row.participant.conversationId) ?? [];
      list.push({ ...row.participant, user: row.user });
      participantsByConvId.set(row.participant.conversationId, list);
    }

    return convs.map(conv => ({
      ...conv,
      participants: participantsByConvId.get(conv.id) ?? [],
      unreadCount: unreadByConvId.get(conv.id) ?? 0,
    }));
  }

  async updateConversation(id: string, updates: Partial<InsertConversation>): Promise<Conversation> {
    const [result] = await db.update(conversations).set(updates).where(eq(conversations.id, id)).returning();
    return result;
  }

  async deleteConversation(id: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, id));
  }

  // Event group chats whose linked event ended more than 7 days ago —
  // dissolved by eventGroupScheduler.ts. Messages/participants cascade via
  // the existing conversationMessages/conversationParticipants FKs.
  async getDissolvableEventGroupConversationIds(): Promise<string[]> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await db
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(events, eq(conversations.eventId, events.id))
      .where(and(isNotNull(conversations.eventId), lt(events.eventDate, cutoff)));
    return result.map(r => r.id);
  }

  async generateInviteCode(conversationId: string): Promise<string> {
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    await db.update(conversations).set({ inviteCode: code }).where(eq(conversations.id, conversationId));
    return code;
  }

  async getConversationByInviteCode(inviteCode: string): Promise<Conversation | undefined> {
    const [result] = await db.select().from(conversations).where(eq(conversations.inviteCode, inviteCode));
    return result;
  }

  async getConversationByEventId(eventId: string): Promise<Conversation | undefined> {
    const [result] = await db.select().from(conversations).where(eq(conversations.eventId, eventId));
    return result;
  }

  // Adds a participant if there's room under MAX_GROUP_MEMBERS (enforced in
  // messages-routes.ts for explicit adds; re-checked here too since this is
  // also called from the ticket-purchase/RSVP hooks, which have no route of
  // their own to gate at). Silently no-ops past capacity or if already a
  // member — a ticket purchase must never fail because the event chat is full.
  async addConversationParticipantIfRoom(conversationId: string, userId: string, maxMembers: number): Promise<boolean> {
    const alreadyIn = await this.isConversationParticipant(conversationId, userId);
    if (alreadyIn) return false;

    const participants = await this.getConversationParticipants(conversationId);
    if (participants.length >= maxMembers) return false;

    await this.addConversationParticipant(conversationId, userId, 'member');
    return true;
  }

  async getOrCreateDirectConversation(userId1: string, userId2: string): Promise<Conversation> {
    // Deterministic key regardless of argument order — prevents duplicate direct threads
    const directKey = [userId1, userId2].sort().join(':');

    // Upsert the conversation row — ON CONFLICT DO NOTHING is the race-safe guard
    await db.insert(conversations)
      .values({ directKey, isGroup: false, createdById: userId1 })
      .onConflictDoNothing();

    const [conversation] = await db.select()
      .from(conversations)
      .where(eq(conversations.directKey, directKey));

    // Ensure both users are participants — uniqueParticipant constraint makes this idempotent
    await db.insert(conversationParticipants)
      .values([
        { conversationId: conversation.id, userId: userId1, role: 'member', lastReadAt: new Date() },
        { conversationId: conversation.id, userId: userId2, role: 'member', lastReadAt: new Date() },
      ])
      .onConflictDoNothing();

    return conversation;
  }

  // Conversation participants
  async addConversationParticipant(conversationId: string, userId: string, role: string = 'member'): Promise<ConversationParticipant> {
    const [result] = await db.insert(conversationParticipants).values({
      conversationId,
      userId,
      role,
    }).returning();
    return result;
  }

  async removeConversationParticipant(conversationId: string, userId: string): Promise<void> {
    await db.delete(conversationParticipants).where(and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.userId, userId)
    ));
  }

  async updateParticipantRole(conversationId: string, userId: string, role: string): Promise<ConversationParticipant> {
    const [result] = await db
      .update(conversationParticipants)
      .set({ role })
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      ))
      .returning();
    return result;
  }

  async isConversationParticipant(conversationId: string, userId: string): Promise<boolean> {
    const result = await db
      .select()
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      ));
    return result.length > 0;
  }

  async getConversationParticipants(conversationId: string): Promise<Array<ConversationParticipant & { user: User }>> {
    const result = await db
      .select({
        participant: conversationParticipants,
        user: users,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(conversationParticipants.userId, users.id))
      .where(eq(conversationParticipants.conversationId, conversationId));
    
    return result.map(r => ({
      ...r.participant,
      user: r.user,
    }));
  }

  async getParticipantRole(conversationId: string, userId: string): Promise<string | undefined> {
    const result = await db
      .select({ role: conversationParticipants.role })
      .from(conversationParticipants)
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      ));
    return result[0]?.role;
  }

  async updateLastReadAt(conversationId: string, userId: string): Promise<void> {
    await db
      .update(conversationParticipants)
      .set({ lastReadAt: new Date(), unreadCount: 0 })
      .where(and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId)
      ));
  }

  async getUnreadMessageCount(userId: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM conversation_messages cm
      JOIN conversation_participants cp
        ON cm.conversation_id = cp.conversation_id
        AND cp.user_id = ${userId}
      WHERE cm.sender_id != ${userId}
        AND cm.is_deleted = false
        AND (cp.last_read_at IS NULL OR cm.created_at > cp.last_read_at)
    `);
    return Number((result.rows[0] as { count: string })?.count || 0);
  }

  // Conversation messages
  async sendConversationMessage(message: InsertConversationMessage): Promise<ConversationMessage> {
    const [result] = await db.insert(conversationMessages).values(message).returning();

    const preview = message.content?.trim()
      ? message.content.length > 60 ? message.content.substring(0, 60) + '…' : message.content
      : message.messageType === 'poll' ? 'Created a poll'
      : message.messageType === 'image' ? 'Sent an image'
      : message.messageType === 'event' ? 'Shared an event'
      : message.messageType === 'venue' ? 'Shared a venue'
      : message.messageType === 'post' ? 'Shared a post'
      : message.messageType === 'story_reply' ? 'Replied to your story'
      : 'Sent a message';

    // Update conversation metadata and increment unread for all other participants in parallel
    await Promise.all([
      db.update(conversations)
        .set({ lastMessageAt: new Date(), lastMessagePreview: preview })
        .where(eq(conversations.id, message.conversationId)),
      db.update(conversationParticipants)
        .set({ unreadCount: sql`${conversationParticipants.unreadCount} + 1` })
        .where(and(
          eq(conversationParticipants.conversationId, message.conversationId),
          sql`${conversationParticipants.userId} != ${message.senderId}`
        )),
    ]);

    return result;
  }

  // Deleted messages leave a tombstone rather than vanishing (getConversationMessages
  // used to filter isDeleted=false, which just made them disappear with no
  // "[message deleted]" placeholder possible). blankIfDeleted() blanks the
  // actual payload server-side rather than trusting the client to hide it —
  // same approach as the post-comment soft-delete pattern elsewhere.
  private blankIfDeleted<T extends ConversationMessage>(message: T): T {
    if (!message.isDeleted) return message;
    return {
      ...message,
      content: null,
      imageUrls: [],
      eventId: null,
      venueId: null,
      postId: null,
      pollId: null,
      storyId: null,
      replyToId: null,
    };
  }

  async getConversationMessage(messageId: string): Promise<ConversationMessage | undefined> {
    const [result] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
    return result;
  }

  async searchConversationMessages(conversationId: string, query: string, limit: number = 50): Promise<Array<ConversationMessage & { sender: User }>> {
    const result = await db
      .select({ message: conversationMessages, sender: users })
      .from(conversationMessages)
      .innerJoin(users, eq(conversationMessages.senderId, users.id))
      .where(and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.isDeleted, false),
        ilike(conversationMessages.content, `%${query}%`),
      ))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);

    return result.map(r => ({ ...r.message, sender: r.sender }));
  }

  async getConversationMessages(conversationId: string, limit: number = 50, before?: string): Promise<Array<ConversationMessage & { sender: User; replyTo?: ConversationMessage & { sender: User }; story?: Story & { user: User } }>> {
    const result = await db
      .select({ message: conversationMessages, sender: users })
      .from(conversationMessages)
      .innerJoin(users, eq(conversationMessages.senderId, users.id))
      .where(and(
        eq(conversationMessages.conversationId, conversationId),
        before ? lt(conversationMessages.createdAt, new Date(before)) : undefined
      ))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);

    // Batch-fetch stories for story_reply messages — one query regardless of thread length.
    // Deleted messages are excluded here (their storyId gets blanked below anyway).
    const storyIds = [...new Set(
      result
        .filter(r => !r.message.isDeleted && r.message.messageType === 'story_reply' && r.message.storyId)
        .map(r => r.message.storyId!)
    )];

    const storiesById = new Map<string, Story & { user: User }>();
    if (storyIds.length > 0) {
      const storyRows = await db
        .select({ story: stories, storyUser: users })
        .from(stories)
        .innerJoin(users, eq(stories.userId, users.id))
        .where(inArray(stories.id, storyIds));
      for (const row of storyRows) {
        storiesById.set(row.story.id, { ...row.story, user: row.storyUser });
      }
    }

    // Collect replyTo IDs and batch-fetch them
    const replyToIds = [...new Set(
      result.filter(r => !r.message.isDeleted && r.message.replyToId).map(r => r.message.replyToId!)
    )];

    const replyToById = new Map<string, ConversationMessage & { sender: User }>();
    if (replyToIds.length > 0) {
      const replyRows = await db
        .select({ message: conversationMessages, sender: users })
        .from(conversationMessages)
        .innerJoin(users, eq(conversationMessages.senderId, users.id))
        .where(inArray(conversationMessages.id, replyToIds));
      for (const row of replyRows) {
        replyToById.set(row.message.id, { ...row.message, sender: row.sender });
      }
    }

    const messagesWithData: Array<ConversationMessage & { sender: User; replyTo?: ConversationMessage & { sender: User }; story?: Story & { user: User } }> = result.map(r => {
      const blanked = this.blankIfDeleted(r.message);
      const replyTo = blanked.replyToId ? replyToById.get(blanked.replyToId) : undefined;
      return {
        ...blanked,
        sender: r.sender,
        replyTo: replyTo ? { ...this.blankIfDeleted(replyTo), sender: replyTo.sender } : undefined,
        story: blanked.storyId ? storiesById.get(blanked.storyId) : undefined,
      };
    });

    // Return in chronological order (oldest first)
    return messagesWithData.reverse();
  }

  async deleteConversationMessage(messageId: string): Promise<void> {
    await db
      .update(conversationMessages)
      .set({ isDeleted: true })
      .where(eq(conversationMessages.id, messageId));
  }

  // Polls
  async createPoll(poll: InsertPoll, options: Array<{ text: string; eventId?: string; venueId?: string }>): Promise<Poll & { options: PollOption[] }> {
    const [createdPoll] = await db.insert(polls).values(poll).returning();
    
    const optionsData = options.map((opt, index) => ({
      pollId: createdPoll.id,
      text: opt.text,
      eventId: opt.eventId,
      venueId: opt.venueId,
      orderIndex: index,
    }));
    
    const createdOptions = await db.insert(pollOptions).values(optionsData).returning();
    
    // Create a message for the poll
    await this.sendConversationMessage({
      conversationId: poll.conversationId,
      senderId: poll.creatorId,
      messageType: 'poll',
      pollId: createdPoll.id,
      content: poll.question,
    });
    
    return {
      ...createdPoll,
      options: createdOptions,
    };
  }

  async getPoll(id: string): Promise<(Poll & { options: Array<PollOption & { voteCount: number; voters: User[] }>; creator: User }) | undefined> {
    const pollResult = await db
      .select({
        poll: polls,
        creator: users,
      })
      .from(polls)
      .innerJoin(users, eq(polls.creatorId, users.id))
      .where(eq(polls.id, id));
    
    if (!pollResult[0]) return undefined;
    
    const { poll, creator } = pollResult[0];
    
    // Get options with vote counts and voters
    const optionsResult = await db
      .select()
      .from(pollOptions)
      .where(eq(pollOptions.pollId, id))
      .orderBy(pollOptions.orderIndex);
    
    const optionsWithVotes: Array<PollOption & { voteCount: number; voters: User[] }> = [];
    
    for (const option of optionsResult) {
      const votesResult = await db
        .select({
          vote: pollVotes,
          user: users,
        })
        .from(pollVotes)
        .innerJoin(users, eq(pollVotes.userId, users.id))
        .where(eq(pollVotes.optionId, option.id));
      
      optionsWithVotes.push({
        ...option,
        voteCount: votesResult.length,
        voters: votesResult.map(v => v.user),
      });
    }
    
    return {
      ...poll,
      creator,
      options: optionsWithVotes,
    };
  }

  async votePoll(pollId: string, optionId: string, userId: string): Promise<PollVote> {
    const [result] = await db.insert(pollVotes).values({
      pollId,
      optionId,
      userId,
    }).returning();
    return result;
  }

  async unvotePoll(pollId: string, optionId: string, userId: string): Promise<void> {
    await db.delete(pollVotes).where(and(
      eq(pollVotes.pollId, pollId),
      eq(pollVotes.optionId, optionId),
      eq(pollVotes.userId, userId)
    ));
  }

  async getUserPollVotes(pollId: string, userId: string): Promise<PollVote[]> {
    return db.select().from(pollVotes).where(and(
      eq(pollVotes.pollId, pollId),
      eq(pollVotes.userId, userId)
    ));
  }

  async closePoll(pollId: string): Promise<Poll> {
    const [result] = await db
      .update(polls)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(polls.id, pollId))
      .returning();
    return result;
  }

  // Migration: Convert legacy direct messages to new conversation system
  async migrateLegacyMessages(): Promise<{ migratedConversations: number; migratedMessages: number }> {
    // Get all unique sender/receiver pairs from legacy messages table
    const legacyMessages = await db.select().from(messages).orderBy(messages.createdAt);
    
    if (legacyMessages.length === 0) {
      return { migratedConversations: 0, migratedMessages: 0 };
    }

    // Track unique conversation pairs
    const conversationPairs = new Map<string, { user1: string; user2: string; messages: typeof legacyMessages }>();
    
    for (const msg of legacyMessages) {
      // Create a consistent key for the pair (sorted user IDs)
      const sortedIds = [msg.senderId, msg.receiverId].sort();
      const pairKey = `${sortedIds[0]}_${sortedIds[1]}`;
      
      if (!conversationPairs.has(pairKey)) {
        conversationPairs.set(pairKey, { 
          user1: sortedIds[0], 
          user2: sortedIds[1], 
          messages: [] 
        });
      }
      conversationPairs.get(pairKey)!.messages.push(msg);
    }

    let migratedConversations = 0;
    let migratedMessages = 0;

    for (const pair of Array.from(conversationPairs.values())) {
      // Check if conversation already exists (avoid duplicates)
      const existingConv = await this.findExistingDirectConversation(pair.user1, pair.user2);
      
      let conversation: Conversation;
      if (existingConv) {
        conversation = existingConv;
      } else {
        // Create new conversation
        const [newConv] = await db.insert(conversations).values({
          isGroup: false,
          createdById: pair.user1,
        }).returning();
        conversation = newConv;
        
        // Add participants
        await db.insert(conversationParticipants).values([
          { conversationId: conversation.id, userId: pair.user1, role: 'member' },
          { conversationId: conversation.id, userId: pair.user2, role: 'member' },
        ]);
        
        migratedConversations++;
      }

      // Migrate messages (check if already migrated by looking for same content/timestamp)
      for (const msg of pair.messages) {
        // Check if this message was already migrated
        const [existing] = await db
          .select()
          .from(conversationMessages)
          .where(and(
            eq(conversationMessages.conversationId, conversation.id),
            eq(conversationMessages.senderId, msg.senderId),
            eq(conversationMessages.content, msg.content),
            eq(conversationMessages.createdAt, msg.createdAt)
          ))
          .limit(1);
        
        if (!existing) {
          await db.insert(conversationMessages).values({
            conversationId: conversation.id,
            senderId: msg.senderId,
            content: msg.content,
            messageType: 'text',
            eventId: msg.eventId,
            venueId: msg.venueId,
            createdAt: msg.createdAt,
          });
          migratedMessages++;
        }
      }

      // Update lastMessageAt on conversation
      const lastMsg = pair.messages[pair.messages.length - 1];
      if (lastMsg) {
        await db.update(conversations)
          .set({ lastMessageAt: lastMsg.createdAt })
          .where(eq(conversations.id, conversation.id));
      }
      
      // Set lastReadAt for both participants based on isRead flags
      const readMessages = pair.messages.filter((m: typeof legacyMessages[0]) => m.isRead);
      if (readMessages.length > 0) {
        const lastReadTime = readMessages[readMessages.length - 1].createdAt;
        await db.update(conversationParticipants)
          .set({ lastReadAt: lastReadTime })
          .where(and(
            eq(conversationParticipants.conversationId, conversation.id),
            eq(conversationParticipants.userId, pair.user2)
          ));
      }
    }

    return { migratedConversations, migratedMessages };
  }

  // Idempotent boot migration for the unified comment-threading model:
  // 1. Add the new columns/table if they don't exist yet (safe on repeat runs).
  // 2. Copy every commentReplies row into comments, REUSING its original id —
  //    this makes the idempotency check a trivial "does this id already
  //    exist" (no fuzzy content-matching needed) and means any existing
  //    notification whose relatedEntityId points at an old reply id keeps
  //    resolving correctly after the migration.
  // 3. Backfill posts.commentCount from actual (non-deleted) comment rows —
  //    cheap at this app's current scale and self-healing if counts ever drift.
  async ensureUnifiedCommentSchema(): Promise<void> {
    await db.execute(sql`
      ALTER TABLE comments
        ADD COLUMN IF NOT EXISTS parent_comment_id VARCHAR REFERENCES comments(id),
        ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
    `);
    await db.execute(sql`
      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved',
        ADD COLUMN IF NOT EXISTS comment_count INTEGER NOT NULL DEFAULT 0
    `);
  }

  // Report abuse-hardening + venue ratings — idempotent, same ADD-COLUMN-IF-
  // NOT-EXISTS / CREATE-TABLE-IF-NOT-EXISTS convention as everything else
  // that self-heals on boot in this project rather than relying on db:push.
  async ensureSocialLayerSchema(): Promise<void> {
    await db.execute(sql`
      ALTER TABLE event_ratings ADD COLUMN IF NOT EXISTS review_text TEXT
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS venue_ratings (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        venue_id VARCHAR NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL,
        review_text TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP,
        CONSTRAINT venue_rating_check CHECK (rating >= 1 AND rating <= 5),
        CONSTRAINT unique_venue_user_rating UNIQUE (venue_id, user_id)
      )
    `);
    // One report per user per item — a DO block since Postgres has no
    // "ADD CONSTRAINT IF NOT EXISTS".
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'unique_reporter_content'
        ) THEN
          ALTER TABLE content_reports
            ADD CONSTRAINT unique_reporter_content UNIQUE (reporter_id, content_type, content_id);
        END IF;
      END $$;
    `);
  }

  async migrateLegacyCommentReplies(): Promise<{ migratedReplies: number; backfilledPosts: number }> {
    const insertResult = await db.execute(sql`
      INSERT INTO comments (id, user_id, post_id, parent_comment_id, content, created_at)
      SELECT cr.id, cr.user_id, c.post_id, cr.comment_id, cr.content, cr.created_at
      FROM comment_replies cr
      JOIN comments c ON c.id = cr.comment_id
      WHERE cr.id NOT IN (SELECT id FROM comments)
      RETURNING comments.id
    `);
    const migratedReplies = insertResult.rows?.length ?? 0;

    const backfillResult = await db.execute(sql`
      UPDATE posts SET comment_count = sub.cnt
      FROM (
        SELECT post_id, count(*) AS cnt FROM comments WHERE NOT is_deleted GROUP BY post_id
      ) sub
      WHERE posts.id = sub.post_id AND posts.comment_count != sub.cnt
      RETURNING posts.id
    `);
    const backfilledPosts = backfillResult.rows?.length ?? 0;

    return { migratedReplies, backfilledPosts };
  }

  async ensureMediaUploadsTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS media_uploads (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        data TEXT NOT NULL,
        content_type VARCHAR(100) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async ensureBannerColumns(): Promise<void> {
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS banner_mode  TEXT,
        ADD COLUMN IF NOT EXISTS banner_vibe  TEXT,
        ADD COLUMN IF NOT EXISTS banner_color TEXT
    `);
  }

  async ensureTicketTiersTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ticket_tiers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id VARCHAR NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        price_smallest_unit INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'GBP',
        quantity INTEGER NOT NULL,
        sales_end_date TIMESTAMP,
        day_date TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async ensureEventModerationsTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS event_moderations (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id VARCHAR NOT NULL REFERENCES events(id),
        admin_id VARCHAR NOT NULL REFERENCES admin_users(id),
        action TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async saveMedia(data: string, contentType: string, ownerId?: string): Promise<string> {
    const result = await db.execute(sql`
      INSERT INTO media_uploads (owner_id, data, content_type)
      VALUES (${ownerId ?? null}, ${data}, ${contentType})
      RETURNING id
    `);
    return (result.rows[0] as { id: string }).id;
  }

  async getMedia(id: string): Promise<{ data: string; contentType: string } | null> {
    const result = await db.execute(sql`
      SELECT data, content_type FROM media_uploads WHERE id = ${id}
    `);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { data: string; content_type: string };
    return { data: row.data, contentType: row.content_type };
  }

  async deleteMedia(id: string): Promise<void> {
    await db.execute(sql`DELETE FROM media_uploads WHERE id = ${id}`);
  }

  async deleteMediaByUrls(urls: string[]): Promise<void> {
    const ids = urls
      .map(u => { const m = u.match(/^\/api\/media\/([a-f0-9-]+)$/); return m ? m[1] : null; })
      .filter(Boolean) as string[];
    for (const id of ids) {
      await this.deleteMedia(id);
    }
  }

  private async findExistingDirectConversation(userId1: string, userId2: string): Promise<Conversation | undefined> {
    const user1Convs = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, userId1));
    
    const user2Convs = await db
      .select({ conversationId: conversationParticipants.conversationId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, userId2));
    
    const sharedConvIds = user1Convs
      .map(c => c.conversationId)
      .filter(id => user2Convs.some(c => c.conversationId === id));
    
    for (const convId of sharedConvIds) {
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
      if (conv && !conv.isGroup) {
        const [participantCount] = await db
          .select({ count: count() })
          .from(conversationParticipants)
          .where(eq(conversationParticipants.conversationId, convId));
        
        if (participantCount?.count === 2) {
          return conv;
        }
      }
    }
    
    return undefined;
  }

  async upsertPushSubscription(sub: InsertPushSubscription): Promise<PushSubscription> {
    const [result] = await db
      .insert(pushSubscriptions)
      .values(sub)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          p256dhKey: sub.p256dhKey,
          authKey: sub.authKey,
          userId: sub.userId,
        },
      })
      .returning();
    return result;
  }

  async getPushSubscriptionsByUserId(userId: string): Promise<PushSubscription[]> {
    return db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }

  // ── Staff access codes ───────────────────────────────────────────────────

  async createStaffCode(eventId: string, organizerId: string, expiresAt: Date): Promise<EventStaffAccessCode> {
    const code = crypto.randomBytes(32).toString("hex");
    const result = await db
      .insert(eventStaffAccessCodes)
      .values({ eventId, organizerId, code, expiresAt })
      .returning();
    return result[0];
  }

  async getStaffCodeByCode(code: string): Promise<EventStaffAccessCode | undefined> {
    const result = await db
      .select()
      .from(eventStaffAccessCodes)
      .where(eq(eventStaffAccessCodes.code, code));
    return result[0];
  }

  async redeemStaffCode(
    id: string,
    staffName: string,
    ip: string,
    ua: string,
    scannerToken: string,
  ): Promise<EventStaffAccessCode> {
    const result = await db
      .update(eventStaffAccessCodes)
      .set({
        status: "active",
        scannerToken,
        validatedBy: staffName,
        validatedDeviceIp: ip,
        validatedDeviceUa: ua,
        redeemedAt: new Date(),
      })
      .where(and(eq(eventStaffAccessCodes.id, id), eq(eventStaffAccessCodes.status, "pending")))
      .returning();
    if (!result[0]) throw new Error("Code already redeemed or revoked");
    return result[0];
  }

  async getStaffCodeByScannerToken(token: string): Promise<EventStaffAccessCode | undefined> {
    const result = await db
      .select()
      .from(eventStaffAccessCodes)
      .where(eq(eventStaffAccessCodes.scannerToken, token));
    return result[0];
  }

  async getEventStaffCodes(eventId: string, organizerId: string): Promise<EventStaffAccessCode[]> {
    return db
      .select()
      .from(eventStaffAccessCodes)
      .where(and(eq(eventStaffAccessCodes.eventId, eventId), eq(eventStaffAccessCodes.organizerId, organizerId)))
      .orderBy(desc(eventStaffAccessCodes.createdAt));
  }

  async revokeStaffCode(id: string, organizerId: string): Promise<void> {
    await db
      .update(eventStaffAccessCodes)
      .set({ status: "revoked" })
      .where(and(eq(eventStaffAccessCodes.id, id), eq(eventStaffAccessCodes.organizerId, organizerId)));
  }

  async incrementStaffCodeScanCount(id: string): Promise<void> {
    await db
      .update(eventStaffAccessCodes)
      .set({ scanCount: sql`${eventStaffAccessCodes.scanCount} + 1` })
      .where(eq(eventStaffAccessCodes.id, id));
  }

  async getAllSafetyAlerts(limit: number): Promise<any[]> {
    const rows = await db
      .select({
        id: safetyAlerts.id,
        username: users.username,
        latitude: safetyAlerts.latitude,
        longitude: safetyAlerts.longitude,
        status: safetyAlerts.status,
        createdAt: safetyAlerts.createdAt,
      })
      .from(safetyAlerts)
      .innerJoin(users, eq(safetyAlerts.userId, users.id))
      .orderBy(desc(safetyAlerts.createdAt))
      .limit(limit);
    return rows;
  }

  // ── Event ratings ────────────────────────────────────────────────────────

  // Upsert — re-rating an event you already rated updates it instead of being
  // rejected forever. Every mainstream rating product (Google, Yelp, Airbnb)
  // lets you edit your own review; hard-rejecting resubmission is worse than
  // the industry baseline, not "done."
  async createEventRating(eventId: string, userId: string, rating: number, reviewText?: string | null): Promise<EventRating> {
    const [result] = await db
      .insert(eventRatings)
      .values({ eventId, userId, rating, reviewText: reviewText ?? null })
      .onConflictDoUpdate({
        target: [eventRatings.eventId, eventRatings.userId],
        set: { rating, reviewText: reviewText ?? null, updatedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getUserEventRating(eventId: string, userId: string): Promise<EventRating | null> {
    const result = await db
      .select()
      .from(eventRatings)
      .where(and(eq(eventRatings.eventId, eventId), eq(eventRatings.userId, userId)))
      .limit(1);
    return result[0] ?? null;
  }

  async getEventRatingStats(eventId: string): Promise<{ averageRating: number | null; totalRatings: number; distribution: Record<number, number> }> {
    const result = await db.execute(sql`
      SELECT
        AVG(rating)::NUMERIC(3,2)                        AS average_rating,
        COUNT(*)                                          AS total_ratings,
        COUNT(*) FILTER (WHERE rating = 1)               AS one_star,
        COUNT(*) FILTER (WHERE rating = 2)               AS two_star,
        COUNT(*) FILTER (WHERE rating = 3)               AS three_star,
        COUNT(*) FILTER (WHERE rating = 4)               AS four_star,
        COUNT(*) FILTER (WHERE rating = 5)               AS five_star
      FROM event_ratings
      WHERE event_id = ${eventId}
    `);
    const row = result.rows[0] as any;
    return {
      averageRating: row.average_rating ? parseFloat(row.average_rating) : null,
      totalRatings: parseInt(row.total_ratings, 10),
      distribution: {
        1: parseInt(row.one_star, 10),
        2: parseInt(row.two_star, 10),
        3: parseInt(row.three_star, 10),
        4: parseInt(row.four_star, 10),
        5: parseInt(row.five_star, 10),
      },
    };
  }

  async getOrganizerRating(organizerId: string): Promise<{ averageRating: number | null; totalRatings: number; eventsRated: number }> {
    const result = await db.execute(sql`
      SELECT
        AVG(er.rating)::NUMERIC(3,2)  AS average_rating,
        COUNT(er.id)                  AS total_ratings,
        COUNT(DISTINCT er.event_id)   AS events_rated
      FROM event_ratings er
      JOIN events e ON e.id = er.event_id
      WHERE e.organizer_id = ${organizerId}
    `);
    const row = result.rows[0] as any;
    return {
      averageRating: row.average_rating ? parseFloat(row.average_rating) : null,
      totalRatings: parseInt(row.total_ratings, 10),
      eventsRated: parseInt(row.events_rated, 10),
    };
  }

  // Mirrors createEventRating's upsert semantics exactly.
  async createVenueRating(venueId: string, userId: string, rating: number, reviewText?: string | null): Promise<VenueRating> {
    const [result] = await db
      .insert(venueRatings)
      .values({ venueId, userId, rating, reviewText: reviewText ?? null })
      .onConflictDoUpdate({
        target: [venueRatings.venueId, venueRatings.userId],
        set: { rating, reviewText: reviewText ?? null, updatedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getUserVenueRating(venueId: string, userId: string): Promise<VenueRating | null> {
    const result = await db
      .select()
      .from(venueRatings)
      .where(and(eq(venueRatings.venueId, venueId), eq(venueRatings.userId, userId)))
      .limit(1);
    return result[0] ?? null;
  }

  async getVenueRatingStats(venueId: string): Promise<{ averageRating: number | null; totalRatings: number; distribution: Record<number, number> }> {
    const result = await db.execute(sql`
      SELECT
        AVG(rating)::NUMERIC(3,2)          AS average_rating,
        COUNT(*)                            AS total_ratings,
        COUNT(*) FILTER (WHERE rating = 1) AS one_star,
        COUNT(*) FILTER (WHERE rating = 2) AS two_star,
        COUNT(*) FILTER (WHERE rating = 3) AS three_star,
        COUNT(*) FILTER (WHERE rating = 4) AS four_star,
        COUNT(*) FILTER (WHERE rating = 5) AS five_star
      FROM venue_ratings
      WHERE venue_id = ${venueId}
    `);
    const row = result.rows[0] as any;
    return {
      averageRating: row.average_rating ? parseFloat(row.average_rating) : null,
      totalRatings: parseInt(row.total_ratings, 10),
      distribution: {
        1: parseInt(row.one_star, 10),
        2: parseInt(row.two_star, 10),
        3: parseInt(row.three_star, 10),
        4: parseInt(row.four_star, 10),
        5: parseInt(row.five_star, 10),
      },
    };
  }

  // "Attended" for a venue means a checked-in, confirmed venueTicket for an
  // entry night that belongs to this venue and has already happened — one
  // join deeper than the event check since a venue isn't a single dated event.
  // Reuses the existing getUserVenueTickets join rather than a new raw query.
  async hasAttendedVenue(userId: string, venueId: string): Promise<boolean> {
    const ticketsWithVenue = await this.getUserVenueTickets(userId);
    const now = new Date();
    return ticketsWithVenue.some(t =>
      t.venue.id === venueId &&
      t.checkedInAt !== null &&
      t.status === "confirmed" &&
      new Date(t.entryNight.date) < now
    );
  }

  // ── Login attempt tracking (brute-force protection, survives restarts) ─────

  async ensureLoginAttemptsTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS login_attempts (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_attempt TIMESTAMPTZ NOT NULL,
        locked_until TIMESTAMPTZ
      )
    `);
  }

  async ensureSafetyTimerStageColumns(): Promise<void> {
    await db.execute(sql`
      ALTER TABLE safety_timers
        ADD COLUMN IF NOT EXISTS last_stage_notified INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS snooze_count INTEGER NOT NULL DEFAULT 0
    `);
  }

  async ensureSafetyAlertSharesTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS safety_alert_shares (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        share_token VARCHAR NOT NULL UNIQUE,
        alert_type TEXT NOT NULL,
        message TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        location_text TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        expires_at TIMESTAMP NOT NULL
      )
    `);
  }

  async ensureDeliveryLogsTable(): Promise<void> {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS delivery_logs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        provider_message_id VARCHAR NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        context TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async createDeliveryLog(params: { provider: string; providerMessageId: string; phoneNumber: string; context: string; status?: string }): Promise<DeliveryLog> {
    const [result] = await db.insert(deliveryLogs).values({
      provider: params.provider,
      providerMessageId: params.providerMessageId,
      phoneNumber: params.phoneNumber,
      context: params.context,
      status: params.status ?? "sent",
    }).returning();
    return result;
  }

  async updateDeliveryLogStatus(provider: string, providerMessageId: string, status: string): Promise<void> {
    await db.update(deliveryLogs)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(deliveryLogs.provider, provider), eq(deliveryLogs.providerMessageId, providerMessageId)));
  }

  async getLoginAttempt(key: string): Promise<{ count: number; lastAttempt: Date; lockedUntil: Date | null } | null> {
    const result = await db.execute(sql`
      SELECT count, last_attempt, locked_until FROM login_attempts WHERE key = ${key}
    `);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { count: number; last_attempt: Date; locked_until: Date | null };
    return { count: row.count, lastAttempt: row.last_attempt, lockedUntil: row.locked_until };
  }

  async upsertLoginAttempt(key: string, count: number, lastAttempt: Date, lockedUntil: Date | null): Promise<void> {
    await db.execute(sql`
      INSERT INTO login_attempts (key, count, last_attempt, locked_until)
      VALUES (${key}, ${count}, ${lastAttempt}, ${lockedUntil})
      ON CONFLICT (key) DO UPDATE SET
        count = EXCLUDED.count,
        last_attempt = EXCLUDED.last_attempt,
        locked_until = EXCLUDED.locked_until
    `);
  }

  async deleteLoginAttempt(key: string): Promise<void> {
    await db.execute(sql`DELETE FROM login_attempts WHERE key = ${key}`);
  }

  async cleanupExpiredLoginAttempts(): Promise<void> {
    await db.execute(sql`
      DELETE FROM login_attempts
      WHERE last_attempt < NOW() - INTERVAL '30 minutes'
      AND (locked_until IS NULL OR locked_until < NOW())
    `);
  }

  // ============================================
  // ZERNIO SOCIAL MEDIA
  // ============================================

  async setZernioProfileId(userId: string, profileId: string): Promise<void> {
    await db.update(users)
      .set({ zernioProfileId: profileId } as any)
      .where(eq(users.id, userId));
  }

  async getConnectedSocials(userId: string): Promise<ConnectedSocial[]> {
    return db.select()
      .from(connectedSocials)
      .where(and(
        eq(connectedSocials.userId, userId),
        isNull(connectedSocials.disconnectedAt),
      ));
  }

  async getConnectedSocial(
    userId: string,
    platform: string,
  ): Promise<ConnectedSocial | undefined> {
    const result = await db.select()
      .from(connectedSocials)
      .where(and(
        eq(connectedSocials.userId, userId),
        eq(connectedSocials.platform, platform),
        isNull(connectedSocials.disconnectedAt),
      ))
      .limit(1);
    return result[0];
  }

  async upsertConnectedSocial(data: {
    userId: string;
    platform: string;
    zernioAccountId: string;
    handle: string | null;
  }): Promise<ConnectedSocial> {
    // ON CONFLICT resets disconnected_at so reconnecting the same platform
    // reactivates the existing row rather than violating the unique constraint
    const result = await db.execute(sql`
      INSERT INTO connected_socials (user_id, platform, zernio_account_id, handle)
      VALUES (${data.userId}, ${data.platform}, ${data.zernioAccountId}, ${data.handle})
      ON CONFLICT (user_id, platform) DO UPDATE SET
        zernio_account_id   = EXCLUDED.zernio_account_id,
        handle              = EXCLUDED.handle,
        connected_at        = now(),
        disconnected_at     = NULL
      RETURNING *
    `);
    return result.rows[0] as ConnectedSocial;
  }

  async disconnectSocial(userId: string, platform: string): Promise<void> {
    await db.update(connectedSocials)
      .set({ disconnectedAt: new Date() })
      .where(and(
        eq(connectedSocials.userId, userId),
        eq(connectedSocials.platform, platform),
        isNull(connectedSocials.disconnectedAt),
      ));
  }

  async insertSocialPost(data: {
    eventId: string;
    userId: string;
    platform: string;
    zernioPostId?: string | null;
    content: string;
    status: string;
    errorMessage?: string | null;
    costUsd: string;
  }): Promise<SocialPost> {
    const result = await db.insert(socialPosts).values({
      eventId: data.eventId,
      userId: data.userId,
      platform: data.platform,
      zernioPostId: data.zernioPostId ?? null,
      content: data.content,
      status: data.status,
      errorMessage: data.errorMessage ?? null,
      costUsd: data.costUsd,
    } as any).returning();
    return result[0];
  }

  async getRecentSocialPost(
    eventId: string,
    platform: string,
    windowMinutes: number,
  ): Promise<SocialPost | undefined> {
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
    const result = await db.select()
      .from(socialPosts)
      .where(and(
        eq(socialPosts.eventId, eventId),
        eq(socialPosts.platform, platform),
        eq(socialPosts.status, "posted"),
        gte(socialPosts.postedAt, cutoff),
      ))
      .limit(1);
    return result[0];
  }

  async getSocialDashboardStats(dateFrom: Date): Promise<{
    totalPosts: number;
    totalCostUsd: string;
    failedPosts: number;
    platformsUsed: number;
  }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int                                           AS total_posts,
        COALESCE(SUM(cost_usd), 0)::text                       AS total_cost_usd,
        COUNT(*) FILTER (WHERE status = 'failed')::int         AS failed_posts,
        COUNT(DISTINCT platform)::int                          AS platforms_used
      FROM social_posts
      WHERE posted_at >= ${dateFrom}
    `);
    const row = result.rows[0] as any;
    return {
      totalPosts:    Number(row?.total_posts   ?? 0),
      totalCostUsd:  String(row?.total_cost_usd ?? "0"),
      failedPosts:   Number(row?.failed_posts  ?? 0),
      platformsUsed: Number(row?.platforms_used ?? 0),
    };
  }

  async getSocialDailyBreakdown(
    dateFrom: Date,
  ): Promise<Array<{ date: string; count: number; costUsd: string }>> {
    const result = await db.execute(sql`
      SELECT
        DATE(posted_at)::text                          AS date,
        COUNT(*)::int                                  AS count,
        COALESCE(SUM(cost_usd), 0)::text               AS cost_usd
      FROM social_posts
      WHERE posted_at >= ${dateFrom}
      GROUP BY DATE(posted_at)
      ORDER BY DATE(posted_at)
    `);
    return (result.rows as any[]).map((r) => ({
      date:    r.date,
      count:   Number(r.count),
      costUsd: String(r.cost_usd),
    }));
  }

  async getSocialPlatformBreakdown(
    dateFrom: Date,
  ): Promise<Array<{ platform: string; posts: number; costUsd: string }>> {
    const result = await db.execute(sql`
      SELECT
        platform,
        COUNT(*)::int                                  AS posts,
        COALESCE(SUM(cost_usd), 0)::text               AS cost_usd
      FROM social_posts
      WHERE posted_at >= ${dateFrom}
      GROUP BY platform
      ORDER BY posts DESC
    `);
    return (result.rows as any[]).map((r) => ({
      platform: r.platform,
      posts:    Number(r.posts),
      costUsd:  String(r.cost_usd),
    }));
  }

  async getSocialOrganizerStats(
    limit: number,
    offset: number,
  ): Promise<Array<{
    userId: string;
    orgName: string | null;
    connectedAccounts: number;
    postsThisMonth: number;
    costThisMonth: string;
  }>> {
    // month_start is computed in SQL to avoid timezone skew between app and DB
    const result = await db.execute(sql`
      SELECT
        u.id                                                                    AS user_id,
        u.organization_name                                                     AS org_name,
        COUNT(DISTINCT cs.id) FILTER (WHERE cs.disconnected_at IS NULL)::int   AS connected_accounts,
        COUNT(sp.id) FILTER (WHERE sp.posted_at >= date_trunc('month', now()))::int AS posts_this_month,
        COALESCE(
          SUM(sp.cost_usd) FILTER (WHERE sp.posted_at >= date_trunc('month', now())),
          0
        )::text                                                                 AS cost_this_month
      FROM users u
      LEFT JOIN connected_socials cs ON cs.user_id = u.id
      LEFT JOIN social_posts      sp ON sp.user_id = u.id
      WHERE u.user_type = 'organizer'
      GROUP BY u.id, u.organization_name
      ORDER BY posts_this_month DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    return (result.rows as any[]).map((r) => ({
      userId:           r.user_id,
      orgName:          r.org_name ?? null,
      connectedAccounts: Number(r.connected_accounts ?? 0),
      postsThisMonth:   Number(r.posts_this_month ?? 0),
      costThisMonth:    String(r.cost_this_month ?? "0"),
    }));
  }
}

export const storage = new DbStorage();
