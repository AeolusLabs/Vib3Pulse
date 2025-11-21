import { 
  type User, 
  type InsertUser,
  type Event,
  type InsertEvent,
  type Ticket,
  type InsertTicket,
  type Rsvp,
  type InsertRsvp,
  type Post,
  type InsertPost,
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
  users,
  events,
  tickets,
  rsvps,
  posts,
  follows,
  messages,
  likes,
  comments,
  bookmarks
} from "@shared/schema";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { eq, and, gte, lt, or, ilike, desc } from "drizzle-orm";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  getEvents(): Promise<Event[]>;
  getEvent(id: string): Promise<Event | undefined>;
  getUserEvents(userId: string): Promise<Event[]>;
  getEventsByOrganizer(organizerId: string): Promise<Event[]>;
  createEvent(event: InsertEvent): Promise<Event>;
  updateEvent(id: string, event: Partial<InsertEvent>): Promise<Event>;
  
  getUserTickets(userId: string): Promise<Array<Ticket & { event: Event }>>;
  getTicket(id: string): Promise<Ticket | undefined>;
  getTicketByPaymentIntent(paymentIntentId: string): Promise<Ticket | undefined>;
  createTicket(ticket: InsertTicket): Promise<Ticket>;
  
  getUserRsvps(userId: string): Promise<Array<Rsvp & { event: Event }>>;
  getRsvp(userId: string, eventId: string): Promise<Rsvp | undefined>;
  createRsvp(rsvp: InsertRsvp): Promise<Rsvp>;
  cancelRsvp(userId: string, eventId: string): Promise<void>;
  
  getPosts(): Promise<Array<Post & { user: User }>>;
  getPost(id: string): Promise<Post | undefined>;
  getUserPosts(userId: string): Promise<Post[]>;
  createPost(post: InsertPost): Promise<Post>;
  deletePost(id: string): Promise<void>;
  
  followUser(followerId: string, followingId: string): Promise<Follow>;
  unfollowUser(followerId: string, followingId: string): Promise<void>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  getFollowers(userId: string): Promise<Array<Follow & { follower: User }>>;
  getFollowing(userId: string): Promise<Array<Follow & { following: User }>>;
  
  sendMessage(message: InsertMessage): Promise<Message>;
  getConversation(userId1: string, userId2: string): Promise<Array<Message & { sender: User; receiver: User }>>;
  getConversations(userId: string): Promise<Array<{ otherUser: User; lastMessage: Message }>>;
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

  async getEvents(): Promise<Event[]> {
    return await db.select().from(events).orderBy(events.eventDate);
  }

  async getEvent(id: string): Promise<Event | undefined> {
    const result = await db.select().from(events).where(eq(events.id, id));
    return result[0];
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

  async getConversations(userId: string): Promise<Array<{ otherUser: User; lastMessage: Message }>> {
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
    
    for (const msg of allMessages) {
      const otherUserId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!conversationMap.has(otherUserId)) {
        conversationMap.set(otherUserId, msg);
      }
    }
    
    const conversations = await Promise.all(
      Array.from(conversationMap.entries()).map(async ([otherUserId, lastMessage]) => {
        const otherUser = await this.getUser(otherUserId);
        const { passwordHash, ...userWithoutPassword } = otherUser!;
        return {
          otherUser: userWithoutPassword as User,
          lastMessage,
        };
      })
    );
    
    return conversations;
  }

  async markAsRead(messageId: string): Promise<void> {
    await db.update(messages).set({ isRead: true }).where(eq(messages.id, messageId));
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
}

export const storage = new DbStorage();
