import type { Express } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import { deliverNotification } from "./notifications.js";
import { sendAlertSMS } from "./buddyService.js";
import { calculateDistanceMiles } from "./utils/geo.js";
import { validateTwilioWebhook } from "./twilioService.js";
import { requireAuth } from "./middleware.js";

// The background timer job has no request object to derive a host from (unlike
// the SOS route, which uses req.protocol/req.headers.host) — APP_URL must be
// set in production for timer-expiry share links to resolve correctly.
const PUBLIC_BASE_URL = process.env.APP_URL || "http://localhost:5000";

// Minimal proximity tag for the live alert payload only — NOT the full Layer 7
// venue-safety-network (no incident counting, no thresholds, nothing
// persisted). ~200m radius, matching the PRD's venue-proximity figure.
const VENUE_PROXIMITY_MILES = 0.124;

async function findNearestVenue(lat: number, lng: number): Promise<{ id: string; name: string } | null> {
  try {
    const venues = await storage.getVenues();
    let nearest: { id: string; name: string; distance: number } | null = null;
    for (const venue of venues) {
      if (venue.latitude == null || venue.longitude == null) continue;
      const distance = calculateDistanceMiles(lat, lng, venue.latitude, venue.longitude);
      if (distance <= VENUE_PROXIMITY_MILES && (!nearest || distance < nearest.distance)) {
        nearest = { id: venue.id, name: venue.name, distance };
      }
    }
    return nearest ? { id: nearest.id, name: nearest.name } : null;
  } catch (err) {
    console.error("[Safety] findNearestVenue error:", err);
    return null;
  }
}

const sosRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  keyGenerator: (req) => (req.user as any)?.id ?? "unauthenticated",
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
    accuracy: z.number().optional().nullable(),
  });

  app.post("/api/safety/sos", requireAuth, sosRateLimit, async (req, res) => {
    try {
      const { latitude, longitude, locationText, accuracy } = sosSchema.parse(req.body);
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

      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.headers.host}`;
      let phoneBuddyAlertUrl: string | null = null;
      const nearbyVenue = latitude && longitude ? await findNearestVenue(latitude, longitude) : null;

      const alertIds: string[] = [];
      let actualNotified = 0;

      for (const buddy of confirmedBuddies) {
        if (!buddy.buddyUserId) {
          // Phone-only buddy — send SMS directly, with a no-auth link to the
          // live alert page. One share row per SOS trigger, reused across
          // every phone-only buddy notified by this same alert.
          if (!phoneBuddyAlertUrl) {
            const share = await storage.createSafetyAlertShare({
              userId,
              alertType: "manual_sos",
              message: alertMessage,
              latitude,
              longitude,
              locationText,
            });
            phoneBuddyAlertUrl = `${baseUrl}/safety/alert/${share.shareToken}`;
          }
          await sendAlertSMS(buddy.phoneNumber, senderName, alertMessage, locationText ?? null, phoneBuddyAlertUrl);
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
            triggerMethod: "manual_sos",
            latitude: latitude ?? null,
            longitude: longitude ?? null,
            accuracy: accuracy ?? null,
            locationText: locationText ?? null,
            venueId: nearbyVenue?.id ?? null,
            venueName: nearbyVenue?.name ?? null,
            timestamp: alert.createdAt.toISOString(),
          },
        });

        await deliverNotification({
          userId: buddy.buddyUserId,
          type: "buddy_alert",
          title: "SOS Alert",
          message: `${senderName} needs help!${locationPart}`,
          link: "/buddy/alerts",
          relatedUserId: userId,
          relatedEntityId: alert.id,
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

  // Either the alert's sender (resolving their own alert) or their confirmed
  // buddy (confirming they reached the sender) may call these two routes.
  // `storage.resolveSafetyAlert` matches on userId OR buddyId; we branch the
  // notification here based on which side actually acted.
  app.post("/api/safety/alerts/:id/resolve", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user!.id;
      const alert = await storage.resolveSafetyAlert(id, userId, "safe");
      if (!alert) {
        return res.status(404).json({ message: "Alert not found" });
      }

      const actor = await storage.getUser(userId);
      const actorName = actor?.displayName || actor?.username || "Your buddy";
      const isSender = alert.userId === userId;

      if (isSender) {
        await deliverNotification({
          userId: alert.buddyId,
          type: "buddy_alert_resolved",
          title: "Buddy is Safe",
          message: `${actorName} has marked themselves as safe`,
          link: "/buddy/alerts",
          relatedUserId: userId,
          relatedEntityId: id,
        });
      } else {
        await deliverNotification({
          userId: alert.userId,
          type: "buddy_alert_resolved",
          title: "Buddy Reached You",
          message: `${actorName} confirmed they reached you and you're safe`,
          link: "/buddy/alerts",
          relatedUserId: userId,
          relatedEntityId: id,
        });
      }

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
      if (!alert) {
        return res.status(404).json({ message: "Alert not found" });
      }

      const actor = await storage.getUser(userId);
      const actorName = actor?.displayName || actor?.username || "Your buddy";
      const isSender = alert.userId === userId;

      if (isSender) {
        await deliverNotification({
          userId: alert.buddyId,
          type: "buddy_alert_resolved",
          title: "Alert: False Alarm",
          message: `${actorName} marked their alert as a false alarm`,
          link: "/buddy/alerts",
          relatedUserId: userId,
          relatedEntityId: id,
        });
      } else {
        await deliverNotification({
          userId: alert.userId,
          type: "buddy_alert_resolved",
          title: "Alert Marked False Alarm",
          message: `${actorName} marked your alert as a false alarm`,
          link: "/buddy/alerts",
          relatedUserId: userId,
          relatedEntityId: id,
        });
      }

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
    eventId: z.string().optional(),
  });

  app.post("/api/safety/timer", requireAuth, async (req, res) => {
    try {
      const { durationMinutes, eventId } = createTimerSchema.parse(req.body);
      const userId = req.user!.id;

      const confirmedBuddies = await storage.getConfirmedBuddies(userId);
      if (confirmedBuddies.length === 0) {
        return res.status(400).json({ message: "You need at least one confirmed safety buddy to start a timer" });
      }

      const timer = await storage.createSafetyTimer({
        userId,
        durationMinutes,
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

  app.post("/api/safety/timer/snooze", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const timer = await storage.snoozeSafetyTimer(userId);
      if (!timer) {
        return res.status(404).json({ message: "No active check-in timer to snooze" });
      }
      res.json({ timer });
    } catch (error: any) {
      if (error.message === "No more snoozes available for this timer") {
        return res.status(409).json({ message: "You've used all 3 snoozes for this timer" });
      }
      console.error("[Safety] Snooze timer error:", error);
      res.status(500).json({ message: "Failed to snooze timer" });
    }
  });

  const extendTimerSchema = z.object({
    hours: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  });

  app.post("/api/safety/timer/extend", requireAuth, async (req, res) => {
    try {
      const { hours } = extendTimerSchema.parse(req.body);
      const userId = req.user!.id;
      const timer = await storage.extendSafetyTimer(userId, hours);
      if (!timer) {
        return res.status(404).json({ message: "No active check-in timer to extend" });
      }
      res.json({ timer });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "hours must be 1, 2, or 4" });
      }
      console.error("[Safety] Extend timer error:", error);
      res.status(500).json({ message: "Failed to extend timer" });
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

  // ============================================================
  // PUBLIC ALERT SHARE (no auth — for phone-only buddies without the app)
  // ============================================================

  app.get("/api/safety/public-alert/:token", async (req, res) => {
    try {
      const share = await storage.getSafetyAlertShareByToken(req.params.token);
      if (!share || share.expiresAt.getTime() < Date.now()) {
        return res.status(404).json({ message: "This alert link has expired or doesn't exist." });
      }

      const sender = await storage.getUser(share.userId);

      res.json({
        status: "active",
        senderDisplayName: sender?.displayName || sender?.username || "Someone",
        senderAvatarUrl: sender?.avatarUrl ?? null,
        message: share.message,
        alertType: share.alertType,
        latitude: share.latitude,
        longitude: share.longitude,
        locationText: share.locationText,
        createdAt: share.createdAt.toISOString(),
      });
    } catch (error) {
      console.error("[Safety] Public alert lookup error:", error);
      res.status(500).json({ message: "Failed to load alert" });
    }
  });

  // ============================================================
  // SMS DELIVERY STATUS WEBHOOKS (no requireAuth — providers call these)
  // ============================================================

  app.post("/api/safety/sms-delivery-status/twilio", async (req, res) => {
    try {
      if (process.env.NODE_ENV === "production" && process.env.TWILIO_AUTH_TOKEN) {
        const signature = (req.headers["x-twilio-signature"] as string) ?? "";
        const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
        const valid = validateTwilioWebhook(signature, url, req.body as Record<string, string>);
        if (!valid) {
          console.warn("[Safety] Invalid Twilio delivery-status signature from", req.ip);
          return res.status(403).send("Forbidden");
        }
      }

      const { MessageSid, MessageStatus } = req.body as Record<string, string>;
      if (MessageSid && MessageStatus) {
        await storage.updateDeliveryLogStatus("twilio", MessageSid, MessageStatus);
      }
      res.status(200).send("OK");
    } catch (error) {
      console.error("[Safety] Twilio delivery-status webhook error:", error);
      res.status(500).send("Internal server error");
    }
  });

  // Termii's delivery webhook has no documented signature scheme (their
  // inbound SMS-reply webhook has none either — confirmed this session), and
  // the callback URL is configured in Termii's own dashboard rather than
  // passed per-request like Twilio's statusCallback. A shared-secret query
  // param is the best available protection until Termii offers something
  // stronger.
  app.post("/api/safety/sms-delivery-status/termii", async (req, res) => {
    try {
      const secret = process.env.TERMII_WEBHOOK_SECRET;
      if (secret && req.query.key !== secret) {
        console.warn("[Safety] Invalid Termii delivery-status secret from", req.ip);
        return res.status(403).send("Forbidden");
      }

      const body = req.body as Record<string, any>;
      const messageId = body.message_id ?? body.messageId;
      const status = body.status;
      if (messageId && status) {
        await storage.updateDeliveryLogStatus("termii", String(messageId), String(status));
      }
      res.status(200).send("OK");
    } catch (error) {
      console.error("[Safety] Termii delivery-status webhook error:", error);
      res.status(500).send("Internal server error");
    }
  });
}

// ============================================================
// BACKGROUND JOB — fire buddy alerts when grace period ends
// Called from server/routes.ts on startup
// ============================================================

// Graduated self check-in reminders (PRD stages T+0/T+10/T+20/T+25 — stage 4 is
// the existing "alerted" flow below, unchanged). These notify the TIMER'S OWN
// USER, not a buddy — stage 4 is the only stage that alerts a buddy.
const STAGE_COPY: Record<number, { title: string; message: string }> = {
  1: { title: "Quick check-in", message: "Tap to let us know you're okay." },
  2: { title: "Still there?", message: "We haven't heard from you — check in now." },
  3: { title: "Last chance", message: "Your buddy will be alerted in 5 minutes unless you check in." },
};

function computeStage(timer: { expiresAt: Date }): number {
  const elapsedMs = Date.now() - timer.expiresAt.getTime();
  if (elapsedMs < 0) return 0;
  if (elapsedMs < 10 * 60_000) return 1;
  if (elapsedMs < 20 * 60_000) return 2;
  if (elapsedMs < 25 * 60_000) return 3;
  return 4;
}

async function runStageNotificationPass(): Promise<void> {
  const timers = await storage.getTimersForStageCheck();
  for (const timer of timers) {
    const stage = computeStage(timer);
    if (stage > timer.lastStageNotified && stage >= 1 && stage <= 3) {
      const copy = STAGE_COPY[stage];
      try {
        await deliverNotification({
          userId: timer.userId,
          type: "checkin_stage_reminder",
          title: copy.title,
          message: copy.message,
          link: "/buddy/settings",
          relatedEntityId: timer.id,
        });
        await storage.updateTimerStageNotified(timer.id, stage);
      } catch (err) {
        console.error(`[Safety] Stage-${stage} notification failed for timer ${timer.id}:`, err);
      }
    }
  }
}

export function startSafetyTimerJob(): void {
  const POLL_INTERVAL_MS = 30_000; // 30 seconds

  setInterval(async () => {
    try {
      await runStageNotificationPass();
    } catch (err) {
      console.error("[Safety] Stage notification pass error:", err);
    }

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
          let phoneBuddyAlertUrl: string | null = null;

          for (const buddy of confirmedBuddies) {
            if (!buddy.buddyUserId) {
              // Phone-only buddy — send SMS, with a no-auth link to the live alert page
              if (!phoneBuddyAlertUrl) {
                const share = await storage.createSafetyAlertShare({
                  userId: timer.userId,
                  alertType: "timer_expiry",
                  message: alertMessage,
                });
                phoneBuddyAlertUrl = `${PUBLIC_BASE_URL}/safety/alert/${share.shareToken}`;
              }
              await sendAlertSMS(buddy.phoneNumber, senderName, alertMessage, null, phoneBuddyAlertUrl);
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
                triggerMethod: "timer_expiry",
                latitude: null,
                longitude: null,
                accuracy: null,
                locationText: null,
                venueId: null,
                venueName: null,
                timestamp: alert.createdAt.toISOString(),
              },
            });

            await deliverNotification({
              userId: buddy.buddyUserId,
              type: "buddy_timer_expiry",
              title: "Check-In Timer Expired",
              message: `${senderName} didn't check in on time — they may need help`,
              link: "/buddy/alerts",
              relatedUserId: timer.userId,
              relatedEntityId: alert.id,
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
