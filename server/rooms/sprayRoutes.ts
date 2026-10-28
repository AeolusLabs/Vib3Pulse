// Spraying (phase 5, tasks 5.4 and 5.5): the HTTP routes. Registered by one line in registerRoomRoutes.
// Every rule is in spray.ts / sprayLimits.ts; these handlers only parse, call and answer. Nothing here returns a card's
// authorization code, signature, the payment reference or another person's data; the global redaction is the safety net.
import type { Express, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { db, storage } from "../storage";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { roomHub } from "./RoomHub";
import { sprayBoardFor, sprayReceivedFor } from "./sprayBoard";
import { ageFromDob } from "@shared/age";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import { moneyEligibleRoom } from "@shared/roomRules";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import * as rs from "./roomStorage";
import * as ss from "./sprayStorage";
import { canViewRoom } from "./roomAccess";
import { roomFeatures } from "./features";
import { TokenBucket } from "./rateLimit";
import { withSpraySource } from "./sprayEvents";
import { SPRAY_UNAVAILABLE, finalizeSpray, getOwnSpray, sprayStatusView, startSpray } from "./spray";
import { batchStatusView, getOwnBatch, startTeamSpray } from "./teamSpray";
import * as bs from "./sprayBatchStorage";

/** A normal per-IP limiter on the spray routes, on top of the per-user database-backed velocity (rule B5). */
export const sprayIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { message: "You're doing that too fast. Please try again in a bit.", code: "RATE_LIMITED" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
});

