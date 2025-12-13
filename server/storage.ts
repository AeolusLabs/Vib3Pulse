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
  type Buddy,
  type InsertBuddy,
  type DistressMessage,
  type InsertDistressMessage,
  type DistressAlert,
  type InsertDistressAlert,
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
  users,
  events,
  tickets,
  ticketTiers,
  rsvps,
  posts,
  stories,
  storyLikes,
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
  buddies,
  distressMessages,
  distressAlerts,
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
  notifications
} from "@shared/schema";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { eq, and, gte, lt, or, ilike, desc, sql, count, inArray, notInArray } from "drizzle-orm";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User>;
  updateUserPassword(userId: string, hashedPassword: string): Promise<void>;
  updateUsername(userId: string, newUsername: string): Promise<User>;
  
  getEvents(): Promise<Event[]>;
  getEvent(id: string): Promise<(Event & { organizer: User }) | undefined>;
  getUserEvents(userId: string): Promise<Event[]>;
  getEventsByOrganizer(organizerId: string): Promise<Event[]>;
  createEvent(event: InsertEvent): Promise<Event>;
  updateEvent(id: string, event: Partial<InsertEvent>): Promise<Event>;
  
  getUserTickets(userId: string): Promise<Array<Ticket & { event: Event }>>;
  getTicket(id: string): Promise<Ticket | undefined>;
  getTicketByPaymentIntent(paymentIntentId: string): Promise<Ticket | undefined>;
  getTicketByValidationCode(validationCode: string): Promise<Ticket | undefined>;
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  checkInTicket(ticketId: string, organizerId: string): Promise<Ticket>;
  getEventCheckIns(eventId: string): Promise<Array<Ticket & { user: User }>>;

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
  getPost(id: string): Promise<Post | undefined>;
  getUserPosts(userId: string): Promise<Post[]>;
  getUserLikedPosts(userId: string): Promise<Array<Post & { user: User }>>;
  getUserRepostedPosts(userId: string): Promise<Array<Post & { user: User }>>;
  createPost(post: InsertPost): Promise<Post>;
  deletePost(id: string): Promise<void>;
  
  createStory(story: InsertStory, allowedViewerIds?: string[]): Promise<Story>;
  getActiveStories(viewerId?: string): Promise<Array<Story & { user: User; likeCount: number; isLiked?: boolean; isReshare?: boolean }>>;
  getStory(id: string): Promise<Story | undefined>;
  getUserStories(userId: string): Promise<Story[]>;
  deleteStory(id: string): Promise<void>;
  
  // Story likes
  likeStory(userId: string, storyId: string): Promise<void>;
  unlikeStory(userId: string, storyId: string): Promise<void>;
  hasUserLikedStory(userId: string, storyId: string): Promise<boolean>;
  getStoryLikeCount(storyId: string): Promise<number>;
  
  // Story reshares
  reshareStory(userId: string, originalStoryId: string): Promise<Story>;
  
  // Story allowed viewers
  setStoryAllowedViewers(storyId: string, viewerIds: string[]): Promise<void>;
  getStoryAllowedViewers(storyId: string): Promise<string[]>;
  canViewStory(viewerId: string, storyId: string): Promise<boolean>;
  
  followUser(followerId: string, followingId: string): Promise<Follow>;
  unfollowUser(followerId: string, followingId: string): Promise<void>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  getFollowers(userId: string): Promise<Array<Follow & { follower: User }>>;
  getFollowing(userId: string): Promise<Array<Follow & { following: User }>>;
  
  sendMessage(message: InsertMessage): Promise<Message>;
  getConversation(userId1: string, userId2: string): Promise<Array<Message & { sender: User; receiver: User; replyTo?: Message & { sender: User } }>>;
  getConversations(userId: string): Promise<Array<{ otherUser: User; lastMessage: Message; unreadCount: number }>>;
  markAsRead(messageId: string): Promise<void>;
  
  getUserProfile(userId: string): Promise<{ user: User; posts: Post[]; events: Array<Rsvp & { event: Event }> } | undefined>;
  searchUsers(query: string): Promise<User[]>;
  
  // Universal search methods
  universalSearch(query: string, types?: string[]): Promise<{
    users: User[];
    events: Array<Event & { organizer: User }>;
    venues: Venue[];
    posts: Array<Post & { user: User }>;
  }>;
  searchEvents(query: string): Promise<Array<Event & { organizer: User }>>;
  searchVenues(query: string): Promise<Venue[]>;
  searchPosts(query: string): Promise<Array<Post & { user: User }>>;
  
  // Trending methods
  getTrendingPosts(limit?: number): Promise<Array<Post & { user: User; likeCount: number; commentCount: number }>>;
  getTrendingEvents(limit?: number): Promise<Array<Event & { organizer: User; rsvpCount: number; ticketCount: number }>>;
  getTrendingVenues(limit?: number): Promise<Array<Venue & { viewCount: number }>>;
  getTrendingStories(limit?: number): Promise<Array<Story & { user: User; likeCount: number }>>;
  getSuggestedUsers(userId: string, limit?: number): Promise<User[]>;
  
  likePost(userId: string, postId: string): Promise<Like>;
  unlikePost(userId: string, postId: string): Promise<void>;
  getPostLikes(postId: string): Promise<number>;
  hasUserLikedPost(userId: string, postId: string): Promise<boolean>;
  
  addComment(comment: InsertComment): Promise<Comment>;
  getPostComments(postId: string): Promise<Array<Comment & { user: User }>>;
  getCommentCount(postId: string): Promise<number>;
  
  // Comment interactions
  likeComment(userId: string, commentId: string): Promise<CommentLike>;
  unlikeComment(userId: string, commentId: string): Promise<void>;
  hasUserLikedComment(userId: string, commentId: string): Promise<boolean>;
  getCommentLikeCount(commentId: string): Promise<number>;
  
  addCommentReply(userId: string, commentId: string, content: string): Promise<CommentReply>;
  getCommentReplies(commentId: string): Promise<Array<CommentReply & { user: User }>>;
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

  setBuddy(userId: string, buddyId: string): Promise<void>;
  getBuddy(userId: string): Promise<User | undefined>;
  removeBuddy(userId: string): Promise<void>;
  setDistressMessage(userId: string, message: string): Promise<void>;
  getDistressMessage(userId: string): Promise<string | undefined>;
  logDistressAlert(userId: string, buddyId: string, message: string, latitude?: string, longitude?: string): Promise<void>;
  getDistressAlerts(userId: string): Promise<any[]>;

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
  deleteVenue(id: string): Promise<void>;
  getPromotedVenues(): Promise<Venue[]>;
  promoteVenue(venueId: string, durationDays: number): Promise<Venue>;

  // Venue entry nights methods
  getVenueEntryNights(venueId: string): Promise<VenueEntryNight[]>;
  getUpcomingVenueEntryNights(venueId: string): Promise<VenueEntryNight[]>;
  getVenueEntryNight(id: string): Promise<VenueEntryNight | undefined>;
  createVenueEntryNight(entryNight: InsertVenueEntryNight): Promise<VenueEntryNight>;
  updateVenueEntryNight(id: string, entryNight: Partial<InsertVenueEntryNight>): Promise<VenueEntryNight>;
  deleteVenueEntryNight(id: string): Promise<void>;

  // Venue tickets methods
  getUserVenueTickets(userId: string): Promise<Array<VenueTicket & { entryNight: VenueEntryNight; venue: Venue }>>;
  getVenueTicket(id: string): Promise<VenueTicket | undefined>;
  getVenueTicketByValidationCode(validationCode: string): Promise<VenueTicket | undefined>;
  createVenueTicket(ticket: InsertVenueTicket): Promise<VenueTicket>;
  checkInVenueTicket(ticketId: string, organizerId: string): Promise<VenueTicket>;
  incrementVenueEntryNightTicketsSold(entryNightId: string): Promise<void>;

  // Venue analytics methods
  trackVenueView(venueId: string, userId?: string): Promise<void>;
  trackVenueClick(venueId: string, actionType: string, userId?: string): Promise<void>;
  getVenueAnalytics(venueId: string): Promise<{ views: number; clicks: number; ticketsSold: number }>;

  // Organizer demographics analytics
  getOrganizerDemographics(organizerId: string): Promise<{
    totalEvents: number;
    totalRsvps: number;
    totalTicketsSold: number;
    totalViews: number;
    totalRevenue: number;
    ageDistribution: { ageGroup: string; count: number; percentage: number }[];
    genderDistribution: { gender: string; count: number; percentage: number }[];
    eventBreakdown: { eventId: string; title: string; rsvps: number; tickets: number; views: number }[];
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
  getContentReports(status?: string): Promise<Array<ContentReport & { reporter: User }>>;
  getContentReport(id: string): Promise<ContentReport | undefined>;
  updateContentReport(id: string, updates: { status: string; reviewedBy: string; resolution?: string }): Promise<ContentReport>;

  // User suspensions
  suspendUser(suspension: InsertUserSuspension): Promise<UserSuspension>;
  getUserSuspensions(userId: string): Promise<UserSuspension[]>;
  getActiveSuspension(userId: string): Promise<UserSuspension | undefined>;
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
    totalRevenue: number;
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
  getAllEventsAdmin(limit?: number, offset?: number): Promise<Array<Event & { organizer: User }>>;
  deleteEvent(id: string): Promise<void>;

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
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
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

  async getEvents(): Promise<Event[]> {
    return await db.select().from(events).orderBy(events.eventDate);
  }

  async getEvent(id: string): Promise<(Event & { organizer: User }) | undefined> {
    const result = await db
      .select()
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .where(eq(events.id, id));
    
    if (!result[0]) return undefined;
    
    const { passwordHash, ...userWithoutPassword } = result[0].users;
    return {
      ...result[0].events,
      organizer: userWithoutPassword as User,
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
    return result[0];
  }

  async updateEvent(id: string, eventUpdate: Partial<InsertEvent>): Promise<Event> {
    const result = await db.update(events).set(eventUpdate).where(eq(events.id, id)).returning();
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
    const result = await db.select().from(tickets).where(eq(tickets.stripePaymentIntentId, paymentIntentId));
    return result[0];
  }

  async createTicket(insertTicket: InsertTicket): Promise<Ticket> {
    const result = await db.insert(tickets).values(insertTicket).returning();
    return result[0];
  }

  async getTicketByValidationCode(validationCode: string): Promise<Ticket | undefined> {
    const result = await db.select().from(tickets).where(eq(tickets.validationCode, validationCode));
    return result[0];
  }

  async checkInTicket(ticketId: string, organizerId: string): Promise<Ticket> {
    const result = await db
      .update(tickets)
      .set({ 
        checkedInAt: new Date(),
        checkedInBy: organizerId,
      })
      .where(eq(tickets.id, ticketId))
      .returning();
    return result[0];
  }

  async getEventCheckIns(eventId: string): Promise<Array<Ticket & { user: User }>> {
    const result = await db
      .select()
      .from(tickets)
      .innerJoin(users, eq(tickets.userId, users.id))
      .where(eq(tickets.eventId, eventId));
    
    return result.map(row => ({ ...row.tickets, user: row.users }));
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
    return result[0];
  }

  async deletePost(id: string): Promise<void> {
    await db.delete(posts).where(eq(posts.id, id));
  }

  async createStory(insertStory: InsertStory, allowedViewerIds?: string[]): Promise<Story> {
    const result = await db.insert(stories).values(insertStory).returning();
    const story = result[0];
    
    // If private story with allowed viewers, insert them
    if (insertStory.privacy === 'private' && allowedViewerIds && allowedViewerIds.length > 0) {
      await this.setStoryAllowedViewers(story.id, allowedViewerIds);
    }
    
    return story;
  }

  async getActiveStories(viewerId?: string): Promise<Array<Story & { user: User; likeCount: number; isLiked?: boolean; isReshare?: boolean }>> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await db
      .select()
      .from(stories)
      .innerJoin(users, eq(stories.userId, users.id))
      .where(gte(stories.createdAt, twentyFourHoursAgo))
      .orderBy(desc(stories.createdAt));
    
    const storiesWithData = await Promise.all(result.map(async (row) => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      
      // Check privacy - if private, only show to allowed viewers
      if (row.stories.privacy === 'private' && viewerId) {
        const canView = await this.canViewStory(viewerId, row.stories.id);
        if (!canView && row.stories.userId !== viewerId) {
          return null; // Skip this story
        }
      } else if (row.stories.privacy === 'private' && !viewerId) {
        return null; // Skip private stories for unauthenticated users
      }
      
      // Get like count
      const likeCount = await this.getStoryLikeCount(row.stories.id);
      
      // Check if viewer has liked
      let isLiked = false;
      if (viewerId) {
        isLiked = await this.hasUserLikedStory(viewerId, row.stories.id);
      }
      
      return {
        ...row.stories,
        user: userWithoutPassword as User,
        likeCount,
        isLiked,
        isReshare: !!row.stories.originalStoryId,
      };
    }));
    
    // Filter out null values (private stories viewer can't see)
    return storiesWithData.filter(s => s !== null) as Array<Story & { user: User; likeCount: number; isLiked?: boolean; isReshare?: boolean }>;
  }

  async getStory(id: string): Promise<Story | undefined> {
    const result = await db.select().from(stories).where(eq(stories.id, id));
    return result[0];
  }

  async getUserStories(userId: string): Promise<Story[]> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    return await db
      .select()
      .from(stories)
      .where(and(
        eq(stories.userId, userId),
        gte(stories.createdAt, twentyFourHoursAgo)
      ))
      .orderBy(desc(stories.createdAt));
  }

  async deleteStory(id: string): Promise<void> {
    await db.delete(stories).where(eq(stories.id, id));
  }

  // Story likes
  async likeStory(userId: string, storyId: string): Promise<void> {
    await db.insert(storyLikes).values({ storyId, userId }).onConflictDoNothing();
  }

  async unlikeStory(userId: string, storyId: string): Promise<void> {
    await db.delete(storyLikes).where(
      and(
        eq(storyLikes.storyId, storyId),
        eq(storyLikes.userId, userId)
      )
    );
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

  async sendMessage(insertMessage: InsertMessage): Promise<Message> {
    const result = await db.insert(messages).values(insertMessage).returning();
    return result[0];
  }

  async getConversation(userId1: string, userId2: string): Promise<Array<Message & { sender: User; receiver: User; replyTo?: Message & { sender: User } }>> {
    const result = await db
      .select()
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(
        or(
          and(eq(messages.senderId, userId1), eq(messages.receiverId, userId2)),
          and(eq(messages.senderId, userId2), eq(messages.receiverId, userId1))
        )
      )
      .orderBy(messages.createdAt);
    
    const messagesWithSender = await Promise.all(result.map(async row => {
      const receiver = await this.getUser(row.messages.receiverId);
      const { passwordHash: senderHash, ...senderWithoutPassword } = row.users;
      const { passwordHash: receiverHash, ...receiverWithoutPassword } = receiver!;
      
      let replyTo: (Message & { sender: User }) | undefined;
      if (row.messages.replyToId) {
        const replyMessage = await db.select().from(messages).where(eq(messages.id, row.messages.replyToId));
        if (replyMessage.length > 0) {
          const replySender = await this.getUser(replyMessage[0].senderId);
          if (replySender) {
            const { passwordHash: replySenderHash, ...replySenderWithoutPassword } = replySender;
            replyTo = {
              ...replyMessage[0],
              sender: replySenderWithoutPassword as User,
            };
          }
        }
      }
      
      return {
        ...row.messages,
        sender: senderWithoutPassword as User,
        receiver: receiverWithoutPassword as User,
        replyTo,
      };
    }));
    
    return messagesWithSender;
  }

  async getConversations(userId: string): Promise<Array<{ otherUser: User; lastMessage: Message; unreadCount: number }>> {
    const allMessages = await db
      .select()
      .from(messages)
      .where(
        or(
          eq(messages.senderId, userId),
          eq(messages.receiverId, userId)
        )
      )
      .orderBy(desc(messages.createdAt));
    
    const conversationMap = new Map<string, Message>();
    const unreadCountMap = new Map<string, number>();
    
    for (const msg of allMessages) {
      const otherUserId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      
      // Track last message for each conversation
      if (!conversationMap.has(otherUserId)) {
        conversationMap.set(otherUserId, msg);
      }
      
      // Count unread messages from the other user
      if (msg.senderId === otherUserId && !msg.isRead && msg.receiverId === userId) {
        unreadCountMap.set(otherUserId, (unreadCountMap.get(otherUserId) || 0) + 1);
      }
    }
    
    const conversations = await Promise.all(
      Array.from(conversationMap.entries()).map(async ([otherUserId, lastMessage]) => {
        const otherUser = await this.getUser(otherUserId);
        const { passwordHash, ...userWithoutPassword } = otherUser!;
        return {
          otherUser: userWithoutPassword as User,
          lastMessage,
          unreadCount: unreadCountMap.get(otherUserId) || 0,
        };
      })
    );
    
    return conversations;
  }

  async markAsRead(messageId: string): Promise<void> {
    // Get the message to find the conversation participants
    const message = await db.select().from(messages).where(eq(messages.id, messageId));
    if (message.length === 0) return;
    
    const msg = message[0];
    
    // Determine the current user (receiver of this message) and the other user
    const currentUserId = msg.receiverId;
    const otherUserId = msg.senderId;
    
    // Mark ALL unread messages in this conversation where current user is the receiver
    // This includes messages sent by the other user that haven't been read yet
    await db.update(messages)
      .set({ isRead: true })
      .where(
        and(
          eq(messages.receiverId, currentUserId),
          eq(messages.senderId, otherUserId),
          eq(messages.isRead, false),
          or(
            lt(messages.createdAt, msg.createdAt),
            eq(messages.id, messageId)
          )
        )
      );
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

  async universalSearch(query: string, types?: string[]): Promise<{
    users: User[];
    events: Array<Event & { organizer: User }>;
    venues: Venue[];
    posts: Array<Post & { user: User }>;
  }> {
    const searchTypes = types && types.length > 0 ? types : ['users', 'events', 'venues', 'posts'];
    
    const [userResults, eventResults, venueResults, postResults] = await Promise.all([
      searchTypes.includes('users') ? this.searchUsers(query) : Promise.resolve([]),
      searchTypes.includes('events') ? this.searchEvents(query) : Promise.resolve([]),
      searchTypes.includes('venues') ? this.searchVenues(query) : Promise.resolve([]),
      searchTypes.includes('posts') ? this.searchPosts(query) : Promise.resolve([]),
    ]);

    return {
      users: userResults.slice(0, 10),
      events: eventResults.slice(0, 10),
      venues: venueResults.slice(0, 10),
      posts: postResults.slice(0, 10),
    };
  }

  async getTrendingPosts(limit: number = 10): Promise<Array<Post & { user: User; likeCount: number; commentCount: number }>> {
    const postsWithUser = await db
      .select()
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .orderBy(desc(posts.createdAt))
      .limit(50);
    
    const postsWithEngagement = await Promise.all(
      postsWithUser.map(async (row) => {
        const likeCount = await this.getPostLikes(row.posts.id);
        const commentCount = await this.getCommentCount(row.posts.id);
        const { passwordHash, ...userWithoutPassword } = row.users;
        return {
          ...row.posts,
          user: userWithoutPassword as User,
          likeCount,
          commentCount,
          engagementScore: likeCount * 2 + commentCount * 3,
        };
      })
    );
    
    return postsWithEngagement
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, limit)
      .map(({ engagementScore, ...rest }) => rest);
  }

  async getTrendingEvents(limit: number = 10): Promise<Array<Event & { organizer: User; rsvpCount: number; ticketCount: number }>> {
    const allEvents = await db
      .select()
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .where(gte(events.eventDate, new Date()))
      .orderBy(desc(events.eventDate))
      .limit(50);
    
    const eventsWithEngagement = await Promise.all(
      allEvents.map(async (row) => {
        const rsvpResult = await db.select().from(rsvps).where(eq(rsvps.eventId, row.events.id));
        const ticketResult = await db.select().from(tickets).where(eq(tickets.eventId, row.events.id));
        const { passwordHash, ...userWithoutPassword } = row.users;
        return {
          ...row.events,
          organizer: userWithoutPassword as User,
          rsvpCount: rsvpResult.length,
          ticketCount: ticketResult.length,
          engagementScore: rsvpResult.length * 2 + ticketResult.length * 3 + (row.events.isPromoted ? 10 : 0),
        };
      })
    );
    
    return eventsWithEngagement
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, limit)
      .map(({ engagementScore, ...rest }) => rest);
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

  async addComment(insertComment: InsertComment): Promise<Comment> {
    const result = await db.insert(comments).values(insertComment).returning();
    return result[0];
  }

  async getPostComments(postId: string): Promise<Array<Comment & { user: User }>> {
    const result = await db
      .select()
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.postId, postId))
      .orderBy(comments.createdAt);
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comments,
        user: userWithoutPassword as User,
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

  async addCommentReply(userId: string, commentId: string, content: string): Promise<CommentReply> {
    const result = await db.insert(commentReplies).values({
      userId,
      commentId,
      content,
    }).returning();
    return result[0];
  }

  async getCommentReplies(commentId: string): Promise<Array<CommentReply & { user: User }>> {
    const result = await db
      .select()
      .from(commentReplies)
      .innerJoin(users, eq(commentReplies.userId, users.id))
      .where(eq(commentReplies.commentId, commentId))
      .orderBy(commentReplies.createdAt);
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.comment_replies,
        user: userWithoutPassword as User,
      };
    });
  }

  async getCommentReplyCount(commentId: string): Promise<number> {
    const result = await db.select().from(commentReplies).where(eq(commentReplies.commentId, commentId));
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
    const result = await db.insert(reposts).values({ userId, postId }).returning();
    return result[0];
  }

  async unrepostPost(userId: string, postId: string): Promise<void> {
    await db.delete(reposts).where(
      and(eq(reposts.userId, userId), eq(reposts.postId, postId))
    );
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

  async setBuddy(userId: string, buddyId: string): Promise<void> {
    await db.delete(buddies).where(eq(buddies.userId, userId));
    await db.insert(buddies).values({ userId, buddyId });
  }

  async getBuddy(userId: string): Promise<User | undefined> {
    const result = await db
      .select()
      .from(buddies)
      .innerJoin(users, eq(buddies.buddyId, users.id))
      .where(eq(buddies.userId, userId));
    
    if (result.length === 0) return undefined;
    
    const { passwordHash, ...userWithoutPassword } = result[0].users;
    return userWithoutPassword as User;
  }

  async removeBuddy(userId: string): Promise<void> {
    await db.delete(buddies).where(eq(buddies.userId, userId));
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
    return result.length > 0 ? result[0].message : undefined;
  }

  async logDistressAlert(userId: string, buddyId: string, message: string, latitude?: string, longitude?: string): Promise<void> {
    await db.insert(distressAlerts).values({
      userId,
      buddyId,
      message,
      latitude,
      longitude,
    });
  }

  async getDistressAlerts(userId: string): Promise<any[]> {
    const sent = await db
      .select()
      .from(distressAlerts)
      .innerJoin(users, eq(distressAlerts.buddyId, users.id))
      .where(eq(distressAlerts.userId, userId))
      .orderBy(desc(distressAlerts.createdAt));
    
    const received = await db
      .select()
      .from(distressAlerts)
      .innerJoin(users, eq(distressAlerts.userId, users.id))
      .where(eq(distressAlerts.buddyId, userId))
      .orderBy(desc(distressAlerts.createdAt));
    
    const sentAlerts = sent.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.distress_alerts,
        type: 'sent',
        buddy: userWithoutPassword,
      };
    });
    
    const receivedAlerts = received.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.distress_alerts,
        type: 'received',
        sender: userWithoutPassword,
      };
    });
    
    return [...sentAlerts, ...receivedAlerts].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
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

  async checkInVenueTicket(ticketId: string, organizerId: string): Promise<VenueTicket> {
    const result = await db
      .update(venueTickets)
      .set({ 
        checkedInAt: new Date(),
        checkedInBy: organizerId,
        status: 'checked_in'
      })
      .where(eq(venueTickets.id, ticketId))
      .returning();
    return result[0];
  }

  async incrementVenueEntryNightTicketsSold(entryNightId: string): Promise<void> {
    await db
      .update(venueEntryNights)
      .set({ ticketsSold: sql`${venueEntryNights.ticketsSold} + 1` })
      .where(eq(venueEntryNights.id, entryNightId));
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

  async getOrganizerDemographics(organizerId: string): Promise<{
    totalEvents: number;
    totalRsvps: number;
    totalTicketsSold: number;
    totalViews: number;
    totalRevenue: number;
    ageDistribution: { ageGroup: string; count: number; percentage: number }[];
    genderDistribution: { gender: string; count: number; percentage: number }[];
    eventBreakdown: { eventId: string; title: string; rsvps: number; tickets: number; views: number; revenue: number; ticketPrice: number }[];
    ticketSalesByAge: { ageGroup: string; tickets: number; revenue: number; percentage: number }[];
    ticketSalesByGender: { gender: string; tickets: number; revenue: number; percentage: number }[];
    averageTicketPrice: number;
    bestSellingEvent: { title: string; tickets: number; revenue: number } | null;
    conversionRate: number;
  }> {
    // Get all events for this organizer
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
    
    // Get all users who have interacted with these events (RSVPs and ticket purchases)
    const rsvpUsers = await db
      .select({ userId: rsvps.userId })
      .from(rsvps)
      .where(inArray(rsvps.eventId, eventIds));
    
    const ticketUsers = await db
      .select({ userId: tickets.userId })
      .from(tickets)
      .where(inArray(tickets.eventId, eventIds));
    
    // Combine unique user IDs
    const userIdSet = new Set<string>();
    rsvpUsers.forEach(r => userIdSet.add(r.userId));
    ticketUsers.forEach(t => userIdSet.add(t.userId));
    const allUserIds = Array.from(userIdSet);
    
    // Get user demographics
    let userDemographics: { dateOfBirth: string | null; gender: string | null }[] = [];
    if (allUserIds.length > 0) {
      userDemographics = await db
        .select({ dateOfBirth: users.dateOfBirth, gender: users.gender })
        .from(users)
        .where(inArray(users.id, allUserIds));
    }
    
    // Calculate age distribution
    const now = new Date();
    const ageGroups: Record<string, number> = {
      'Under 18': 0,
      '18-25': 0,
      '26-35': 0,
      '36-45': 0,
      '45+': 0,
      'Unknown': 0,
    };
    
    userDemographics.forEach(user => {
      if (!user.dateOfBirth) {
        ageGroups['Unknown']++;
        return;
      }
      
      const birthDate = new Date(user.dateOfBirth);
      const age = Math.floor((now.getTime() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      
      if (age < 18) ageGroups['Under 18']++;
      else if (age <= 25) ageGroups['18-25']++;
      else if (age <= 35) ageGroups['26-35']++;
      else if (age <= 45) ageGroups['36-45']++;
      else ageGroups['45+']++;
    });
    
    const totalUsers = userDemographics.length;
    const ageDistribution = Object.entries(ageGroups)
      .filter(([_, count]) => count > 0)
      .map(([ageGroup, count]) => ({
        ageGroup,
        count,
        percentage: totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0,
      }));
    
    // Calculate gender distribution
    const genderGroups: Record<string, number> = {
      'Male': 0,
      'Female': 0,
      'Rather not say': 0,
      'Unknown': 0,
    };
    
    userDemographics.forEach(user => {
      const gender = user.gender || 'Unknown';
      if (genderGroups[gender] !== undefined) {
        genderGroups[gender]++;
      } else {
        genderGroups['Unknown']++;
      }
    });
    
    const genderDistribution = Object.entries(genderGroups)
      .filter(([_, count]) => count > 0)
      .map(([gender, count]) => ({
        gender,
        count,
        percentage: totalUsers > 0 ? Math.round((count / totalUsers) * 100) : 0,
      }));
    
    // Calculate totals
    const totalRsvps = rsvpUsers.length;
    const totalTicketsSold = ticketUsers.length;
    
    // Get total views
    const viewsResult = await db
      .select({ count: count() })
      .from(eventAnalytics)
      .where(and(
        inArray(eventAnalytics.eventId, eventIds),
        eq(eventAnalytics.actionType, 'view')
      ));
    const totalViews = viewsResult[0]?.count || 0;
    
    // Event breakdown with revenue (calculated per-event for accuracy)
    const eventBreakdown = await Promise.all(
      organizerEvents.map(async (event) => {
        const eventRsvps = await db
          .select({ count: count() })
          .from(rsvps)
          .where(eq(rsvps.eventId, event.id));
        
        const eventTickets = await db
          .select({ count: count() })
          .from(tickets)
          .where(eq(tickets.eventId, event.id));
        
        const eventViews = await db
          .select({ count: count() })
          .from(eventAnalytics)
          .where(and(
            eq(eventAnalytics.eventId, event.id),
            eq(eventAnalytics.actionType, 'view')
          ));
        
        const ticketCount = eventTickets[0]?.count || 0;
        const ticketPrice = event.ticketPrice || 0;
        
        return {
          eventId: event.id,
          title: event.title,
          rsvps: eventRsvps[0]?.count || 0,
          tickets: ticketCount,
          views: eventViews[0]?.count || 0,
          revenue: ticketCount * ticketPrice,
          ticketPrice: ticketPrice,
        };
      })
    );
    
    // Get detailed ticket purchases with user demographics for ticket sales analysis
    const ticketPurchasesWithDemos = await db
      .select({
        eventId: tickets.eventId,
        userId: tickets.userId,
        dateOfBirth: users.dateOfBirth,
        gender: users.gender,
      })
      .from(tickets)
      .innerJoin(users, eq(tickets.userId, users.id))
      .where(inArray(tickets.eventId, eventIds));
    
    // Create event price lookup
    const eventPriceMap = new Map(organizerEvents.map(e => [e.id, e.ticketPrice || 0]));
    
    // Calculate ticket sales by age group with revenue
    const ticketsByAge: Record<string, { tickets: number; revenue: number }> = {
      'Under 18': { tickets: 0, revenue: 0 },
      '18-25': { tickets: 0, revenue: 0 },
      '26-35': { tickets: 0, revenue: 0 },
      '36-45': { tickets: 0, revenue: 0 },
      '45+': { tickets: 0, revenue: 0 },
      'Unknown': { tickets: 0, revenue: 0 },
    };
    
    ticketPurchasesWithDemos.forEach(purchase => {
      const ticketPrice = eventPriceMap.get(purchase.eventId) || 0;
      let ageGroup = 'Unknown';
      
      if (purchase.dateOfBirth) {
        const birthDate = new Date(purchase.dateOfBirth);
        const age = Math.floor((now.getTime() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        
        if (age < 18) ageGroup = 'Under 18';
        else if (age <= 25) ageGroup = '18-25';
        else if (age <= 35) ageGroup = '26-35';
        else if (age <= 45) ageGroup = '36-45';
        else ageGroup = '45+';
      }
      
      ticketsByAge[ageGroup].tickets++;
      ticketsByAge[ageGroup].revenue += ticketPrice;
    });
    
    const totalTicketPurchases = ticketPurchasesWithDemos.length;
    const ticketSalesByAge = Object.entries(ticketsByAge)
      .filter(([_, data]) => data.tickets > 0)
      .map(([ageGroup, data]) => ({
        ageGroup,
        tickets: data.tickets,
        revenue: data.revenue,
        percentage: totalTicketPurchases > 0 ? Math.round((data.tickets / totalTicketPurchases) * 100) : 0,
      }));
    
    // Calculate ticket sales by gender with revenue
    const ticketsByGender: Record<string, { tickets: number; revenue: number }> = {
      'Male': { tickets: 0, revenue: 0 },
      'Female': { tickets: 0, revenue: 0 },
      'Rather not say': { tickets: 0, revenue: 0 },
      'Unknown': { tickets: 0, revenue: 0 },
    };
    
    ticketPurchasesWithDemos.forEach(purchase => {
      const ticketPrice = eventPriceMap.get(purchase.eventId) || 0;
      const gender = purchase.gender || 'Unknown';
      
      if (ticketsByGender[gender]) {
        ticketsByGender[gender].tickets++;
        ticketsByGender[gender].revenue += ticketPrice;
      } else {
        ticketsByGender['Unknown'].tickets++;
        ticketsByGender['Unknown'].revenue += ticketPrice;
      }
    });
    
    const ticketSalesByGender = Object.entries(ticketsByGender)
      .filter(([_, data]) => data.tickets > 0)
      .map(([gender, data]) => ({
        gender,
        tickets: data.tickets,
        revenue: data.revenue,
        percentage: totalTicketPurchases > 0 ? Math.round((data.tickets / totalTicketPurchases) * 100) : 0,
      }));
    
    // Calculate actual total revenue from event breakdown
    const calculatedRevenue = eventBreakdown.reduce((sum, event) => sum + event.revenue, 0);
    
    // Calculate average ticket price
    const averageTicketPrice = totalTicketPurchases > 0 
      ? Math.round(calculatedRevenue / totalTicketPurchases) 
      : 0;
    
    // Find best selling event
    const sortedEvents = [...eventBreakdown].sort((a, b) => b.tickets - a.tickets);
    const bestSellingEvent = sortedEvents.length > 0 && sortedEvents[0].tickets > 0
      ? { title: sortedEvents[0].title, tickets: sortedEvents[0].tickets, revenue: sortedEvents[0].revenue }
      : null;
    
    // Calculate conversion rate
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

  async getContentReports(status?: string): Promise<Array<ContentReport & { reporter: User }>> {
    const query = db
      .select()
      .from(contentReports)
      .innerJoin(users, eq(contentReports.reporterId, users.id))
      .orderBy(desc(contentReports.createdAt));
    
    let results;
    if (status) {
      results = await query.where(eq(contentReports.status, status));
    } else {
      results = await query;
    }
    
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
            gte(userSuspensions.suspendedUntil, now)
          )
        )
      );
    return result[0];
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
    return result[0];
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
    totalRevenue: number;
    activeUsers: number;
    newUsersToday: number;
    pendingReports: number;
    activeOrganizers: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const [userCount] = await db.select({ count: count() }).from(users);
    const [eventCount] = await db.select({ count: count() }).from(events);
    const [ticketCount] = await db.select({ count: count() }).from(tickets);
    const [pendingReportCount] = await db.select({ count: count() }).from(contentReports).where(eq(contentReports.status, 'pending'));
    const [newUserCount] = await db.select({ count: count() }).from(users).where(gte(users.createdAt, today));
    const [organizerCount] = await db.select({ count: count() }).from(users).where(eq(users.userType, 'organizer'));
    
    // Calculate revenue from tickets - get events and sum ticketPrice * ticketCount per event
    const ticketRevenue = await db
      .select({
        eventId: tickets.eventId,
        count: count(),
      })
      .from(tickets)
      .groupBy(tickets.eventId);
    
    let totalRevenue = 0;
    for (const t of ticketRevenue) {
      const event = await db.select().from(events).where(eq(events.id, t.eventId));
      if (event[0]) {
        totalRevenue += (event[0].ticketPrice || 0) * Number(t.count);
      }
    }

    return {
      totalUsers: Number(userCount?.count || 0),
      totalEvents: Number(eventCount?.count || 0),
      totalTicketsSold: Number(ticketCount?.count || 0),
      totalRevenue,
      activeUsers: Number(userCount?.count || 0),
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

  async getAllEventsAdmin(limit: number = 50, offset: number = 0): Promise<Array<Event & { organizer: User }>> {
    const result = await db
      .select()
      .from(events)
      .innerJoin(users, eq(events.organizerId, users.id))
      .orderBy(desc(events.eventDate))
      .limit(limit)
      .offset(offset);
    
    return result.map(r => ({
      ...r.events,
      organizer: r.users,
    }));
  }

  async deleteEvent(id: string): Promise<void> {
    await db.delete(events).where(eq(events.id, id));
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
}

export const storage = new DbStorage();
