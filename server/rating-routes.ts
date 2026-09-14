import type { Express } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { requireAuth } from "./middleware.js";
import { ratingSubmitLimiter } from "./security.js";

const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  reviewText: z.string().max(500).optional(),
});

export function registerRatingRoutes(app: Express): void {

  // GET /api/events/:eventId/ratings — public
  app.get("/api/events/:eventId/ratings", async (req, res) => {
    try {
      const { eventId } = req.params;
      const stats = await storage.getEventRatingStats(eventId);
      res.json({
        eventId,
        averageRating: stats.averageRating,
        totalRatings: stats.totalRatings,
        distribution: stats.distribution,
      });
    } catch (error) {
      console.error("[Ratings] Get event ratings error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get ratings", statusCode: 500 });
    }
  });

  // GET /api/events/:eventId/user-rating — auth required
  app.get("/api/events/:eventId/user-rating", requireAuth, async (req, res) => {
    try {
      const { eventId } = req.params;
      const userId = req.user!.id;
      const existing = await storage.getUserEventRating(eventId, userId);
      if (!existing) {
        return res.json({ hasRated: false });
      }
      return res.json({ hasRated: true, rating: existing.rating, ratedAt: existing.createdAt });
    } catch (error) {
      console.error("[Ratings] Get user event rating error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get rating", statusCode: 500 });
    }
  });

  // GET /api/organizers/:organizerId/rating — public
  app.get("/api/organizers/:organizerId/rating", async (req, res) => {
    try {
      const { organizerId } = req.params;
      const rating = await storage.getOrganizerRating(organizerId);
      res.json({
        organizerId,
        averageRating: rating.averageRating,
        totalRatings: rating.totalRatings,
        eventsRated: rating.eventsRated,
      });
    } catch (error) {
      console.error("[Ratings] Get organizer rating error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get organizer rating", statusCode: 500 });
    }
  });

  // POST /api/events/:eventId/ratings — auth required, full validation chain.
  // Upsert: submitting again updates your existing rating instead of being
  // rejected forever (every mainstream rating product lets you edit a review).
  app.post("/api/events/:eventId/ratings", requireAuth, ratingSubmitLimiter, async (req, res) => {
    try {
      const { eventId } = req.params;
      const userId = req.user!.id;

      // 1. Validate rating value
      const parseResult = ratingSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "INVALID_RATING", message: "Rating must be 1-5", statusCode: 400 });
      }
      const { rating, reviewText } = parseResult.data;

      // 2. Event must exist
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({ error: "EVENT_NOT_FOUND", message: "Event not found", statusCode: 404 });
      }

      // 3. Event must have ended — prefer eventEndDate, fall back to eventDate
      const eventEnd = event.eventEndDate ?? event.eventDate;
      if (new Date(eventEnd) > new Date()) {
        return res.status(403).json({ error: "EVENT_NOT_ENDED", message: "Event hasn't ended yet", statusCode: 403 });
      }

      // 4. User must have a confirmed, checked-in ticket for this event
      const userTickets = await storage.getUserTickets(userId);
      const attendedTicket = userTickets.find(
        (t) => t.eventId === eventId && t.checkedInAt !== null && t.status === "confirmed"
      );
      if (!attendedTicket) {
        return res.status(403).json({ error: "NOT_ATTENDED", message: "You didn't attend this event", statusCode: 403 });
      }

      // 5. Create or update rating
      const created = await storage.createEventRating(eventId, userId, rating, reviewText ?? null);
      return res.status(201).json({
        id: created.id,
        eventId: created.eventId,
        userId: created.userId,
        rating: created.rating,
        reviewText: created.reviewText,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
    } catch (error: any) {
      console.error("[Ratings] Post rating error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to submit rating", statusCode: 500 });
    }
  });

  // ── Venue ratings — same shape, eligibility is "attended a past, checked-in
  // entry night at this venue" instead of "attended this specific event" ──

  app.get("/api/venues/:venueId/ratings", async (req, res) => {
    try {
      const { venueId } = req.params;
      const stats = await storage.getVenueRatingStats(venueId);
      res.json({ venueId, averageRating: stats.averageRating, totalRatings: stats.totalRatings, distribution: stats.distribution });
    } catch (error) {
      console.error("[Ratings] Get venue ratings error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get ratings", statusCode: 500 });
    }
  });

  app.get("/api/venues/:venueId/user-rating", requireAuth, async (req, res) => {
    try {
      const { venueId } = req.params;
      const existing = await storage.getUserVenueRating(venueId, req.user!.id);
      if (!existing) return res.json({ hasRated: false });
      return res.json({ hasRated: true, rating: existing.rating, reviewText: existing.reviewText, ratedAt: existing.createdAt });
    } catch (error) {
      console.error("[Ratings] Get user venue rating error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get rating", statusCode: 500 });
    }
  });

  app.post("/api/venues/:venueId/ratings", requireAuth, ratingSubmitLimiter, async (req, res) => {
    try {
      const { venueId } = req.params;
      const userId = req.user!.id;

      const parseResult = ratingSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "INVALID_RATING", message: "Rating must be 1-5", statusCode: 400 });
      }
      const { rating, reviewText } = parseResult.data;

      const venue = await storage.getVenue(venueId);
      if (!venue) {
        return res.status(404).json({ error: "VENUE_NOT_FOUND", message: "Venue not found", statusCode: 404 });
      }

      const attended = await storage.hasAttendedVenue(userId, venueId);
      if (!attended) {
        return res.status(403).json({ error: "NOT_ATTENDED", message: "You haven't attended a past checked-in night at this venue", statusCode: 403 });
      }

      const created = await storage.createVenueRating(venueId, userId, rating, reviewText ?? null);
      return res.status(201).json({
        id: created.id,
        venueId: created.venueId,
        userId: created.userId,
        rating: created.rating,
        reviewText: created.reviewText,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
    } catch (error: any) {
      console.error("[Ratings] Post venue rating error:", error);
      res.status(500).json({ error: "SERVER_ERROR", message: "Failed to submit rating", statusCode: 500 });
    }
  });
}