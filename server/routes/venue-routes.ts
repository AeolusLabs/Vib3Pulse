import type { Express } from "express";
import crypto from "crypto";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, requireOrganizer } from "../middleware";
import { authRateLimiter } from "../security";
import { handleTicketValidate, handleStaffRedeem } from "../utils/doorAccess.js";
import { geocodeAddress, sortByProximity } from "../utils/geo";
import { generateRecurrenceDates, shiftByDelta, type RecurrenceInterval } from "../utils/recurrence.js";
import { staffCodeExpiry } from "../utils/staffCodeExpiry.js";
import { venueWriteSchema, venueUpdateSchema, venueEntryNightWriteSchema, venueEntryNightUpdateSchema, venueCategories } from "@shared/schema";

const MAP_WARNING = "We couldn't find this address on the map, so the venue won't appear there. Check the street, city and country.";

export function registerVenueRoutes(app: Express): void {
  // ==================== VENUE ROUTES ====================

  // Get all venues
  app.get("/api/venues", async (req, res) => {
    try {
      const allVenues = await storage.getVenues();
      res.json(allVenues);
    } catch (error) {
      console.error("Get venues error:", error);
      res.status(500).json({ message: "Failed to get venues" });
    }
  });

  // Get promoted/featured venues
  app.get("/api/venues/promoted", async (req, res) => {
    try {
      const promotedVenues = await storage.getPromotedVenues();
      res.json(promotedVenues);
    } catch (error) {
      console.error("Get promoted venues error:", error);
      res.status(500).json({ message: "Failed to get promoted venues" });
    }
  });

  // Get venues sorted by proximity to user location
  app.get("/api/venues/nearby", async (req, res) => {
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

      const allVenues = await storage.getVenues();
      const venuesWithDistance = sortByProximity(allVenues, userLat, userLon);

      // Filter by max distance if provided
      const filteredVenues = maxDist
        ? venuesWithDistance.filter(v => v.distance === null || v.distance <= maxDist)
        : venuesWithDistance;

      res.json(filteredVenues);
    } catch (error) {
      console.error('Error fetching nearby venues:', error);
      res.status(500).json({ message: "Failed to fetch nearby venues" });
    }
  });

  // Get venue categories
  app.get("/api/venues/categories", (req, res) => {
    res.json(venueCategories);
  });

  // Get single venue
  app.get("/api/venues/:id", async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      // Track venue view
      await storage.trackVenueView(req.params.id, req.user?.id);

      res.json(venue);
    } catch (error) {
      console.error("Get venue error:", error);
      res.status(500).json({ message: "Failed to get venue" });
    }
  });

  // Get venues owned by current user
  app.get("/api/my-venues", requireOrganizer, async (req, res) => {
    try {
      const myVenues = await storage.getVenuesByOwner(req.user!.id);
      res.json(myVenues);
    } catch (error) {
      console.error("Get my venues error:", error);
      res.status(500).json({ message: "Failed to get your venues" });
    }
  });

  // Create venue
  app.post("/api/venues", requireOrganizer, async (req, res) => {
    try {
      // Derive location from address and city if not provided
      let location = req.body.location;
      if (!location) {
        const parts = [req.body.address, req.body.city].filter(Boolean);
        location = parts.length > 0 ? parts.join(", ") : req.body.name;
      }

      // Geocode address to capture lat/lng
      let latitude: number | null = null;
      let longitude: number | null = null;
      const addressParts = [req.body.address, req.body.city, req.body.country].filter(Boolean);
      if (addressParts.length > 0) {
        const coords = await geocodeAddress(addressParts.join(", "));
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
        }
      }

      // Allow-listed fields only; owner and coordinates are set here, never taken from the body.
      const venueData = {
        ...venueWriteSchema.parse({ ...req.body, location }),
        ownerId: req.user!.id,
        latitude,
        longitude,
      };

      const venue = await storage.createVenue(venueData);
      // Venues without coordinates never appear on the map, so tell the organizer instead of failing silently.
      res.status(201).json({ ...venue, mapWarning: latitude === null && addressParts.length > 0 ? MAP_WARNING : undefined });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid venue data", errors: error.flatten() });
      }
      console.error("Create venue error:", error);
      res.status(400).json({ message: "Failed to create venue" });
    }
  });

  // Update venue
  app.patch("/api/venues/:id", requireOrganizer, async (req, res) => {
    try {
      if (!req.user!.canManageVenues) {
        return res.status(403).json({ message: "Venue management permission required" });
      }

      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      // Check ownership
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only update your own venues" });
      }

      // Allow-listed fields only (see venueWriteSchema): ownership, verification, promotion and
      // coordinates can't be changed through this route.
      const updates: Record<string, unknown> & { address?: string | null; city?: string | null; latitude?: number; longitude?: number } =
        venueUpdateSchema.parse(req.body);

      // Re-geocode if address or city changed
      const addressChanged = updates.address !== undefined || updates.city !== undefined || updates.country !== undefined;
      if (addressChanged) {
        const address = updates.address ?? venue.address;
        const city = updates.city ?? venue.city;
        const country = (updates.country as string | null | undefined) ?? venue.country;
        const addressParts = [address, city, country].filter(Boolean);
        if (addressParts.length > 0) {
          const coords = await geocodeAddress(addressParts.join(", "));
          if (coords) {
            updates.latitude = coords.latitude;
            updates.longitude = coords.longitude;
          }
        }
      }

      const updatedVenue = await storage.updateVenue(req.params.id, updates);
      res.json({ ...updatedVenue, mapWarning: addressChanged && updatedVenue.latitude == null ? MAP_WARNING : undefined });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid venue data", errors: error.flatten() });
      }
      console.error("Update venue error:", error);
      res.status(400).json({ message: "Failed to update venue" });
    }
  });

  // Delete venue
  app.delete("/api/venues/:id", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      // Check ownership
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only delete your own venues" });
      }

      await storage.deleteVenue(req.params.id);
      res.json({ message: "Venue deleted successfully" });
    } catch (error) {
      console.error("Delete venue error:", error);
      res.status(500).json({ message: "Failed to delete venue" });
    }
  });

  // Venue promotion is paid — see /api/payments/venue/promote/intent + /confirm
  // in payment-routes.ts. This used to also exist here as an unguarded free
  // bypass sitting right next to the paid flow; removed.

  // Get venue analytics
  app.get("/api/venues/:id/analytics", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only view analytics for your own venues" });
      }

      const analytics = await storage.getVenueAnalytics(req.params.id);
      res.json(analytics);
    } catch (error) {
      console.error("Get venue analytics error:", error);
      res.status(500).json({ message: "Failed to get venue analytics" });
    }
  });

  // ==================== VENUE EVENTS ROUTES ====================

  // Get all upcoming venue events across all venues (for Discover page)
  app.get("/api/venue-events/upcoming", async (req, res) => {
    try {
      const events = await storage.getUpcomingAllVenueEvents();
      res.json(events);
    } catch (error) {
      console.error("Get upcoming venue events error:", error);
      res.status(500).json({ message: "Failed to get upcoming venue events" });
    }
  });

  // Get single venue event with venue details (public detail page)
  app.get("/api/venue-events/:id", async (req, res) => {
    try {
      const event = await storage.getVenueEventWithVenue(req.params.id);
      if (!event) return res.status(404).json({ message: "Venue event not found" });
      res.json(event);
    } catch (error) {
      console.error("Get venue event error:", error);
      res.status(500).json({ message: "Failed to get venue event" });
    }
  });

  // Get all venue events for a venue (owner management)
  app.get("/api/venues/:venueId/venue-events", async (req, res) => {
    try {
      const events = await storage.getVenueEntryNights(req.params.venueId);
      res.json(events);
    } catch (error) {
      console.error("Get venue events error:", error);
      res.status(500).json({ message: "Failed to get venue events" });
    }
  });

  // Get upcoming venue events for a venue (visitor ticket purchase)
  app.get("/api/venues/:venueId/venue-events/upcoming", async (req, res) => {
    try {
      const upcomingEvents = await storage.getUpcomingVenueEntryNights(req.params.venueId);
      res.json(upcomingEvents);
    } catch (error) {
      console.error("Get upcoming venue events error:", error);
      res.status(500).json({ message: "Failed to get upcoming venue events" });
    }
  });

  // Create venue event — optionally recurring. recurrenceEndDate is a
  // request-only field (not a column on venueEntryNights); it just bounds
  // how many generated occurrences get created.
  app.post("/api/venues/:venueId/venue-events", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only create events for your own venues" });
      }
      const { recurrenceEndDate, ...body } = req.body;
      // Allow-listed fields only: a new night is always created "pending" for admin approval.
      const eventData = {
        ...venueEntryNightWriteSchema.parse(body),
        venueId: req.params.venueId,
      };
      const event = await storage.createVenueEntryNight(eventData);

      if (eventData.recurrence && eventData.recurrence !== "none") {
        const interval = eventData.recurrence as RecurrenceInterval;
        const endDate = recurrenceEndDate ? new Date(recurrenceEndDate) : undefined;
        const occurrenceDates = generateRecurrenceDates(eventData.date, interval, endDate);

        for (const date of occurrenceDates) {
          const deltaMs = date.getTime() - eventData.date.getTime();
          await storage.createVenueEntryNight({
            ...eventData,
            date,
            endTime: shiftByDelta(eventData.endTime, deltaMs),
            doorsCloseTime: shiftByDelta(eventData.doorsCloseTime, deltaMs),
            lastCallTime: shiftByDelta(eventData.lastCallTime, deltaMs),
            kitchenCloseTime: shiftByDelta(eventData.kitchenCloseTime, deltaMs),
            recurrenceParentId: event.id,
          });
        }
      }

      res.status(201).json(event);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid venue event data", errors: error.flatten() });
      }
      console.error("Create venue event error:", error);
      res.status(400).json({ message: "Failed to create venue event" });
    }
  });

  // Update venue event
  app.patch("/api/venue-events/:id", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getVenueEntryNight(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Venue event not found" });
      }
      const venue = await storage.getVenue(event.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only update events for your own venues" });
      }
      // Coerce date/time strings to Date objects
      const updateData = { ...req.body };
      const dateFields = ["date", "endTime", "doorsCloseTime", "lastCallTime", "kitchenCloseTime"];
      for (const field of dateFields) {
        if (updateData[field] && typeof updateData[field] === "string") {
          updateData[field] = new Date(updateData[field]);
        } else if (updateData[field] === "") {
          updateData[field] = null;
        }
      }
      // Allow-listed fields only: moderation status, venue and sales counters can't be changed here.
      const updatedEvent = await storage.updateVenueEntryNight(req.params.id, venueEntryNightUpdateSchema.parse(updateData));
      res.json(updatedEvent);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid venue event data", errors: error.flatten() });
      }
      console.error("Update venue event error:", error);
      res.status(400).json({ message: "Failed to update venue event" });
    }
  });

  // Delete venue event
  app.delete("/api/venue-events/:id", requireOrganizer, async (req, res) => {
    try {
      const event = await storage.getVenueEntryNight(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Venue event not found" });
      }
      const venue = await storage.getVenue(event.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only delete events for your own venues" });
      }
      await storage.deleteVenueEntryNight(req.params.id);
      res.json({ message: "Venue event deleted successfully" });
    } catch (error) {
      console.error("Delete venue event error:", error);
      res.status(500).json({ message: "Failed to delete venue event" });
    }
  });

  // ==================== VENUE EVENT CHECK-IN ROUTES ====================

  // Get all check-ins for a venue event (organizer only)
  app.get("/api/venue-events/:id/check-ins", requireAuth, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the venue owner can view check-ins" });
      }
      const checkIns = await storage.getVenueEventCheckIns(req.params.id);
      res.json(checkIns);
    } catch (error) {
      console.error("Get venue check-ins error:", error);
      res.status(500).json({ message: "Failed to get check-ins" });
    }
  });

  // Download venue event guestlist as CSV (venue owner only)
  app.get("/api/venue-events/:id/guestlist.csv", requireAuth, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the venue owner can download the guestlist" });
      }
      const tickets = await storage.getVenueEventCheckIns(req.params.id);
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
      const nightSlug = (entryNight.name || "guestlist").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${nightSlug}-guestlist.csv"`);
      res.send(rows.join("\r\n"));
    } catch (error) {
      console.error("Venue guestlist CSV error:", error);
      res.status(500).json({ message: "Failed to generate guestlist" });
    }
  });

  // Generate a staff code for a venue event
  app.post("/api/venue-events/:id/staff-codes", requireAuth, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the venue owner can generate staff codes" });
      }
      const expiresAt = staffCodeExpiry(new Date(entryNight.date), entryNight.endTime ? new Date(entryNight.endTime) : null);
      if (!expiresAt) return res.status(400).json({ message: "This event has already ended" });
      const staffCode = await storage.createVenueStaffCode(entryNight.id, req.user!.id, expiresAt);
      res.json(staffCode);
    } catch (error) {
      console.error("Create venue staff code error:", error);
      res.status(500).json({ message: "Failed to create staff code" });
    }
  });

  // List staff codes for a venue event
  app.get("/api/venue-events/:id/staff-codes", requireAuth, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the venue owner can view staff codes" });
      }
      const codes = await storage.getVenueEntryNightStaffCodes(entryNight.id, req.user!.id);
      res.json(codes);
    } catch (error) {
      console.error("List venue staff codes error:", error);
      res.status(500).json({ message: "Failed to fetch staff codes" });
    }
  });

  // Revoke a venue event staff code
  app.delete("/api/venue-events/:id/staff-codes/:codeId", requireAuth, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the venue owner can revoke staff codes" });
      }
      await storage.revokeVenueStaffCode(req.params.codeId, req.user!.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Revoke venue staff code error:", error);
      res.status(500).json({ message: "Failed to revoke staff code" });
    }
  });

  // Venue event-scoped staff sign-in: body { staffName, code (64 chars) } OR { staffName, pin (6 digits) }.
  app.post("/api/venue-events/:id/staff-access/validate", authRateLimiter, (req, res) =>
    handleStaffRedeem("venue", req.params.id, req, res));

  // ==================== VENUE TICKET ROUTES ====================

  // Get user's venue tickets
  app.get("/api/my-venue-tickets", requireAuth, async (req, res) => {
    try {
      const tickets = await storage.getUserVenueTickets(req.user!.id);
      res.json(tickets);
    } catch (error) {
      console.error("Get user venue tickets error:", error);
      res.status(500).json({ message: "Failed to get your venue tickets" });
    }
  });

  // Venue entry payment routes handled by payment-routes.ts
  // See /api/payments/venue/intent and /api/payments/venue/confirm

  // Validate venue ticket by full validation code or 8-char short code — organizer session or staff
  // scanner token. Logic shared with events: server/utils/doorAccess.ts.
  app.post("/api/venue-tickets/validate", (req, res) => handleTicketValidate("venue", req, res));
}
