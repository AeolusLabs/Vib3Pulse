// Rooms phase 6, task 6.1: the payout account routes. Registered FIRST in registerRoomRoutes (before any /api/rooms/:id
// route). Every rule is in payouts.ts; these handlers only parse, call and answer. Signed in only (requireAuth), the user is
// always the session's. Room hosts are ordinary users, so no organiser role is required.
import type { Express, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../middleware";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { payoutBanks, payoutStatusFor, setPayoutAccount } from "./payouts";

/** Per-IP limit on the account lookup, on top of the per-user database limit (5 an hour) in payouts.ts. */
export const payoutAccountIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { code: "RATE_LIMITED", message: "Too many tries. Please wait an hour and try again." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
});

const noStore = (res: Response) => res.setHeader("Cache-Control", "private, no-store");

export function registerRoomPayoutRoutes(app: Express): void {
  app.get("/api/rooms/payouts/status", requireAuth, async (req: Request, res: Response) => {
    try {
      noStore(res);
      res.json(await payoutStatusFor(req.user!.id));
    } catch (e) {
      console.error("[rooms:payouts] status failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Failed to load your payout account" });
    }
  });

  // Paystack's bank list (names and codes only, public data), cached an hour in payouts.ts.
  app.get("/api/rooms/payouts/banks", requireAuth, async (_req: Request, res: Response) => {
    try {
      const banks = await payoutBanks();
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.json({ banks: banks.map((b) => ({ name: b.name, code: b.code })) });
    } catch (e) {
      console.error("[rooms:payouts] bank list failed:", sanitizeMoneyError(e));
      res.status(503).json({ code: "PROVIDER_UNAVAILABLE", message: "We could not load the list of banks. Try again in a moment." });
    }
  });

  app.post("/api/rooms/payouts/account", requireAuth, payoutAccountIpLimiter, async (req: Request, res: Response) => {
    try {
      noStore(res);
      const out = await setPayoutAccount(req.user!.id, req.body);
      if (out.retryAfterSec) res.setHeader("Retry-After", String(out.retryAfterSec));
      res.status(out.status).json(out.body);
    } catch (e) {
      // Never the error's text to the client; the log line is sanitised (no account numbers, no emails).
      console.error("[rooms:payouts] account change failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "That did not work. Try again." });
    }
  });
}
