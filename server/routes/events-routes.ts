import type { Express } from "express";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireOrganizer } from "../middleware";
import {
  authRateLimiter,
  sanitizeTextOnly,
} from "../security";
import { deliverNotification } from "../notifications";
import { geocodeAddress, sortByProximity } from "../utils/geo";
import QRCode from "qrcode";
import { eventCreateDto, eventUpdateDto, insertTicketSchema, insertRsvpSchema } from "@shared/schema";

export function registerEventsRoutes(app: Express): void {
  async function addPriceRangesToEvents<T extends { id: string; ticketPrice: number }>(evts: T[]): Promise<(T & { minPrice: number; maxPrice: number })[]> {
    if (evts.length === 0) return [];
    const allTiers = await storage.getBulkEventTicketTiers(evts.map(e => e.id));
    const tiersByEvent = new Map<string, number[]>();
    for (const tier of allTiers) {
      if (!tiersByEvent.has(tier.eventId)) tiersByEvent.set(tier.eventId, []);
      tiersByEvent.get(tier.eventId)!.push(tier.priceSmallestUnit);
    }
    return evts.map(event => {
      const prices = tiersByEvent.get(event.id) ?? [];
      return {
        ...event,
        minPrice: prices.length > 0 ? Math.min(...prices) : event.ticketPrice,
        maxPrice: prices.length > 0 ? Math.max(...prices) : event.ticketPrice,
      };
    });
  }

  // Events
  app.get("/api/events", async (_req, res) => {
    try {
      res.json(await storage.getEvents());
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

  app.get("/api/events/promoted", async (req, res) => {
    try {
      const promotedEvents = await storage.getPromotedEvents();
      const eventsWithPrices = await addPriceRangesToEvents(promotedEvents);
      res.json(eventsWithPrices);
    } catch (error) {
      console.error('Error fetching promoted events:', error);
      res.status(500).json({ message: "Failed to fetch promoted events" });
    }
  });

  // Get events by category (public endpoint for landing page)
  app.get("/api/events/by-category/:category", async (req, res) => {
    try {
      const { category } = req.params;
      const allEvents = await storage.getEvents();
      res.json(allEvents.filter(e => e.category.toLowerCase() === category.toLowerCase()));
    } catch (error) {
      console.error('Error fetching events by category:', error);
      res.status(500).json({ message: "Failed to fetch events by category" });
    }
  });

  // Get featured events for landing page (public endpoint)
  app.get("/api/events/featured", async (_req, res) => {
    try {
      const now = new Date();
      const featured = (await storage.getEvents())
        .filter(e => new Date(e.eventDate) >= now)
        .sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime())
        .slice(0, 8);
      res.json(featured);
    } catch (error) {
      console.error('Error fetching featured events:', error);
      res.status(500).json({ message: "Failed to fetch featured events" });
    }
  });

  // Get events sorted by proximity to user location
  app.get("/api/events/nearby", async (req, res) => {
    try {
      const { lat, lon, maxDistance } = req.query;

      if (!lat || !lon) {
        return res.status(400).json({ message: "Latitude and longitude are required" });
      }

      const userLat = parseFloat(lat as string);
      const userLon = parseFloat(lon as string);
      const maxDist = maxDistance ? parseFloat(maxDistance as string) : undefined;

      if (isNaN(userLat) || isNaN(userLon)) {
        return res.status(400).json({ message: "Invalid coordinates" });
      }

      const allEvents = await storage.getEvents();
      const eventsWithDistance = sortByProximity(allEvents, userLat, userLon);
      const filteredEvents = maxDist
        ? eventsWithDistance.filter(e => e.distance === null || e.distance <= maxDist)
        : eventsWithDistance;
      res.json(filteredEvents);
    } catch (error) {
      console.error('Error fetching nearby events:', error);
      res.status(500).json({ message: "Failed to fetch nearby events" });
    }
  });

  // Get events happening within the next few hours near user
  app.get("/api/events/happening-now", async (req, res) => {
    try {
      const { lat, lon, hours = "3" } = req.query;

      if (!lat || !lon) {
        return res.status(400).json({ message: "Latitude and longitude are required" });
      }

      const userLat = parseFloat(lat as string);
      const userLon = parseFloat(lon as string);
      const hoursAhead = parseInt(hours as string) || 3;

      if (isNaN(userLat) || isNaN(userLon)) {
        return res.status(400).json({ message: "Invalid coordinates" });
      }

      const allEvents = await storage.getEvents();
      const now = new Date();
      const cutoffTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      // Filter events happening within the next X hours
      const upcomingEvents = allEvents.filter(event => {
        const eventDate = new Date(event.eventDate);
        return eventDate >= now && eventDate <= cutoffTime;
      });

      const nearbyUpcoming = sortByProximity(upcomingEvents, userLat, userLon)
        .filter(e => e.distance === null || e.distance <= 25);
      res.json(nearbyUpcoming);
    } catch (error) {
      console.error('Error fetching happening now events:', error);
      res.status(500).json({ message: "Failed to fetch happening now events" });
    }
  });

  // Get trending events in user's city
  app.get("/api/events/trending-in-city", async (req, res) => {
    try {
      const { city } = req.query;

      if (!city) {
        return res.status(400).json({ message: "City is required" });
      }

      const cityName = (city as string).toLowerCase();
      const allEvents = await storage.getEvents();

      // Filter events by city (checking both city field and location text)
      const cityEvents = allEvents.filter(event => {
        const eventCity = event.city?.toLowerCase() || "";
        const eventLocation = event.location.toLowerCase();
        return eventCity.includes(cityName) || eventLocation.includes(cityName);
      });

      const sortedEvents = cityEvents.sort((a, b) =>
        new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime()
      );
      res.json(sortedEvents);
    } catch (error) {
      console.error('Error fetching trending events:', error);
      res.status(500).json({ message: "Failed to fetch trending events" });
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

      // Check if user is allowed to add external ticket URLs (only verified/official accounts)
      const currentUser = await storage.getUser(req.user!.id);
      if (parsedData.externalTicketUrl && !currentUser?.isVerified && !currentUser?.isOfficial) {
        return res.status(403).json({
          message: "Only verified accounts can add external ticketing links"
        });
      }

      // Handle community creation or linking
      let communityId: string | null = null;
      if (parsedData.createCommunity && parsedData.communityName) {
        const communitySlug = parsedData.communityName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') + '-' + Date.now();

        const newCommunity = await storage.createCommunity({
          name: parsedData.communityName,
          slug: communitySlug,
          description: `Community for ${parsedData.title || parsedData.communityName}`,
          createdByUserId: req.user!.id,
        });

        // Auto-join the creator as owner
        await storage.joinCommunity(req.user!.id, newCommunity.id, 'owner');
        communityId = newCommunity.id;
      } else if (parsedData.communityId) {
        // Link to an existing community — validate it exists and user is a member
        const linkedCommunity = await storage.getCommunity(parsedData.communityId);
        if (!linkedCommunity) {
          return res.status(400).json({ message: "Community not found" });
        }
        const isMember = await storage.isCommunityMember(req.user!.id, parsedData.communityId);
        if (!isMember) {
          return res.status(403).json({ message: "You must be a member of the community to link an event" });
        }
        communityId = parsedData.communityId;
      }

      const sanitizedData = {
        ...parsedData,
        title: sanitizeTextOnly(parsedData.title || ""),
        description: sanitizeTextOnly(parsedData.description || ""),
        location: sanitizeTextOnly(parsedData.location || ""),
        // Strip external ticket URL if user is not verified
        externalTicketUrl: (currentUser?.isVerified || currentUser?.isOfficial)
          ? parsedData.externalTicketUrl
          : null,
      };

      // Geocode the location to get coordinates
      let geocodeResult = null;
      if (sanitizedData.location) {
        geocodeResult = await geocodeAddress(sanitizedData.location);
      }

      const event = await storage.createEvent({
        ...sanitizedData,
        organizerId: req.user!.id,
        latitude: geocodeResult?.latitude || null,
        longitude: geocodeResult?.longitude || null,
        city: geocodeResult?.city || sanitizedData.city || null,
        communityId: communityId,
      });

      // Auto-generate promotional post for followers
      const user = await storage.getUser(req.user!.id);
      const eventDate = new Date(event.eventDate).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const postContent = `🎉 New Event: ${event.title}\n\n📅 ${eventDate}\n📍 ${event.location}\n\n${event.description.substring(0, 150)}${event.description.length > 150 ? '...' : ''}`;

      await storage.createEventPost(req.user!.id, event.id, postContent, event.imageUrl || undefined);

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

      // Check if user is allowed to add external ticket URLs (only verified/official accounts)
      const currentUser = await storage.getUser(req.user!.id);
      if (parsedData.externalTicketUrl && !currentUser?.isVerified && !currentUser?.isOfficial) {
        return res.status(403).json({
          message: "Only verified accounts can add external ticketing links"
        });
      }

      // If location changed, re-geocode
      let updateData = {
        ...parsedData,
        // Strip external ticket URL if user is not verified - always set to null for non-verified
        externalTicketUrl: (currentUser?.isVerified || currentUser?.isOfficial)
          ? parsedData.externalTicketUrl
          : null, // Non-verified users cannot have external ticket links
      };
      if (parsedData.location && parsedData.location !== event.location) {
        const geocodeResult = await geocodeAddress(parsedData.location);
        if (geocodeResult) {
          updateData.latitude = geocodeResult.latitude;
          updateData.longitude = geocodeResult.longitude;
          updateData.city = geocodeResult.city || parsedData.city || null;
        }
      }

      const updatedEvent = await storage.updateEvent(req.params.id, updateData);
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

  // Endpoint to backfill geocoding for events without coordinates (organizer can geocode their own events)
  app.post("/api/events/geocode-missing", requireOrganizer, async (req, res) => {
    try {
      const userId = req.user!.id;
      const allEvents = await storage.getEvents();
      // Only geocode events owned by this user
      const eventsWithoutCoords = allEvents.filter(e =>
        (!e.latitude || !e.longitude) && e.organizerId === userId
      );

      let geocoded = 0;
      let failed = 0;
      const results: { id: string; location: string; success: boolean; city?: string | null }[] = [];

      for (const event of eventsWithoutCoords) {
        if (!event.location) {
          results.push({ id: event.id, location: "", success: false });
          failed++;
          continue;
        }

        // Rate limit to respect Nominatim usage policy (1 request per second)
        await new Promise(resolve => setTimeout(resolve, 1100));

        const geocodeResult = await geocodeAddress(event.location);
        if (geocodeResult) {
          await storage.updateEvent(event.id, {
            latitude: geocodeResult.latitude,
            longitude: geocodeResult.longitude,
            city: geocodeResult.city,
          });
          results.push({ id: event.id, location: event.location, success: true, city: geocodeResult.city });
          geocoded++;
        } else {
          results.push({ id: event.id, location: event.location, success: false });
          failed++;
        }
      }

      res.json({
        message: `Geocoding complete: ${geocoded} successful, ${failed} failed`,
        total: eventsWithoutCoords.length,
        geocoded,
        failed,
        results,
      });
    } catch (error) {
      console.error("Geocode backfill error:", error);
      res.status(500).json({ message: "Failed to geocode events" });
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

      const tiersWithEventId = tiers.map((tier: any) => ({
        name: tier.name,
        priceSmallestUnit: tier.priceSmallestUnit ?? tier.priceCents ?? 0,
        currency: tier.currency || "GBP",
        quantity: tier.quantity,
        eventId: req.params.eventId,
        salesEndDate: tier.salesEndDate ? new Date(tier.salesEndDate) : null,
        dayDate: tier.dayDate ? new Date(tier.dayDate) : null,
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

  // Publish / unpublish organizer's own event
  app.patch("/api/events/:id/publish", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to update this event" });
      }
      const { published } = req.body;
      if (typeof published !== "boolean") {
        return res.status(400).json({ message: "published must be a boolean" });
      }
      const updated = await storage.setEventPublished(req.params.id, published);
      res.json(updated);
    } catch (error) {
      console.error('Error updating event publish state:', error);
      res.status(500).json({ message: "Failed to update event" });
    }
  });

  // Delete organizer's own event
  app.delete("/api/events/:id", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to delete this event" });
      }
      await storage.deleteEvent(req.params.id);
      res.json({ message: "Event deleted" });
    } catch (error) {
      console.error('Error deleting event:', error);
      res.status(500).json({ message: "Failed to delete event" });
    }
  });

  // Event Promotion & Analytics
  app.post("/api/events/:id/promote", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to promote this event" });
      }

      const { durationDays } = req.body;
      if (!durationDays || typeof durationDays !== 'number' || durationDays < 1 || durationDays > 30) {
        return res.status(400).json({ message: "Invalid duration. Must be between 1 and 30 days" });
      }

      const promotedEvent = await storage.promoteEvent(req.params.id, durationDays);
      res.json(promotedEvent);
    } catch (error) {
      console.error('Error promoting event:', error);
      res.status(500).json({ message: "Failed to promote event" });
    }
  });

  app.get("/api/events/:id/analytics", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view analytics for this event" });
      }

      const analytics = await storage.getEventAnalytics(req.params.id);
      res.json(analytics);
    } catch (error) {
      console.error('Error fetching event analytics:', error);
      res.status(500).json({ message: "Failed to fetch event analytics" });
    }
  });

  // Organizer Demographics Dashboard
  app.get("/api/organizers/:id/demographics", requireAuth, async (req, res) => {
    try {
      const organizerId = req.params.id;

      if (organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view demographics for this organizer" });
      }

      // Optional period filter: "30d" | "90d" — defaults to all-time
      let startDate: Date | undefined;
      const period = req.query.period as string | undefined;
      if (period === '30d') {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
      } else if (period === '90d') {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 90);
      }
      // endDate is always "now" when a period is set
      const endDate = startDate ? new Date() : undefined;

      const demographics = await storage.getOrganizerDemographics(organizerId, { startDate, endDate });
      res.json(demographics);
    } catch (error) {
      console.error('Error fetching organizer demographics:', error);
      res.status(500).json({ message: "Failed to fetch demographics" });
    }
  });

  app.post("/api/events/:id/track-view", async (req, res) => {
    try {
      const userId = req.user?.id;
      await storage.trackEventView(req.params.id, userId);
      res.json({ message: "View tracked" });
    } catch (error) {
      console.error('Error tracking view:', error);
      res.status(500).json({ message: "Failed to track view" });
    }
  });

  app.post("/api/events/:id/track-click", async (req, res) => {
    try {
      const { actionType } = req.body;
      if (!actionType || typeof actionType !== 'string') {
        return res.status(400).json({ message: "Invalid action type" });
      }

      const userId = req.user?.id;
      await storage.trackEventClick(req.params.id, actionType, userId);
      res.json({ message: "Click tracked" });
    } catch (error) {
      console.error('Error tracking click:', error);
      res.status(500).json({ message: "Failed to track click" });
    }
  });

  // Report an event
  app.post("/api/events/:id/report", requireAuth, async (req, res) => {
    try {
      const { reason, description } = req.body;
      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ message: "Reason is required" });
      }
      await storage.createContentReport({
        reporterId: req.user!.id,
        contentType: "event",
        contentId: req.params.id,
        reason,
        description: description || null,
      });
      res.json({ message: "Report submitted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to submit report" });
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

  // Payment routes for event tickets are handled by payment-routes.ts
  // See /api/payments/event/checkout and /api/payments/event/verify

  // Get QR code for a ticket
  app.get("/api/tickets/:ticketId/qr", requireAuth, async (req, res) => {
    try {
      const ticket = await storage.getTicket(req.params.ticketId);

      if (!ticket) {
        return res.status(404).json({ message: "Ticket not found" });
      }

      if (ticket.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view this ticket" });
      }

      const holder = await storage.getUser(ticket.userId);
      const holderName = holder?.displayName || holder?.username || "Ticket Holder";

      const qrCodeDataUrl = await QRCode.toDataURL(ticket.validationCode, {
        errorCorrectionLevel: 'H',
        type: 'image/png',
        width: 300,
        margin: 2,
      });

      res.json({ qrCode: qrCodeDataUrl, holderName });
    } catch (error) {
      console.error('Error generating QR code:', error);
      res.status(500).json({ message: "Failed to generate QR code" });
    }
  });

  // Validate a ticket by validation code (organizer session OR staff scanner token)
  app.post("/api/tickets/validate", async (req, res) => {
    try {
      const requestSchema = z.object({
        validationCode: z.string().min(1),
        eventId: z.string().min(1),
      });

      const parseResult = requestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          message: "Invalid request data",
          errors: parseResult.error.errors,
        });
      }

      const { validationCode, eventId } = parseResult.data;

      // Resolve who is scanning: organizer session or staff scanner token
      let scannerId: string;
      let staffCodeId: string | null = null;

      const scannerToken = req.headers["x-scanner-token"] as string | undefined;

      if (scannerToken) {
        const staffCode = await storage.getStaffCodeByScannerToken(scannerToken);
        if (!staffCode || staffCode.status !== "active") {
          return res.status(401).json({ message: "Invalid or expired scanner token" });
        }
        if (new Date() > staffCode.expiresAt) {
          return res.status(401).json({ message: "Scanner token has expired" });
        }
        if (staffCode.eventId !== eventId) {
          return res.status(403).json({ message: "Scanner not authorised for this event" });
        }
        // Use organizer's ID for checkedInBy so audit trail links to the account
        const event = await storage.getEvent(eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });
        scannerId = event.organizerId;
        staffCodeId = staffCode.id;
      } else if (req.isAuthenticated()) {
        const event = await storage.getEvent(eventId);
        if (!event) return res.status(404).json({ message: "Event not found" });
        if (event.organizerId !== req.user!.id) {
          return res.status(403).json({ message: "Not authorised to validate tickets for this event" });
        }
        scannerId = req.user!.id;
      } else {
        return res.status(401).json({ message: "Authentication required" });
      }

      const ticket = await storage.getTicketByValidationCode(validationCode);
      if (!ticket) {
        return res.status(404).json({ message: "Invalid ticket code" });
      }

      if (ticket.eventId !== eventId) {
        return res.status(400).json({ message: "This ticket is not for this event" });
      }

      if (ticket.checkedInAt) {
        const ticketUser = await storage.getUser(ticket.userId);
        return res.json({
          valid: false,
          alreadyCheckedIn: true,
          message: "Ticket already used",
          checkedInAt: ticket.checkedInAt,
          ticket: { ...ticket, user: ticketUser },
        });
      }

      // Atomic check-in — returns null if a concurrent request beat us
      const updatedTicket = await storage.checkInTicket(ticket.id, scannerId);
      if (!updatedTicket) {
        const ticketUser = await storage.getUser(ticket.userId);
        return res.json({
          valid: false,
          alreadyCheckedIn: true,
          message: "Ticket already used",
          ticket: { ...ticket, user: ticketUser },
        });
      }

      if (staffCodeId) {
        await storage.incrementStaffCodeScanCount(staffCodeId);
      }

      const ticketUser = await storage.getUser(updatedTicket.userId);
      res.json({
        valid: true,
        alreadyCheckedIn: false,
        message: "Ticket validated successfully",
        ticket: { ...updatedTicket, user: ticketUser },
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

  // Download guestlist as CSV (organizer only)
  app.get("/api/events/:eventId/guestlist.csv", requireAuth, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized" });
      }
      const tickets = await storage.getEventCheckIns(req.params.eventId);
      const csvEscape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const rows = [
        ["Name", "Email", "Status", "Checked In At", "Ticket ID"].map(csvEscape).join(","),
        ...tickets.map((t) => [
          t.user.displayName || t.user.username,
          t.user.email,
          t.checkedInAt ? "Checked In" : "Not Arrived",
          t.checkedInAt ? new Date(t.checkedInAt).toISOString().replace("T", " ").slice(0, 16) : "",
          t.id,
        ].map(csvEscape).join(",")),
      ];
      const eventSlug = (event.title || "guestlist").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${eventSlug}-guestlist.csv"`);
      res.send(rows.join("\r\n"));
    } catch (error) {
      console.error("Guestlist CSV error:", error);
      res.status(500).json({ message: "Failed to generate guestlist" });
    }
  });

  // ── Staff access code routes ──────────────────────────────────────────────

  // Generate a new staff code for an event
  app.post("/api/events/:eventId/staff-codes", requireAuth, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the organiser can generate staff codes" });
      }
      // Codes expire at event end time OR 24 h from now, whichever is sooner
      const eventEnd = event.eventDate ? new Date(event.eventDate) : null;
      const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const expiresAt = eventEnd && eventEnd < in24h ? eventEnd : in24h;

      const staffCode = await storage.createStaffCode(event.id, req.user!.id, expiresAt);
      res.json(staffCode);
    } catch (error) {
      console.error("Create staff code error:", error);
      res.status(500).json({ message: "Failed to create staff code" });
    }
  });

  // List staff codes for an event
  app.get("/api/events/:eventId/staff-codes", requireAuth, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the organiser can view staff codes" });
      }
      const codes = await storage.getEventStaffCodes(event.id, req.user!.id);
      res.json(codes);
    } catch (error) {
      console.error("List staff codes error:", error);
      res.status(500).json({ message: "Failed to fetch staff codes" });
    }
  });

  // Revoke a staff code
  app.delete("/api/events/:eventId/staff-codes/:codeId", requireAuth, async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });
      if (event.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the organiser can revoke staff codes" });
      }
      await storage.revokeStaffCode(req.params.codeId, req.user!.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Revoke staff code error:", error);
      res.status(500).json({ message: "Failed to revoke staff code" });
    }
  });

  // Bouncer redeems a staff code → gets scanner token (no auth required)
  app.post("/api/scanner/auth", authRateLimiter, async (req, res) => {
    try {
      const schema = z.object({
        code: z.string().length(64),
        staffName: z.string().min(1).max(80),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request", errors: parsed.error.errors });
      }
      const { code, staffName } = parsed.data;

      const staffCode = await storage.getStaffCodeByCode(code);
      if (!staffCode) {
        return res.status(404).json({ message: "Invalid code" });
      }
      if (staffCode.status === "revoked") {
        return res.status(403).json({ message: "This code has been revoked" });
      }
      if (staffCode.status === "active") {
        return res.status(409).json({ message: "This code has already been used by someone else" });
      }
      if (new Date() > staffCode.expiresAt) {
        return res.status(410).json({ message: "This code has expired" });
      }

      const event = await storage.getEvent(staffCode.eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });

      const scannerToken = crypto.randomBytes(32).toString("hex");
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
      const ua = req.headers["user-agent"] || "";

      const redeemed = await storage.redeemStaffCode(staffCode.id, staffName, ip, ua, scannerToken);

      res.json({
        scannerToken: redeemed.scannerToken,
        eventId: redeemed.eventId,
        eventTitle: event.title,
        staffName: redeemed.validatedBy,
        expiresAt: redeemed.expiresAt,
      });
    } catch (error: any) {
      if (error.message === "Code already redeemed or revoked") {
        return res.status(409).json({ message: "This code has already been used" });
      }
      console.error("Scanner auth error:", error);
      res.status(500).json({ message: "Failed to authenticate" });
    }
  });

  // Verify scanner token is still valid (called on page load by bouncer)
  // Checks both regular event and venue event staff code tables.
  app.get("/api/scanner/verify", async (req, res) => {
    try {
      const token = req.headers["x-scanner-token"] as string | undefined;
      if (!token) return res.status(401).json({ valid: false });

      // Check regular event staff codes first
      const eventStaffCode = await storage.getStaffCodeByScannerToken(token);
      if (eventStaffCode && eventStaffCode.status === "active" && new Date() <= eventStaffCode.expiresAt) {
        const event = await storage.getEvent(eventStaffCode.eventId);
        return res.json({
          valid: true,
          type: "event",
          eventId: eventStaffCode.eventId,
          eventTitle: event?.title ?? "",
          staffName: eventStaffCode.validatedBy,
          expiresAt: eventStaffCode.expiresAt,
          scanCount: eventStaffCode.scanCount,
        });
      }

      // Check venue event staff codes
      const venueStaffCode = await storage.getVenueStaffCodeByScannerToken(token);
      if (venueStaffCode && venueStaffCode.status === "active" && new Date() <= venueStaffCode.expiresAt) {
        const entryNight = await storage.getVenueEntryNight(venueStaffCode.venueEntryNightId);
        return res.json({
          valid: true,
          type: "venue-event",
          eventId: venueStaffCode.venueEntryNightId,
          eventTitle: entryNight?.name ?? "",
          staffName: venueStaffCode.validatedBy,
          expiresAt: venueStaffCode.expiresAt,
          scanCount: venueStaffCode.scanCount,
        });
      }

      res.json({ valid: false });
    } catch (error) {
      console.error("Scanner verify error:", error);
      res.status(500).json({ valid: false });
    }
  });

  // Event-scoped staff code redemption — bouncer submits code at a specific event URL
  app.post("/api/events/:eventId/staff-access/validate", authRateLimiter, async (req, res) => {
    try {
      const schema = z.object({
        code: z.string().length(64),
        staffName: z.string().min(1).max(80),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request", errors: parsed.error.errors });
      }
      const { code, staffName } = parsed.data;
      const { eventId } = req.params;

      const staffCode = await storage.getStaffCodeByCode(code);
      if (!staffCode) {
        return res.status(404).json({ message: "Invalid code" });
      }
      // Ensure code belongs to THIS event — prevents cross-event token reuse
      if (staffCode.eventId !== eventId) {
        return res.status(404).json({ message: "Invalid code" });
      }
      if (staffCode.status === "revoked") {
        return res.status(403).json({ message: "This code has been revoked" });
      }
      if (staffCode.status === "active") {
        return res.status(409).json({ message: "This code has already been used by someone else" });
      }
      if (new Date() > staffCode.expiresAt) {
        return res.status(410).json({ message: "This code has expired" });
      }

      const event = await storage.getEvent(eventId);
      if (!event) return res.status(404).json({ message: "Event not found" });

      const scannerToken = crypto.randomBytes(32).toString("hex");
      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "";
      const ua = req.headers["user-agent"] || "";

      const redeemed = await storage.redeemStaffCode(staffCode.id, staffName, ip, ua, scannerToken);

      res.json({
        scannerToken: redeemed.scannerToken,
        eventId: redeemed.eventId,
        eventTitle: event.title,
        staffName: redeemed.validatedBy,
        expiresAt: redeemed.expiresAt,
      });
    } catch (error: any) {
      if (error.message === "Code already redeemed or revoked") {
        return res.status(409).json({ message: "This code has already been used" });
      }
      console.error("Staff access validate error:", error);
      res.status(500).json({ message: "Failed to authenticate" });
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

      if (event.moderationStatus !== 'approved') {
        return res.status(403).json({ message: "This event is not yet available for RSVP" });
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

      // Notify event organizer about the RSVP
      const attendee = await storage.getUser(userId);
      await deliverNotification({
        userId: event.organizerId,
        type: "event_rsvp",
        title: "New RSVP",
        message: `${attendee?.displayName || attendee?.username || "Someone"} RSVPed to ${event.title}`,
        link: `/event/${eventId}`,
        relatedUserId: userId,
        relatedEntityId: eventId,
      });

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
}
