import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean } from "drizzle-orm/pg-core";
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
  bio: text("bio"),
  interests: text("interests").array().default(sql`'{}'`),
  organizationName: text("organization_name"),
  contactEmail: text("contact_email"),
  socialMediaLinks: text("social_media_links").array().default(sql`'{}'`),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
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
});

export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
}).extend({
  eventDate: z.coerce.date(),
});

export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

export const tickets = pgTable("tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  eventId: varchar("event_id").notNull().references(() => events.id),
  purchaseDate: timestamp("purchase_date").notNull().default(sql`now()`),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  status: text("status").notNull().default("confirmed"),
});

export const insertTicketSchema = createInsertSchema(tickets).omit({
  id: true,
  purchaseDate: true,
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
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertPostSchema = createInsertSchema(posts).omit({
  id: true,
  createdAt: true,
});

export type InsertPost = z.infer<typeof insertPostSchema>;
export type Post = typeof posts.$inferSelect;

export const follows = pgTable("follows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  followerId: varchar("follower_id").notNull().references(() => users.id),
  followingId: varchar("following_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

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
