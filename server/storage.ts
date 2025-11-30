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
  type Follow,
  type InsertFollow,
  type Message,
  type InsertMessage,
  type Like,
  type InsertLike,
  type Comment,
  type InsertComment,
  type Bookmark,
  type InsertBookmark,
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
  users,
  events,
  tickets,
  ticketTiers,
  rsvps,
  posts,
  stories,
  follows,
  messages,
  likes,
  comments,
  bookmarks,
  buddies,
  distressMessages,
  distressAlerts,
  eventAnalytics,
  venues,
  venueEntryNights,
  venueTickets,
  venueAnalytics
} from "@shared/schema";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { eq, and, gte, lt, or, ilike, desc, sql, count } from "drizzle-orm";
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
  createPost(post: InsertPost): Promise<Post>;
  deletePost(id: string): Promise<void>;
  
  createStory(story: InsertStory): Promise<Story>;
  getActiveStories(): Promise<Array<Story & { user: User }>>;
  getUserStories(userId: string): Promise<Story[]>;
  deleteStory(id: string): Promise<void>;
  
  followUser(followerId: string, followingId: string): Promise<Follow>;
  unfollowUser(followerId: string, followingId: string): Promise<void>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  getFollowers(userId: string): Promise<Array<Follow & { follower: User }>>;
  getFollowing(userId: string): Promise<Array<Follow & { following: User }>>;
  
  sendMessage(message: InsertMessage): Promise<Message>;
  getConversation(userId1: string, userId2: string): Promise<Array<Message & { sender: User; receiver: User }>>;
  getConversations(userId: string): Promise<Array<{ otherUser: User; lastMessage: Message; unreadCount: number }>>;
  markAsRead(messageId: string): Promise<void>;
  
  getUserProfile(userId: string): Promise<{ user: User; posts: Post[]; events: Array<Rsvp & { event: Event }> } | undefined>;
  searchUsers(query: string): Promise<User[]>;
  
  likePost(userId: string, postId: string): Promise<Like>;
  unlikePost(userId: string, postId: string): Promise<void>;
  getPostLikes(postId: string): Promise<number>;
  hasUserLikedPost(userId: string, postId: string): Promise<boolean>;
  
  addComment(comment: InsertComment): Promise<Comment>;
  getPostComments(postId: string): Promise<Array<Comment & { user: User }>>;
  getCommentCount(postId: string): Promise<number>;
  
  bookmarkPost(userId: string, postId: string): Promise<Bookmark>;
  unbookmarkPost(userId: string, postId: string): Promise<void>;
  hasUserBookmarkedPost(userId: string, postId: string): Promise<boolean>;

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
      .orderBy(posts.createdAt);
  }

  async createPost(insertPost: InsertPost): Promise<Post> {
    const result = await db.insert(posts).values(insertPost).returning();
    return result[0];
  }

  async deletePost(id: string): Promise<void> {
    await db.delete(posts).where(eq(posts.id, id));
  }

  async createStory(insertStory: InsertStory): Promise<Story> {
    const result = await db.insert(stories).values(insertStory).returning();
    return result[0];
  }

  async getActiveStories(): Promise<Array<Story & { user: User }>> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await db
      .select()
      .from(stories)
      .innerJoin(users, eq(stories.userId, users.id))
      .where(gte(stories.createdAt, twentyFourHoursAgo))
      .orderBy(desc(stories.createdAt));
    
    return result.map(row => {
      const { passwordHash, ...userWithoutPassword } = row.users;
      return {
        ...row.stories,
        user: userWithoutPassword as User,
      };
    });
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

  async getConversation(userId1: string, userId2: string): Promise<Array<Message & { sender: User; receiver: User }>> {
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
      return {
        ...row.messages,
        sender: senderWithoutPassword as User,
        receiver: receiverWithoutPassword as User,
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
}

export const storage = new DbStorage();
