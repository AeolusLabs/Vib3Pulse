// Admin-side room tools. Logic lives here (not in the route handlers) so it can be tested without an admin session;
// the routes in admin-routes.ts are thin wrappers. Every action writes an audit row with the reason.
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, storage } from "../storage";
import { contentReports, rooms, users } from "@shared/schema";
import { AGE_LIMITS, type AgeLimit } from "@shared/age";
import * as rs from "./roomStorage";
import { endRoom, enforceAgeLimit } from "./roomSocket";
import { hostSummary } from "./roomAccess";

type Fail = { ok: false; status: 400 | 404 | 409; message: string };
type Ok = { ok: true; room: ReturnType<typeof rest> };
const rest = (r: NonNullable<Awaited<ReturnType<typeof rs.getRoom>>>) => { const { inviteTokenHash, ...x } = r; return x; };

const need = (reason: unknown): string | null => (typeof reason === "string" && reason.trim() ? reason.trim() : null);

export async function adminSetRoomAgeLimit(a: { adminId: string; roomId: string; ageLimit: AgeLimit; reason: string; ip?: string }): Promise<Ok | Fail> {
  const reason = need(a.reason);
  if (!reason) return { ok: false, status: 400, message: "A reason is required" };
  if (!(AGE_LIMITS as readonly string[]).includes(a.ageLimit)) return { ok: false, status: 400, message: "Invalid age limit" };
  const room = await rs.getRoom(a.roomId);
  if (!room) return { ok: false, status: 404, message: "Room not found" };
  const updated = await rs.updateRoom(room.id, { ageLimit: a.ageLimit });
  if (updated.status === "live") await enforceAgeLimit(room.id); // people already inside who fail the new limit are sent out now
  await storage.logAdminActivity({
    adminId: a.adminId, action: "room.age_limit_changed", targetType: "room", targetId: room.id,
    details: `age limit ${room.ageLimit} -> ${a.ageLimit}`, reason, ipAddress: a.ip,
  });
  return { ok: true, room: rest(updated) };
}

export async function adminEndRoom(a: { adminId: string; roomId: string; reason: string; ip?: string }): Promise<Ok | Fail> {
  const reason = need(a.reason);
  if (!reason) return { ok: false, status: 400, message: "A reason is required" };
  const room = await rs.getRoom(a.roomId);
  if (!room) return { ok: false, status: 404, message: "Room not found" };
  if (room.status === "ended") return { ok: false, status: 409, message: "This room has already ended" };
  await endRoom(room.id); // status, live sockets told, presence + timers cleared
  await storage.logAdminActivity({
    adminId: a.adminId, action: "room.ended_by_admin", targetType: "room", targetId: room.id,
    details: `ended "${room.title}"`, reason, ipAddress: a.ip,
  });
  return { ok: true, room: rest((await rs.getRoom(room.id))!) };
}

/** Pending reports about rooms, grouped by room, newest first. Each report's description already carries the chat excerpt. */
export async function listReportedRooms(limit = 100) {
  const reports = await db.select().from(contentReports)
    .where(and(inArray(contentReports.contentType, ["room", "room_message", "room_user"]), eq(contentReports.status, "pending")))
    .orderBy(desc(contentReports.createdAt)).limit(500);
  const pending = reports;
  const roomIdOf = (contentId: string) => contentId.split(":")[0];
  const ids = Array.from(new Set(pending.map((r) => roomIdOf(r.contentId))));
  if (!ids.length) return [];
  const rows = await db.select().from(rooms).where(inArray(rooms.id, ids));
  const hostIds = Array.from(new Set(rows.map((r) => r.hostId)));
  const hosts = new Map((await db.select().from(users).where(inArray(users.id, hostIds))).map((u) => [u.id, hostSummary(u)]));
  const byRoom = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ roomId: string; title: string; status: string; ageLimit: string; hostId: string; host: ReturnType<typeof hostSummary> | null; reports: any[] }> = [];
  for (const id of ids) {
    const room = byRoom.get(id);
    if (!room) continue;
    out.push({
      roomId: id, title: room.title, status: room.status, ageLimit: room.ageLimit, hostId: room.hostId, host: hosts.get(room.hostId) ?? null,
      reports: pending.filter((r) => roomIdOf(r.contentId) === id).map((r) => ({
        id: r.id, type: r.contentType, reason: r.reason, description: r.description, createdAt: r.createdAt, reporterId: r.reporterId,
        targetUserId: r.contentType === "room" ? null : r.contentId.split(":")[1] ?? null,
      })),
    });
  }
  return out.slice(0, limit);
}
