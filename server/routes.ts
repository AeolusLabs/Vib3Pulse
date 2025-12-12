import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertEventSchema, eventCreateDto, eventUpdateDto, insertTicketSchema, insertRsvpSchema, insertUserSchema, insertPostSchema, insertStorySchema, insertVenueSchema, insertVenueEntryNightSchema, venueCategories } from "@shared/schema";
import { hashPassword, userToSessionUser } from "./auth";
import { requireAuth, requireOrganizer } from "./middleware";
import passport from "passport";
import { wsManager } from "./websocket";
import { z } from "zod";
import QRCode from "qrcode";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission } from "./objectAcl";
import { 
  authRateLimiter, 
  sensitiveOperationLimiter,
  checkLoginThrottle, 
  recordLoginAttempt, 
  clearLoginAttempts,
  sanitizeTextOnly,
  validateAndSanitizeObject,
  logSecurityEvent,
  rotateCsrfToken
} from "./security";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  createPaymentIntent,
  isPaymentSimulated,
  getPaymentModeDescription,
} from "./paymentService";

// Helper function to resolve identifier (UUID or username) to userId
async function resolveUserId(identifier: string): Promise<string | null> {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  
  if (isUUID) {
    const user = await storage.getUser(identifier);
    return user?.id || null;
  } else {
    const user = await storage.getUserByUsername(identifier);
    return user?.id || null;
  }
}

