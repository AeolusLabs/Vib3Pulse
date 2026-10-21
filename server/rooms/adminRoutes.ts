// Rooms admin routes (rooms admin plan): read endpoints (task 4), and later the audited freeze endpoints (task 5).
// Registered from server/admin-routes.ts. Existing room levers (end room, reported rooms, payout hold, refund-all, clawbacks) stay where
// they are; this file only adds what was missing: live rooms, usage numbers and the spray breakdown.
import type { Express, Request, Response } from "express";
import { requireRole } from "../services/adminSecurity";
import { listLiveRooms, parseRange, roomsOverview, sprayBreakdown } from "./adminStats";

const MODERATION = ["super_admin", "content_moderator"] as const;
const FINANCE = ["super_admin", "finance_manager"] as const;

export function registerRoomsAdminRoutes(app: Express): void {
  app.get("/api/admin/rooms/live", requireRole(...MODERATION), async (_req: Request, res: Response) => {
    try {
      res.json({ rooms: await listLiveRooms() });
    } catch (e) {
      console.error("[ADMIN] live rooms failed:", (e as Error)?.message);
      res.status(500).json({ message: "Failed to load live rooms" });
    }
  });

  app.get("/api/admin/rooms/overview", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const range = parseRange({ from: req.query.from, to: req.query.to });
    if (!range) return res.status(400).json({ message: "Pick a valid date range of at most 366 days.", code: "BAD_RANGE" });
    try {
      res.json(await roomsOverview(range));
    } catch (e) {
      console.error("[ADMIN] rooms overview failed:", (e as Error)?.message);
      res.status(500).json({ message: "Failed to load the overview" });
    }
  });

  app.get("/api/admin/rooms/sprays", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const range = parseRange({ from: req.query.from, to: req.query.to });
    if (!range) return res.status(400).json({ message: "Pick a valid date range of at most 366 days.", code: "BAD_RANGE" });
    try {
      res.json(await sprayBreakdown(range));
    } catch (e) {
      console.error("[ADMIN] spray breakdown failed:", (e as Error)?.message);
      res.status(500).json({ message: "Failed to load the spray breakdown" });
    }
  });
}
