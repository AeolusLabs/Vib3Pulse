import type { Express } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import { sendAlertSMS } from "./buddyService.js";
import { requireAuth } from "./middleware.js";

const sosRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  keyGenerator: (req) => (req.user as any)?.id ?? req.ip ?? "unknown",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many SOS alerts sent. Please wait before sending another." },
});

export function registerSafetyRoutes(app: Express): void {

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

  app.post("/api/safety/sos", requireAuth, sosRateLimit, async (req, res) => {
    try {
      const { latitude, longitude, locationText } = sosSchema.parse(req.body);
      const userId = req.user!.id;

      const confirmedBuddies = await storage.getConfirmedBuddies(userId);
      if (confirmedBuddies.length === 0) {
        return res.status(400).json({ message: "No confirmed safety buddies. Add and confirm a buddy first." });
      }

      const distressMessage = await storage.getDistressMessage(userId);
      const alertMessage = distressMessage || "I need help! Please check on me.";
      const sender = await storage.getUser(userId);
      const senderName = sender?.displayName || sender?.username || "Your buddy";

      const locationPart = locationText ? ` Location: ${locationText}` : (latitude && longitude)
        ? ` Coordinates: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
        : "";

      const alertIds: string[] = [];
      let actualNotified = 0;

      for (const buddy of confirmedBuddies) {
        if (!buddy.buddyUserId) {
          // Phone-only buddy — send SMS directly
          await sendAlertSMS(buddy.phoneNumber, senderName, alertMessage, locationText ?? null);
          console.log(`[Safety] SOS SMS sent to phone-only buddy ${buddy.phoneNumber} for user ${userId}`);
          actualNotified++;
          continue;
        }

        // Buddy has an app account — WebSocket + in-app notification + DB record
        const alert = await storage.createSafetyAlert({
          userId,
          buddyId: buddy.buddyUserId,
          alertType: "manual_sos",
          message: alertMessage,
          latitude: latitude ?? undefined,
          longitude: longitude ?? undefined,
          locationText: locationText ?? undefined,
        });
        alertIds.push(alert.id);
        actualNotified++;

        wsManager.sendToUser(buddy.buddyUserId, {
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

        await storage.createNotification({
          userId: buddy.buddyUserId,
          type: "buddy_alert",
          title: "SOS Alert",
          message: `${senderName} needs help!${locationPart}`,
          link: "/safety/alerts",
          relatedUserId: userId,
          relatedEntityId: alert.id,
        });

        wsManager.sendToUser(buddy.buddyUserId, {
          type: "notification",
          data: { type: "buddy_alert" },
        });
      }

      res.json({
        message: "SOS alert sent",
        alertIds,
        buddiesNotified: actualNotified,
      });
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

      const confirmedBuddies = await storage.getConfirmedBuddies(userId);
      if (confirmedBuddies.length === 0) {
        return res.status(400).json({ message: "You need at least one confirmed safety buddy to start a timer" });
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
// Called from server/routes.ts on startup
// ============================================================

export function startSafetyTimerJob(): void {
  const POLL_INTERVAL_MS = 30_000; // 30 seconds

  setInterval(async () => {
    try {
      const timers = await storage.getTimersNeedingAlert();

      for (const timer of timers) {
        try {
          const confirmedBuddies = await storage.getConfirmedBuddies(timer.userId);
          if (confirmedBuddies.length === 0) {
            await storage.markTimerAlerted(timer.id);
            continue;
          }

          const distressMsg = await storage.getDistressMessage(timer.userId);
          const alertMessage = distressMsg || "I need help! Please check on me.";
          const sender = await storage.getUser(timer.userId);
          const senderName = sender?.displayName || sender?.username || "Your buddy";

          let timerNotified = 0;

          for (const buddy of confirmedBuddies) {
            if (!buddy.buddyUserId) {
              // Phone-only buddy — send SMS
              await sendAlertSMS(buddy.phoneNumber, senderName, alertMessage, null);
              console.log(`[Safety] Timer ${timer.id} expired — SMS sent to phone-only buddy ${buddy.phoneNumber}`);
              timerNotified++;
              continue;
            }

            const alert = await storage.createSafetyAlert({
              userId: timer.userId,
              buddyId: buddy.buddyUserId,
              alertType: "timer_expiry",
              message: alertMessage,
              timerId: timer.id,
            });
            timerNotified++;

            wsManager.sendToUser(buddy.buddyUserId, {
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
              userId: buddy.buddyUserId,
              type: "buddy_timer_expiry",
              title: "Check-In Timer Expired",
              message: `${senderName} didn't check in on time — they may need help`,
              link: "/safety/alerts",
              relatedUserId: timer.userId,
              relatedEntityId: alert.id,
            });

            wsManager.sendToUser(buddy.buddyUserId, {
              type: "notification",
              data: { type: "buddy_timer_expiry" },
            });
          }

          await storage.markTimerAlerted(timer.id);
          console.log(`[Safety] Timer ${timer.id} expired — alerts sent to ${timerNotified} buddy(ies)`);
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
