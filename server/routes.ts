import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertEventSchema, insertTicketSchema, insertRsvpSchema } from "@shared/schema";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-11-17.clover",
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Events
  app.get("/api/events", async (req, res) => {
    try {
      const events = await storage.getEvents();
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch events" });
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

  app.post("/api/events", async (req, res) => {
    try {
      const eventData = insertEventSchema.parse(req.body);
      const event = await storage.createEvent(eventData);
      res.json(event);
    } catch (error) {
      res.status(400).json({ message: "Invalid event data" });
    }
  });

  // Tickets
  app.get("/api/tickets", async (req, res) => {
    try {
      if (!req.query.userId) {
        return res.status(400).json({ message: "userId is required" });
      }
      const tickets = await storage.getUserTickets(req.query.userId as string);
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tickets" });
    }
  });

  app.post("/api/tickets/purchase", async (req, res) => {
    try {
      const { eventId, userId } = req.body;
      
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
        success_url: `${req.headers.origin}/ticket-wallet?success=true`,
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
  // This endpoint is called by the client after successful payment redirect
  // 
  // SECURITY NOTE: This endpoint currently accepts userId from the request body
  // because the application does not yet have proper authentication middleware.
  // In production, this MUST be replaced with authenticated session middleware
  // that extracts the userId from a verified JWT/session token, not from the request body.
  // 
  // TODO: Implement authentication middleware and replace userId parameter with
  // req.user.id from authenticated session before production deployment.
  app.post("/api/tickets/verify-payment", async (req, res) => {
    try {
      // Validate request body
      const requestSchema = z.object({
        sessionId: z.string().min(1),
        userId: z.string().min(1), // TODO: Replace with req.user.id from auth middleware
      });
      
      const { sessionId, userId } = requestSchema.parse(req.body);

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

  // RSVPs
  app.get("/api/rsvps", async (req, res) => {
    try {
      if (!req.query.userId) {
        return res.status(400).json({ message: "userId is required" });
      }
      const rsvps = await storage.getUserRsvps(req.query.userId as string);
      res.json(rsvps);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch RSVPs" });
    }
  });

  app.post("/api/rsvps", async (req, res) => {
    try {
      const rsvpData = insertRsvpSchema.parse(req.body);
      
      // Fetch the event to validate it's free and requires RSVP
      const event = await storage.getEvent(rsvpData.eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // Only allow RSVPs for free events
      if (event.ticketPrice > 0) {
        return res.status(400).json({ message: "This is a paid event, please purchase a ticket instead" });
      }

      // Check if RSVP already exists
      const existingRsvp = await storage.getRsvp(rsvpData.userId, rsvpData.eventId);
      if (existingRsvp) {
        return res.status(400).json({ message: "Already RSVPed to this event" });
      }

      const rsvp = await storage.createRsvp(rsvpData);
      
      // Also create a ticket for the free event
      const ticketData = insertTicketSchema.parse({
        userId: rsvpData.userId,
        eventId: rsvpData.eventId,
        status: "confirmed",
      });
      await storage.createTicket(ticketData);
      
      res.json(rsvp);
    } catch (error) {
      res.status(400).json({ message: "Failed to create RSVP" });
    }
  });

  app.delete("/api/rsvps/:eventId", async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) {
        return res.status(400).json({ message: "userId is required" });
      }
      await storage.cancelRsvp(userId as string, req.params.eventId);
      res.json({ message: "RSVP cancelled" });
    } catch (error) {
      res.status(500).json({ message: "Failed to cancel RSVP" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
