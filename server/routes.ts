import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertEventSchema, eventCreateDto, eventUpdateDto, insertTicketSchema, insertRsvpSchema, insertUserSchema, insertPostSchema } from "@shared/schema";
import { hashPassword, userToSessionUser } from "./auth";
import { requireAuth, requireOrganizer } from "./middleware";
import passport from "passport";
import { wsManager } from "./websocket";
import Stripe from "stripe";
import { z } from "zod";
import QRCode from "qrcode";

const stripe = new Stripe(process.env.TESTING_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-11-17.clover",
});

const signupSchema = insertUserSchema.omit({ passwordHash: true }).extend({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Authentication routes
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const { password, ...userData } = signupSchema.parse(req.body);
      
      const existingUsername = await storage.getUserByUsername(userData.username);
      if (existingUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const existingEmail = await storage.getUserByEmail(userData.email);
      if (existingEmail) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const passwordHash = await hashPassword(password);
      const user = await storage.createUser({
        ...userData,
        passwordHash,
      });

      req.login(userToSessionUser(user), (err) => {
        if (err) {
          return res.status(500).json({ message: "Failed to login after signup" });
        }
        res.json({ user: userToSessionUser(user) });
      });
    } catch (error) {
      res.status(400).json({ message: "Invalid user data" });
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: Express.User | false, info: any) => {
      if (err) {
        return res.status(500).json({ message: "Login failed" });
      }
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({ message: "Login failed" });
        }
        res.json({ user });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.json({ message: "Logged out successfully" });
    });
  });

  app.get("/api/auth/session", (req, res) => {
    if (req.isAuthenticated()) {
      res.json({ user: req.user });
    } else {
      res.status(401).json({ message: "Not authenticated" });
    }
  });

  // Update user profile
  app.patch("/api/users/:userId", requireAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      
      // Security check: Users can only update their own profile
      if (req.user!.id !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }
      
      const { updateUserSchema } = await import("@shared/schema");
      const updates = updateUserSchema.parse(req.body);
      
      const updatedUser = await storage.updateUser(userId, updates);
      res.json(updatedUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid profile data", errors: error.errors });
      }
      console.error('Error updating profile:', error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Events
  app.get("/api/events", async (req, res) => {
    try {
      const events = await storage.getEvents();
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch events" });
    }
  });

  app.get("/api/events/my-events", requireAuth, async (req, res) => {
    try {
      const events = await storage.getEventsByOrganizer(req.user!.id);
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch your events" });
    }
  });

  app.get("/api/events/:id", async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch event" });
    }
  });

  app.post("/api/events", requireOrganizer, async (req, res) => {
    try {
      const parsedData = eventCreateDto.omit({ organizerId: true }).parse(req.body);
      const event = await storage.createEvent({
        ...parsedData,
        organizerId: req.user!.id,
      });
      res.json(event);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Validation error creating event:', error.errors);
        return res.status(400).json({ message: "Invalid event data", errors: error.errors });
      }
      console.error('Error creating event:', error);
      res.status(500).json({ message: "Failed to create event" });
    }
  });

  app.put("/api/events/:id", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      
      // Verify the user owns this event
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to edit this event" });
      }

      const parsedData = eventUpdateDto.parse(req.body);
      const updatedEvent = await storage.updateEvent(req.params.id, parsedData);
      res.json(updatedEvent);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Validation error updating event:', error.errors);
        return res.status(400).json({ message: "Invalid event data", errors: error.errors });
      }
      console.error('Error updating event:', error);
      res.status(500).json({ message: "Failed to update event" });
    }
  });

  // Ticket Tiers
  app.get("/api/events/:eventId/ticket-tiers", async (req, res) => {
    try {
      const tiers = await storage.getEventTicketTiers(req.params.eventId);
      res.json(tiers);
    } catch (error) {
      console.error('Error fetching ticket tiers:', error);
      res.status(500).json({ message: "Failed to fetch ticket tiers" });
    }
  });

  app.post("/api/events/:eventId/ticket-tiers", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to edit this event" });
      }

      const { tiers } = req.body;
      if (!Array.isArray(tiers)) {
        return res.status(400).json({ message: "Tiers must be an array" });
      }

      const tiersWithEventId = tiers.map(tier => ({
        ...tier,
        eventId: req.params.eventId,
        salesEndDate: tier.salesEndDate ? new Date(tier.salesEndDate) : null,
      }));

      const createdTiers = await storage.createTicketTiers(tiersWithEventId);
      res.json(createdTiers);
    } catch (error) {
      console.error('Error creating ticket tiers:', error);
      res.status(500).json({ message: "Failed to create ticket tiers" });
    }
  });

  app.put("/api/ticket-tiers/:id", requireOrganizer, async (req, res) => {
    try {
      const tier = await storage.getTicketTier(req.params.id);
      if (!tier) {
        return res.status(404).json({ message: "Ticket tier not found" });
      }

      const event = await storage.getEvent(tier.eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to edit this ticket tier" });
      }

      const updatedTier = await storage.updateTicketTier(req.params.id, req.body);
      res.json(updatedTier);
    } catch (error) {
      console.error('Error updating ticket tier:', error);
      res.status(500).json({ message: "Failed to update ticket tier" });
    }
  });

  app.delete("/api/ticket-tiers/:id", requireOrganizer, async (req, res) => {
    try {
      const tier = await storage.getTicketTier(req.params.id);
      if (!tier) {
        return res.status(404).json({ message: "Ticket tier not found" });
      }

      const event = await storage.getEvent(tier.eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to delete this ticket tier" });
      }

      await storage.deleteTicketTier(req.params.id);
      res.json({ message: "Ticket tier deleted successfully" });
    } catch (error) {
      console.error('Error deleting ticket tier:', error);
      res.status(500).json({ message: "Failed to delete ticket tier" });
    }
  });

  // Tickets
  app.get("/api/tickets", requireAuth, async (req, res) => {
    try {
      const tickets = await storage.getUserTickets(req.user!.id);
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tickets" });
    }
  });

  app.post("/api/tickets/purchase", requireAuth, async (req, res) => {
    try {
      const { eventId } = req.body;
      const userId = req.user!.id;
      
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.ticketPrice === 0) {
        return res.status(400).json({ message: "This is a free event, use RSVP instead" });
      }

      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: event.title,
                description: event.description,
              },
              unit_amount: event.ticketPrice,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${req.headers.origin}/ticket-wallet?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.headers.origin}/discover?canceled=true`,
        metadata: {
          eventId,
          userId,
        },
      });

      res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  // Verify Stripe checkout session and create ticket
  app.post("/api/tickets/verify-payment", requireAuth, async (req, res) => {
    try {
      const requestSchema = z.object({
        sessionId: z.string().min(1),
      });
      
      const { sessionId } = requestSchema.parse(req.body);
      const userId = req.user!.id;

      // Retrieve the session from Stripe to verify payment
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      // Verify payment was successful
      if (session.payment_status !== 'paid') {
        return res.status(400).json({ message: "Payment not completed" });
      }

      // Validate metadata exists
      if (!session.metadata?.userId || !session.metadata?.eventId) {
        return res.status(400).json({ message: "Invalid session metadata" });
      }

      // CRITICAL SECURITY CHECK: Verify the requesting user matches the session metadata
      if (session.metadata.userId !== userId) {
        console.error(`Security violation: User ${userId} attempted to claim ticket for user ${session.metadata.userId}`);
        return res.status(403).json({ message: "Unauthorized: Session does not belong to you" });
      }

      // Verify we haven't already created a ticket for this session (idempotency)
      const existingTicket = await storage.getTicketByPaymentIntent(session.payment_intent as string);
      if (existingTicket) {
        return res.json({ message: "Ticket already created", ticket: existingTicket });
      }

      // Create the ticket
      const ticketData = insertTicketSchema.parse({
        userId: session.metadata.userId,
        eventId: session.metadata.eventId,
        stripePaymentIntentId: session.payment_intent as string,
        status: "confirmed",
      });
      
      const ticket = await storage.createTicket(ticketData);
      res.json({ message: "Ticket created successfully", ticket });
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Invalid request:', error);
        return res.status(400).json({ message: "Invalid request data" });
      }
      console.error('Error verifying payment:', error);
      res.status(500).json({ message: "Failed to verify payment" });
    }
  });

  // Get QR code for a ticket
  app.get("/api/tickets/:ticketId/qr", requireAuth, async (req, res) => {
    try {
      const ticket = await storage.getTicket(req.params.ticketId);
      
      if (!ticket) {
        return res.status(404).json({ message: "Ticket not found" });
      }

      // Verify the ticket belongs to the requesting user
      if (ticket.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view this ticket" });
      }

      // Generate QR code from the validation code
      const qrCodeDataUrl = await QRCode.toDataURL(ticket.validationCode, {
        errorCorrectionLevel: 'H',
        type: 'image/png',
        width: 300,
        margin: 2,
      });

      res.json({ qrCode: qrCodeDataUrl });
    } catch (error) {
      console.error('Error generating QR code:', error);
      res.status(500).json({ message: "Failed to generate QR code" });
    }
  });

  // Validate a ticket by validation code (for organizers)
  app.post("/api/tickets/validate", requireAuth, async (req, res) => {
    try {
      const requestSchema = z.object({
        validationCode: z.string().min(1),
        eventId: z.string().min(1),
      });

      const parseResult = requestSchema.safeParse(req.body);
      if (!parseResult.success) {
        console.error('Validation error:', parseResult.error.errors);
        console.error('Request body:', req.body);
        return res.status(400).json({ 
          message: "Invalid request data",
          errors: parseResult.error.errors 
        });
      }

      const { validationCode, eventId } = parseResult.data;
      const organizerId = req.user!.id;

      // Verify the user is the organizer of this event
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.organizerId !== organizerId) {
        return res.status(403).json({ message: "Not authorized to validate tickets for this event" });
      }

      // Find the ticket by validation code
      const ticket = await storage.getTicketByValidationCode(validationCode);
      if (!ticket) {
        return res.status(404).json({ message: "Invalid ticket code" });
      }

      // Verify the ticket is for this event
      if (ticket.eventId !== eventId) {
        return res.status(400).json({ message: "This ticket is not for this event" });
      }

      // Check if already checked in
      if (ticket.checkedInAt) {
        return res.json({
          valid: false,
          alreadyCheckedIn: true,
          message: "Ticket already used",
          checkedInAt: ticket.checkedInAt,
          ticket,
        });
      }

      // Mark ticket as checked in
      const updatedTicket = await storage.checkInTicket(ticket.id, organizerId);

      res.json({
        valid: true,
        alreadyCheckedIn: false,
        message: "Ticket validated successfully",
        ticket: updatedTicket,
      });
    } catch (error) {
      console.error('Error validating ticket:', error);
      res.status(500).json({ message: "Failed to validate ticket" });
    }
  });

  // Get check-in status for an event (for organizers)
  app.get("/api/events/:eventId/check-ins", requireAuth, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // Verify the user is the organizer of this event
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view check-ins for this event" });
      }

      const checkIns = await storage.getEventCheckIns(req.params.eventId);
      res.json(checkIns);
    } catch (error) {
      console.error('Error fetching check-ins:', error);
      res.status(500).json({ message: "Failed to fetch check-ins" });
    }
  });

  // RSVPs
  app.get("/api/rsvps", requireAuth, async (req, res) => {
    try {
      const rsvps = await storage.getUserRsvps(req.user!.id);
      res.json(rsvps);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch RSVPs" });
    }
  });

  app.post("/api/rsvps", requireAuth, async (req, res) => {
    try {
      const { eventId } = req.body;
      const userId = req.user!.id;
      
      // Fetch the event to validate it's free and requires RSVP
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // Only allow RSVPs for free events
      if (event.ticketPrice > 0) {
        return res.status(400).json({ message: "This is a paid event, please purchase a ticket instead" });
      }

      // Check if RSVP already exists
      const existingRsvp = await storage.getRsvp(userId, eventId);
      if (existingRsvp) {
        return res.status(400).json({ message: "Already RSVPed to this event" });
      }

      const rsvpData = insertRsvpSchema.parse({ userId, eventId });
      const rsvp = await storage.createRsvp(rsvpData);
      
      // Also create a ticket for the free event
      const ticketData = insertTicketSchema.parse({
        userId,
        eventId,
        status: "confirmed",
      });
      await storage.createTicket(ticketData);
      
      res.json(rsvp);
    } catch (error) {
      res.status(400).json({ message: "Failed to create RSVP" });
    }
  });

  app.delete("/api/rsvps/:eventId", requireAuth, async (req, res) => {
    try {
      await storage.cancelRsvp(req.user!.id, req.params.eventId);
      res.json({ message: "RSVP cancelled" });
    } catch (error) {
      res.status(500).json({ message: "Failed to cancel RSVP" });
    }
  });

  // Posts
  app.get("/api/posts", async (req, res) => {
    try {
      const posts = await storage.getPosts();
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch posts" });
    }
  });

  app.get("/api/posts/user/:userId", async (req, res) => {
    try {
      const posts = await storage.getUserPosts(req.params.userId);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user posts" });
    }
  });

  app.post("/api/posts", requireAuth, async (req, res) => {
    try {
      const postData = insertPostSchema.omit({ userId: true }).parse(req.body);
      const post = await storage.createPost({
        ...postData,
        userId: req.user!.id,
      });
      res.json(post);
    } catch (error) {
      res.status(400).json({ message: "Invalid post data" });
    }
  });

  app.delete("/api/posts/:id", requireAuth, async (req, res) => {
    try {
      const post = await storage.getPost(req.params.id);
      if (!post) {
        return res.status(404).json({ message: "Post not found" });
      }
      
      if (post.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to delete this post" });
      }
      
      await storage.deletePost(req.params.id);
      res.json({ message: "Post deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete post" });
    }
  });

  // Post Interactions - Likes
  app.post("/api/posts/:postId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      const alreadyLiked = await storage.hasUserLikedPost(userId, postId);
      if (alreadyLiked) {
        return res.status(400).json({ message: "Already liked this post" });
      }
      
      const like = await storage.likePost(userId, postId);
      res.json(like);
    } catch (error) {
      res.status(500).json({ message: "Failed to like post" });
    }
  });

  app.delete("/api/posts/:postId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      await storage.unlikePost(userId, postId);
      res.json({ message: "Unliked post" });
    } catch (error) {
      res.status(500).json({ message: "Failed to unlike post" });
    }
  });

  app.get("/api/posts/:postId/likes", requireAuth, async (req, res) => {
    try {
      const postId = req.params.postId;
      const userId = req.user!.id;
      
      const count = await storage.getPostLikes(postId);
      const isLiked = await storage.hasUserLikedPost(userId, postId);
      
      res.json({ count, isLiked });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch likes" });
    }
  });

  // Post Interactions - Comments
  app.post("/api/posts/:postId/comments", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      const { content } = req.body;
      
      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Comment content is required" });
      }
      
      const comment = await storage.addComment({
        userId,
        postId,
        content: content.trim(),
      });
      
      res.json(comment);
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment" });
    }
  });

  app.get("/api/posts/:postId/comments", async (req, res) => {
    try {
      const postId = req.params.postId;
      const comments = await storage.getPostComments(postId);
      res.json(comments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  // Post Interactions - Bookmarks
  app.post("/api/posts/:postId/bookmark", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      const alreadyBookmarked = await storage.hasUserBookmarkedPost(userId, postId);
      if (alreadyBookmarked) {
        return res.status(400).json({ message: "Already bookmarked this post" });
      }
      
      const bookmark = await storage.bookmarkPost(userId, postId);
      res.json(bookmark);
    } catch (error) {
      res.status(500).json({ message: "Failed to bookmark post" });
    }
  });

  app.delete("/api/posts/:postId/bookmark", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      await storage.unbookmarkPost(userId, postId);
      res.json({ message: "Removed bookmark" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove bookmark" });
    }
  });

  // Follows
  app.post("/api/follows/:userId", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = req.params.userId;
      
      if (followerId === followingId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
      }
      
      const isAlreadyFollowing = await storage.isFollowing(followerId, followingId);
      if (isAlreadyFollowing) {
        return res.status(400).json({ message: "Already following this user" });
      }
      
      const follow = await storage.followUser(followerId, followingId);
      res.json(follow);
    } catch (error) {
      res.status(500).json({ message: "Failed to follow user" });
    }
  });
  
  app.delete("/api/follows/:userId", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = req.params.userId;
      
      await storage.unfollowUser(followerId, followingId);
      res.json({ message: "Unfollowed successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to unfollow user" });
    }
  });
  
  app.get("/api/follows/:userId/status", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = req.params.userId;
      
      const isFollowing = await storage.isFollowing(followerId, followingId);
      res.json({ isFollowing });
    } catch (error) {
      res.status(500).json({ message: "Failed to check follow status" });
    }
  });
  
  app.get("/api/follows/:userId/followers", async (req, res) => {
    try {
      const followers = await storage.getFollowers(req.params.userId);
      res.json(followers);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch followers" });
    }
  });
  
  app.get("/api/follows/:userId/following", async (req, res) => {
    try {
      const following = await storage.getFollowing(req.params.userId);
      res.json(following);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch following" });
    }
  });

  // Messages
  app.post("/api/messages", requireAuth, async (req, res) => {
    try {
      const { receiverId, content } = req.body;
      const senderId = req.user!.id;
      
      if (senderId === receiverId) {
        return res.status(400).json({ message: "Cannot message yourself" });
      }
      
      const message = await storage.sendMessage({
        senderId,
        receiverId,
        content,
        isRead: false,
      });
      
      // Broadcast message via WebSocket to recipient
      const sender = await storage.getUser(senderId);
      const receiver = await storage.getUser(receiverId);
      
      if (sender && receiver) {
        const { passwordHash: senderHash, ...senderData } = sender;
        const { passwordHash: receiverHash, ...receiverData } = receiver;
        
        wsManager.broadcastMessage(senderId, receiverId, {
          ...message,
          sender: senderData,
          receiver: receiverData,
        });
      }
      
      res.json(message);
    } catch (error) {
      res.status(500).json({ message: "Failed to send message" });
    }
  });
  
  app.get("/api/messages/:userId", requireAuth, async (req, res) => {
    try {
      const userId1 = req.user!.id;
      const userId2 = req.params.userId;
      
      const conversation = await storage.getConversation(userId1, userId2);
      res.json(conversation);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch conversation" });
    }
  });
  
  app.get("/api/messages", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const conversations = await storage.getConversations(userId);
      res.json(conversations);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch conversations" });
    }
  });
  
  app.patch("/api/messages/:id/read", requireAuth, async (req, res) => {
    try {
      await storage.markAsRead(req.params.id);
      
      // Broadcast read status via WebSocket
      wsManager.broadcastMessageRead(req.params.id, req.user!.id);
      
      res.json({ message: "Message marked as read" });
    } catch (error) {
      res.status(500).json({ message: "Failed to mark message as read" });
    }
  });

  // User search and profile
  app.get("/api/users/search", async (req, res) => {
    try {
      const query = (req.query.q as string || "").trim();
      
      // Validate query length (min 2 chars)
      if (query.length < 2) {
        return res.json([]);
      }
      
      // Limit query length for safety
      if (query.length > 50) {
        return res.status(400).json({ message: "Search query too long" });
      }
      
      const users = await storage.searchUsers(query);
      
      // Limit results to prevent large responses
      const limitedResults = users.slice(0, 20);
      
      res.json(limitedResults);
    } catch (error) {
      res.status(500).json({ message: "Failed to search users" });
    }
  });
  
  app.get("/api/users/:userId/profile", async (req, res) => {
    try {
      const profile = await storage.getUserProfile(req.params.userId);
      if (!profile) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(profile);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // User profile (legacy - keep for backward compatibility)
  app.get("/api/users/:username", async (req, res) => {
    try {
      const user = await storage.getUserByUsername(req.params.username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Don't send password hash to client
      const { passwordHash, ...userWithoutPassword } = user;

      // Get user's events or RSVPs based on user type
      if (user.userType === "organizer") {
        const events = await storage.getUserEvents(user.id);
        res.json({ ...userWithoutPassword, events });
      } else {
        const rsvps = await storage.getUserRsvps(user.id);
        res.json({ ...userWithoutPassword, rsvps });
      }
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
