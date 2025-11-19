import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertEventSchema, insertTicketSchema, insertRsvpSchema } from "@shared/schema";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-11-20.acacia",
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

  app.post("/api/tickets/confirm", async (req, res) => {
    try {
      const ticketData = insertTicketSchema.parse(req.body);
      const ticket = await storage.createTicket(ticketData);
      res.json(ticket);
    } catch (error) {
      res.status(400).json({ message: "Invalid ticket data" });
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
      
      // Check if RSVP already exists
      const existingRsvp = await storage.getRsvp(rsvpData.userId, rsvpData.eventId);
      if (existingRsvp) {
        return res.status(400).json({ message: "Already RSVPed to this event" });
      }

      const rsvp = await storage.createRsvp(rsvpData);
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
