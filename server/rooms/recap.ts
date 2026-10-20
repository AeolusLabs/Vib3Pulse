// Room recap (phase 6, task 6.5): GET /api/rooms/:id/recap.
//
// Who gets one (everyone else: the same 404 as a room that does not exist, so nothing can be learned by probing ids):
//  - the room must have ENDED and have gone live (started_at set): a room still live, scheduled or cancelled before it
//    started has nothing to recap;
//  - the host, or a member who really joined it (a room_members row whose joined_at is not NEVER_JOINED; a row made only to
//    ban someone before they arrived does not count), who is not banned from it and not blocked either way with the host.
//  - (fix round) the room is not taken down by moderation (moderation_status 'approved'); an admin still reads it.
// Owner decision (fix round): the host and the people who actually took part, NOTHING else; plus an ADMIN read path
// (GET /api/admin/rooms/:id/recap, admin session + role, audited) that returns the host's view.
// What it shows: only the viewer's own numbers, the host's public summary (shown in the room already) and the host's next
// room if the viewer may see it. No other member's identity, ever. Host-only numbers are added by shapeRecap only for the
// host. earnedKobo comes from stored rows only, with the Earnings page's rule: paid tickets' host_kobo + the host's share of
// sprays delivered in the room (delivered, or delivered then disputed).
// Rooms that ended before tracking existed (peak_members IS NULL, review r2 I5) answer minutesIn / messages / peak as null:
// the counters were never recorded for them, so no number is shown rather than a false 0.
import type { Express } from "express";
import { pool, storage } from "../storage";
import { requireAuth } from "../middleware";
import { requireRole } from "../services/adminSecurity";
import { roomLimiter } from "../security";
import { isBlockedEitherWay } from "../utils/blocks";
import { liveMinutes, minutesInRoom, shapeRecap, type RoomRecapResponse } from "@shared/roomRecap";
import type { Room } from "@shared/schema";
import * as rs from "./roomStorage";
import { canViewRoom, hostSummary } from "./roomAccess";
import { NEVER_JOINED } from "./roomLock";

const ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
const ms = (d: Date | string | null | undefined): number | null => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

/** The host's soonest scheduled room this viewer may see (canViewRoom: visibility, blocks, minors' rooms), or null. */
async function nextRoomFor(hostId: string, viewerId: string, nowMs: number): Promise<{ roomId: string; scheduledFor: string } | null> {
  const rows = (await pool.query(
    `select id from rooms where host_id = $1 and status = 'scheduled' and scheduled_for > $2::timestamp order by scheduled_for asc limit 5`,
    [hostId, new Date(nowMs).toISOString()],
  )).rows as Array<{ id: string }>;
  for (const r of rows) {
    const room = await rs.getRoom(r.id);
    if (room && room.status === "scheduled" && room.scheduledFor && (await canViewRoom(room, viewerId))) {
      return { roomId: room.id, scheduledFor: new Date(room.scheduledFor).toISOString() };
    }
  }
  return null;
}

async function hostNumbers(room: Room): Promise<{ ticketsSold: number; earnedKobo: number; followersGained: number | null }> {
  const t = (await pool.query(
    `select count(*)::int as n, coalesce(sum(host_kobo), 0)::bigint as kobo from room_tickets where room_id = $1 and status = 'paid'`,
    [room.id],
  )).rows[0] as { n: number; kobo: string };
  const s = (await pool.query(
    `select coalesce(sum(host_kobo), 0)::bigint as kobo from spray_payments
      where room_id = $1 and host_id = $2 and delivered_at is not null and status in ('delivered', 'disputed')`,
    [room.id, room.hostId],
  )).rows[0] as { kobo: string };
  let followersGained: number | null = null;
  if (room.startedAt && room.endedAt) {
    // Follows that still exist, made by people who really joined this room, while it was live. Someone who followed and
    // unfollowed again is not counted (the row is gone): a lower bound, never a guess.
    const f = (await pool.query(
      `select count(distinct f.follower_id)::int as n
         from follows f join room_members m on m.room_id = $1 and m.user_id = f.follower_id and m.joined_at <> $5::timestamp
        where f.following_id = $2 and f.follower_id <> $2 and f.created_at >= $3::timestamp and f.created_at <= $4::timestamp`,
      [room.id, room.hostId, new Date(room.startedAt).toISOString(), new Date(room.endedAt).toISOString(), NEVER_JOINED.toISOString()],
    )).rows[0] as { n: number };
    followersGained = Number(f?.n ?? 0);
  }
  return { ticketsSold: Number(t?.n ?? 0), earnedKobo: Number(t?.kobo ?? 0) + Number(s?.kobo ?? 0), followersGained };
}

/**
 * The recap for this viewer, or null (the route answers 404 for every null). opts.admin: the admin read path; the viewer is
 * then the host (the answer is exactly the host's view) and a room taken down by moderation is still readable.
 */
