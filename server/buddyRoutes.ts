import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import { assignBuddy, processBuddySMSReply, getConfirmedBuddies, removeBuddy } from "./buddyService.js";
import { validateTwilioWebhook, parseTwilioInboundSMS } from "./twilioService.js";

function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

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
      const updatedBuddy = buddies.find(b => b.phoneNumber === from || b.phoneNumber.endsWith(from.replace(/^\+/, "")));
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

export { router as buddyRouter };
