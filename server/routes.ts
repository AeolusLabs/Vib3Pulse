import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
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
import { fetchLinkPreview } from "./linkPreviewService";
import { sendPushNotification, getVapidPublicKey } from "./pushService";
import { registerSafetyRoutes, startSafetyTimerJob } from "./safety-routes";
import { registerPaymentRoutes } from "./payment-routes";
import { buddyRouter } from "./buddyRoutes";
import { startBuddyScheduler } from "./buddyScheduler";

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
  // Unified helper: DB notification + WebSocket + push notification
  async function deliverNotification(params: {
    userId: string;
    type: string;
    title: string;
    message: string;
    link?: string;
    relatedUserId?: string;
    relatedEntityId?: string;
  }): Promise<void> {
    await storage.createNotification(params as Parameters<typeof storage.createNotification>[0]);
    wsManager.sendToUser(params.userId, { type: "notification", data: { type: params.type } });
    sendPushNotification(params.userId, {
      title: params.title,
      body: params.message,
      url: params.link,
      tag: params.type,
    }).catch(() => {});
  }

  // ==================== CONFIG ROUTES ====================

  // Expose app configuration (safe public info only)
  app.get("/api/config", (req, res) => {
    res.json({
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
      paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
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

  // Change password
  app.patch("/api/auth/change-password", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }
      
      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      const bcrypt = await import("bcrypt");
      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUserPassword(req.user!.id, hashedPassword);
      res.json({ message: "Password changed successfully" });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  // Forgot password - request reset email
  app.post("/api/auth/forgot-password", authRateLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }
      
      const user = await storage.getUserByEmail(email);
      
      // Always return success to prevent email enumeration attacks
      if (!user) {
        return res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      }
      
      // Generate secure random token
      const crypto = await import("crypto");
      const resetToken = crypto.randomBytes(32).toString("hex");
      
      // Token expires in 1 hour
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      
      await storage.setPasswordResetToken(user.id, resetToken, expires);
      
      // Send reset email
      const { sendPasswordResetEmail } = await import("./emailService");
      const baseUrl = process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.APP_URL || "http://localhost:5000";
      const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;
      
      const emailSent = await sendPasswordResetEmail({
        to: user.email,
        resetLink,
        userName: user.displayName || user.username,
      });
      
      if (!emailSent) {
        console.error("Failed to send password reset email to:", email);
      }
      
      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
    } catch (error) {
      console.error("Error in forgot-password:", error);
      res.status(500).json({ message: "Failed to process password reset request" });
    }
  });

  // Reset password with token
  app.post("/api/auth/reset-password", authRateLimiter, async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) {
        return res.status(400).json({ message: "Token and new password are required" });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      
      const user = await storage.getUserByPasswordResetToken(token);
      if (!user) {
        // Log internally for admin monitoring, but return generic error to prevent token enumeration
        console.log("Password reset attempted with invalid or expired token");
        return res.status(400).json({ message: "Unable to reset password. Please request a new reset link." });
      }
      
      // Use the same hashPassword function as signup for consistency
      const hashedPassword = await hashPassword(newPassword);
      
      await storage.updateUserPassword(user.id, hashedPassword);
      console.log(`Password reset successful for user ${user.id} (${user.email})`);
      await storage.clearPasswordResetToken(user.id);
      
      res.json({ message: "Password has been reset successfully. You can now login with your new password." });
    } catch (error) {
      console.error("Error in reset-password:", error);
      // Return same generic error message to prevent information leakage
      res.status(400).json({ message: "Unable to reset password. Please request a new reset link." });
    }
  });

  // Change username
  app.patch("/api/users/me/username", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const { newUsername } = req.body;
      if (!newUsername) {
        return res.status(400).json({ message: "New username is required" });
      }
      if (newUsername.length < 3) {
        return res.status(400).json({ message: "Username must be at least 3 characters" });
      }
      
      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (user.usernameChangesRemaining <= 0) {
        return res.status(400).json({ message: "No username changes remaining. You can only change your username twice." });
      }
      
      const existingUser = await storage.getUserByUsername(newUsername);
      if (existingUser && existingUser.id !== user.id) {
        return res.status(400).json({ message: "Username is already taken" });
      }
      
      const updatedUser = await storage.updateUsername(req.user!.id, newUsername);
      
      // Update session with new username
      req.login(userToSessionUser(updatedUser), (err) => {
        if (err) {
          console.error("Error updating session:", err);
        }
      });
      
      res.json({ 
        message: "Username changed successfully",
        user: userToSessionUser(updatedUser),
        usernameChangesRemaining: updatedUser.usernameChangesRemaining
      });
    } catch (error) {
      console.error("Error changing username:", error);
      res.status(500).json({ message: "Failed to change username" });
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
      
      // Enforce one-time gender edit: only block if the submitted value
      // actually differs from what is already stored.
      if (updates.gender !== undefined) {
        const currentUser = await storage.getUser(userId);
        if (currentUser?.genderEditedAt && updates.gender !== currentUser.gender) {
          return res.status(400).json({ message: "Gender can only be changed once" });
        }
      }
      
      const updatedUser = await storage.updateUser(userId, updates);
      // Refresh session so updated displayName/avatar immediately reflect in navigation
      req.login(userToSessionUser(updatedUser), (err) => {
        if (err) console.error('Session refresh error after profile update:', err);
      });
      const { passwordHash, ...userWithoutPassword } = updatedUser as any;
      res.json(userWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid profile data", errors: error.errors });
      }
      console.error('Error updating profile:', error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Batch fetch users by usernames (for @mentions avatar lookup)
  app.post("/api/users/by-usernames", async (req, res) => {
    try {
      const { usernames } = req.body;
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.json([]);
      }
      // Limit to 50 usernames per request
      const limitedUsernames = usernames.slice(0, 50);
      const users = await storage.getUsersByUsernames(limitedUsernames);
      // Only return public profile info for mentions
      const publicUsers = users.map(u => ({
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
      }));
      res.json(publicUsers);
    } catch (error) {
      console.error("Error fetching users by usernames:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Helper function to add price ranges to events
  async function addPriceRangesToEvents<T extends { id: string; ticketPrice: number }>(events: T[]): Promise<(T & { minPrice: number; maxPrice: number })[]> {
    return Promise.all(
      events.map(async (event) => {
        try {
          const tiers = await storage.getEventTicketTiers(event.id);
          if (tiers.length === 0) {
            return {
              ...event,
              minPrice: event.ticketPrice,
              maxPrice: event.ticketPrice,
            };
          }
          const prices = tiers.map(t => t.priceSmallestUnit);
          return {
            ...event,
            minPrice: Math.min(...prices),
            maxPrice: Math.max(...prices),
          };
        } catch {
          return {
            ...event,
            minPrice: event.ticketPrice,
            maxPrice: event.ticketPrice,
          };
        }
      })
    );
  }

  // Events
  app.get("/api/events", async (req, res) => {
    try {
      const events = await storage.getEvents();
      const eventsWithPriceRanges = await addPriceRangesToEvents(events);
      res.json(eventsWithPriceRanges);
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
      // Filter events by category (case-insensitive)
      const filteredEvents = allEvents.filter(
        (event) => event.category.toLowerCase() === category.toLowerCase()
      );
      const eventsWithPrices = await addPriceRangesToEvents(filteredEvents);
      res.json(eventsWithPrices);
    } catch (error) {
      console.error('Error fetching events by category:', error);
      res.status(500).json({ message: "Failed to fetch events by category" });
    }
  });

  // Get featured events for landing page (public endpoint)
  app.get("/api/events/featured", async (req, res) => {
    try {
      const allEvents = await storage.getEvents();
      // Return upcoming events sorted by date, limit to 8
      const now = new Date();
      const featuredEvents = allEvents
        .filter((event) => new Date(event.eventDate) >= now)
        .sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime())
        .slice(0, 8);
      const eventsWithPrices = await addPriceRangesToEvents(featuredEvents);
      res.json(eventsWithPrices);
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
      
      // Filter by max distance if provided
      const filteredEvents = maxDist 
        ? eventsWithDistance.filter(e => e.distance === null || e.distance <= maxDist)
        : eventsWithDistance;
      
      const eventsWithPrices = await addPriceRangesToEvents(filteredEvents);
      res.json(eventsWithPrices);
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
      
      const eventsWithPrices = await addPriceRangesToEvents(nearbyUpcoming);
      res.json(eventsWithPrices);
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
      
      const eventsWithPrices = await addPriceRangesToEvents(sortedEvents);
      res.json(eventsWithPrices);
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

  // Bouncer redeems a 6-digit code → gets scanner token (no auth required)
  app.post("/api/scanner/auth", async (req, res) => {
    try {
      const schema = z.object({
        code: z.string().length(6),
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
  app.post("/api/events/:eventId/staff-access/validate", async (req, res) => {
    try {
      const schema = z.object({
        code: z.string().length(6),
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
        link: `/events/${eventId}`,
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

  // Generic image upload endpoint for posts/venues (supports multiple images)
  app.post("/api/upload-images", requireAuth, async (req, res) => {
    try {
      const { images } = req.body;
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ message: "No images provided" });
      }
      if (images.length > 6) {
        return res.status(400).json({ message: "Maximum 6 images allowed per upload" });
      }
      const urls: string[] = [];
      for (const imageData of images) {
        if (!imageData || !imageData.startsWith('data:image')) continue;
        const url = await storeMedia(imageData, req.user!.id);
        urls.push(url);
      }
      res.json({ urls });
    } catch (error) {
      console.error("Error uploading images:", error);
      res.status(500).json({ message: "Failed to upload images" });
    }
  });

  app.post("/api/upload-video", requireAuth, async (req, res) => {
    try {
      const { videoData } = req.body;
      if (!videoData || !videoData.startsWith('data:video')) {
        return res.status(400).json({ message: "Invalid video data" });
      }
      const videoUrl = await storeMedia(videoData, req.user!.id);
      res.json({ videoUrl });
    } catch (error) {
      console.error("Error uploading video:", error);
      res.status(500).json({ message: "Failed to upload video" });
    }
  });

  // Posts
  app.get("/api/posts", async (req, res) => {
    try {
      const posts = await storage.getPostsWithCommunity();
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
      
      // If posting to a community, validate membership
      if (postData.communityId) {
        const isMember = await storage.isCommunityMember(req.user!.id, postData.communityId);
        if (!isMember) {
          return res.status(403).json({ message: "You must be a member of this community to post" });
        }
      }
      
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
          await deliverNotification({
            userId: mentionedUser.id,
            type: "mention",
            title: "You were mentioned",
            message: `${poster?.displayName || poster?.username || "Someone"} mentioned you in a post`,
            link: `/feed`,
            relatedUserId: req.user!.id,
            relatedEntityId: post.id,
          });
        }
      }

      // Notify community members if this is a community post
      if (postData.communityId) {
        const community = await storage.getCommunity(postData.communityId);
        const memberIds = await storage.getCommunityMemberIds(postData.communityId);
        const poster = await storage.getUser(req.user!.id);
        
        for (const memberId of memberIds) {
          // Don't notify the poster themselves
          if (memberId !== req.user!.id) {
            await deliverNotification({
              userId: memberId,
              type: "community_post",
              title: `New post in ${community?.name}`,
              message: `${poster?.displayName || poster?.username || "Someone"} posted in ${community?.name}`,
              link: `/feed`,
              relatedUserId: req.user!.id,
              relatedEntityId: post.id,
            });
          }
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

  // ──── Media Storage (Railway-compatible, DB-backed) ────────────────────────

  // Helper: store base64 data URL in DB, return /api/media/{id} URL
  async function storeMedia(data: string, ownerId: string): Promise<string> {
    const contentTypeMatch = data.match(/data:([^;]+);base64/);
    const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
    const id = await storage.saveMedia(data, contentType, ownerId);
    return `/api/media/${id}`;
  }

  // Serve any uploaded media from DB
  app.get("/api/media/:id", async (req, res) => {
    try {
      const media = await storage.getMedia(req.params.id);
      if (!media) return res.sendStatus(404);
      const base64 = media.data.includes(',') ? media.data.split(',')[1] : media.data;
      const buffer = Buffer.from(base64, 'base64');
      res.set('Content-Type', media.contentType);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Length', String(buffer.length));
      res.send(buffer);
    } catch {
      res.sendStatus(500);
    }
  });

  // Central upload: accepts base64 data URL, stores in DB, returns /api/media/{id} URL
  app.post("/api/media/upload", requireAuth, async (req, res) => {
    try {
      const { data } = req.body;
      if (!data || !data.startsWith('data:')) {
        return res.status(400).json({ message: "Invalid media data" });
      }
      const url = await storeMedia(data, req.user!.id);
      res.json({ url });
    } catch {
      res.status(500).json({ message: "Failed to save media" });
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

  // Get story image upload URL (legacy endpoint — kept for compatibility)
  app.get("/api/stories/upload-url", requireAuth, async (req, res) => {
    const tempId = crypto.randomUUID();
    res.json({ uploadURL: `/api/media/binary-upload/${tempId}`, stablePath: null });
  });

  // Server-side story image upload (bypasses CORS issues)
  app.post("/api/stories/upload", requireAuth, async (req, res) => {
    try {
      const { imageData } = req.body;
      const isImage = imageData && imageData.startsWith('data:image');
      const isVideo = imageData && imageData.startsWith('data:video');
      if (!imageData || (!isImage && !isVideo)) {
        return res.status(400).json({ message: "Invalid media data" });
      }
      const stablePath = await storeMedia(imageData, req.user!.id);
      res.json({ stablePath, mediaType: isVideo ? 'video' : 'image' });
    } catch (error) {
      console.error("Error uploading story media:", error);
      res.status(500).json({ message: "Failed to upload media" });
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

  // Fix ACL on existing story images that are missing public visibility
  app.post("/api/stories/fix-acl", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const allStories = await storage.getActiveStories(req.user!.id);
      const userStories = allStories.filter(s => s.userId === req.user!.id);
      
      let fixed = 0;
      const errors: { storyId: string; error: string }[] = [];
      
      for (const story of userStories) {
        if (story.imageUrl && story.imageUrl.startsWith('/objects/')) {
          try {
            await objectStorageService.trySetObjectEntityAclPolicy(story.imageUrl, {
              owner: req.user!.id,
              visibility: "public",
            });
            fixed++;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // ObjectNotFoundError means the image doesn't exist - not a real failure
            if (errorMessage.includes('ObjectNotFound') || errorMessage.includes('not found')) {
              console.log(`Story ${story.id} image not found in storage, skipping`);
            } else {
              console.error(`Failed to fix ACL for story ${story.id}:`, err);
              errors.push({ storyId: story.id, error: errorMessage });
            }
          }
        }
      }
      
      res.json({ 
        message: `Fixed ACL on ${fixed} story images`,
        fixed,
        total: userStories.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error("Fix ACL error:", error);
      res.status(500).json({ message: "Failed to fix story ACLs" });
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
        await deliverNotification({
          userId: story.userId,
          type: "story_like",
          title: "Story Liked",
          message: `${likerName} liked your story`,
          link: `/stories`,
          relatedUserId: userId,
          relatedEntityId: storyId,
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

  // Story Views - record a view when the viewer opens a story slide
  app.post("/api/stories/:storyId/view", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }

      // Don't record owner viewing their own story
      if (story.userId !== userId) {
        await storage.recordStoryView(storyId, userId);
      }

      const viewCount = await storage.getStoryViewCount(storyId);
      res.json({ viewCount });
    } catch (error) {
      console.error("Record story view error:", error);
      res.status(500).json({ message: "Failed to record view" });
    }
  });

  // Story Interactions - viewers + likers list (owner only)
  app.get("/api/stories/:storyId/interactions", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }

      if (story.userId !== userId) {
        return res.status(403).json({ message: "Only the story owner can view interactions" });
      }

      const viewers = await storage.getStoryViewersWithLikeStatus(storyId);
      const viewCount = viewers.length;
      const likeCount = await storage.getStoryLikeCount(storyId);

      res.json({ viewers, viewCount, likeCount });
    } catch (error) {
      console.error("Get story interactions error:", error);
      res.status(500).json({ message: "Failed to get interactions" });
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
        await deliverNotification({
          userId: post.userId,
          type: "post_like",
          title: "New Post Like",
          message: `${liker?.displayName || liker?.username || "Someone"} liked your post: "${postSnippet}"`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
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
        await deliverNotification({
          userId: post.userId,
          type: "post_comment",
          title: "New Comment",
          message: `${commenter?.displayName || commenter?.username || "Someone"} commented: "${commentSnippet}"`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
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
        await deliverNotification({
          userId: originalPost.userId,
          type: "repost",
          title: "Post Reposted",
          message: `${reposter?.displayName || reposter?.username || "Someone"} reposted your post`,
          link: `/feed`,
          relatedUserId: userId,
          relatedEntityId: postId,
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
      await deliverNotification({
        userId: followingId,
        type: "new_follower",
        title: "New Follower",
        message: `${follower?.displayName || follower?.username || "Someone"} started following you`,
        link: `/profile/${follower?.username}`,
        relatedUserId: followerId,
        relatedEntityId: followerId,
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
        await deliverNotification({
          userId: receiverId,
          type: "new_message",
          title: "New Message",
          message: `${sender.displayName || sender.username}: "${messageSnippet}"`,
          link: `/messages/${senderId}`,
          relatedUserId: senderId,
          relatedEntityId: message.id,
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

  // Link preview endpoint with SSRF protection and rate limiting
  app.get("/api/link-preview", requireAuth, sensitiveOperationLimiter, async (req, res) => {
    try {
      const url = req.query.url as string;
      
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: "URL parameter is required" });
      }
      
      if (url.length > 2048) {
        return res.status(400).json({ message: "URL too long" });
      }
      
      const metadata = await fetchLinkPreview(url);
      
      if (!metadata) {
        return res.status(404).json({ message: "Could not fetch link preview" });
      }
      
      res.json(metadata);
    } catch (error) {
      console.error("Link preview error:", error);
      res.status(500).json({ message: "Failed to fetch link preview" });
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
      await deliverNotification({
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

  // Avatar upload endpoint - server-side upload to DB storage
  app.post("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const { imageData } = req.body;
      if (!imageData || !imageData.startsWith('data:image')) {
        return res.status(400).json({ message: "Invalid image data" });
      }
      // Delete old avatar media if it was a DB-backed URL
      const currentUser = await storage.getUser(req.user!.id);
      if (currentUser?.avatarUrl) {
        await storage.deleteMediaByUrls([currentUser.avatarUrl]);
      }
      const avatarUrl = await storeMedia(imageData, req.user!.id);
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl });
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      return res.json(userWithoutPassword);
    } catch (error: any) {
      console.error("[Avatar Upload] Error:", error?.message || error);
      res.status(500).json({ message: "Failed to upload avatar. Please try again." });
    }
  });

  // Update avatar URL after upload - accepts any path
  app.patch("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      const { avatarPath } = req.body;
      if (!avatarPath) return res.status(400).json({ message: "Avatar path is required" });
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl: avatarPath });
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      res.json(userWithoutPassword);
    } catch (error: any) {
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Delete avatar - removes avatar URL from user profile
  app.delete("/api/users/me/avatar", requireAuth, async (req, res) => {
    try {
      console.log(`[Avatar Delete] User ${req.user!.id} removing avatar`);
      const updatedUser = await storage.updateUser(req.user!.id, { avatarUrl: null });
      console.log(`[Avatar Delete] Successfully removed avatar for user ${req.user!.id}`);
      const { passwordHash, ...userWithoutPassword } = updatedUser;
      res.json(userWithoutPassword);
    } catch (error: any) {
      console.error("[Avatar Delete] Error removing avatar:", error?.message || error);
      res.status(500).json({ message: "Failed to remove avatar" });
    }
  });

  // Group avatar upload endpoint
  app.post("/api/conversations/:id/avatar", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) return res.status(404).json({ message: "Conversation not found" });
      if (!conversation.isGroup) return res.status(400).json({ message: "Avatar upload only available for group chats" });
      const participant = conversation.participants.find(p => p.userId === req.user!.id);
      if (!participant || participant.role !== 'admin') return res.status(403).json({ message: "Only group admins can update the avatar" });

      const { imageData } = req.body;
      if (imageData && imageData.startsWith('data:image')) {
        // Direct upload path
        const avatarUrl = await storeMedia(imageData, req.user!.id);
        const updatedConversation = await storage.updateConversation(conversationId, { avatarUrl });
        return res.json(updatedConversation);
      }
      // Return a dummy upload URL for backward compat with ObjectUploader
      res.json({ uploadURL: '/api/media/upload', stablePath: null });
    } catch (error) {
      console.error("Error with group avatar:", error);
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });

  // Update group avatar URL after upload - accepts the stable path
  app.patch("/api/conversations/:id/avatar", requireAuth, async (req, res) => {
    try {
      const conversationId = req.params.id;
      const { avatarPath } = req.body;
      if (!avatarPath) return res.status(400).json({ message: "Avatar path is required" });
      const conversation = await storage.getConversationById(conversationId);
      if (!conversation) return res.status(404).json({ message: "Conversation not found" });
      if (!conversation.isGroup) return res.status(400).json({ message: "Only group chats have avatars" });
      const participant = conversation.participants.find(p => p.userId === req.user!.id);
      if (!participant || participant.role !== 'admin') return res.status(403).json({ message: "Only admins can update avatar" });
      const updatedConversation = await storage.updateConversation(conversationId, { avatarUrl: avatarPath });
      res.json(updatedConversation);
    } catch (error) {
      res.status(500).json({ message: "Failed to update avatar" });
    }
  });


  // Safety routes (buddy, SOS alerts, check-in timers) handled by safety-routes.ts


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

  // Get unread message count
  app.get("/api/messages/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const count = await storage.getUnreadMessageCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Get unread message count error:", error);
      res.status(500).json({ message: "Failed to get unread message count" });
    }
  });

  // ============================================
  // PUSH NOTIFICATIONS
  // ============================================

  // Return VAPID public key for client subscription
  app.get("/api/push/vapid-public-key", requireAuth, (req, res) => {
    res.json({ key: getVapidPublicKey() });
  });

  // Save push subscription
  app.post("/api/push/subscribe", requireAuth, async (req, res) => {
    try {
      const { endpoint, keys } = req.body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ message: "Invalid subscription" });
      }
      await storage.upsertPushSubscription({
        userId: req.user!.id,
        endpoint,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
      });
      res.json({ message: "Subscribed" });
    } catch (error) {
      console.error("Push subscribe error:", error);
      res.status(500).json({ message: "Failed to save subscription" });
    }
  });

  // Remove push subscription
  app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) return res.status(400).json({ message: "Endpoint required" });
      await storage.deletePushSubscription(endpoint);
      res.json({ message: "Unsubscribed" });
    } catch (error) {
      console.error("Push unsubscribe error:", error);
      res.status(500).json({ message: "Failed to remove subscription" });
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

      // Geocode address to capture lat/lng
      let latitude: number | null = null;
      let longitude: number | null = null;
      const addressParts = [req.body.address, req.body.city].filter(Boolean);
      if (addressParts.length > 0) {
        const coords = await geocodeAddress(addressParts.join(", "));
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
        }
      }

      const venueData = insertVenueSchema.parse({
        ...req.body,
        location,
        ownerId: req.user!.id,
        latitude,
        longitude,
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

      // Re-geocode if address or city changed
      const updates = { ...req.body };
      const addressChanged = updates.address !== undefined || updates.city !== undefined;
      if (addressChanged) {
        const address = updates.address ?? venue.address;
        const city = updates.city ?? venue.city;
        const addressParts = [address, city].filter(Boolean);
        if (addressParts.length > 0) {
          const coords = await geocodeAddress(addressParts.join(", "));
          if (coords) {
            updates.latitude = coords.latitude;
            updates.longitude = coords.longitude;
          }
        }
      }

      const updatedVenue = await storage.updateVenue(req.params.id, updates);
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

  // Create venue event
  app.post("/api/venues/:venueId/venue-events", requireOrganizer, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }
      if (venue.ownerId !== req.user!.id) {
        return res.status(403).json({ message: "You can only create events for your own venues" });
      }
      const eventData = insertVenueEntryNightSchema.parse({
        ...req.body,
        venueId: req.params.venueId,
      });
      const event = await storage.createVenueEntryNight(eventData);
      res.status(201).json(event);
    } catch (error) {
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
      const updatedEvent = await storage.updateVenueEntryNight(req.params.id, updateData);
      res.json(updatedEvent);
    } catch (error) {
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
      const eventEnd = entryNight.date ? new Date(entryNight.date) : null;
      const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const expiresAt = eventEnd && eventEnd < in24h ? eventEnd : in24h;
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

  // Venue event-scoped staff code redemption — bouncer submits code at a specific venue event URL
  app.post("/api/venue-events/:id/staff-access/validate", async (req, res) => {
    try {
      const schema = z.object({
        code: z.string().length(6),
        staffName: z.string().min(1).max(80),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request", errors: parsed.error.errors });
      }
      const { code, staffName } = parsed.data;
      const venueEntryNightId = req.params.id;

      const staffCode = await storage.getVenueStaffCodeByCode(code);
      if (!staffCode) return res.status(404).json({ message: "Invalid code" });
      if (staffCode.venueEntryNightId !== venueEntryNightId) {
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

      const entryNight = await storage.getVenueEntryNight(venueEntryNightId);
      if (!entryNight) return res.status(404).json({ message: "Venue event not found" });

      const scannerToken = crypto.randomBytes(32).toString("hex");
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
      const ua = req.headers["user-agent"] || "";

      const redeemed = await storage.redeemVenueStaffCode(staffCode.id, staffName, ip, ua, scannerToken);

      res.json({
        scannerToken: redeemed.scannerToken,
        eventId: redeemed.venueEntryNightId,
        eventTitle: entryNight.name,
        staffName: redeemed.validatedBy,
        expiresAt: redeemed.expiresAt,
      });
    } catch (error: any) {
      if (error.message === "Code already redeemed or revoked") {
        return res.status(409).json({ message: "This code has already been used" });
      }
      console.error("Venue staff access validate error:", error);
      res.status(500).json({ message: "Failed to authenticate" });
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

  // Venue entry payment routes handled by payment-routes.ts
  // See /api/payments/venue/intent and /api/payments/venue/confirm

  // Validate venue ticket (for check-in) — accepts organizer session or staff scanner token
  app.post("/api/venue-tickets/validate", async (req, res) => {
    try {
      const requestSchema = z.object({
        validationCode: z.string().min(1),
        eventId: z.string().min(1), // venueEntryNightId
      });
      const parseResult = requestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: "Invalid request data" });
      }
      const { validationCode, eventId: venueEntryNightId } = parseResult.data;

      // Resolve scanner identity: staff token or organizer session
      let scannerId: string;
      let venueStaffCodeId: string | null = null;

      const scannerToken = req.headers["x-scanner-token"] as string | undefined;

      if (scannerToken) {
        const venueStaffCode = await storage.getVenueStaffCodeByScannerToken(scannerToken);
        if (!venueStaffCode || venueStaffCode.status !== "active") {
          return res.status(401).json({ message: "Invalid or expired scanner token" });
        }
        if (new Date() > venueStaffCode.expiresAt) {
          return res.status(401).json({ message: "Scanner token has expired" });
        }
        if (venueStaffCode.venueEntryNightId !== venueEntryNightId) {
          return res.status(403).json({ message: "Scanner not authorised for this venue event" });
        }
        const entryNight = await storage.getVenueEntryNight(venueStaffCode.venueEntryNightId);
        const venue = entryNight ? await storage.getVenue(entryNight.venueId) : null;
        if (!venue) return res.status(404).json({ message: "Venue not found" });
        scannerId = venue.ownerId;
        venueStaffCodeId = venueStaffCode.id;
      } else if (req.isAuthenticated()) {
        const entryNight = await storage.getVenueEntryNight(venueEntryNightId);
        if (!entryNight) return res.status(404).json({ message: "Entry night not found" });
        const venue = await storage.getVenue(entryNight.venueId);
        if (!venue || venue.ownerId !== req.user!.id) {
          return res.status(403).json({ message: "You can only validate tickets for your own venues" });
        }
        scannerId = req.user!.id;
      } else {
        return res.status(401).json({ message: "Authentication required" });
      }

      const ticket = await storage.getVenueTicketByValidationCode(validationCode);
      if (!ticket) {
        return res.status(404).json({ valid: false, message: "Invalid ticket code" });
      }

      if (ticket.venueEntryNightId !== venueEntryNightId) {
        return res.status(400).json({ valid: false, message: "This ticket is not for this venue event" });
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

      const checkedInTicket = await storage.checkInVenueTicket(ticket.id, scannerId);
      if (!checkedInTicket) {
        return res.json({
          valid: false,
          alreadyCheckedIn: true,
          message: "Ticket already used",
          ticket,
        });
      }

      if (venueStaffCodeId) {
        await storage.incrementVenueStaffCodeScanCount(venueStaffCodeId);
      }

      const ticketUser = await storage.getUser(checkedInTicket.userId);
      res.json({
        valid: true,
        alreadyCheckedIn: false,
        message: "Ticket validated successfully",
        ticket: { ...checkedInTicket, user: ticketUser },
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
          venueEvents: [],
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

  // Recommended users based on interests and location
  app.get("/api/recommended-users", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 15, 30);
      const recommendedUsers = await storage.getRecommendedUsers(req.user!.id, limit);
      res.json(recommendedUsers);
    } catch (error) {
      console.error("Recommended users error:", error);
      res.status(500).json({ message: "Failed to get recommended users" });
    }
  });

  // Object Storage Routes (Railway-compatible — no GCS)
  // Returns a fake presigned URL that points to our binary upload endpoint
  app.post("/api/objects/upload", requireAuth, async (req, res) => {
    const tempId = crypto.randomUUID();
    res.json({ uploadURL: `/api/media/binary-upload/${tempId}` });
  });

  // Serve uploaded objects (legacy /objects/ paths — fallback to 404)
  app.get("/objects/:objectPath(*)", async (req, res) => {
    return res.sendStatus(404);
  });

  // Receives raw binary from VideoUploader XHR (replaces GCS presigned PUT)
  const tempBinaryStore = new Map<string, { buffer: Buffer; contentType: string }>();

  app.put("/api/media/binary-upload/:tempId", requireAuth, express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    try {
      const contentType = req.headers['content-type'] || 'video/mp4';
      tempBinaryStore.set(req.params.tempId, { buffer: req.body as Buffer, contentType });
      // Clean up after 5 minutes
      setTimeout(() => tempBinaryStore.delete(req.params.tempId), 5 * 60 * 1000);
      res.sendStatus(200);
    } catch {
      res.sendStatus(500);
    }
  });

  // Set ACL policy for post media and get normalized path
  app.put("/api/post-media", requireAuth, async (req, res) => {
    try {
      const { imageURL } = req.body;
      if (!imageURL) return res.status(400).json({ message: "imageURL is required" });
      // imageURL is now either a /api/media/binary-upload/{tempId} or a real URL
      const tempIdMatch = imageURL.match(/\/api\/media\/binary-upload\/([a-f0-9-]+)$/);
      if (tempIdMatch) {
        const tempId = tempIdMatch[1];
        const stored = tempBinaryStore.get(tempId);
        if (!stored) return res.status(404).json({ message: "Upload not found or expired" });
        const base64 = stored.buffer.toString('base64');
        const dataUrl = `data:${stored.contentType};base64,${base64}`;
        const objectPath = await storeMedia(dataUrl, req.user!.id);
        tempBinaryStore.delete(tempId);
        return res.json({ objectPath });
      }
      // Already a real URL — just return it
      res.json({ objectPath: imageURL });
    } catch (error) {
      console.error("Error processing media:", error);
      res.status(500).json({ message: "Failed to process post media" });
    }
  });

  app.put("/api/venue-images", requireAuth, async (req, res) => {
    try {
      const { imageURL } = req.body;
      if (!imageURL) return res.status(400).json({ message: "imageURL is required" });
      // Same logic as /api/post-media
      const tempIdMatch = imageURL.match(/\/api\/media\/binary-upload\/([a-f0-9-]+)$/);
      if (tempIdMatch) {
        const tempId = tempIdMatch[1];
        const stored = tempBinaryStore.get(tempId);
        if (!stored) return res.status(404).json({ message: "Upload not found or expired" });
        const base64 = stored.buffer.toString('base64');
        const dataUrl = `data:${stored.contentType};base64,${base64}`;
        const objectPath = await storeMedia(dataUrl, req.user!.id);
        tempBinaryStore.delete(tempId);
        return res.json({ objectPath });
      }
      res.json({ objectPath: imageURL });
    } catch (error) {
      res.status(500).json({ message: "Failed to process venue image" });
    }
  });

  // ============================================
  // COMMUNITY ROUTES
  // ============================================

  // Get all communities
  app.get("/api/communities", async (req, res) => {
    try {
      const communities = await storage.getCommunities();
      res.json(communities);
    } catch (error) {
      console.error("Error fetching communities:", error);
      res.status(500).json({ message: "Failed to fetch communities" });
    }
  });

  // Get user's communities (communities they are a member of)
  app.get("/api/communities/my", requireAuth, async (req, res) => {
    try {
      const communities = await storage.getUserCommunities(req.user!.id);
      res.json(communities);
    } catch (error) {
      console.error("Error fetching user communities:", error);
      res.status(500).json({ message: "Failed to fetch user communities" });
    }
  });

  // Get a specific community
  app.get("/api/communities/:id", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      res.json(community);
    } catch (error) {
      console.error("Error fetching community:", error);
      res.status(500).json({ message: "Failed to fetch community" });
    }
  });

  // Create a new community
  app.post("/api/communities", requireAuth, async (req, res) => {
    try {
      const { name, description, coverImageUrl } = req.body;
      
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ message: "Community name is required" });
      }

      // Generate slug from name
      const slug = name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);

      // Check if slug already exists
      const existingCommunity = await storage.getCommunityBySlug(slug);
      if (existingCommunity) {
        return res.status(400).json({ message: "A community with a similar name already exists" });
      }

      const community = await storage.createCommunity({
        name: sanitizeTextOnly(name.trim()),
        slug,
        description: description ? sanitizeTextOnly(description) : null,
        coverImageUrl: coverImageUrl || null,
        createdByUserId: req.user!.id,
      });

      // Auto-join the creator as owner
      await storage.joinCommunity(req.user!.id, community.id, "owner");

      res.status(201).json(community);
    } catch (error) {
      console.error("Error creating community:", error);
      res.status(500).json({ message: "Failed to create community" });
    }
  });

  // Update a community
  app.put("/api/communities/:id", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership || membership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can update this community" });
      }

      const { name, description, coverImageUrl } = req.body;
      const updates: any = {};
      
      if (name) updates.name = sanitizeTextOnly(name.trim());
      if (description !== undefined) updates.description = description ? sanitizeTextOnly(description) : null;
      if (coverImageUrl !== undefined) updates.coverImageUrl = coverImageUrl;

      const updatedCommunity = await storage.updateCommunity(req.params.id, updates);
      res.json(updatedCommunity);
    } catch (error) {
      console.error("Error updating community:", error);
      res.status(500).json({ message: "Failed to update community" });
    }
  });

  // Delete a community
  app.delete("/api/communities/:id", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership || membership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can delete this community" });
      }

      await storage.deleteCommunity(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting community:", error);
      res.status(500).json({ message: "Failed to delete community" });
    }
  });

  // Join a community
  app.post("/api/communities/:id/join", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if already a member
      const isMember = await storage.isCommunityMember(req.user!.id, req.params.id);
      if (isMember) {
        return res.status(400).json({ message: "Already a member of this community" });
      }

      const membership = await storage.joinCommunity(req.user!.id, req.params.id);
      res.status(201).json(membership);
    } catch (error) {
      console.error("Error joining community:", error);
      res.status(500).json({ message: "Failed to join community" });
    }
  });

  // Leave a community
  app.delete("/api/communities/:id/leave", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (membership?.role === "owner") {
        return res.status(400).json({ message: "Owner cannot leave the community. Transfer ownership or delete the community." });
      }

      await storage.leaveCommunity(req.user!.id, req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error leaving community:", error);
      res.status(500).json({ message: "Failed to leave community" });
    }
  });

  // Get community members
  app.get("/api/communities/:id/members", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const members = await storage.getCommunityMembers(req.params.id, limit, offset);
      res.json(members);
    } catch (error) {
      console.error("Error fetching community members:", error);
      res.status(500).json({ message: "Failed to fetch community members" });
    }
  });

  // Get community posts
  app.get("/api/communities/:id/posts", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10) || 30, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const posts = await storage.getCommunityPosts(req.params.id, limit, offset);
      res.json(posts);
    } catch (error) {
      console.error("Error fetching community posts:", error);
      res.status(500).json({ message: "Failed to fetch community posts" });
    }
  });

  // Check membership status
  app.get("/api/communities/:id/membership", requireAuth, async (req, res) => {
    try {
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      res.json({ isMember: !!membership, membership: membership || null });
    } catch (error) {
      console.error("Error checking membership:", error);
      res.status(500).json({ message: "Failed to check membership" });
    }
  });

  // Toggle notification preference for current user in a community
  app.patch("/api/communities/:id/notifications", requireAuth, async (req, res) => {
    try {
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership) {
        return res.status(403).json({ message: "You are not a member of this community" });
      }
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }
      await storage.setCommunityNotifications(req.user!.id, req.params.id, enabled);
      res.json({ notificationsEnabled: enabled });
    } catch (error) {
      console.error("Error updating notification preference:", error);
      res.status(500).json({ message: "Failed to update notification preference" });
    }
  });

  // Get community by slug
  app.get("/api/communities/slug/:slug", async (req, res) => {
    try {
      const community = await storage.getCommunityBySlug(req.params.slug);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      const details = await storage.getCommunityWithDetails(community.id);
      res.json(details);
    } catch (error) {
      console.error("Error fetching community by slug:", error);
      res.status(500).json({ message: "Failed to fetch community" });
    }
  });

  // Get events linked to a community
  app.get("/api/communities/:id/events", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      const communityEvents = await storage.getCommunityEvents(req.params.id);
      res.json(communityEvents);
    } catch (error) {
      console.error("Error fetching community events:", error);
      res.status(500).json({ message: "Failed to fetch community events" });
    }
  });

  // Update a member's role (owner only)
  app.patch("/api/communities/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || callerMembership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can change member roles" });
      }

      if (req.params.userId === req.user!.id) {
        return res.status(400).json({ message: "Use transfer-ownership to change your own role" });
      }

      const { role } = req.body;
      if (!["moderator", "member"].includes(role)) {
        return res.status(400).json({ message: "Role must be 'moderator' or 'member'" });
      }

      const targetMembership = await storage.getCommunityMembership(req.params.userId, req.params.id);
      if (!targetMembership) {
        return res.status(404).json({ message: "Member not found" });
      }

      const updated = await storage.updateCommunityMemberRole(req.params.userId, req.params.id, role);
      res.json(updated);
    } catch (error) {
      console.error("Error updating member role:", error);
      res.status(500).json({ message: "Failed to update member role" });
    }
  });

  // Kick a member (owner or moderator)
  app.delete("/api/communities/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || !["owner", "moderator"].includes(callerMembership.role)) {
        return res.status(403).json({ message: "Only owners and moderators can remove members" });
      }

      if (req.params.userId === req.user!.id) {
        return res.status(400).json({ message: "Use the leave endpoint to leave the community" });
      }

      const targetMembership = await storage.getCommunityMembership(req.params.userId, req.params.id);
      if (!targetMembership) {
        return res.status(404).json({ message: "Member not found" });
      }

      if (callerMembership.role === "moderator" && ["owner", "moderator"].includes(targetMembership.role)) {
        return res.status(403).json({ message: "Moderators can only remove regular members" });
      }

      await storage.removeCommunityMember(req.params.userId, req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error removing community member:", error);
      res.status(500).json({ message: "Failed to remove member" });
    }
  });

  // Transfer community ownership (owner only)
  app.patch("/api/communities/:id/transfer-ownership", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || callerMembership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can transfer ownership" });
      }

      const { newOwnerId } = req.body;
      if (!newOwnerId) {
        return res.status(400).json({ message: "newOwnerId is required" });
      }

      const newOwnerMembership = await storage.getCommunityMembership(newOwnerId, req.params.id);
      if (!newOwnerMembership) {
        return res.status(404).json({ message: "New owner must be a member of this community" });
      }

      await storage.updateCommunityMemberRole(req.user!.id, req.params.id, "member");
      await storage.updateCommunityMemberRole(newOwnerId, req.params.id, "owner");
      await storage.updateCommunity(req.params.id, { createdByUserId: newOwnerId });

      res.json({ message: "Ownership transferred successfully" });
    } catch (error) {
      console.error("Error transferring ownership:", error);
      res.status(500).json({ message: "Failed to transfer ownership" });
    }
  });

  // ============================================
  // GROUP CHATS / CONVERSATIONS API
  // ============================================

  // Get all conversations for current user
  app.get("/api/conversations", requireAuth, async (req, res) => {
    try {
      const userConversations = await storage.getUserConversations(req.user!.id);
      res.json(userConversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ message: "Failed to fetch conversations" });
    }
  });

  // Create a new group chat
  app.post("/api/conversations/group", requireAuth, async (req, res) => {
    try {
      const { name, participantIds, avatarUrl } = req.body;
      
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ message: "Group name is required" });
      }
      
      if (!participantIds || !Array.isArray(participantIds) || participantIds.length < 1) {
        return res.status(400).json({ message: "At least one participant is required" });
      }
      
      // Ensure creator is included in participants
      const allParticipants = Array.from(new Set([req.user!.id, ...participantIds]));
      
      const conversation = await storage.createConversation(
        {
          isGroup: true,
          name: name.trim(),
          avatarUrl,
          createdById: req.user!.id,
        },
        allParticipants
      );
      
      // Fetch with participants
      const fullConversation = await storage.getConversationById(conversation.id);
      res.status(201).json(fullConversation);
    } catch (error) {
      console.error("Error creating group chat:", error);
      res.status(500).json({ message: "Failed to create group chat" });
    }
  });

  // Get or create a direct conversation
  app.post("/api/conversations/direct", requireAuth, async (req, res) => {
    try {
      const { userId } = req.body;
      
      if (!userId || userId === req.user!.id) {
        return res.status(400).json({ message: "Valid user ID required" });
      }
      
      const conversation = await storage.getOrCreateDirectConversation(req.user!.id, userId);
      const fullConversation = await storage.getConversationById(conversation.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error creating direct conversation:", error);
      res.status(500).json({ message: "Failed to create conversation" });
    }
  });

  // Get a specific conversation
  app.get("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Check if user is a participant
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      res.json(conversation);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ message: "Failed to fetch conversation" });
    }
  });

  // Update group settings (name, avatar)
  app.patch("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot update direct conversations" });
      }
      
      // Only admins can update group settings
      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can update group settings" });
      }
      
      const { name, avatarUrl } = req.body;
      const updates: any = {};
      
      if (name !== undefined) updates.name = name.trim();
      if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
      
      const updated = await storage.updateConversation(req.params.id, updates);
      const fullConversation = await storage.getConversationById(updated.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error updating conversation:", error);
      res.status(500).json({ message: "Failed to update conversation" });
    }
  });

  // Delete a group (admin only)
  app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot delete direct conversations" });
      }
      
      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can delete groups" });
      }
      
      await storage.deleteConversation(req.params.id);
      res.json({ message: "Group deleted" });
    } catch (error) {
      console.error("Error deleting conversation:", error);
      res.status(500).json({ message: "Failed to delete conversation" });
    }
  });

  // Add a participant to group
  app.post("/api/conversations/:id/participants", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot add participants to direct conversations" });
      }
      
      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can add participants" });
      }
      
      const { userId, userRole = 'member' } = req.body;
      
      if (!userId) {
        return res.status(400).json({ message: "User ID required" });
      }
      
      // Check if already a participant
      const isAlreadyParticipant = await storage.isConversationParticipant(req.params.id, userId);
      if (isAlreadyParticipant) {
        return res.status(400).json({ message: "User is already a participant" });
      }
      
      const participant = await storage.addConversationParticipant(req.params.id, userId, userRole);
      res.status(201).json(participant);
    } catch (error) {
      console.error("Error adding participant:", error);
      res.status(500).json({ message: "Failed to add participant" });
    }
  });

  // Remove a participant from group
  app.delete("/api/conversations/:id/participants/:userId", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot remove participants from direct conversations" });
      }
      
      const currentUserRole = await storage.getParticipantRole(req.params.id, req.user!.id);
      const isRemovingSelf = req.params.userId === req.user!.id;
      
      // Users can remove themselves, admins can remove others
      if (!isRemovingSelf && currentUserRole !== 'admin') {
        return res.status(403).json({ message: "Only admins can remove other participants" });
      }
      
      // Check if trying to remove the last admin
      if (isRemovingSelf && currentUserRole === 'admin') {
        const participants = await storage.getConversationParticipants(req.params.id);
        const admins = participants.filter(p => p.role === 'admin');
        
        if (admins.length === 1) {
          return res.status(400).json({ message: "Cannot leave group - you are the last admin. Transfer admin role first or delete the group." });
        }
      }
      
      await storage.removeConversationParticipant(req.params.id, req.params.userId);
      res.json({ message: "Participant removed" });
    } catch (error) {
      console.error("Error removing participant:", error);
      res.status(500).json({ message: "Failed to remove participant" });
    }
  });

  // Update participant role
  app.patch("/api/conversations/:id/participants/:userId", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot update roles in direct conversations" });
      }
      
      const currentUserRole = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ message: "Only admins can update roles" });
      }
      
      const { role } = req.body;
      if (!role || !['admin', 'member'].includes(role)) {
        return res.status(400).json({ message: "Valid role required (admin or member)" });
      }
      
      const updated = await storage.updateParticipantRole(req.params.id, req.params.userId, role);
      res.json(updated);
    } catch (error) {
      console.error("Error updating participant role:", error);
      res.status(500).json({ message: "Failed to update role" });
    }
  });

  // Generate invite code for group
  app.post("/api/conversations/:id/invite", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);
      
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot create invite for direct conversations" });
      }
      
      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can generate invite codes" });
      }
      
      const inviteCode = await storage.generateInviteCode(req.params.id);
      res.json({ inviteCode });
    } catch (error) {
      console.error("Error generating invite code:", error);
      res.status(500).json({ message: "Failed to generate invite code" });
    }
  });

  // Join group via invite code
  app.post("/api/conversations/join/:code", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationByInviteCode(req.params.code);
      
      if (!conversation) {
        return res.status(404).json({ message: "Invalid invite code" });
      }
      
      // Check if already a participant
      const isAlreadyParticipant = await storage.isConversationParticipant(conversation.id, req.user!.id);
      if (isAlreadyParticipant) {
        // Return the conversation anyway so they can navigate to it
        const fullConversation = await storage.getConversationById(conversation.id);
        return res.json(fullConversation);
      }
      
      // Add as member
      await storage.addConversationParticipant(conversation.id, req.user!.id, 'member');
      const fullConversation = await storage.getConversationById(conversation.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error joining group:", error);
      res.status(500).json({ message: "Failed to join group" });
    }
  });

  // Get conversation messages
  app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      const limit = parseInt(req.query.limit as string) || 50;
      const before = req.query.before as string | undefined;
      
      const messages = await storage.getConversationMessages(req.params.id, limit, before);
      
      // Mark as read
      await storage.updateLastReadAt(req.params.id, req.user!.id);
      
      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  // Send a message in conversation
  app.post("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      const { content, messageType = 'text', eventId, venueId, postId, imageUrls, replyToId } = req.body;
      
      // Validate content exists for text messages
      if (messageType === 'text' && (!content || content.trim().length === 0)) {
        return res.status(400).json({ message: "Message content required" });
      }
      
      const message = await storage.sendConversationMessage({
        conversationId: req.params.id,
        senderId: req.user!.id,
        content: content?.trim(),
        messageType,
        eventId,
        venueId,
        postId,
        imageUrls,
        replyToId,
      });
      
      res.status(201).json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  // Delete a message
  app.delete("/api/conversations/:id/messages/:messageId", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      await storage.deleteConversationMessage(req.params.messageId);
      res.json({ message: "Message deleted" });
    } catch (error) {
      console.error("Error deleting message:", error);
      res.status(500).json({ message: "Failed to delete message" });
    }
  });

  // ============================================
  // POLLS API
  // ============================================

  // Create a poll in a conversation
  app.post("/api/conversations/:id/polls", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      const { question, options, allowMultiple, expiresAt } = req.body;
      
      if (!question || question.trim().length === 0) {
        return res.status(400).json({ message: "Question required" });
      }
      
      if (!options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ message: "At least 2 options required" });
      }
      
      const poll = await storage.createPoll(
        {
          conversationId: req.params.id,
          creatorId: req.user!.id,
          question: question.trim(),
          allowMultiple: allowMultiple || false,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        options.map((opt: any) => ({
          text: typeof opt === 'string' ? opt : opt.text,
          eventId: opt.eventId,
          venueId: opt.venueId,
        }))
      );
      
      res.status(201).json(poll);
    } catch (error) {
      console.error("Error creating poll:", error);
      res.status(500).json({ message: "Failed to create poll" });
    }
  });

  // Get a poll
  app.get("/api/polls/:id", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);
      
      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }
      
      // Check if user is in the conversation
      const isParticipant = await storage.isConversationParticipant(poll.conversationId, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      // Get user's votes
      const userVotes = await storage.getUserPollVotes(poll.id, req.user!.id);
      
      res.json({ ...poll, userVotes });
    } catch (error) {
      console.error("Error fetching poll:", error);
      res.status(500).json({ message: "Failed to fetch poll" });
    }
  });

  // Vote on a poll
  app.post("/api/polls/:id/vote", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);
      
      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }
      
      if (poll.status === 'closed') {
        return res.status(400).json({ message: "Poll is closed" });
      }
      
      if (poll.expiresAt && new Date() > poll.expiresAt) {
        return res.status(400).json({ message: "Poll has expired" });
      }
      
      const isParticipant = await storage.isConversationParticipant(poll.conversationId, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }
      
      const { optionId } = req.body;
      
      if (!optionId) {
        return res.status(400).json({ message: "Option ID required" });
      }
      
      // Check if option belongs to this poll
      const validOption = poll.options.find(o => o.id === optionId);
      if (!validOption) {
        return res.status(400).json({ message: "Invalid option" });
      }
      
      // If not allowing multiple, remove existing votes first
      if (!poll.allowMultiple) {
        const existingVotes = await storage.getUserPollVotes(poll.id, req.user!.id);
        for (const vote of existingVotes) {
          await storage.unvotePoll(poll.id, vote.optionId, req.user!.id);
        }
      }
      
      try {
        const vote = await storage.votePoll(req.params.id, optionId, req.user!.id);
        res.status(201).json(vote);
      } catch (e: any) {
        if (e.code === '23505') { // Unique constraint violation
          return res.status(400).json({ message: "Already voted for this option" });
        }
        throw e;
      }
    } catch (error) {
      console.error("Error voting on poll:", error);
      res.status(500).json({ message: "Failed to vote" });
    }
  });

  // Remove vote from poll
  app.delete("/api/polls/:id/vote/:optionId", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);
      
      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }
      
      if (poll.status === 'closed') {
        return res.status(400).json({ message: "Poll is closed" });
      }
      
      await storage.unvotePoll(req.params.id, req.params.optionId, req.user!.id);
      res.json({ message: "Vote removed" });
    } catch (error) {
      console.error("Error removing vote:", error);
      res.status(500).json({ message: "Failed to remove vote" });
    }
  });

  // Close a poll (creator or admin only)
  app.post("/api/polls/:id/close", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);
      
      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }
      
      // Check if user is creator or admin
      const isCreator = poll.creatorId === req.user!.id;
      const role = await storage.getParticipantRole(poll.conversationId, req.user!.id);
      
      if (!isCreator && role !== 'admin') {
        return res.status(403).json({ message: "Only poll creator or group admin can close poll" });
      }
      
      const closedPoll = await storage.closePoll(req.params.id);
      res.json(closedPoll);
    } catch (error) {
      console.error("Error closing poll:", error);
      res.status(500).json({ message: "Failed to close poll" });
    }
  });

  const httpServer = createServer(app);

  // Register new route modules
  registerSafetyRoutes(app);
  registerPaymentRoutes(app);
  app.use("/api/safety", buddyRouter);

  // Start background jobs
  startSafetyTimerJob();
  startBuddyScheduler();

  return httpServer;
}
