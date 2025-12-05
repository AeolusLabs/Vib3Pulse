import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, unique, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  userType: text("user_type").notNull(),
  displayName: text("display_name"),
  dateOfBirth: text("date_of_birth"),
  gender: text("gender"),
  genderEditedAt: timestamp("gender_edited_at"),
  bio: text("bio"),
  interests: text("interests").array().default(sql`'{}'`),
  organizationName: text("organization_name"),
  contactEmail: text("contact_email"),
  socialMediaLinks: text("social_media_links").array().default(sql`'{}'`),
  phoneNumber: text("phone_number"),
  canManageVenues: boolean("can_manage_venues").default(false),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

// Schema for safely updating user profile (excludes sensitive fields)
export const updateUserSchema = insertUserSchema.pick({
  displayName: true,
  dateOfBirth: true,
  gender: true,
  bio: true,
  interests: true,
  organizationName: true,
  contactEmail: true,
  socialMediaLinks: true,
  phoneNumber: true,
  canManageVenues: true,
  avatarUrl: true,
}).partial();

// Gender options enum
export const genderOptions = ["Male", "Female", "Rather not say"] as const;
export type Gender = typeof genderOptions[number];

export type InsertUser = z.infer<typeof insertUserSchema>;
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type User = typeof users.$inferSelect;

// Session table for express-session with connect-pg-simple
export const sessions = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: text("sess").notNull(),
  expire: timestamp("expire").notNull(),
});

export const events = pgTable("events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizerId: varchar("organizer_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  eventDate: timestamp("event_date").notNull(),
  location: text("location").notNull(),
  category: text("category").notNull(),
  ticketPrice: integer("ticket_price").notNull().default(0),
  requiresRSVP: boolean("requires_rsvp").notNull().default(false),
  ticketsAvailable: integer("tickets_available").notNull(),
  imageUrl: text("image_url"),
  isPromoted: boolean("is_promoted").notNull().default(false),
  promotedUntil: timestamp("promoted_until"),
});

export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
}).extend({
  eventDate: z.coerce.date(),
});

export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

// DTO schemas for API requests - accept ISO string dates and transform to Date objects
export const eventCreateDto = insertEventSchema.extend({
  eventDate: z.string().datetime().transform((val) => new Date(val)),
});

export const eventUpdateDto = eventCreateDto.omit({ organizerId: true }).partial();

export type EventCreateDto = z.input<typeof eventCreateDto>; // Input type (before transform)
export type EventUpdateDto = z.input<typeof eventUpdateDto> & { id: string };

export const ticketTiers = pgTable("ticket_tiers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  quantity: integer("quantity").notNull(),
  salesEndDate: timestamp("sales_end_date"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertTicketTierSchema = createInsertSchema(ticketTiers).omit({
  id: true,
  createdAt: true,
});

export type InsertTicketTier = z.infer<typeof insertTicketTierSchema>;
export type TicketTier = typeof ticketTiers.$inferSelect;

export const tickets = pgTable("tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  eventId: varchar("event_id").notNull().references(() => events.id),
  purchaseDate: timestamp("purchase_date").notNull().default(sql`now()`),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").notNull().default("confirmed"),
  validationCode: varchar("validation_code").notNull().unique().default(sql`gen_random_uuid()`),
  checkedInAt: timestamp("checked_in_at"),
  checkedInBy: varchar("checked_in_by").references(() => users.id),
});

export const insertTicketSchema = createInsertSchema(tickets).omit({
  id: true,
  purchaseDate: true,
  validationCode: true,
  checkedInAt: true,
  checkedInBy: true,
});

export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type Ticket = typeof tickets.$inferSelect;

export const rsvps = pgTable("rsvps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  eventId: varchar("event_id").notNull().references(() => events.id),
  rsvpDate: timestamp("rsvp_date").notNull().default(sql`now()`),
  status: text("status").notNull().default("confirmed"),
});

export const insertRsvpSchema = createInsertSchema(rsvps).omit({
  id: true,
  rsvpDate: true,
});

export type InsertRsvp = z.infer<typeof insertRsvpSchema>;
export type Rsvp = typeof rsvps.$inferSelect;

export const posts = pgTable("posts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  eventId: varchar("event_id").references(() => events.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertPostSchema = createInsertSchema(posts).omit({
  id: true,
  createdAt: true,
});

export type InsertPost = z.infer<typeof insertPostSchema>;
export type Post = typeof posts.$inferSelect;

// Reposts - tracks who reposted which post (like Twitter retweets)
export const reposts = pgTable("reposts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  postId: varchar("post_id").notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueRepost: unique().on(table.userId, table.postId),
}));