export async function buildRecap(roomId: string, viewerIdIn: string, nowMs = Date.now(), opts: { admin?: boolean } = {}): Promise<RoomRecapResponse | null> {
  if (typeof roomId !== "string" || !ID_SHAPE.test(roomId)) return null;
  const room = await rs.getRoom(roomId);
  if (!room || room.status !== "ended" || !room.startedAt) return null;
  if (!opts.admin && room.moderationStatus !== "approved") return null; // review r2 m4: taken down = no recap
  const viewerId = opts.admin ? room.hostId : viewerIdIn;
  const isHost = room.hostId === viewerId;
  const member = await rs.getMember(roomId, viewerId);
  if (!isHost) {
    if (!member || member.banned) return null;
    if (ms(member.joinedAt) === NEVER_JOINED.getTime()) return null; // a ban-before-arrival row, never a visit
    if (await isBlockedEitherWay(viewerId, room.hostId)) return null;
  }
  const startedMs = ms(room.startedAt);
  const endedMs = ms(room.endedAt) ?? nowMs;
  const roomMinutes = liveMinutes(startedMs, endedMs);
  const realVisit = !!member && ms(member.joinedAt) !== NEVER_JOINED.getTime();
  const minutesIn = realVisit
    ? minutesInRoom({ secondsIn: member!.secondsIn ?? 0, joinedAtMs: ms(member!.joinedAt), leftAtMs: ms(member!.leftAt), untilMs: endedMs, roomMinutes })
    : 0;
  const [host, next, followsHost, extras] = await Promise.all([
    storage.getUser(room.hostId),
    nextRoomFor(room.hostId, viewerId, nowMs),
    isHost ? Promise.resolve(false)
      : pool.query(`select 1 from follows where follower_id = $1 and following_id = $2 limit 1`, [viewerId, room.hostId]).then((r) => (r.rowCount ?? 0) > 0),
    isHost ? hostNumbers(room) : Promise.resolve({ ticketsSold: 0, earnedKobo: 0, followersGained: null as number | null }),
  ]);
  // Not tracked (ended before the counters existed): null, never a false 0.
  const tracked = room.peakMembers !== null && room.peakMembers !== undefined;
  const recap = shapeRecap({
    minutesIn: tracked ? minutesIn : null, messages: tracked ? (realVisit ? member!.messagesSent ?? 0 : 0) : null, next, follow: followsHost,
    minutes: roomMinutes, peak: room.peakMembers ?? null, ...extras,
  }, isHost);
  const h = host ? hostSummary(host) : null;
  return {
    room: { id: room.id, title: room.title, startedAt: new Date(room.startedAt).toISOString(), endedAt: room.endedAt ? new Date(room.endedAt).toISOString() : null },
    host: h ? { id: h.id, username: h.username ?? null, displayName: h.displayName ?? null, organizationName: h.organizationName ?? null, avatarUrl: h.avatarUrl ?? null } : null,
    isHost,
    recap,
    ...(opts.admin ? { adminView: true as const } : {}),
  };
}

export function registerRoomRecapRoutes(app: Express): void {
  app.get("/api/rooms/:id/recap", requireAuth, roomLimiter, async (req, res) => {
    try {
      const out = await buildRecap(req.params.id, req.user!.id);
      if (!out) return res.status(404).json({ message: "Room not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(out);
    } catch (e) {
      console.error("[rooms] recap failed:", req.params.id, e instanceof Error ? e.message : e);
      res.status(500).json({ message: "Couldn't load the recap" });
    }
  });
}

/**
 * Admin read path (owner decision, fix round): the host's view of an ended room's recap, for moderation and support.
 * The route (admin-routes.ts) runs behind the admin session and requireRole; this writes the audit row. null = 404.
 */
export async function adminRecap(a: { adminId: string; roomId: string; ip?: string }): Promise<RoomRecapResponse | null> {
  const out = await buildRecap(a.roomId, "", Date.now(), { admin: true });
  if (!out) return null;
  await storage.logAdminActivity({
    adminId: a.adminId, action: "room.recap_viewed", targetType: "room", targetId: out.room.id, details: "admin read the room recap", ipAddress: a.ip,
  });
  return out;
}

/** Registered by admin-routes.ts (after the admin session middleware). Moderator roles only; users never reach it. */
export function registerRoomRecapAdminRoute(app: Express): void {
  app.get("/api/admin/rooms/:id/recap", requireRole("super_admin", "content_moderator"), async (req, res) => {
    try {
      const out = await adminRecap({ adminId: req.session.adminId!, roomId: String(req.params.id ?? ""), ip: req.ip });
      if (!out) return res.status(404).json({ message: "Room not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(out);
    } catch (e) {
      console.error("[ADMIN] room recap failed:", e instanceof Error ? e.message : e);
      res.status(500).json({ message: "Failed to load the recap" });
    }
  });
}
