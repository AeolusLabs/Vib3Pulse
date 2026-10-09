import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import { requestPhoneCode, confirmPhoneCode } from "../services/phoneVerification";

// Phone verification for hosting public events. Global API rate limiting and CSRF already
// apply to /api; the service adds per-user / per-number / cooldown limits on top.
export function registerPhoneRoutes(app: Express): void {
  app.get("/api/auth/phone/status", requireAuth, async (req, res) => {
    const user = await storage.getUser(req.user!.id);
    res.json({ verified: !!user?.verifiedPhone, phoneLast4: user?.verifiedPhone ? user.verifiedPhone.slice(-4) : null });
  });

  app.post("/api/auth/phone/request", requireAuth, async (req, res) => {
    try {
      const { phone } = z.object({ phone: z.string().min(5).max(30) }).parse(req.body);
      const result = await requestPhoneCode(req.user!.id, phone, req.ip ?? null);
      if (!result.ok) return res.status(result.status).json({ message: result.message, code: result.code });
      res.json({ phoneLast4: result.phoneLast4, expiresInSeconds: result.expiresInSeconds });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Enter your phone number", code: "INVALID_PHONE" });
      console.error("[Phone] request failed:", (error as Error).message);
      res.status(500).json({ message: "Couldn't send a code. Please try again." });
    }
  });

  app.post("/api/auth/phone/verify", requireAuth, async (req, res) => {
    try {
      const { code } = z.object({ code: z.string().min(1).max(12) }).parse(req.body);
      const result = await confirmPhoneCode(req.user!.id, code);
      if (!result.ok) return res.status(result.status).json({ message: result.message, code: result.code });
      res.json({ verified: true, phoneLast4: result.phoneLast4 });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Enter the 6-digit code", code: "INVALID_CODE" });
      console.error("[Phone] verify failed:", (error as Error).message);
      res.status(500).json({ message: "Couldn't verify the code. Please try again." });
    }
  });
}