export const insertRepostSchema = createInsertSchema(reposts).omit({
  id: true,
  createdAt: true,
});

export type InsertRepost = z.infer<typeof insertRepostSchema>;
export type Repost = typeof reposts.$inferSelect;

// Hashtags - stores unique hashtags for searchability
export const hashtags = pgTable("hashtags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tag: text("tag").notNull().unique(),
  postCount: integer("post_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertHashtagSchema = createInsertSchema(hashtags).omit({
  id: true,
  createdAt: true,
  postCount: true,
});

export type InsertHashtag = z.infer<typeof insertHashtagSchema>;
export type Hashtag = typeof hashtags.$inferSelect;

// Post Hashtags - junction table for posts and hashtags
export const postHashtags = pgTable("post_hashtags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull().references(() => posts.id, { onDelete: 'cascade' }),
  hashtagId: varchar("hashtag_id").notNull().references(() => hashtags.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniquePostHashtag: unique().on(table.postId, table.hashtagId),
}));

export const insertPostHashtagSchema = createInsertSchema(postHashtags).omit({
  id: true,
  createdAt: true,
});

export type InsertPostHashtag = z.infer<typeof insertPostHashtagSchema>;
export type PostHashtag = typeof postHashtags.$inferSelect;

// Post Mentions - tracks @mentions in posts for notifications
export const postMentions = pgTable("post_mentions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  postId: varchar("post_id").notNull().references(() => posts.id, { onDelete: 'cascade' }),
  mentionedUserId: varchar("mentioned_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueMention: unique().on(table.postId, table.mentionedUserId),
}));

export const insertPostMentionSchema = createInsertSchema(postMentions).omit({
  id: true,
  createdAt: true,
});

export type InsertPostMention = z.infer<typeof insertPostMentionSchema>;
export type PostMention = typeof postMentions.$inferSelect;

export const stories = pgTable("stories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  imageUrl: text("image_url").notNull(),
  type: text("type").notNull().default("image"),
  privacy: text("privacy").notNull().default("public"), // "public" or "private"
  originalStoryId: varchar("original_story_id").references((): any => stories.id), // For reshared stories
  expiresAt: timestamp("expires_at").default(sql`now() + interval '24 hours'`),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertStorySchema = createInsertSchema(stories).omit({
  id: true,
  createdAt: true,
  expiresAt: true,
});

export type InsertStory = z.infer<typeof insertStorySchema>;
export type Story = typeof stories.$inferSelect;

// Story likes - tracks who liked which story
export const storyLikes = pgTable("story_likes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  storyId: varchar("story_id").notNull().references(() => stories.id, { onDelete: 'cascade' }),
  userId: varchar("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueStoryLike: unique().on(table.storyId, table.userId),
}));

export const insertStoryLikeSchema = createInsertSchema(storyLikes).omit({
  id: true,
  createdAt: true,
});

export type InsertStoryLike = z.infer<typeof insertStoryLikeSchema>;
export type StoryLike = typeof storyLikes.$inferSelect;

// Story allowed viewers - for private stories
export const storyAllowedViewers = pgTable("story_allowed_viewers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  storyId: varchar("story_id").notNull().references(() => stories.id, { onDelete: 'cascade' }),
  viewerId: varchar("viewer_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueViewer: unique().on(table.storyId, table.viewerId),
}));

export const insertStoryAllowedViewerSchema = createInsertSchema(storyAllowedViewers).omit({
  id: true,
  createdAt: true,
});

export type InsertStoryAllowedViewer = z.infer<typeof insertStoryAllowedViewerSchema>;
export type StoryAllowedViewer = typeof storyAllowedViewers.$inferSelect;

export const follows = pgTable("follows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  followerId: varchar("follower_id").notNull().references(() => users.id),
  followingId: varchar("following_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueFollow: unique().on(table.followerId, table.followingId),
}));

export const insertFollowSchema = createInsertSchema(follows).omit({
  id: true,
  createdAt: true,
});

export type InsertFollow = z.infer<typeof insertFollowSchema>;
export type Follow = typeof follows.$inferSelect;

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  receiverId: varchar("receiver_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  replyToId: varchar("reply_to_id"),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

export const likes = pgTable("likes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  postId: varchar("post_id").notNull().references(() => posts.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertLikeSchema = createInsertSchema(likes).omit({
  id: true,
  createdAt: true,
});

export type InsertLike = z.infer<typeof insertLikeSchema>;
export type Like = typeof likes.$inferSelect;

export const comments = pgTable("comments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  postId: varchar("post_id").notNull().references(() => posts.id),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertCommentSchema = createInsertSchema(comments).omit({
  id: true,
  createdAt: true,
});

