// Door tooling shared by events and venue nights: live stats, the check-in log, and undo.
// Ticket validation and staff sign-in live in server/utils/doorAccess.ts.
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware";
import {
  getCheckInLog,
  getDoorCounts,
  undoCheckIn,
  type DoorKind,
} from "../doorStorage";
import { getDoorScope, resolveDoorActor, resolveScannerToken } from "../utils/doorAccess.js";

/** Staff may only undo a check-in made in the last 10 minutes; the owning organiser has no limit. */
export const STAFF_UNDO_WINDOW_MS = 10 * 60 * 1000;

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return 30;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

const undoSchema = z.object({ ticketId: z.string().min(1), eventId: z.string().min(1) });

export function registerDoorRoutes(app: Express): void {
  // Door counters for the scanner header. Staff token only (event or venue night).
  app.get("/api/scanner/stats", async (req, res) => {
    try {
      const token = req.headers["x-scanner-token"] as string | undefined;
      if (!token) return res.status(401).json({ message: "Scanner token required" });
      const auth = await resolveScannerToken(token);
      if (!auth.ok) return res.status(auth.status).json(auth.body);
      const scope = await getDoorScope(auth.kind, auth.staff.scopeId);
      if (!scope) return res.status(404).json({ message: "Event not found" });
      const { admitted, total } = await getDoorCounts(auth.kind, scope.id);
      res.json({
        type: auth.kind === "event" ? "event" : "venue-event",
        admitted,
        total,
        capacity: scope.capacity,
        mine: auth.staff.scanCount,
      });
    } catch (error) {
      console.error("Scanner stats error:", error);
      res.status(500).json({ message: "Failed to load stats" });
    }
  });

  // Shared door log, newest first, so every device at the door sees the same list.
  app.get("/api/scanner/log", async (req, res) => {
    try {
      const token = req.headers["x-scanner-token"] as string | undefined;
      if (!token) return res.status(401).json({ message: "Scanner token required" });
      const limit = parseLimit(req.query.limit);
      if (limit === null) return res.status(400).json({ message: "limit must be a whole number from 1 to 100" });
      const auth = await resolveScannerToken(token);
      if (!auth.ok) return res.status(auth.status).json(auth.body);
      res.json(await getCheckInLog(auth.kind, auth.staff.scopeId, limit));
    } catch (error) {
      console.error("Scanner log error:", error);
      res.status(500).json({ message: "Failed to load log" });
    }
  });

  // Organiser view of the same log.
  const organiserLog = (kind: DoorKind) => async (req: Request, res: Response) => {
    try {
      const scopeId = kind === "event" ? req.params.eventId : req.params.id;
      const limit = parseLimit(req.query.limit);
      if (limit === null) return res.status(400).json({ message: "limit must be a whole number from 1 to 100" });
      const scope = await getDoorScope(kind, scopeId);
      if (!scope) return res.status(404).json({ message: kind === "event" ? "Event not found" : "Venue event not found" });
      if (scope.organizerId !== req.user!.id) {
        return res.status(403).json({ message: "Only the organiser can view the check-in log" });
      }
      res.json(await getCheckInLog(kind, scopeId, limit));
    } catch (error) {
      console.error("Check-in log error:", error);
      res.status(500).json({ message: "Failed to load check-in log" });
    }
  };
  app.get("/api/events/:eventId/check-in-log", requireAuth, organiserLog("event"));
  app.get("/api/venue-events/:id/check-in-log", requireAuth, organiserLog("venue"));

  // Undo a check-in: owning organiser any time; staff token only within STAFF_UNDO_WINDOW_MS.
  const undo = (kind: DoorKind) => async (req: Request, res: Response) => {
    try {
      const parsed = undoSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid request data", reason: "bad_request" });
      const { ticketId, eventId } = parsed.data;

      const auth = await resolveDoorActor(req, kind, eventId);
      if (!auth.ok) return res.status(auth.status).json(auth.body);

      const notBefore = auth.actor.type === "staff" ? new Date(Date.now() - STAFF_UNDO_WINDOW_MS) : null;
      const result = await undoCheckIn(kind, eventId, ticketId, auth.actor, notBefore);
      if (result.ok) return res.json({ success: true });
      switch (result.reason) {
        case "not_found":
          return res.status(404).json({ message: "Ticket not found for this event", reason: "not_found" });
        case "not_checked_in":
          return res.status(409).json({ message: "That ticket isn't checked in.", reason: "not_checked_in" });
        case "window_expired":
          return res.status(403).json({
            message: "Staff can only undo a check-in within 10 minutes. Ask the organiser.",
            reason: "window_expired",
          });
      }
    } catch (error) {
      console.error("Undo check-in error:", error);
      res.status(500).json({ message: "Failed to undo check-in" });
    }
  };
  app.post("/api/tickets/undo-check-in", undo("event"));
  app.post("/api/venue-tickets/undo-check-in", undo("venue"));
}
