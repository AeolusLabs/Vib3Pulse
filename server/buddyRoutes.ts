import { Router } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import { assignBuddy, assignAppBuddy, acceptBuddyRequest, declineBuddyRequest, processBuddySMSReply, removeBuddy } from "./buddyService.js";
import { validateTwilioWebhook, parseTwilioInboundSMS } from "./twilioService.js";
import { requireAuth } from "./middleware.js";

const router = Router();

// POST /api/safety/buddy-assignment
// Assign a buddy by phone number — sends confirmation SMS
router.post("/buddy-assignment", requireAuth, async (req, res) => {
  try {
    const { name, phone_number } = z.object({
      name: z.string().min(1).max(100),
      phone_number: z.string().min(7).max(20),
    }).parse(req.body);

    const userId = req.user!.id;
    const buddy = await assignBuddy(userId, name, phone_number);

    res.status(201).json({
      message: `SMS sent to ${buddy.phoneNumber}. They need to reply YES to confirm.`,
      buddy,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: "name and phone_number are required" });
    }
    console.error("[BuddyRoutes] buddy-assignment error:", err);
    const status = err.message?.includes("Maximum") || err.message?.includes("pending") ? 400 : 500;
    res.status(status).json({ message: err.message || "Failed to assign buddy" });
  }
});

// POST /api/safety/buddy-sms-reply
// Inbound SMS webhook from Twilio/Termii — no auth, CSRF exempt
router.post("/buddy-sms-reply", async (req, res) => {
  try {
    // Validate Twilio signature when running in production
    if (process.env.NODE_ENV === "production" && process.env.TWILIO_AUTH_TOKEN) {
      const signature = req.headers["x-twilio-signature"] as string ?? "";
      const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
      const valid = validateTwilioWebhook(signature, url, req.body as Record<string, string>);
      if (!valid) {
        console.warn("[BuddyRoutes] Invalid Twilio signature from", req.ip);
        return res.status(403).send("Forbidden");
      }
    }

    const { from, body } = parseTwilioInboundSMS(req.body as Record<string, string>);

    if (!from) {
      return res.status(400).send("Missing From number");
    }

    const result = await processBuddySMSReply(from, body);

    if (result.updated && result.userId) {
      // Notify the user in-app that their buddy replied
      const buddies = await storage.getBuddiesByUser(result.userId);
      const updatedBuddy = buddies.find(b => b.phoneNumber && (b.phoneNumber === from || b.phoneNumber.endsWith(from.replace(/^\+/, ""))));
      const status = updatedBuddy?.confirmationStatus;
      const name = updatedBuddy?.name ?? "Your buddy";

      if (status === "confirmed") {
        await storage.createNotification({
          userId: result.userId,
          type: "buddy_request_response",
          title: "Buddy Confirmed!",
          message: `${name} has confirmed they will be your safety buddy.`,
          link: "/safety/settings",
        });
        wsManager.sendToUser(result.userId, {
          type: "notification",
          data: { type: "buddy_confirmed" },
        });
      } else if (status === "declined") {
        await storage.createNotification({
          userId: result.userId,
          type: "buddy_request_response",
          title: "Buddy Declined",
          message: `${name} declined your safety buddy request.`,
          link: "/safety/settings",
        });
        wsManager.sendToUser(result.userId, {
          type: "notification",
          data: { type: "buddy_declined" },
        });
      }
    }

    // Twilio expects TwiML or 200 with empty body
    res.set("Content-Type", "text/xml").send("<Response></Response>");
  } catch (err: any) {
    console.error("[BuddyRoutes] buddy-sms-reply error:", err);
    res.status(500).send("Internal server error");
  }
});

// GET /api/safety/buddies
// List all buddies for the authenticated user (all statuses)
router.get("/buddies", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const buddies = await storage.getBuddiesByUser(userId);
    res.json({ buddies });
  } catch (err: any) {
    console.error("[BuddyRoutes] get buddies error:", err);
    res.status(500).json({ message: "Failed to get buddies" });
  }
});

// DELETE /api/safety/buddies/:buddyId
// Remove a buddy
router.delete("/buddies/:buddyId", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { buddyId } = req.params;
    await removeBuddy(userId, buddyId);
    res.json({ message: "Buddy removed" });
  } catch (err: any) {
    console.error("[BuddyRoutes] remove buddy error:", err);
    const status = err.message === "Forbidden" ? 403 : err.message === "Buddy not found" ? 404 : 500;
    res.status(status).json({ message: err.message || "Failed to remove buddy" });
  }
});

// GET /api/safety/watching-over
// Returns users who have the logged-in user as a confirmed buddy, with their active timer and recent alerts
router.get("/watching-over", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const data = await storage.getWatchingOver(userId);
    res.json({ watching: data });
  } catch (err: any) {
    console.error("[BuddyRoutes] watching-over error:", err);
    res.status(500).json({ message: "Failed to get watching-over data" });
  }
});

// GET /api/safety/followers-for-buddy
// Returns users the current user follows, with existing buddy status if any
router.get("/followers-for-buddy", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const results = await storage.getFollowingForBuddy(userId);
    res.json({ followers: results });
  } catch (err: any) {
    console.error("[BuddyRoutes] followers-for-buddy error:", err);
    res.status(500).json({ message: "Failed to get followers" });
  }
});

// GET /api/safety/buddy-requests
// Returns pending in-app buddy requests sent TO the current user
router.get("/buddy-requests", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const requests = await storage.getPendingIncomingBuddyRequests(userId);
    res.json({ requests });
  } catch (err: any) {
    console.error("[BuddyRoutes] buddy-requests error:", err);
    res.status(500).json({ message: "Failed to get buddy requests" });
  }
});

// POST /api/safety/buddy-assignment/app
// Assign a follower as an in-app buddy — sends in-app notification
router.post("/buddy-assignment/app", requireAuth, async (req, res) => {
  try {
    const { targetUserId, name } = z.object({
      targetUserId: z.string().min(1),
      name: z.string().min(1).max(100),
    }).parse(req.body);

    const userId = req.user!.id;
    const buddy = await assignAppBuddy(userId, targetUserId, name);

    res.status(201).json({
      message: "Buddy request sent. They'll get a notification to confirm.",
      buddy,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: "targetUserId and name are required" });
    }
    console.error("[BuddyRoutes] buddy-assignment/app error:", err);
    const status = err.message?.includes("Maximum") || err.message?.includes("already sent") || err.message?.includes("yourself") ? 400 : 500;
    res.status(status).json({ message: err.message || "Failed to send buddy request" });
  }
});

// POST /api/safety/buddy-requests/:buddyId/accept
router.post("/buddy-requests/:buddyId/accept", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    await acceptBuddyRequest(req.params.buddyId, userId);
    res.json({ message: "Buddy request accepted" });
  } catch (err: any) {
    console.error("[BuddyRoutes] accept buddy-request error:", err);
    const status = err.message === "Forbidden" ? 403 : err.message === "Buddy request not found" ? 404 : 400;
    res.status(status).json({ message: err.message || "Failed to accept request" });
  }
});

// POST /api/safety/buddy-requests/:buddyId/decline
router.post("/buddy-requests/:buddyId/decline", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    await declineBuddyRequest(req.params.buddyId, userId);
    res.json({ message: "Buddy request declined" });
  } catch (err: any) {
    console.error("[BuddyRoutes] decline buddy-request error:", err);
    const status = err.message === "Forbidden" ? 403 : err.message === "Buddy request not found" ? 404 : 400;
    res.status(status).json({ message: err.message || "Failed to decline request" });
  }
});

export { router as buddyRouter };