export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Comment = typeof comments.$inferSelect;

export const bookmarks = pgTable("bookmarks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  postId: varchar("post_id").notNull().references(() => posts.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertBookmarkSchema = createInsertSchema(bookmarks).omit({
  id: true,
  createdAt: true,
});

export type InsertBookmark = z.infer<typeof insertBookmarkSchema>;
export type Bookmark = typeof bookmarks.$inferSelect;

export const buddies = pgTable("buddies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  buddyId: varchar("buddy_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
}, (table) => ({
  uniqueBuddy: unique().on(table.userId),
}));

export const insertBuddySchema = createInsertSchema(buddies).omit({
  id: true,
  createdAt: true,
});

export type InsertBuddy = z.infer<typeof insertBuddySchema>;
export type Buddy = typeof buddies.$inferSelect;

export const distressMessages = pgTable("distress_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id).unique(),
  message: text("message").notNull(),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const insertDistressMessageSchema = createInsertSchema(distressMessages).omit({
  id: true,
  updatedAt: true,
});

export type InsertDistressMessage = z.infer<typeof insertDistressMessageSchema>;
export type DistressMessage = typeof distressMessages.$inferSelect;

export const distressAlerts = pgTable("distress_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  buddyId: varchar("buddy_id").notNull().references(() => users.id),
  message: text("message").notNull(),
  latitude: text("latitude"),
  longitude: text("longitude"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertDistressAlertSchema = createInsertSchema(distressAlerts).omit({
  id: true,
  createdAt: true,
});

export type InsertDistressAlert = z.infer<typeof insertDistressAlertSchema>;
export type DistressAlert = typeof distressAlerts.$inferSelect;

export const eventAnalytics = pgTable("event_analytics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id),
  actionType: text("action_type").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertEventAnalyticsSchema = createInsertSchema(eventAnalytics).omit({
  id: true,
  createdAt: true,
});

export type InsertEventAnalytics = z.infer<typeof insertEventAnalyticsSchema>;
export type EventAnalytics = typeof eventAnalytics.$inferSelect;

// Venue categories
export const venueCategories = ["Club", "Pub", "Lounge", "Bar", "Nightclub", "Rooftop"] as const;
export type VenueCategory = typeof venueCategories[number];

// Venues table for clubs, pubs, lounges
export const venues = pgTable("venues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  description: text("description"),
  location: text("location").notNull(),
  imageUrl: varchar("image_url", { length: 512 }),
  coverImageUrl: varchar("cover_image_url", { length: 512 }),
  address: varchar("address", { length: 500 }),
  city: varchar("city", { length: 100 }),
  phone: varchar("phone", { length: 50 }),
  website: varchar("website", { length: 255 }),
  hours: text("hours"),
  amenities: text("amenities").array().default(sql`'{}'`),
  musicTypes: text("music_types").array().default(sql`'{}'`),
  dressCode: varchar("dress_code", { length: 100 }),
  ageRestriction: integer("age_restriction"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  isPromoted: boolean("is_promoted").notNull().default(false),
  promotedUntil: timestamp("promoted_until"),
  isVerified: boolean("is_verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").default(sql`now()`),
});

export const insertVenueSchema = createInsertSchema(venues).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  isVerified: true,
});

export type InsertVenue = z.infer<typeof insertVenueSchema>;
export type Venue = typeof venues.$inferSelect;

// Venue entry nights - for cover charge nights at venues
export const venueEntryNights = pgTable("venue_entry_nights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  venueId: varchar("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  date: timestamp("date").notNull(),
  coverPriceCents: integer("cover_price_cents").notNull(),
  capacity: integer("capacity"),
  ticketsSold: integer("tickets_sold").notNull().default(0),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertVenueEntryNightSchema = createInsertSchema(venueEntryNights).omit({
  id: true,
  ticketsSold: true,
  createdAt: true,
}).extend({
  date: z.coerce.date(),
});

export type InsertVenueEntryNight = z.infer<typeof insertVenueEntryNightSchema>;
export type VenueEntryNight = typeof venueEntryNights.$inferSelect;

// Venue entry tickets - tickets purchased for venue entry nights
export const venueTickets = pgTable("venue_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  venueEntryNightId: varchar("venue_entry_night_id").notNull().references(() => venueEntryNights.id),
  purchaseDate: timestamp("purchase_date").notNull().default(sql`now()`),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").notNull().default("confirmed"),
  validationCode: varchar("validation_code").notNull().unique().default(sql`gen_random_uuid()`),
  checkedInAt: timestamp("checked_in_at"),
  checkedInBy: varchar("checked_in_by").references(() => users.id),
});

export const insertVenueTicketSchema = createInsertSchema(venueTickets).omit({
  id: true,
  purchaseDate: true,
  validationCode: true,
  checkedInAt: true,
  checkedInBy: true,
});

export type InsertVenueTicket = z.infer<typeof insertVenueTicketSchema>;
export type VenueTicket = typeof venueTickets.$inferSelect;

// Venue analytics for tracking views and clicks
export const venueAnalytics = pgTable("venue_analytics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  venueId: varchar("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id),
  actionType: text("action_type").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertVenueAnalyticsSchema = createInsertSchema(venueAnalytics).omit({
  id: true,
  createdAt: true,
});

export type InsertVenueAnalytics = z.infer<typeof insertVenueAnalyticsSchema>;
export type VenueAnalytics = typeof venueAnalytics.$inferSelect;

// ============================================
// ADMIN PANEL - Completely Separate from User System
// ============================================

// Admin roles enum
export const adminRoles = [
  "super_admin",
  "content_moderator", 
  "user_support",
  "event_reviewer",
  "finance_manager",
  "analytics_viewer"
] as const;
export type AdminRole = typeof adminRoles[number];

// Admin users table - completely separate from regular users
export const adminUsers = pgTable("admin_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertAdminUserSchema = createInsertSchema(adminUsers).omit({
  id: true,
  lastLoginAt: true,
  createdAt: true,
});

export type InsertAdminUser = z.infer<typeof insertAdminUserSchema>;
export type AdminUser = typeof adminUsers.$inferSelect;

// Admin sessions - separate from user sessions
export const adminSessions = pgTable("admin_session", {
  sid: varchar("sid").primaryKey(),
  sess: text("sess").notNull(),
  expire: timestamp("expire").notNull(),
});

// Admin activity logs - track all admin actions
export const adminActivityLogs = pgTable("admin_activity_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  adminId: varchar("admin_id").notNull().references(() => adminUsers.id),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: varchar("target_id"),
  details: text("details"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertAdminActivityLogSchema = createInsertSchema(adminActivityLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertAdminActivityLog = z.infer<typeof insertAdminActivityLogSchema>;
export type AdminActivityLog = typeof adminActivityLogs.$inferSelect;

// Content reports - for moderation queue
export const contentReports = pgTable("content_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reporterId: varchar("reporter_id").notNull().references(() => users.id),
  contentType: text("content_type").notNull(),
  contentId: varchar("content_id").notNull(),
  reason: text("reason").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  reviewedBy: varchar("reviewed_by").references(() => adminUsers.id),
  reviewedAt: timestamp("reviewed_at"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertContentReportSchema = createInsertSchema(contentReports).omit({
  id: true,
  status: true,
  reviewedBy: true,
  reviewedAt: true,
  resolution: true,
  createdAt: true,
});

export type InsertContentReport = z.infer<typeof insertContentReportSchema>;
export type ContentReport = typeof contentReports.$inferSelect;

// User suspensions - for user moderation
export const userSuspensions = pgTable("user_suspensions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  adminId: varchar("admin_id").notNull().references(() => adminUsers.id),
  reason: text("reason").notNull(),
  suspendedUntil: timestamp("suspended_until"),
  isPermanent: boolean("is_permanent").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertUserSuspensionSchema = createInsertSchema(userSuspensions).omit({
  id: true,
  isActive: true,
  createdAt: true,
});

export type InsertUserSuspension = z.infer<typeof insertUserSuspensionSchema>;
export type UserSuspension = typeof userSuspensions.$inferSelect;

// Event moderation status
export const eventModerationStatus = ["pending", "approved", "rejected", "flagged"] as const;
export type EventModerationStatus = typeof eventModerationStatus[number];

// Event moderation actions
export const eventModerations = pgTable("event_moderations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id").notNull().references(() => events.id),
  adminId: varchar("admin_id").notNull().references(() => adminUsers.id),
  action: text("action").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertEventModerationSchema = createInsertSchema(eventModerations).omit({
  id: true,
  createdAt: true,
});

export type InsertEventModeration = z.infer<typeof insertEventModerationSchema>;
export type EventModeration = typeof eventModerations.$inferSelect;

// ============================================
// NOTIFICATIONS
// ============================================

// Notification types
export const notificationTypes = [
  "post_like",
  "post_comment",
  "story_like",
  "story_comment",
  "new_message",
  "buddy_alert",
  "event_rsvp",
  "ticket_purchase",
  "new_follower",
] as const;
export type NotificationType = typeof notificationTypes[number];

// Notifications table
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"),
  relatedUserId: varchar("related_user_id").references(() => users.id),
  relatedEntityId: varchar("related_entity_id"),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  isRead: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;
