// Spraying (phase 5, tasks 5.4 and 5.5): the HTTP routes. Registered by one line in registerRoomRoutes.
// Every rule is in spray.ts / sprayLimits.ts; these handlers only parse, call and answer. Nothing here returns a card's
// authorization code, signature, the payment reference or another person's data; the global redaction is the safety net.
import type { Express, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { db, storage } from "../storage";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { ageFromDob } from "@shared/age";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import { moneyEligibleRoom } from "@shared/roomRules";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import * as rs from "./roomStorage";
import * as ss from "./sprayStorage";
import { canViewRoom } from "./roomAccess";
import { roomFeatures } from "./features";
import { TokenBucket } from "./rateLimit";
import { SPRAY_UNAVAILABLE, finalizeSpray, getOwnSpray, sprayStatusView, startSpray } from "./spray";
import { checkDailyLimitChange, checkRoomLimitChange, dailyWindowStart, effectiveDailyLimit } from "./sprayLimits";

/** A normal per-IP limiter on the spray routes, on top of the per-user database-backed velocity (rule B5). */
export const sprayIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { message: "You're doing that too fast. Please try again in a bit.", code: "RATE_LIMITED" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
});

const buckets = new Map<string, TokenBucket>();
const take = (key: string, rate: number, burst: number) => {
  let b = buckets.get(key);
  if (!b) { if (buckets.size > 5000) buckets.clear(); b = new TokenBucket(rate, burst); buckets.set(key, b); }
  return b.take();
};

const unavailable = (res: Response) => res.status(403).json({ ...SPRAY_UNAVAILABLE });
const isAdult = (u: { dateOfBirth: string | null }) => { const a = ageFromDob(u.dateOfBirth); return a !== null && a >= 18; };

export function registerSprayRoutes(app: Express): void {
  // ------------------------------------------------------------ spray (pay at the moment you throw)
  app.post("/api/rooms/:id/spray", requireAuth, sprayIpLimiter, roomLimiter, async (req: Request, res: Response) => {
    try {
      const out = await startSpray({
        roomId: String(req.params.id ?? ""),
        payerId: req.user!.id, // the session's, never the body's
        body: req.body,
        devOrigin: `${req.protocol}://${req.headers.host}`,
      });
      if (out.retryAfterSec) res.setHeader("Retry-After", String(out.retryAfterSec));
      res.status(out.status).json(out.body);
    } catch (e) {
      console.error("[rooms:spray] spray failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Spraying isn't working right now. Try again." });
    }
  });

  // ------------------------------------------------------------ the payer's own spray (polling after a bank approval)
  // Payer only; anyone else (or another room) gets the same 404 as a spray that does not exist. While the spray is still in
  // flight this also asks the provider (finalizeSpray, skipping at once if another process has it), so the payer's return
  // from the bank page is not left waiting for the webhook. Rate limited per user.
  app.get("/api/rooms/:id/spray/:sprayId", requireAuth, async (req: Request, res: Response) => {
    try {
      let row = await getOwnSpray(String(req.params.id ?? ""), String(req.params.sprayId ?? ""), req.user!.id);
      if (!row) return res.status(404).json({ message: "Not found" });
      if ((row.status === "created" || row.status === "pending" || row.status === "paid") && take(`sprayfin:${req.user!.id}`, 1 / 3, 3)) {
        await finalizeSpray(row.providerRef, { waitMs: 0 }).catch((e) => console.error("[rooms:spray] finalize on poll failed:", sanitizeMoneyError(e)));
        row = (await ss.getSprayById(row.id)) ?? row;
      }
      res.json(sprayStatusView(row));
    } catch (e) {
      console.error("[rooms:spray] spray status failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load the spray" });
    }
  });

  // ------------------------------------------------------------ room limit (the payer's own, per room)
  app.put("/api/rooms/:id/spray/limit", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return unavailable(res);
      const [user, room] = await Promise.all([storage.getUser(req.user!.id), rs.getRoom(String(req.params.id ?? ""))]);
      // Not a money room for this person, or not visible: the generic answer (no detail).
      if (!user || user.deletedAt || !isAdult(user) || !room || !moneyEligibleRoom(room) || room.minorsRoom
        || !(await canViewRoom(room, user.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
        return unavailable(res);
      }
      const kobo = (req.body ?? {}).kobo;
      const chk = checkRoomLimitChange(user, kobo);
      if (!chk.ok) return res.status(chk.status).json({ code: chk.code, message: chk.message });
      const saved = await ss.setRoomLimit(room.id, user.id, kobo as number);
      res.json({ limitKobo: Number(saved.limitKobo), spentKobo: Number(saved.spentKobo) });
    } catch (e) {
      console.error("[rooms:spray] room limit failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to save the room limit" });
    }
  });

  // ------------------------------------------------------------ the payer's spray settings
  // Teens and unknown age never get money controls: the generic 403. An adult who is not ID-verified sees verified: false
  // (they can lower limits and remove a card, but cannot spray).
  app.get("/api/users/me/spray", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return unavailable(res);
      const user = await storage.getUser(req.user!.id);
      if (!user || user.deletedAt || !isAdult(user)) return unavailable(res);
      const [method, spent] = await Promise.all([
        ss.getSavedMethod(user.id),
        ss.sumPayerKoboSince(db, user.id, dailyWindowStart(Date.now())),
      ]);
      res.json({
        // last4 and brand only: never auth_enc, the signature or the bank.
        method: method ? { last4: method.last4 ?? "", brand: method.brand ?? "" } : null,
        dailyLimitKobo: effectiveDailyLimit(user),
        dailySpentKobo: spent,
        verified: isIdVerifiedAdult(user),
      });
    } catch (e) {
      console.error("[rooms:spray] spray settings failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load your spray settings" });
    }
  });

  app.put("/api/users/me/spray/daily-limit", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return unavailable(res);
      const user = await storage.getUser(req.user!.id);
      if (!user || user.deletedAt || !isAdult(user)) return unavailable(res);
      const kobo = (req.body ?? {}).kobo;
      const chk = checkDailyLimitChange(user, kobo);
      if (!chk.ok) return res.status(chk.status).json({ code: chk.code, message: chk.message });
      await ss.setDailyLimit(user.id, kobo as number);
      res.json({ dailyLimitKobo: effectiveDailyLimit({ ...user, sprayDailyLimitKobo: kobo as number }) });
    } catch (e) {
      console.error("[rooms:spray] daily limit failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to save your daily limit" });
    }
  });

  // Removing a saved card always works, whatever the flag or the person's age: it only ever takes something away.
  app.delete("/api/users/me/spray/method", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      const removed = await ss.deleteMethod(req.user!.id);
      res.json({ removed: removed > 0 });
    } catch (e) {
      console.error("[rooms:spray] card removal failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to remove the card" });
    }
  });

}
