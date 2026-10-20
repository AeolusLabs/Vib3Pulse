// Rooms phase 6, tasks 6.2 and 6.3: earnings, the payer's payments and receipts. Signed in only; every answer is about
// the session's user (there is no user id in any of these paths). Registered first in registerRoomRoutes.
import type { Express, Request, Response } from "express";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { sanitizeMoneyError } from "@shared/roomRefunds";
import { isEarningsRange } from "@shared/roomEarnings";
import { earningsFor } from "./earnings";
import { BadCursorError, paymentsPage, receiptHtmlFor } from "./receipts";

const noStore = (res: Response) => res.setHeader("Cache-Control", "private, no-store");

/** The receipt page's headers (revision B 6.3), plus no framing and no referrer. */
export const RECEIPT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

export function registerRoomEarningsRoutes(app: Express): void {
  app.get("/api/users/me/room-earnings", requireAuth, async (req: Request, res: Response) => {
    const range = req.query.range === undefined ? "week" : req.query.range;
    if (!isEarningsRange(range)) return res.status(400).json({ code: "BAD_RANGE", message: "range must be week, month or all" });
    try {
      noStore(res);
      res.json(await earningsFor(req.user!.id, range));
    } catch (e) {
      console.error("[rooms:earnings] earnings failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Failed to load your earnings" });
    }
  });

  app.get("/api/users/me/room-payments", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      noStore(res);
      res.json(await paymentsPage(req.user!.id, req.query.cursor));
    } catch (e) {
      if (e instanceof BadCursorError) return res.status(400).json({ code: "BAD_CURSOR", message: "That page link is not valid. Reload the list." });
      console.error("[rooms:earnings] payments failed:", sanitizeMoneyError(e));
      res.status(500).json({ code: "SERVER_ERROR", message: "Failed to load your payments" });
    }
  });

  // Own lines only: anything else (another person's, a malformed id, a line without a receipt) is the same 404.
  app.get("/api/users/me/room-payments/:id/receipt", requireAuth, roomLimiter, async (req: Request, res: Response) => {
    try {
      const html = await receiptHtmlFor(req.user!.id, String(req.params.id ?? ""));
      if (!html) return res.status(404).json({ message: "Not found" });
      for (const [k, v] of Object.entries(RECEIPT_HEADERS)) res.setHeader(k, v);
      res.status(200).send(html);
    } catch (e) {
      console.error("[rooms:earnings] receipt failed:", sanitizeMoneyError(e));
      res.status(500).json({ message: "Failed to load the receipt" });
    }
  });
}