// Per-user buckets for finalize-on-poll. Bounded by evicting the OLDEST bucket (a Map keeps insertion order), never by
// clearing them all: clearing would hand every user a fresh budget at once and amplify provider verify calls.
const buckets = new Map<string, TokenBucket>();
const MAX_BUCKETS = 5000;
const take = (key: string, rate: number, burst: number) => {
  let b = buckets.get(key);
  if (!b) {
    while (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
    b = new TokenBucket(rate, burst);
    buckets.set(key, b);
  }
  return b.take();
};

/** A failed spray this recent is still re-checked on the payer's poll: a payment that landed late is refunded at once. */
const POLL_FAILED_RECHECK_MS = 60 * 60_000;

const unavailable = (res: Response) => res.status(403).json({ ...SPRAY_UNAVAILABLE });
const isAdult = (u: { dateOfBirth: string | null }) => { const a = ageFromDob(u.dateOfBirth); return a !== null && a >= 18; };

export function registerSprayRoutes(app: Express): void {
  // ------------------------------------------------------------ spray (pay at the moment you throw)
  app.post("/api/rooms/:id/spray", requireAuth, sprayIpLimiter, roomLimiter, async (req: Request, res: Response) => {
    try {
      const out = await withSpraySource("api", () => startSpray({
        roomId: String(req.params.id ?? ""),
        payerId: req.user!.id, // the session's, never the body's
        body: req.body,
        devOrigin: `${req.protocol}://${req.headers.host}`,
      }));
      if (out.retryAfterSec) res.setHeader("Retry-After", String(out.retryAfterSec));
      res.status(out.status).json(out.body);
    } catch (e) {
      console.error("[rooms:spray] spray failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Spraying isn't working right now. Try again." });
    }
  });

  // ------------------------------------------------------------ the room's spray board (top three) and my own total
  // For someone who is in the room right now; anyone else gets the same 404 as a room that does not exist. The total is only ever
  // the caller's own (what they were sprayed here), never anyone else's.
  app.get("/api/rooms/:id/spray/board", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return unavailable(res);
      const roomId = String(req.params.id ?? "");
      if (!roomHub.get(roomId, req.user!.id)) return res.status(404).json({ message: "Not found" });
      const [top, mine] = await Promise.all([sprayBoardFor(roomId), sprayReceivedFor(roomId, req.user!.id)]);
      res.json({ top, mine });
    } catch (e) {
      console.error("[rooms:spray] board failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load the board" });
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
      const recentFailure = row.status === "failed" && Date.now() - new Date(row.createdAt).getTime() < POLL_FAILED_RECHECK_MS;
      if ((row.status === "created" || row.status === "pending" || row.status === "paid" || recentFailure) && take(`sprayfin:${req.user!.id}`, 1 / 3, 3)) {
        const ref = row.providerRef; // (a const keeps the null check above in force inside the callback)
        await withSpraySource("api", () => finalizeSpray(ref, { waitMs: 0 })).catch((e) => console.error("[rooms:spray] finalize on poll failed:", sanitizeMoneyError(e)));
        row = (await ss.getSprayById(row.id)) ?? row;
      }
      res.json(sprayStatusView(row));
    } catch (e) {
      console.error("[rooms:spray] spray status failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load the spray" });
    }
  });

  // ------------------------------------------------------------ team spray (gaming): ONE charge for a whole team
  // 404 whenever ROOMS_GAMING is off. Every eligibility failure is the single spray's generic 403 SPRAY_UNAVAILABLE (teamSpray.ts).
  app.post("/api/rooms/:id/spray/team", requireAuth, sprayIpLimiter, roomLimiter, async (req: Request, res: Response) => {
    if (!roomFeatures.gaming) return res.status(404).json({ message: "Not found" });
    try {
      const out = await withSpraySource("api", () => startTeamSpray({
        roomId: String(req.params.id ?? ""),
        payerId: req.user!.id, // the session's, never the body's
        body: req.body,
        devOrigin: `${req.protocol}://${req.headers.host}`,
      }));
      if (out.retryAfterSec) res.setHeader("Retry-After", String(out.retryAfterSec));
      res.status(out.status).json(out.body);
    } catch (e) {
      console.error("[rooms:spray] team spray failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Spraying isn't working right now. Try again." });
    }
  });

  // The payer's own team spray (polling after a bank approval). Same rules as the single spray's status route.
  app.get("/api/rooms/:id/spray/team/:batchId", requireAuth, async (req: Request, res: Response) => {
    if (!roomFeatures.gaming) return res.status(404).json({ message: "Not found" });
    try {
      let b = await getOwnBatch(String(req.params.id ?? ""), String(req.params.batchId ?? ""), req.user!.id);
      if (!b) return res.status(404).json({ message: "Not found" });
      const recentFailure = b.status === "failed" && Date.now() - new Date(b.createdAt).getTime() < POLL_FAILED_RECHECK_MS;
      if ((b.status === "created" || b.status === "pending" || b.status === "paid" || recentFailure) && take(`sprayfin:${req.user!.id}`, 1 / 3, 3)) {
        const ref = b.providerRef;
        await withSpraySource("api", () => finalizeSpray(ref, { waitMs: 0 })).catch((e) => console.error("[rooms:spray] finalize on team poll failed:", sanitizeMoneyError(e)));
        b = (await bs.getBatchById(b.id)) ?? b;
      }
      res.json(await batchStatusView(b));
    } catch (e) {
      console.error("[rooms:spray] team spray status failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load the spray" });
    }
  });

  // ------------------------------------------------------------ the payer's spray settings
  // Teens and unknown age never get money controls: the generic 403. An adult who is not ID-verified sees verified: false
  // (they can remove a card, but cannot spray).
  app.get("/api/users/me/spray", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!roomFeatures.spray) return unavailable(res);
      const user = await storage.getUser(req.user!.id);
      if (!user || user.deletedAt || !isAdult(user)) return unavailable(res);
      const method = await ss.getSavedMethod(user.id);
      res.json({
        // last4 and brand only: never auth_enc, the signature or the bank.
        method: method ? { last4: method.last4 ?? "", brand: method.brand ?? "" } : null,
        verified: isIdVerifiedAdult(user),
      });
    } catch (e) {
      console.error("[rooms:spray] spray settings failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load your spray settings" });
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
