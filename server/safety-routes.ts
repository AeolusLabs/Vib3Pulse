import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";

function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// ============================================================
// SAFETY BUDDY ROUTES
// ============================================================

export function registerSafetyRoutes(app: Express): void {

  // Set or replace safety buddy (sends a request they must accept)
  app.post("/api/safety/buddy", requireAuth, async (req, res) => {
    try {
      const { buddyId } = z.object({ buddyId: z.string().min(1) }).parse(req.body);
      const userId = req.user!.id;

      if (buddyId === userId) {
        return res.status(400).json({ message: "You cannot be your own safety buddy" });
      }

      const buddy = await storage.getUser(buddyId);
      if (!buddy) {
        return res.status(404).json({ message: "User not found" });
      }
      if (buddy.userType !== "social") {
        return res.status(400).json({ message: "Only social users can be safety buddies" });
      }

      await storage.setSafetyBuddy(userId, buddyId);

      const currentUser = await storage.getUser(userId);

      // Notify the buddy in-app
      await storage.createNotification({
        userId: buddyId,
        type: "buddy_request",
        title: "Safety Buddy Request",
        message: `${currentUser?.displayName || currentUser?.username || "Someone"} wants you as their safety buddy`,
        link: "/safety/settings",
        relatedUserId: userId,
        relatedEntityId: userId,
      });

      wsManager.sendToUser(buddyId, {
        type: "notification",
        data: { type: "buddy_request", fromUserId: userId },
      });

      res.json({ message: "Buddy request sent" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "buddyId is required" });
      }
      console.error("[Safety] Set buddy error:", error);
      res.status(500).json({ message: "Failed to send buddy request" });
    }
  });

  // Get current buddy status
  app.get("/api/safety/buddy", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const result = await storage.getSafetyBuddy(userId);

      if (!result) {
        return res.json({ buddy: null, status: null });
      }

      res.json({ buddy: result.buddy, status: result.record.status });
    } catch (error) {
      console.error("[Safety] Get buddy error:", error);
      res.status(500).json({ message: "Failed to get buddy" });
    }
  });

  // Remove current buddy
  app.delete("/api/safety/buddy", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      await storage.removeSafetyBuddy(userId);
      res.json({ message: "Buddy removed" });
    } catch (error) {
      console.error("[Safety] Remove buddy error:", error);
      res.status(500).json({ message: "Failed to remove buddy" });
    }
  });

  // Get pending buddy requests (requests I've received)
  app.get("/api/safety/buddy/requests", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const requests = await storage.getSafetyBuddyRequests(userId);
      res.json({ requests });
    } catch (error) {
      console.error("[Safety] Get buddy requests error:", error);
      res.status(500).json({ message: "Failed to get buddy requests" });
    }
  });

  // Respond to a buddy request
  app.post("/api/safety/buddy/respond", requireAuth, async (req, res) => {
    try {
      const { requesterId, accept } = z.object({
        requesterId: z.string().min(1),
        accept: z.boolean(),
      }).parse(req.body);

      const buddyId = req.user!.id;
      await storage.respondToSafetyBuddyRequest(buddyId, requesterId, accept);

      const currentUser = await storage.getUser(buddyId);
      const notifMessage = accept
        ? `${currentUser?.displayName || currentUser?.username} accepted your buddy request`
        : `${currentUser?.displayName || currentUser?.username} declined your buddy request`;

      await storage.createNotification({
        userId: requesterId,
        type: "buddy_request_response",
        title: accept ? "Buddy Request Accepted" : "Buddy Request Declined",
        message: notifMessage,
        link: "/safety/settings",
        relatedUserId: buddyId,
        relatedEntityId: buddyId,
      });

      wsManager.sendToUser(requesterId, {
        type: "notification",
        data: { type: "buddy_request_response", accepted: accept },
      });

      res.json({ message: accept ? "Request accepted" : "Request declined" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "requesterId and accept are required" });
      }
      console.error("[Safety] Respond to buddy error:", error);
      res.status(500).json({ message: "Failed to respond to buddy request" });
    }
  });

  // ============================================================
  // DISTRESS MESSAGE
  // ============================================================

  app.post("/api/safety/distress-message", requireAuth, async (req, res) => {
    try {
      const { message } = z.object({ message: z.string().min(1).max(500) }).parse(req.body);
      const userId = req.user!.id;
      await storage.setDistressMessage(userId, message);
      res.json({ message: "Distress message saved" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "message is required (max 500 chars)" });
      }
      console.error("[Safety] Set distress message error:", error);
      res.status(500).json({ message: "Failed to save distress message" });
    }
  });

  app.get("/api/safety/distress-message", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const message = await storage.getDistressMessage(userId);
      res.json({ message: message ?? null });
    } catch (error) {
      console.error("[Safety] Get distress message error:", error);
      res.status(500).json({ message: "Failed to get distress message" });
    }
  });

  // ============================================================
  // SOS ALERT
  // ============================================================

  const sosSchema = z.object({
    latitude: z.number().optional().nullable(),
    longitude: z.number().optional().nullable(),
    locationText: z.string().optional().nullable(),
  });

  app.post("/api/safety/sos", requireAuth, async (req, res) => {
    try {
      const { latitude, longitude, locationText } = sosSchema.parse(req.body);
      const userId = req.user!.id;

      const buddyData = await storage.getSafetyBuddy(userId);
      if (!buddyData) {
        return res.status(400).json({ message: "No safety buddy set" });
      }
      if (buddyData.record.status !== "accepted") {
        return res.status(400).json({ message: "Your buddy hasn't accepted your request yet" });
      }

      const buddy = buddyData.buddy;
      const distressMessage = await storage.getDistressMessage(userId);
      const alertMessage = distressMessage || "I need help! Please check on me.";

      const alert = await storage.createSafetyAlert({
        userId,
        buddyId: buddy.id,
        alertType: "manual_sos",
        message: alertMessage,
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined,
        locationText: locationText ?? undefined,
      });

      const sender = await storage.getUser(userId);
      const senderName = sender?.displayName || sender?.username || "Your buddy";

      const locationPart = locationText ? ` Location: ${locationText}` : (latitude && longitude)
        ? ` Coordinates: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
        : "";

      // Real-time push to buddy
      wsManager.sendToUser(buddy.id, {
        type: "distress_alert",
        data: {
          alertId: alert.id,
          senderId: userId,
          senderName,
          message: alertMessage,
          alertType: "manual_sos",
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          locationText: locationText ?? null,
          timestamp: alert.createdAt.toISOString(),
        },
      });

      // Persistent notification
      await storage.createNotification({
        userId: buddy.id,
        type: "buddy_alert",
        title: "SOS Alert",
        message: `${senderName} needs help!${locationPart}`,
        link: "/safety/alerts",
        relatedUserId: userId,
        relatedEntityId: alert.id,
      });

      wsManager.sendToUser(buddy.id, {
        type: "notification",
        data: { type: "buddy_alert" },
      });

      res.json({ message: "SOS alert sent", alertId: alert.id, buddy: { username: buddy.username, displayName: buddy.displayName } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid request body" });
      }
      console.error("[Safety] SOS error:", error);
      res.status(500).json({ message: "Failed to send SOS alert" });
    }
  });

  // ============================================================
  // ALERT HISTORY
  // ============================================================

  app.get("/api/safety/alerts", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const alerts = await storage.getSafetyAlerts(userId);
      res.json({ alerts });
    } catch (error) {
      console.error("[Safety] Get alerts error:", error);
      res.status(500).json({ message: "Failed to get alerts" });
    }
  });

  app.post("/api/safety/alerts/:id/resolve", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;
      const alert = await storage.resolveSafetyAlert(id, userId, "safe");

      const sender = await storage.getUser(userId);
      const senderName = sender?.displayName || sender?.username || "Your buddy";

      wsManager.sendToUser(alert.buddyId, {
        type: "notification",
        data: { type: "buddy_alert_resolved" },
      });

      await storage.createNotification({
        userId: alert.buddyId,
        type: "buddy_alert_resolved",
        title: "Buddy is Safe",
        message: `${senderName} has marked themselves as safe`,
        link: "/safety/alerts",
        relatedUserId: userId,
        relatedEntityId: id,
      });

      res.json({ message: "Marked as safe" });
    } catch (error) {
      console.error("[Safety] Resolve alert error:", error);
      res.status(500).json({ message: "Failed to resolve alert" });
    }
  });

  app.post("/api/safety/alerts/:id/false-alarm", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;
      const alert = await storage.resolveSafetyAlert(id, userId, "false_alarm");

      const sender = await storage.getUser(userId);
      const senderName = sender?.displayName || sender?.username || "Your buddy";

      wsManager.sendToUser(alert.buddyId, {
        type: "notification",
        data: { type: "buddy_alert_resolved" },
      });

      await storage.createNotification({
        userId: alert.buddyId,
        type: "buddy_alert_resolved",
        title: "Alert: False Alarm",
        message: `${senderName} marked their alert as a false alarm`,
        link: "/safety/alerts",
        relatedUserId: userId,
        relatedEntityId: id,
      });

      res.json({ message: "Marked as false alarm" });
    } catch (error) {
      console.error("[Safety] False alarm error:", error);
      res.status(500).json({ message: "Failed to mark as false alarm" });
    }
  });

  // ============================================================
  // CHECK-IN TIMER
  // ============================================================

  const createTimerSchema = z.object({
    durationMinutes: z.number().int().min(1).max(1440),
    gracePeriodMinutes: z.number().int().min(1).max(60).optional(),
    eventId: z.string().optional(),
  });

  app.post("/api/safety/timer", requireAuth, async (req, res) => {
    try {
      const { durationMinutes, gracePeriodMinutes, eventId } = createTimerSchema.parse(req.body);
      const userId = req.user!.id;

      const buddyData = await storage.getSafetyBuddy(userId);
      if (!buddyData || buddyData.record.status !== "accepted") {
        return res.status(400).json({ message: "You need an accepted safety buddy to start a timer" });
      }

      const timer = await storage.createSafetyTimer({
        userId,
        durationMinutes,
        gracePeriodMinutes: gracePeriodMinutes ?? 5,
        eventId,
      });

      res.json({ timer });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid timer parameters" });
      }
      console.error("[Safety] Create timer error:", error);
      res.status(500).json({ message: "Failed to create timer" });
    }
  });

  app.get("/api/safety/timer", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const timer = await storage.getActiveSafetyTimer(userId);
      res.json({ timer });
    } catch (error) {
      console.error("[Safety] Get timer error:", error);
      res.status(500).json({ message: "Failed to get timer" });
    }
  });

  app.post("/api/safety/timer/checkin", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      await storage.checkInSafetyTimer(userId);
      res.json({ message: "Checked in — you're safe" });
    } catch (error) {
      console.error("[Safety] Check-in error:", error);
      res.status(500).json({ message: "Failed to check in" });
    }
  });

  app.delete("/api/safety/timer", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      await storage.cancelSafetyTimer(userId);
      res.json({ message: "Timer cancelled" });
    } catch (error) {
      console.error("[Safety] Cancel timer error:", error);
      res.status(500).json({ message: "Failed to cancel timer" });
    }
  });
}

// ============================================================
// BACKGROUND JOB — fire buddy alerts when grace period ends
// Called from server/index.ts on startup
// ============================================================

export function startSafetyTimerJob(): void {
  const POLL_INTERVAL_MS = 30_000; // 30 seconds

  setInterval(async () => {
    try {
      const timers = await storage.getTimersNeedingAlert();

      for (const timer of timers) {
        try {
          const buddyData = await storage.getSafetyBuddy(timer.userId);
          if (!buddyData || buddyData.record.status !== "accepted") {
            await storage.markTimerAlerted(timer.id);
            continue;
          }

          const buddy = buddyData.buddy;
          const distressMsg = await storage.getDistressMessage(timer.userId);
          const alertMessage = distressMsg || "I need help! Please check on me.";

          const alert = await storage.createSafetyAlert({
            userId: timer.userId,
            buddyId: buddy.id,
            alertType: "timer_expiry",
            message: alertMessage,
            timerId: timer.id,
          });

          await storage.markTimerAlerted(timer.id);

          const sender = await storage.getUser(timer.userId);
          const senderName = sender?.displayName || sender?.username || "Your buddy";

          wsManager.sendToUser(buddy.id, {
            type: "distress_alert",
            data: {
              alertId: alert.id,
              senderId: timer.userId,
              senderName,
              message: alertMessage,
              alertType: "timer_expiry",
              latitude: null,
              longitude: null,
              locationText: null,
              timestamp: alert.createdAt.toISOString(),
            },
          });

          await storage.createNotification({
            userId: buddy.id,
            type: "buddy_timer_expiry",
            title: "Check-In Timer Expired",
            message: `${senderName} didn't check in on time — they may need help`,
            link: "/safety/alerts",
            relatedUserId: timer.userId,
            relatedEntityId: alert.id,
          });

          wsManager.sendToUser(buddy.id, {
            type: "notification",
            data: { type: "buddy_timer_expiry" },
          });

          console.log(`[Safety] Timer ${timer.id} expired — alert sent to buddy ${buddy.id}`);
        } catch (err) {
          console.error(`[Safety] Error processing timer ${timer.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[Safety] Timer job error:", err);
    }
  }, POLL_INTERVAL_MS);

  console.log("[Safety] Timer background job started (30s interval)");
}
