// Rooms admin routes (rooms admin plan): read endpoints (task 4) and the audited freeze endpoints (task 5).
// Registered from server/admin-routes.ts. Existing room levers (end room, reported rooms, payout hold, refund-all, clawbacks) stay where
// they are; this file adds what was missing: live rooms, usage numbers, the spray breakdown and the pause / host-freeze controls.
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { pool, storage } from "../storage";
import { requireRole } from "../services/adminSecurity";
import { listLiveRooms, parseRange, roomsOverview, sprayBreakdown } from "./adminStats";
import { CONTROL_KEYS, freezeHost, getControl, listFrozenHosts, setControl, unfreezeHost, type ControlKey } from "./roomControls";
import { adminHoldAllPayoutsForHost } from "./settlement";
import { adminEndRoom } from "./roomAdmin";

const MODERATION = ["super_admin", "content_moderator"] as const;
const FINANCE = ["super_admin", "finance_manager"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonSchema = z.string().trim().min(3).max(300);
const REASON_REQUIRED = { message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" };

/** The audit row is the record of a freeze: written only when something changed, and a failure is shouted, never silent. */
async function audit(req: Request, action: string, targetType: string, targetId: string, reason: string, details: unknown): Promise<void> {
  await storage.logAdminActivity({
    adminId: req.session.adminId!, action, targetType, targetId, details: JSON.stringify(details).slice(0, 1000), reason, ipAddress: req.ip,
  }).catch((e) => console.error(`[ADMIN] ALERT ${action} on ${targetId} took effect but the audit row failed:`, (e as Error)?.message));
}

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

  // ---------------------------------------------------------------- freeze controls (audited)
  app.get("/api/admin/rooms/controls", requireRole(...FINANCE), async (_req: Request, res: Response) => {
    try {
      const [spraysPaused, ticketsPaused, frozenHosts] = await Promise.all([getControl("sprays_paused"), getControl("tickets_paused"), listFrozenHosts()]);
      res.json({ spraysPaused, ticketsPaused, frozenHosts });
    } catch (e) {
      console.error("[ADMIN] room controls failed:", (e as Error)?.message);
      res.status(500).json({ message: "Failed to load the controls" });
    }
  });

  // Pausing: super_admin or finance_manager. Resuming: super_admin only. A repeat of the current state is a 200 with changed:false and no audit row.
  app.post("/api/admin/rooms/controls/:key", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const key = String(req.params.key ?? "") as ControlKey;
    if (!CONTROL_KEYS.includes(key)) return res.status(404).json({ message: "Unknown control" });
    const reason = reasonSchema.safeParse(req.body?.reason);
    if (!reason.success) return res.status(400).json(REASON_REQUIRED);
    if (typeof req.body?.on !== "boolean") return res.status(400).json({ message: "on must be true or false", code: "BAD_REQUEST" });
    const on = req.body.on as boolean;
    if (!on && req.session.adminRole !== "super_admin") return res.status(403).json({ message: "Only a super-admin can resume this.", code: "SUPER_ADMIN_ONLY" });
    try {
      const r = await setControl({ key, on, adminId: req.session.adminId!, reason: reason.data });
      if (r.changed) await audit(req, on ? "room_control.on" : "room_control.off", "room_control", key, reason.data, { key, on });
      res.json({ key, on, changed: r.changed });
    } catch (e) {
      console.error("[ADMIN] room control failed:", (e as Error)?.message);
      res.status(500).json({ message: "That did not work. Check the switch before trying again." });
    }
  });

  // Freeze a host: no new sprays or ticket sales, every holdable payout held, optionally their live rooms ended. Super_admin or finance_manager.
  app.post("/api/admin/rooms/hosts/:hostId/freeze", requireRole(...FINANCE), async (req: Request, res: Response) => {
    const hostId = String(req.params.hostId ?? "");
    if (!UUID.test(hostId) || !(await pool.query(`select 1 from users where id = $1`, [hostId])).rowCount) return res.status(404).json({ message: "Host not found" });
    const reason = reasonSchema.safeParse(req.body?.reason);
    if (!reason.success) return res.status(400).json(REASON_REQUIRED);
    const endLiveRooms = req.body?.endLiveRooms === true;
    try {
      const r = await freezeHost({ hostId, adminId: req.session.adminId!, reason: reason.data });
      if (!r.changed) return res.json({ changed: false });
      const held = await adminHoldAllPayoutsForHost(hostId, reason.data);
      let endedRooms = 0;
      if (endLiveRooms) {
        const live = (await pool.query(`select id from rooms where host_id = $1 and status = 'live'`, [hostId])).rows as { id: string }[];
        for (const room of live) {
          const out = await adminEndRoom({ adminId: req.session.adminId!, roomId: room.id, reason: `Host frozen: ${reason.data}`, ip: req.ip });
          if (out.ok) endedRooms++;
        }
      }
      await audit(req, "room_host.freeze", "room_host", hostId, reason.data, { held, endedRooms, endLiveRooms });
      res.json({ changed: true, held, endedRooms });
    } catch (e) {
      console.error("[ADMIN] host freeze failed:", (e as Error)?.message);
      res.status(500).json({ message: "That did not work. Check the host's freeze state before trying again." });
    }
  });

  // Unfreeze: super_admin only. Does NOT release held payouts: an admin releases those deliberately, room by room.
  app.post("/api/admin/rooms/hosts/:hostId/unfreeze", requireRole("super_admin"), async (req: Request, res: Response) => {
    const hostId = String(req.params.hostId ?? "");
    if (!UUID.test(hostId)) return res.status(404).json({ message: "Host not found" });
    const reason = reasonSchema.safeParse(req.body?.reason);
    if (!reason.success) return res.status(400).json(REASON_REQUIRED);
    try {
      const r = await unfreezeHost({ hostId, adminId: req.session.adminId! });
      if (r.changed) await audit(req, "room_host.unfreeze", "room_host", hostId, reason.data, {});
      res.json({ changed: r.changed });
    } catch (e) {
      console.error("[ADMIN] host unfreeze failed:", (e as Error)?.message);
      res.status(500).json({ message: "That did not work. Check the host's freeze state before trying again." });
    }
  });
}