// Haversine formula for calculating distance between two coordinates (in miles)
function calculateDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Forward geocode an address to coordinates using OpenStreetMap Nominatim
async function geocodeAddress(address: string): Promise<{ latitude: number; longitude: number; city: string | null } | null> {
  try {
    // Add UK bias for better results
    const searchAddress = address.includes("UK") || address.includes("United Kingdom") 
      ? address 
      : `${address}, UK`;
    
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchAddress)}&format=json&addressdetails=1&limit=1`,
      {
        headers: {
          "User-Agent": "VibePulse/1.0 (social-events-platform)",
        },
      }
    );
    
    if (!response.ok) {
      console.error("Geocoding request failed:", response.status);
      return null;
    }
    
    const results = await response.json();
    if (!results || results.length === 0) {
      console.log("No geocoding results for:", address);
      return null;
    }
    
    const result = results[0];
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    
    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }
    
    // Extract city from address details
    const addr = result.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || null;
    
    console.log(`Geocoded "${address}" to lat=${lat}, lon=${lon}, city=${city}`);
    return { latitude: lat, longitude: lon, city };
  } catch (error) {
    console.error("Geocoding error for address:", address, error);
    return null;
  }
}

// Helper to add distance to events/venues and sort by proximity
function sortByProximity<T extends { latitude?: number | null; longitude?: number | null }>(
  items: T[],
  userLat: number,
  userLon: number
): (T & { distance: number | null })[] {
  return items
    .map(item => ({
      ...item,
      distance: item.latitude && item.longitude 
        ? calculateDistanceMiles(userLat, userLon, item.latitude, item.longitude)
        : null
    }))
    .sort((a, b) => {
      // Items with distance come first, sorted by distance
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
      if (a.distance !== null) return -1;
      if (b.distance !== null) return 1;
      return 0;
    });
}

const signupSchema = insertUserSchema.omit({ passwordHash: true }).extend({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function registerRoutes(app: Express): Promise<Server> {
  // ==================== CONFIG ROUTES ====================
  
  // Expose app configuration (safe public info only)
  app.get("/api/config", (req, res) => {
    res.json({
      paymentMode: isPaymentSimulated() ? "demo" : "live",
      paymentModeDescription: getPaymentModeDescription(),
    });
  });

  // ==================== AUTHENTICATION ROUTES ====================
  
  app.post("/api/auth/signup", authRateLimiter, async (req, res) => {
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
      
      // If gender is provided during signup, set genderEditedAt to lock it
      const userDataWithGenderTimestamp = userData.gender 
        ? { ...userData, genderEditedAt: new Date() }
        : userData;
      
      const user = await storage.createUser({
        ...userDataWithGenderTimestamp,
        passwordHash,
      } as any);

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

  app.post("/api/auth/login", authRateLimiter, (req, res, next) => {
    const identifier = req.body.username || "";
    const ip = req.ip || req.headers["x-forwarded-for"] as string || "unknown";
    
    const throttleCheck = checkLoginThrottle(identifier, ip);
    if (!throttleCheck.allowed) {
      logSecurityEvent("lockout", { identifier, ip, lockedUntil: throttleCheck.lockedUntil });
      return res.status(429).json({ 
        message: `Account temporarily locked. Try again after ${throttleCheck.lockedUntil?.toLocaleTimeString()}`,
        lockedUntil: throttleCheck.lockedUntil
      });
    }
    
    passport.authenticate("local", (err: any, user: Express.User | false, info: any) => {
      if (err) {
        return res.status(500).json({ message: "Login failed" });
      }
      if (!user) {
        recordLoginAttempt(identifier, ip, false);
        
        // Check if this failed attempt triggered a lockout
        const postAttemptCheck = checkLoginThrottle(identifier, ip);
        if (!postAttemptCheck.allowed) {
          logSecurityEvent("lockout", { identifier, ip, lockedUntil: postAttemptCheck.lockedUntil });
          return res.status(429).json({ 
            message: `Too many failed attempts. Account temporarily locked. Try again after ${postAttemptCheck.lockedUntil?.toLocaleTimeString()}`,
            lockedUntil: postAttemptCheck.lockedUntil
          });
        }
        
        logSecurityEvent("login_failed", { identifier, ip, remainingAttempts: postAttemptCheck.remainingAttempts || 0 });
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }
      
      req.session.regenerate((regenerateErr) => {
        if (regenerateErr) {
          return res.status(500).json({ message: "Login failed" });
        }
        
        req.login(user, (loginErr) => {
          if (loginErr) {
            return res.status(500).json({ message: "Login failed" });
          }
          
          clearLoginAttempts(identifier, ip);
          logSecurityEvent("login_success", { userId: user.id, ip });
          
          // Rotate CSRF token on successful login for security
          const newCsrfToken = rotateCsrfToken(res);
          
          res.json({ user, csrfToken: newCsrfToken });
        });
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
  app.patch("/api/users/:userId", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      let { userId } = req.params;
      
      // Handle "me" as a special case for current user
      if (userId === "me") {
        userId = req.user!.id;
      }
      
      // Security check: Users can only update their own profile
      if (req.user!.id !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }
      
      const { updateUserSchema } = await import("@shared/schema");
      let updates = updateUserSchema.parse(req.body);
      
      // Sanitize text fields in profile updates
      if (updates.displayName) updates.displayName = sanitizeTextOnly(updates.displayName);
      if (updates.bio) updates.bio = sanitizeTextOnly(updates.bio);
      if (updates.organizationName) updates.organizationName = sanitizeTextOnly(updates.organizationName);
      
      // Security: Only organizers can enable venue management
      if (updates.canManageVenues !== undefined) {
        if (req.user!.userType !== "organizer") {
          return res.status(403).json({ message: "Only event organizers can enable venue management" });
        }
      }
      
      // Check if user is trying to update gender
      if (updates.gender !== undefined) {
        const currentUser = await storage.getUser(userId);
        if (currentUser?.genderEditedAt) {
          return res.status(400).json({ message: "Gender can only be changed once" });
        }
      }
      
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

  app.get("/api/events/promoted", async (req, res) => {
    try {
      const promotedEvents = await storage.getPromotedEvents();
      res.json(promotedEvents);
    } catch (error) {
      console.error('Error fetching promoted events:', error);
      res.status(500).json({ message: "Failed to fetch promoted events" });
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
      
      // Filter by max distance if provided
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
      
      // Sort by proximity and limit to nearby events (within 25 miles)
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
      
      // Sort by upcoming date (soonest first)
      const sortedEvents = cityEvents.sort((a, b) => {
        const dateA = new Date(a.eventDate).getTime();
        const dateB = new Date(b.eventDate).getTime();
        return dateA - dateB;
      });
      
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
      
      const sanitizedData = {
        ...parsedData,
        title: sanitizeTextOnly(parsedData.title || ""),
        description: sanitizeTextOnly(parsedData.description || ""),
        location: sanitizeTextOnly(parsedData.location || ""),
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
      
      // If location changed, re-geocode
      let updateData = { ...parsedData };
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
      
      // Only allow organizers to view their own demographics, or allow viewing their own
      if (organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to view demographics for this organizer" });
      }
      
      const demographics = await storage.getOrganizerDemographics(organizerId);
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

  // Tickets
  app.get("/api/tickets", requireAuth, async (req, res) => {
    try {
      const tickets = await storage.getUserTickets(req.user!.id);
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tickets" });
    }
  });

  app.post("/api/tickets/purchase", requireAuth, sensitiveOperationLimiter, async (req, res) => {
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

      // Create checkout session (real or simulated based on SIMULATE_PAYMENTS env)
      const session = await createCheckoutSession({
        eventId,
        userId,
        eventTitle: event.title,
        eventDescription: event.description,
        priceInPence: event.ticketPrice,
        successUrl: `${req.headers.origin}/ticket-wallet?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${req.headers.origin}/discover?canceled=true`,
      });

      res.json({ sessionId: session.sessionId, url: session.url });
    } catch (error) {
      console.error("Create checkout session error:", error);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  // Verify checkout session and create ticket
  app.post("/api/tickets/verify-payment", requireAuth, async (req, res) => {
    try {
      const requestSchema = z.object({
        sessionId: z.string().min(1),
      });
      
      const { sessionId } = requestSchema.parse(req.body);
      const userId = req.user!.id;

      // Retrieve the session (real or simulated based on SIMULATE_PAYMENTS env)
      const session = await retrieveCheckoutSession(sessionId);
      
      if (!session) {
        return res.status(400).json({ message: "Invalid session" });
      }

      // Verify payment was successful
      if (session.paymentStatus !== "paid") {
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
      const existingTicket = await storage.getTicketByPaymentIntent(session.paymentIntentId);
      if (existingTicket) {
        return res.json({ message: "Ticket already created", ticket: existingTicket });
      }

      // Create the ticket
      const ticketData = insertTicketSchema.parse({
        userId: session.metadata.userId,
        eventId: session.metadata.eventId,
        stripePaymentIntentId: session.paymentIntentId,
        status: "confirmed",
      });
      
      const ticket = await storage.createTicket(ticketData);

      // Notify event organizer about ticket purchase
      const event = await storage.getEvent(session.metadata.eventId);
      if (event) {
        const buyer = await storage.getUser(session.metadata.userId);
        await storage.createNotification({
          userId: event.organizerId,
          type: "ticket_purchase",
          title: "Ticket Sold",
          message: `${buyer?.displayName || buyer?.username || "Someone"} purchased a ticket for ${event.title}`,
          link: `/events/${event.id}`,
          relatedUserId: session.metadata.userId,
          relatedEntityId: ticket.id,
        });
        // Push real-time notification via WebSocket
        wsManager.sendToUser(event.organizerId, {
          type: "notification",
          data: { type: "ticket_purchase" },
        });
      }

      res.json({ message: "Ticket created successfully", ticket });
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("Invalid request:", error);
        return res.status(400).json({ message: "Invalid request data" });
      }
      console.error("Error verifying payment:", error);
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

      // Notify event organizer about the RSVP
      const attendee = await storage.getUser(userId);
      await storage.createNotification({
        userId: event.organizerId,
        type: "event_rsvp",
        title: "New RSVP",
        message: `${attendee?.displayName || attendee?.username || "Someone"} RSVPed to ${event.title}`,
        link: `/events/${eventId}`,
        relatedUserId: userId,
        relatedEntityId: eventId,
      });
      // Push real-time notification via WebSocket
      wsManager.sendToUser(event.organizerId, {
        type: "notification",
        data: { type: "event_rsvp" },
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
      
      const sanitizedPostData = {
        ...postData,
        content: sanitizeTextOnly(postData.content || ""),
      };
      
      const post = await storage.createPost({
        ...sanitizedPostData,
        userId: req.user!.id,
      });

      // Extract and store hashtags from post content
      const hashtagRegex = /#(\w+)/g;
      const hashtagMatches = sanitizedPostData.content.match(hashtagRegex) || [];
      for (const match of hashtagMatches) {
        const hashtag = await storage.getOrCreateHashtag(match);
        await storage.addHashtagToPost(post.id, hashtag.id);
      }

      // Extract mentions and create notifications
      const mentionRegex = /@(\w+)/g;
      const mentionMatches = sanitizedPostData.content.match(mentionRegex) || [];
      for (const match of mentionMatches) {
        const username = match.substring(1); // Remove @ symbol
        const mentionedUser = await storage.getUserByUsername(username);
        if (mentionedUser && mentionedUser.id !== req.user!.id) {
          await storage.addMentionToPost(post.id, mentionedUser.id);
          
          // Create notification for the mentioned user
          const poster = await storage.getUser(req.user!.id);
          await storage.createNotification({
            userId: mentionedUser.id,
            type: "mention",
            title: "You were mentioned",
            message: `${poster?.displayName || poster?.username || "Someone"} mentioned you in a post`,
            link: `/feed`,
            relatedUserId: req.user!.id,
            relatedEntityId: post.id,
          });
          wsManager.sendToUser(mentionedUser.id, {
            type: "notification",
            data: { type: "mention" },
          });
        }
      }

      res.json(post);
    } catch (error) {
      console.error("Post creation error:", error);
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

  // Stories
  app.get("/api/stories", async (req, res) => {
    try {
      const viewerId = req.user?.id;
      const stories = await storage.getActiveStories(viewerId);
      res.json(stories);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch stories" });
    }
  });

  // Get story image upload URL
  app.get("/api/stories/upload-url", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      
      // Extract stable path from upload URL
      const url = new URL(uploadURL);
      const pathParts = url.pathname.split('/');
      const uploadsIndex = pathParts.findIndex(p => p === 'uploads');
      const extractedId = uploadsIndex !== -1 ? pathParts.slice(uploadsIndex).join('/') : pathParts.slice(-1)[0];
      const stablePath = `/objects/${extractedId}`;
      
      res.json({ uploadURL, stablePath });
    } catch (error) {
      console.error("Error getting story upload URL:", error);
      res.status(500).json({ message: "Failed to get upload URL" });
    }
  });

  // Server-side story image upload (bypasses CORS issues)
  app.post("/api/stories/upload", requireAuth, async (req, res) => {
    try {
      const { imageData } = req.body;
      
      if (!imageData || !imageData.startsWith('data:image')) {
        return res.status(400).json({ message: "Invalid image data" });
      }
      
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      
      // Extract stable path from upload URL
      const url = new URL(uploadURL);
      const pathParts = url.pathname.split('/');
      const uploadsIndex = pathParts.findIndex(p => p === 'uploads');
      const extractedId = uploadsIndex !== -1 ? pathParts.slice(uploadsIndex).join('/') : pathParts.slice(-1)[0];
      const stablePath = `/objects/${extractedId}`;
      
      // Convert base64 to buffer
      const base64Data = imageData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      
      // Upload to GCS using signed URL
      const uploadResponse = await fetch(uploadURL, {
        method: 'PUT',
        body: buffer,
        headers: {
          'Content-Type': 'image/jpeg',
        },
      });
      
      if (!uploadResponse.ok) {
        console.error("GCS upload failed:", uploadResponse.status, await uploadResponse.text());
        throw new Error('Failed to upload to storage');
      }
      
      // Set ACL policy to make the image publicly readable
      try {
        await objectStorageService.trySetObjectEntityAclPolicy(stablePath, {
          owner: req.user!.id,
          visibility: "public",
        });
      } catch (aclError) {
        console.error("Error setting ACL policy:", aclError);
        // Continue even if ACL fails - the image was uploaded successfully
      }
      
      res.json({ stablePath });
    } catch (error) {
      console.error("Error uploading story image:", error);
      res.status(500).json({ message: "Failed to upload image" });
    }
  });

  app.post("/api/stories", requireAuth, async (req, res) => {
    try {
      const { allowedViewerIds, ...storyInput } = req.body;
      const storyData = insertStorySchema.omit({ userId: true }).parse(storyInput);
      
      const story = await storage.createStory({
        ...storyData,
        userId: req.user!.id,
      }, allowedViewerIds);
      res.json(story);
    } catch (error) {
      console.error("Create story error:", error);
      res.status(400).json({ message: "Invalid story data" });
    }
  });

  app.delete("/api/stories/:id", requireAuth, async (req, res) => {
    try {
      const stories = await storage.getUserStories(req.user!.id);
      const story = stories.find(s => s.id === req.params.id);
      
      if (!story) {
        return res.status(404).json({ message: "Story not found or not authorized" });
      }
      
      await storage.deleteStory(req.params.id);
      res.json({ message: "Story deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete story" });
    }
  });

  // Story Likes
  app.post("/api/stories/:storyId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;
      
      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }
      
      // Check if user can view this story
      const canView = await storage.canViewStory(userId, storyId);
      if (!canView) {
        return res.status(403).json({ message: "Not authorized to view this story" });
      }
      
      await storage.likeStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);

      // Create notification for story owner (if not liking own story)
      if (story.userId !== userId) {
        const liker = await storage.getUser(userId);
        const likerName = liker?.displayName || liker?.username || "Someone";
        await storage.createNotification({
          userId: story.userId,
          type: "story_like",
          title: "Story Liked",
          message: `${likerName} liked your story`,
          link: `/stories`,
          relatedUserId: userId,
          relatedEntityId: storyId,
        });
        // Push real-time notification via WebSocket
        wsManager.sendToUser(story.userId, {
          type: "notification",
          data: { type: "story_like" },
        });
      }

      res.json({ liked: true, likeCount });
    } catch (error) {
      console.error("Like story error:", error);
      res.status(500).json({ message: "Failed to like story" });
    }
  });

  app.delete("/api/stories/:storyId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;
      
      await storage.unlikeStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);
      res.json({ liked: false, likeCount });
    } catch (error) {
      console.error("Unlike story error:", error);
      res.status(500).json({ message: "Failed to unlike story" });
    }
  });

  app.get("/api/stories/:storyId/like-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;
      
      const isLiked = await storage.hasUserLikedStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);
      res.json({ isLiked, likeCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get like status" });
    }
  });

  // Story Reshares
  app.post("/api/stories/:storyId/reshare", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;
      
      const originalStory = await storage.getStory(storyId);
      if (!originalStory) {
        return res.status(404).json({ message: "Story not found" });
      }
      
      // Check if user can view this story
      const canView = await storage.canViewStory(userId, storyId);
      if (!canView) {
        return res.status(403).json({ message: "Not authorized to reshare this story" });
      }
      
      // Users can't reshare their own stories
      if (originalStory.userId === userId) {
        return res.status(400).json({ message: "Cannot reshare your own story" });
      }
      
      const resharedStory = await storage.reshareStory(userId, storyId);
      res.json(resharedStory);
    } catch (error) {
      console.error("Reshare story error:", error);
      res.status(500).json({ message: "Failed to reshare story" });
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

      // Create notification for post owner (if not liking own post)
      const posts = await storage.getPosts();
      const post = posts.find(p => p.id === postId);
      if (post && post.userId !== userId) {
        const liker = await storage.getUser(userId);
        const postSnippet = post.content.length > 50 ? post.content.substring(0, 50) + "..." : post.content;
        await storage.createNotification({
          userId: post.userId,
          type: "post_like",
          title: "New Post Like",
          message: `${liker?.displayName || liker?.username || "Someone"} liked your post: "${postSnippet}"`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
        });
        // Push real-time notification via WebSocket
        wsManager.sendToUser(post.userId, {
          type: "notification",
          data: { type: "post_like" },
        });
      }

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
      
      // Sanitize content to prevent XSS
      const sanitizedContent = sanitizeTextOnly(content.trim());
      
      const comment = await storage.addComment({
        userId,
        postId,
        content: sanitizedContent,
      });

      // Create notification for post owner (if not commenting on own post)
      const posts = await storage.getPosts();
      const post = posts.find(p => p.id === postId);
      if (post && post.userId !== userId) {
        const commenter = await storage.getUser(userId);
        const commentSnippet = sanitizedContent.length > 60 ? sanitizedContent.substring(0, 60) + "..." : sanitizedContent;
        await storage.createNotification({
          userId: post.userId,
          type: "post_comment",
          title: "New Comment",
          message: `${commenter?.displayName || commenter?.username || "Someone"} commented: "${commentSnippet}"`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
        });
        // Push real-time notification via WebSocket
        wsManager.sendToUser(post.userId, {
          type: "notification",
          data: { type: "post_comment" },
        });
      }
      
      res.json(comment);
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment" });
    }
  });

  app.get("/api/posts/:postId/comments", async (req, res) => {
    try {
      const postId = req.params.postId;
      const comments = await storage.getPostComments(postId);
      res.json({ comments, count: comments.length });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  // Comment Interactions - Like
  app.post("/api/comments/:commentId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      
      const alreadyLiked = await storage.hasUserLikedComment(userId, commentId);
      if (alreadyLiked) {
        return res.status(400).json({ message: "Already liked this comment" });
      }
      
      const like = await storage.likeComment(userId, commentId);
      res.json(like);
    } catch (error) {
      res.status(500).json({ message: "Failed to like comment" });
    }
  });

  app.delete("/api/comments/:commentId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      await storage.unlikeComment(userId, commentId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to unlike comment" });
    }
  });

  app.get("/api/comments/:commentId/likes", async (req, res) => {
    try {
      const commentId = req.params.commentId;
      const userId = req.user?.id;
      const count = await storage.getCommentLikeCount(commentId);
      const isLiked = userId ? await storage.hasUserLikedComment(userId, commentId) : false;
      res.json({ count, isLiked });
    } catch (error) {
      res.status(500).json({ message: "Failed to get comment likes" });
    }
  });

  // Comment Interactions - Replies
  app.post("/api/comments/:commentId/replies", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      const { content } = req.body;
      
      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Reply content is required" });
      }
      
      const sanitizedContent = sanitizeTextOnly(content.trim());
      const reply = await storage.addCommentReply(userId, commentId, sanitizedContent);
      res.json(reply);
    } catch (error) {
      res.status(500).json({ message: "Failed to add reply" });
    }
  });

  app.get("/api/comments/:commentId/replies", async (req, res) => {
    try {
      const commentId = req.params.commentId;
      const replies = await storage.getCommentReplies(commentId);
      const count = await storage.getCommentReplyCount(commentId);
      res.json({ replies, count });
    } catch (error) {
      res.status(500).json({ message: "Failed to get replies" });
    }
  });

  // Comment Interactions - Repost
  app.post("/api/comments/:commentId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      
      const alreadyReposted = await storage.hasUserRepostedComment(userId, commentId);
      if (alreadyReposted) {
        return res.status(400).json({ message: "Already reposted this comment" });
      }
      
      const repost = await storage.repostComment(userId, commentId);
      res.json(repost);
    } catch (error) {
      res.status(500).json({ message: "Failed to repost comment" });
    }
  });

  app.delete("/api/comments/:commentId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      await storage.unrepostComment(userId, commentId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove repost" });
    }
  });

  app.get("/api/comments/:commentId/repost-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      const hasReposted = await storage.hasUserRepostedComment(userId, commentId);
      const repostCount = await storage.getCommentRepostCount(commentId);
      res.json({ hasReposted, repostCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get repost status" });
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

  // ============================================
  // POST REPOSTS
  // ============================================

  app.post("/api/posts/:postId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      const alreadyReposted = await storage.hasUserRepostedPost(userId, postId);
      if (alreadyReposted) {
        return res.status(400).json({ message: "Already reposted this post" });
      }
      
      const repost = await storage.repostPost(userId, postId);

      // Notify the original post author
      const originalPost = await storage.getPost(postId);
      if (originalPost && originalPost.userId !== userId) {
        const reposter = await storage.getUser(userId);
        await storage.createNotification({
          userId: originalPost.userId,
          type: "repost",
          title: "Post Reposted",
          message: `${reposter?.displayName || reposter?.username || "Someone"} reposted your post`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
        });
        wsManager.sendToUser(originalPost.userId, {
          type: "notification",
          data: { type: "repost" },
        });
      }

      res.json(repost);
    } catch (error) {
      res.status(500).json({ message: "Failed to repost" });
    }
  });

  app.delete("/api/posts/:postId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      await storage.unrepostPost(userId, postId);
      res.json({ message: "Removed repost" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove repost" });
    }
  });

  app.get("/api/posts/:postId/repost-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      
      const hasReposted = await storage.hasUserRepostedPost(userId, postId);
      const repostCount = await storage.getPostRepostCount(postId);
      
      res.json({ hasReposted, repostCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get repost status" });
    }
  });

  // ============================================
  // HASHTAGS
  // ============================================

  app.get("/api/hashtags/trending", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const trending = await storage.getTrendingHashtags(limit);
      res.json(trending);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trending hashtags" });
    }
  });

  app.get("/api/hashtags/:tag/posts", async (req, res) => {
    try {
      const tag = req.params.tag;
      const posts = await storage.getPostsByHashtag(tag);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch posts by hashtag" });
    }
  });

  // ============================================
  // MENTIONS
  // ============================================

  app.get("/api/users/:userId/mentions", requireAuth, async (req, res) => {
    try {
      const userId = req.params.userId;
      const mentions = await storage.getUserMentions(userId);
      res.json(mentions);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user mentions" });
    }
  });

  // Follows
  app.post("/api/follows/:identifier", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);
      
      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (followerId === followingId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
      }
      
      const isAlreadyFollowing = await storage.isFollowing(followerId, followingId);
      if (isAlreadyFollowing) {
        return res.status(400).json({ message: "Already following this user" });
      }
      
      const follow = await storage.followUser(followerId, followingId);

      // Notify user they have a new follower
      const follower = await storage.getUser(followerId);
      await storage.createNotification({
        userId: followingId,
        type: "new_follower",
        title: "New Follower",
        message: `${follower?.displayName || follower?.username || "Someone"} started following you`,
        link: `/profile/${follower?.username}`,
        relatedUserId: followerId,
        relatedEntityId: followerId,
      });
      // Push real-time notification via WebSocket
      wsManager.sendToUser(followingId, {
        type: "notification",
        data: { type: "new_follower" },
      });

      res.json(follow);
    } catch (error) {
      res.status(500).json({ message: "Failed to follow user" });
    }
  });
  
  app.delete("/api/follows/:identifier", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);
      
      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }
      
      await storage.unfollowUser(followerId, followingId);
      res.json({ message: "Unfollowed successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to unfollow user" });
    }
  });
  
  app.get("/api/follows/:identifier/status", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);
      
      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }
      
      const isFollowing = await storage.isFollowing(followerId, followingId);
      res.json({ isFollowing });
    } catch (error) {
      res.status(500).json({ message: "Failed to check follow status" });
    }
  });
  
  app.get("/api/follows/:identifier/followers", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }
      const followers = await storage.getFollowers(userId);
      // Return just the user objects for easier frontend consumption
      const users = followers.map(f => f.follower);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch followers" });
    }
  });
  
  // Get current user's following list (authenticated route with stable path)
  app.get("/api/follows/me/following", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const following = await storage.getFollowing(userId);
      const users = following.map(f => f.following);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch following" });
    }
  });

  app.get("/api/follows/:identifier/following", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }
      const following = await storage.getFollowing(userId);
      // Return just the user objects for easier frontend consumption
      const users = following.map(f => f.following);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch following" });
    }
  });

  // Messages
  app.post("/api/messages", requireAuth, async (req, res) => {
    try {
      const { receiverId, content, replyToId, eventId, venueId } = req.body;
      const senderId = req.user!.id;
      
      if (senderId === receiverId) {
        return res.status(400).json({ message: "Cannot message yourself" });
      }
      
      const sanitizedContent = sanitizeTextOnly(content || "");
      if (!sanitizedContent.trim()) {
        return res.status(400).json({ message: "Message cannot be empty" });
      }
      
      const message = await storage.sendMessage({
        senderId,
        receiverId,
        content: sanitizedContent,
        replyToId: replyToId || null,
        eventId: eventId || null,
        venueId: venueId || null,
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

        // Create notification for message recipient - use sanitized content
        const messageSnippet = sanitizedContent.length > 50 ? sanitizedContent.substring(0, 50) + "..." : sanitizedContent;
        await storage.createNotification({
          userId: receiverId,
          type: "new_message",
          title: "New Message",
          message: `${sender.displayName || sender.username}: "${messageSnippet}"`,
          link: `/messages/${senderId}`,
          relatedUserId: senderId,
          relatedEntityId: message.id,
        });
        // Push real-time notification via WebSocket
        wsManager.sendToUser(receiverId, {
          type: "notification",
          data: { type: "new_message" },
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
  app.get("/api/users/search", requireAuth, async (req, res) => {
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
  
  app.get("/api/users/:identifier/profile", async (req, res) => {
    try {
      const identifier = req.params.identifier;
      
      // Check if identifier is a UUID or username
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      
      let user;
      if (isUUID) {
        user = await storage.getUser(identifier);
      } else {
        user = await storage.getUserByUsername(identifier);
      }
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Now get the full profile using the user's ID
      const profile = await storage.getUserProfile(user.id);
      if (!profile) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(profile);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // User profile (legacy - keep for backward compatibility)
  app.get("/api/users/:identifier", async (req, res) => {
    try {
      const identifier = req.params.identifier;
      
      // Check if identifier is a UUID or username
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      
      let user;
      if (isUUID) {
        user = await storage.getUser(identifier);
      } else {
        user = await storage.getUserByUsername(identifier);
      }
      
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

  // Follow/Unfollow routes
  app.post("/api/users/:identifier/follow", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const targetUserId = await resolveUserId(req.params.identifier);
      const currentUserId = req.user!.id;
      
      if (!targetUserId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Can't follow yourself
      if (targetUserId === currentUserId) {
        return res.status(400).json({ message: "You cannot follow yourself" });
      }

      // Check if already following
      const alreadyFollowing = await storage.isFollowing(currentUserId, targetUserId);
      if (alreadyFollowing) {
        return res.status(400).json({ message: "Already following this user" });
      }

      const follow = await storage.followUser(currentUserId, targetUserId);

      // Create notification for the followed user
      const currentUser = await storage.getUser(currentUserId);
      await storage.createNotification({
        userId: targetUserId,
        type: "new_follower",
        title: "New Follower",
        message: `${currentUser?.displayName || currentUser?.username || "Someone"} started following you`,
        link: `/profile/${currentUser?.username}`,
        relatedUserId: currentUserId,
        relatedEntityId: currentUserId,
      });

      res.json(follow);
    } catch (error) {
      console.error("Follow error:", error);
      res.status(500).json({ message: "Failed to follow user" });
    }
  });

  app.post("/api/users/:identifier/unfollow", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const targetUserId = await resolveUserId(req.params.identifier);
      const currentUserId = req.user!.id;
      
      if (!targetUserId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if currently following
      const isFollowing = await storage.isFollowing(currentUserId, targetUserId);
      if (!isFollowing) {
        return res.status(400).json({ message: "Not following this user" });
      }

      await storage.unfollowUser(currentUserId, targetUserId);
      res.json({ message: "Successfully unfollowed" });
    } catch (error) {
      console.error("Unfollow error:", error);
      res.status(500).json({ message: "Failed to unfollow user" });
    }
  });

  app.get("/api/users/:identifier/follow-stats", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get followers and following
      const followers = await storage.getFollowers(userId);
      const following = await storage.getFollowing(userId);

      // Check if current user is following this user
      let isFollowing = false;
      if (req.isAuthenticated()) {
        isFollowing = await storage.isFollowing(req.user!.id, userId);
      }

      res.json({
        followersCount: followers.length,
        followingCount: following.length,
        isFollowing,
      });
    } catch (error) {
      console.error("Follow stats error:", error);
      res.status(500).json({ message: "Failed to fetch follow stats" });
    }
  });

  // User posts endpoint
  app.get("/api/users/:identifier/posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const posts = await storage.getUserPosts(userId);
      const user = await storage.getUser(userId);
      
      // Add user info to each post
      const postsWithUser = posts.map(post => ({
        ...post,
        user: user ? { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl } : null
      }));

      res.json(postsWithUser);
    } catch (error) {
      console.error("Get user posts error:", error);
      res.status(500).json({ message: "Failed to fetch user posts" });
    }
  });

  // User liked posts endpoint
  app.get("/api/users/:identifier/liked-posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const likedPosts = await storage.getUserLikedPosts(userId);
      res.json(likedPosts);
    } catch (error) {
      console.error("Get user liked posts error:", error);
      res.status(500).json({ message: "Failed to fetch liked posts" });
    }
  });

  // User reposted posts endpoint
  app.get("/api/users/:identifier/reposted-posts", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }

      const repostedPosts = await storage.getUserRepostedPosts(userId);
      res.json(repostedPosts);
    } catch (error) {
      console.error("Get user reposted posts error:", error);
      res.status(500).json({ message: "Failed to fetch reposted posts" });
    }
  });

  // Avatar upload endpoint - returns presigned PUT URL and stable object path
  app.post("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const privateObjectDir = process.env.PRIVATE_OBJECT_DIR || "";
      const objectId = crypto.randomUUID();
      
      // Get presigned URL for upload
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      
      // Extract the object ID from the upload URL and create stable path
      const url = new URL(uploadURL);
      const pathParts = url.pathname.split('/');
      const uploadsIndex = pathParts.findIndex(p => p === 'uploads');
      const extractedId = uploadsIndex !== -1 ? pathParts.slice(uploadsIndex).join('/') : `uploads/${objectId}`;
      const stablePath = `/objects/${extractedId}`;
      
      res.json({ uploadURL, stablePath });
    } catch (error) {
      console.error("Error getting avatar upload URL:", error);
      res.status(500).json({ message: "Failed to get upload URL" });
    }
  });

  // Update avatar URL after upload - accepts the stable path
  app.patch("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const { avatarPath } = req.body;
      if (!avatarPath) {
        return res.status(400).json({ message: "Avatar path is required" });
      }

      // Validate the path format
      if (!avatarPath.startsWith('/objects/')) {
        return res.status(400).json({ message: "Invalid avatar path format" });
      }

      const objectStorageService = new ObjectStorageService();
      
      // Verify the object exists and set ACL to public
      try {
        const objectFile = await objectStorageService.getObjectEntityFile(avatarPath);
        const { setObjectAclPolicy } = await import('./objectAcl');
        await setObjectAclPolicy(objectFile, { visibility: "public", owner: req.user!.id });
      } catch (err) {
        console.error("Error setting avatar ACL:", err);
        return res.status(400).json({ message: "Avatar upload not found or incomplete" });
      }

      const updatedUser = await storage.updateUser(req.user!.id, { 
        avatarUrl: avatarPath 
      });
      
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error("Error updating avatar:", error);
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Buddy system routes
  const setBuddySchema = z.object({
    buddyId: z.string().min(1, "Buddy ID is required"),
  });

  app.post("/api/buddy/set", requireAuth, async (req, res) => {
    try {
      const validation = setBuddySchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid request data", errors: validation.error.errors });
      }

      const { buddyId } = validation.data;
      const userId = req.user!.id;

      if (buddyId === userId) {
        return res.status(400).json({ message: "Cannot set yourself as buddy" });
      }

      const buddy = await storage.getUser(buddyId);
      if (!buddy) {
        return res.status(404).json({ message: "Buddy user not found" });
      }

      if (buddy.userType !== "social") {
        return res.status(400).json({ message: "Can only set social users as buddy" });
      }

      await storage.setBuddy(userId, buddyId);
      res.json({ message: "Buddy set successfully" });
    } catch (error) {
      console.error("Set buddy error:", error);
      res.status(500).json({ message: "Failed to set buddy" });
    }
  });

  app.get("/api/buddy", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const buddy = await storage.getBuddy(userId);
      res.json({ buddy });
    } catch (error) {
      console.error("Get buddy error:", error);
      res.status(500).json({ message: "Failed to get buddy" });
    }
  });

  app.delete("/api/buddy", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      await storage.removeBuddy(userId);
      res.json({ message: "Buddy removed successfully" });
    } catch (error) {
      console.error("Remove buddy error:", error);
      res.status(500).json({ message: "Failed to remove buddy" });
    }
  });

  const setDistressMessageSchema = z.object({
    message: z.string().min(1, "Distress message is required").max(500, "Message too long"),
  });

  app.post("/api/buddy/distress-message", requireAuth, async (req, res) => {
    try {
      const validation = setDistressMessageSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid request data", errors: validation.error.errors });
      }

      const { message } = validation.data;
      const userId = req.user!.id;

      await storage.setDistressMessage(userId, message);
      res.json({ message: "Distress message saved successfully" });
    } catch (error) {
      console.error("Set distress message error:", error);
      res.status(500).json({ message: "Failed to save distress message" });
    }
  });

  app.get("/api/buddy/distress-message", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const message = await storage.getDistressMessage(userId);
      res.json({ message: message || "I need help! Please check on me." });
    } catch (error) {
      console.error("Get distress message error:", error);
      res.status(500).json({ message: "Failed to get distress message" });
    }
  });

  const triggerAlertSchema = z.object({
    latitude: z.string().optional().nullable(),
    longitude: z.string().optional().nullable(),
  }).refine((data) => {
    if (data.latitude && data.longitude) {
      const lat = parseFloat(data.latitude);
      const lng = parseFloat(data.longitude);
      return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }
    return true;
  }, { message: "Invalid coordinates" });

  // Helper function to reverse geocode coordinates to a readable location name
  async function reverseGeocodeLocation(lat: string, lon: string): Promise<string | null> {
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
        {
          headers: {
            "User-Agent": "VibePulse/1.0",
          },
        }
      );
      if (!response.ok) return null;
      
      const data = await response.json();
      const address = data.address;
      
      // Build a readable location string
      const parts: string[] = [];
      if (address?.road || address?.street) parts.push(address.road || address.street);
      if (address?.suburb || address?.neighbourhood) parts.push(address.suburb || address.neighbourhood);
      if (address?.city || address?.town || address?.village) parts.push(address.city || address.town || address.village);
      if (address?.county) parts.push(address.county);
      
      return parts.length > 0 ? parts.slice(0, 3).join(", ") : null;
    } catch (error) {
      console.error("Reverse geocoding error:", error);
      return null;
    }
  }

  app.post("/api/buddy/trigger-alert", requireAuth, async (req, res) => {
    try {
      const validation = triggerAlertSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid request data", errors: validation.error.errors });
      }

      const { latitude, longitude } = validation.data;
      const userId = req.user!.id;

      const buddy = await storage.getBuddy(userId);
      if (!buddy) {
        return res.status(400).json({ message: "No buddy set" });
      }

      const distressMessage = await storage.getDistressMessage(userId);
      const message = distressMessage || "I need help! Please check on me.";

      // Get readable location name if coordinates provided
      let locationName: string | null = null;
      if (latitude && longitude) {
        locationName = await reverseGeocodeLocation(latitude, longitude);
      }

      // Log the alert
      await storage.logDistressAlert(userId, buddy.id, message, latitude || undefined, longitude || undefined);

      // Send in-app notification via WebSocket
      const user = await storage.getUser(userId);
      const mapLink = latitude && longitude 
        ? `https://www.google.com/maps?q=${latitude},${longitude}`
        : null;
      
      // Build the location message
      const locationMessage = locationName 
        ? ` They are near ${locationName}.`
        : (mapLink ? " Location shared." : "");

      wsManager.sendToUser(buddy.id, {
        type: "distress_alert",
        data: {
          senderId: userId,
          senderName: user?.displayName || user?.username || "A friend",
          message,
          latitude,
          longitude,
          locationName,
          mapLink,
          timestamp: new Date().toISOString(),
        },
      });

      // Create persistent notification for buddy with readable location
      await storage.createNotification({
        userId: buddy.id,
        type: "buddy_alert",
        title: "Buddy Alert",
        message: `${user?.displayName || user?.username || "Your buddy"} needs help!${locationMessage}`,
        link: mapLink || `/buddy`,
        relatedUserId: userId,
        relatedEntityId: userId,
      });
      // Push real-time notification via WebSocket
      wsManager.sendToUser(buddy.id, {
        type: "notification",
        data: { type: "buddy_alert" },
      });

      res.json({ 
        message: "Distress alert sent successfully",
        buddy: { username: buddy.username, displayName: buddy.displayName },
      });
    } catch (error) {
      console.error("Trigger alert error:", error);
      res.status(500).json({ message: "Failed to trigger distress alert" });
    }
  });

  app.get("/api/buddy/alerts", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const alerts = await storage.getDistressAlerts(userId);
      res.json({ alerts });
    } catch (error) {
      console.error("Get alerts error:", error);
      res.status(500).json({ message: "Failed to get distress alerts" });
    }
  });

  // ==================== NOTIFICATION ROUTES ====================

  // Get all notifications for current user
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const notifications = await storage.getUserNotifications(userId, limit);
      res.json({ notifications });
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ message: "Failed to get notifications" });
    }
  });

  // Get unread notification count
  app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const count = await storage.getUnreadNotificationCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Get unread count error:", error);
      res.status(500).json({ message: "Failed to get unread count" });
    }
  });

  // Mark single notification as read
  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const notification = await storage.markNotificationAsRead(req.params.id);
      res.json({ notification });
    } catch (error) {
      console.error("Mark notification read error:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  });

  // Mark all notifications as read
  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      await storage.markAllNotificationsAsRead(userId);
      res.json({ message: "All notifications marked as read" });
    } catch (error) {
      console.error("Mark all read error:", error);
      res.status(500).json({ message: "Failed to mark all notifications as read" });
    }
  });

  // Delete a notification
  app.delete("/api/notifications/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteNotification(req.params.id);
      res.json({ message: "Notification deleted" });
    } catch (error) {
      console.error("Delete notification error:", error);
      res.status(500).json({ message: "Failed to delete notification" });
    }
  });

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
      
      const venueData = insertVenueSchema.parse({
        ...req.body,
        location,
        ownerId: req.user!.id,
      });
      
      const venue = await storage.createVenue(venueData);
      res.status(201).json(venue);
    } catch (error) {
      console.error("Create venue error:", error);
      res.status(400).json({ message: "Failed to create venue" });
    }
  });

  // Update venue
  app.patch("/api/venues/:id", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      
      // Check ownership
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only update your own venues" });
      }
      
      const updatedVenue = await storage.updateVenue(req.params.id, req.body);
      res.json(updatedVenue);
    } catch (error) {
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

  // Promote venue
  app.post("/api/venues/:id/promote", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only promote your own venues" });
      }
      
      const { durationDays } = req.body;
      if (!durationDays || ![3, 7, 14, 30].includes(durationDays)) {
        return res.status(400).json({ message: "Invalid promotion duration" });
      }
      
      const promotedVenue = await storage.promoteVenue(req.params.id, durationDays);
      res.json(promotedVenue);
    } catch (error) {
      console.error("Promote venue error:", error);
      res.status(500).json({ message: "Failed to promote venue" });
    }
  });

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

  // ==================== VENUE ENTRY NIGHTS ROUTES ====================

  // Get entry nights for a venue
  app.get("/api/venues/:venueId/entry-nights", async (req, res) => {
    try {
      const entryNights = await storage.getVenueEntryNights(req.params.venueId);
      res.json(entryNights);
    } catch (error) {
      console.error("Get entry nights error:", error);
      res.status(500).json({ message: "Failed to get entry nights" });
    }
  });

  // Get upcoming entry nights for a venue (for ticket purchasing)
  app.get("/api/venues/:venueId/entry-nights/upcoming", async (req, res) => {
    try {
      const upcomingNights = await storage.getUpcomingVenueEntryNights(req.params.venueId);
      res.json(upcomingNights);
    } catch (error) {
      console.error("Get upcoming entry nights error:", error);
      res.status(500).json({ message: "Failed to get upcoming entry nights" });
    }
  });

  // Create entry night
  app.post("/api/venues/:venueId/entry-nights", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only create entry nights for your own venues" });
      }
      
      const entryNightData = insertVenueEntryNightSchema.parse({
        ...req.body,
        venueId: req.params.venueId,
      });
      
      const entryNight = await storage.createVenueEntryNight(entryNightData);
      res.status(201).json(entryNight);
    } catch (error) {
      console.error("Create entry night error:", error);
      res.status(400).json({ message: "Failed to create entry night" });
    }
  });

  // Update entry night
  app.patch("/api/entry-nights/:id", requireOrganizer, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only update entry nights for your own venues" });
      }
      
      // Convert date string to Date object if provided
      const updateData = { ...req.body };
      if (updateData.date && typeof updateData.date === 'string') {
        updateData.date = new Date(updateData.date);
      }
      
      const updatedEntryNight = await storage.updateVenueEntryNight(req.params.id, updateData);
      res.json(updatedEntryNight);
    } catch (error) {
      console.error("Update entry night error:", error);
      res.status(400).json({ message: "Failed to update entry night" });
    }
  });

  // Delete entry night
  app.delete("/api/entry-nights/:id", requireOrganizer, async (req, res) => {
    try {
      const entryNight = await storage.getVenueEntryNight(req.params.id);
      if (!entryNight) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only delete entry nights for your own venues" });
      }
      
      await storage.deleteVenueEntryNight(req.params.id);
      res.json({ message: "Entry night deleted successfully" });
    } catch (error) {
      console.error("Delete entry night error:", error);
      res.status(500).json({ message: "Failed to delete entry night" });
    }
  });

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

  // Create payment intent for venue entry ticket
  app.post("/api/venue-tickets/create-payment-intent", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { entryNightId } = req.body;
      
      const entryNight = await storage.getVenueEntryNight(entryNightId);
      if (!entryNight) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      
      if (!entryNight.isActive) {
        return res.status(400).json({ message: "This entry night is no longer available" });
      }
      
      // Check capacity
      if (entryNight.capacity && entryNight.ticketsSold >= entryNight.capacity) {
        return res.status(400).json({ message: "This entry night is sold out" });
      }
      
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      
      // Create payment intent (real or simulated based on SIMULATE_PAYMENTS env)
      const paymentIntent = await createPaymentIntent({
        amountInPence: entryNight.coverPriceCents,
        metadata: {
          type: "venue_entry",
          entryNightId,
          venueId: venue.id,
          userId: req.user!.id,
        },
      });
      
      res.json({ 
        clientSecret: paymentIntent.clientSecret,
        paymentIntentId: paymentIntent.paymentIntentId,
      });
    } catch (error) {
      console.error("Create venue payment intent error:", error);
      res.status(500).json({ message: "Failed to create payment" });
    }
  });

  // Confirm venue ticket purchase (requires authentication)
  app.post("/api/venue-tickets/confirm", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { entryNightId, paymentIntentId } = req.body;
      
      const entryNight = await storage.getVenueEntryNight(entryNightId);
      if (!entryNight) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      
      // Create ticket
      const ticket = await storage.createVenueTicket({
        userId: req.user!.id,
        venueEntryNightId: entryNightId,
        stripePaymentIntentId: paymentIntentId,
        status: "confirmed",
      });
      
      // Increment tickets sold
      await storage.incrementVenueEntryNightTicketsSold(entryNightId);
      
      // Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(ticket.validationCode);
      
      res.json({ ticket, qrCode: qrCodeDataUrl });
    } catch (error) {
      console.error("Confirm venue ticket error:", error);
      res.status(500).json({ message: "Failed to confirm ticket purchase" });
    }
  });

  // Validate venue ticket (for check-in)
  app.post("/api/venue-tickets/validate", requireOrganizer, async (req, res) => {
    try {
      const { validationCode } = req.body;
      
      const ticket = await storage.getVenueTicketByValidationCode(validationCode);
      if (!ticket) {
        return res.status(404).json({ message: "Invalid ticket" });
      }
      
      if (ticket.status === "checked_in") {
        return res.status(400).json({ message: "Ticket already used" });
      }
      
      const entryNight = await storage.getVenueEntryNight(ticket.venueEntryNightId);
      if (!entryNight) {
        return res.status(404).json({ message: "Entry night not found" });
      }
      
      const venue = await storage.getVenue(entryNight.venueId);
      if (!venue || venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only validate tickets for your own venues" });
      }
      
      const checkedInTicket = await storage.checkInVenueTicket(ticket.id, req.user!.id);
      
      res.json({ 
        success: true, 
        ticket: checkedInTicket,
        entryNight,
        venue
      });
    } catch (error) {
      console.error("Validate venue ticket error:", error);
      res.status(500).json({ message: "Failed to validate ticket" });
    }
  });

  // =============================================
  // SEARCH & DISCOVERY ROUTES
  // =============================================

  // Universal search endpoint
  app.get("/api/search", requireAuth, async (req, res) => {
    try {
      const query = (req.query.q as string || "").trim();
      const types = req.query.types ? (req.query.types as string).split(",") : undefined;
      
      if (query.length < 2) {
        return res.json({
          users: [],
          events: [],
          venues: [],
          posts: [],
        });
      }
      
      if (query.length > 100) {
        return res.status(400).json({ message: "Search query too long" });
      }
      
      const results = await storage.universalSearch(query, types);
      res.json(results);
    } catch (error) {
      console.error("Universal search error:", error);
      res.status(500).json({ message: "Search failed" });
    }
  });

  // Trending posts
  app.get("/api/trending/posts", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const posts = await storage.getTrendingPosts(limit);
      res.json(posts);
    } catch (error) {
      console.error("Trending posts error:", error);
      res.status(500).json({ message: "Failed to get trending posts" });
    }
  });

  // Trending events
  app.get("/api/trending/events", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const events = await storage.getTrendingEvents(limit);
      res.json(events);
    } catch (error) {
      console.error("Trending events error:", error);
      res.status(500).json({ message: "Failed to get trending events" });
    }
  });

  // Trending venues
  app.get("/api/trending/venues", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const venues = await storage.getTrendingVenues(limit);
      res.json(venues);
    } catch (error) {
      console.error("Trending venues error:", error);
      res.status(500).json({ message: "Failed to get trending venues" });
    }
  });

  // Trending stories
  app.get("/api/trending/stories", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const stories = await storage.getTrendingStories(limit);
      res.json(stories);
    } catch (error) {
      console.error("Trending stories error:", error);
      res.status(500).json({ message: "Failed to get trending stories" });
    }
  });

  // Suggested users to follow
  app.get("/api/suggested-users", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
      const suggestedUsers = await storage.getSuggestedUsers(req.user!.id, limit);
      res.json(suggestedUsers);
    } catch (error) {
      console.error("Suggested users error:", error);
      res.status(500).json({ message: "Failed to get suggested users" });
    }
  });

  // Object Storage Routes (for venue image uploads)
  // Get presigned URL for uploading
  app.post("/api/objects/upload", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ message: "Failed to get upload URL" });
    }
  });

  // Serve uploaded objects (public visibility for venue images)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      const canAccess = await objectStorageService.canAccessObjectEntity({
        objectFile,
        userId: req.user?.id,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canAccess) {
        return res.sendStatus(401);
      }
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error serving object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Set ACL policy for venue images and get normalized path
  app.put("/api/venue-images", requireAuth, async (req, res) => {
    if (!req.body.imageURL) {
      return res.status(400).json({ message: "imageURL is required" });
    }

    const userId = req.user!.id;

    try {
      const objectStorageService = new ObjectStorageService();
      const objectPath = await objectStorageService.trySetObjectEntityAclPolicy(
        req.body.imageURL,
        {
          owner: userId,
          visibility: "public",
        }
      );

      res.status(200).json({ objectPath });
    } catch (error) {
      console.error("Error setting venue image:", error);
      res.status(500).json({ message: "Failed to process venue image" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
