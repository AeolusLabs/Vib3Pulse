// REST for virtual rooms. Live presence/chat is on the WebSocket (roomSocket.ts); everything that must survive
// reconnects (create, schedule, start/end, bans, reports, privacy) is here and persisted.
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { storage, db } from "../storage";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { toPublicUser, userToSessionUser } from "../auth";
import { blockedWith, isBlockedEitherWay } from "../utils/blocks";
import { ageGapBetween } from "../utils/ageGate";
import { deliverNotification } from "../notifications";
import { getConfig } from "../services/moderationConfig";
import { events, follows, users, venues, type Room, type User } from "@shared/schema";
import { ageFromDob, minAgeForLimit } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { resolveRoomPrivacy, validateRoomInput, validateRoomPrivacy } from "@shared/rooms";
import { canHostRoom, canJoinRoom } from "@shared/roomRules";
import * as rs from "./roomStorage";
import { canViewRoom, hostSummary, mutualFollow, plainText, publicRoom, sha256 } from "./roomAccess";
import { TokenBucket } from "./rateLimit";
import { getVoiceService } from "./voice/voiceService";
import { afterRoleChange, canPublishNow, shutdownVoice } from "./stage";
import { applyMod, endRoom, enforceAgeLimit, expectHost, interactionVerdict, notifyScreen } from "./roomSocket";
import { roomHub } from "./RoomHub";

const MAX_SCHEDULED = 10;
const MAX_LIVE = 1;
const MAX_NOTIFY = 200;
const DAY_MS = 86_400_000;

const HOST_MESSAGES = {
  AGE_UNKNOWN: "Add your date of birth in your profile to host rooms.",
  HOST_BELOW_LIMIT: "You can't host a room with that age limit.",
  TEEN_PUBLIC: "Public rooms are for adults. Try a friends-only or invite-only room.",
  ACCOUNT_TOO_NEW: "Your account is too new to host a public room. Try a friends-only or invite-only room.",
} as const;

const newInviteToken = () => crypto.randomBytes(24).toString("hex");

export function isHost(room: Room, userId: string) {
  return room.hostId === userId;
}

async function hostCheck(host: User, input: { visibility: Room["visibility"]; ageLimit: Room["ageLimit"] }) {
  return canHostRoom(
    { age: ageFromDob(host.dateOfBirth), accountAgeDays: (Date.now() - new Date(host.createdAt).getTime()) / DAY_MS },
    input as any,
    { minAccountAgeDays: await getConfig("min_account_age_days") },
  );
}

async function notifyFollowers(room: Room, host: User): Promise<void> {
  if (room.visibility === "invite") return;
  const rows = await db.select({ id: users.id, dob: users.dateOfBirth }).from(follows)
    .innerJoin(users, eq(users.id, follows.followerId)).where(eq(follows.followingId, host.id)).limit(2000);
  if (!rows.length) return;
  const blocked = await blockedWith(host.id);
  let audience = rows.filter((r) => !blocked.has(r.id) && canJoinRoom({ age: ageFromDob(r.dob) }, room as any).ok);
  if (room.visibility === "friends") {
    const back = new Set((await db.select({ id: follows.followingId }).from(follows).where(eq(follows.followerId, host.id))).map((r) => r.id));
    audience = audience.filter((r) => back.has(r.id));
  }
  const name = host.displayName || host.organizationName || host.username;
  await Promise.allSettled(audience.slice(0, MAX_NOTIFY).map((r) => deliverNotification({
    userId: r.id, type: "room_live", title: `${name} is live`, message: room.title,
    link: `/rooms/${room.id}`, relatedUserId: host.id, relatedEntityId: room.id,
  })));
}

async function checkLink(res: Response, hostId: string, v: { eventId?: string; venueId?: string }): Promise<boolean> {
  if (v.eventId) {
    const [e] = await db.select({ o: events.organizerId }).from(events).where(eq(events.id, v.eventId)).limit(1);
    if (!e) { res.status(404).json({ message: "Event not found", field: "eventId" }); return false; }
    if (e.o !== hostId) { res.status(403).json({ message: "You can only link your own event.", code: "NOT_OWNER" }); return false; }
  }
  if (v.venueId) {
    const [e] = await db.select({ o: venues.ownerId }).from(venues).where(eq(venues.id, v.venueId)).limit(1);
    if (!e) { res.status(404).json({ message: "Venue not found", field: "venueId" }); return false; }
    if (e.o !== hostId) { res.status(403).json({ message: "You can only link your own venue.", code: "NOT_OWNER" }); return false; }
  }
  return true;
}

export function registerRoomRoutes(app: Express): void {
  // Loads the room and answers 404 (invisible) / 403 (not the host) itself; returns null when it has responded.
  async function loadHostRoom(req: Request, res: Response): Promise<{ room: Room; host: User } | null> {
    const room = await rs.getRoom(req.params.id);
    if (!room) { res.status(404).json({ message: "Room not found" }); return null; }
    if (!(await canViewRoom(room, req.user!.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
      res.status(404).json({ message: "Room not found" }); return null;
    }
    if (!isHost(room, req.user!.id)) { res.status(403).json({ message: "Only the host can do that." }); return null; }
    const host = await storage.getUser(req.user!.id);
    if (!host) { res.status(404).json({ message: "User not found" }); return null; }
    return { room, host };
  }

  // ------------------------------------------------------------ create
  app.post("/api/rooms", requireAuth, roomLimiter, async (req, res) => {
    try {
      const v = validateRoomInput(req.body);
      if (!v.ok) return res.status(400).json({ message: `Invalid ${v.field}`, field: v.field });
      const host = await storage.getUser(req.user!.id);
      if (!host) return res.status(404).json({ message: "User not found" });

      const hc = await hostCheck(host, v.value);
      if (!hc.ok) return res.status(403).json({ message: HOST_MESSAGES[hc.code], code: hc.code });

      let screen = null;
      if (v.value.screenUrl) {
        const r = resolveScreen(v.value.screenUrl);
        if (!r.ok) return res.status(400).json({ message: "That screen link can't be used.", field: "screenUrl", reason: r.reason });
        screen = r.screen;
      }
      if (!(await checkLink(res, host.id, v.value))) return;
      if ((await rs.countScheduledByHost(host.id)) >= MAX_SCHEDULED) {
        return res.status(429).json({ message: `You can have up to ${MAX_SCHEDULED} scheduled rooms.`, code: "SCHEDULED_LIMIT" });
      }

      const inviteToken = v.value.visibility === "invite" ? newInviteToken() : undefined;
      const room = await rs.createRoom(host.id, {
        ...v.value,
        title: plainText(v.value.title),
        description: v.value.description ? plainText(v.value.description) : undefined,
        screen,
        inviteTokenHash: inviteToken ? sha256(inviteToken) : undefined,
      });
      // Not named "inviteToken": the global response redaction strips that key from every body on purpose.
      res.status(201).json({ room: { ...publicRoom(room), host: hostSummary(host) }, ...(inviteToken ? { inviteLink: `/rooms/${room.id}?token=${inviteToken}` } : {}) });
    } catch (e) {
      console.error("[rooms] create failed:", e);
      res.status(500).json({ message: "Failed to create room" });
    }
  });

  // ------------------------------------------------------------ list
  app.get("/api/rooms", requireAuth, async (req, res) => {
    try {
      const scope = typeof req.query.scope === "string" ? req.query.scope : "live";
      if (scope !== "live" && scope !== "upcoming" && scope !== "friends") return res.status(400).json({ message: "Invalid scope", field: "scope" });
      const str = (x: unknown) => (typeof x === "string" && x.length <= 64 ? x : undefined);
      const list = await rs.listRooms({ scope, viewerId: req.user!.id, eventId: str(req.query.eventId), venueId: str(req.query.venueId) });
      const hostIds = Array.from(new Set(list.map((r) => r.hostId)));
      const hosts = hostIds.length ? await db.select().from(users).where(inArray(users.id, hostIds)) : [];
      const byId = new Map(hosts.map((h) => [h.id, hostSummary(h)]));
      const rooms = list.map((r) => ({ ...publicRoom(r), host: byId.get(r.hostId) ?? null, memberCount: roomHub.count(r.id) }));
      rooms.sort((a, b) => (a.status === b.status && a.status === "live" ? b.memberCount - a.memberCount : 0)); // busiest live rooms first (stable otherwise)
      res.json({ rooms });
    } catch (e) {
      console.error("[rooms] list failed:", e);
      res.status(500).json({ message: "Failed to load rooms" });
    }
  });

  // ------------------------------------------------------------ get
  app.get("/api/rooms/:id", requireAuth, async (req, res) => {
    try {
      const room = await rs.getRoom(req.params.id);
      const token = typeof req.query.token === "string" ? req.query.token : undefined;
      if (!room || !(await canViewRoom(room, req.user!.id, token))) return res.status(404).json({ message: "Room not found" });
      const [viewer, host, member] = await Promise.all([storage.getUser(req.user!.id), storage.getUser(room.hostId), rs.getMember(room.id, req.user!.id)]);
      const gate = canJoinRoom({ age: ageFromDob(viewer?.dateOfBirth) }, room as any);
      const canJoin = member?.banned ? { ok: false, code: "BANNED" } : gate;
      res.json({
        room: publicRoom(room), host: host ? hostSummary(host) : null, canJoin, memberCount: roomHub.count(room.id),
        you: isHost(room, req.user!.id) ? { role: "host" } : member && !member.banned ? { role: member.role } : null,
      });
    } catch (e) {
      console.error("[rooms] get failed:", e);
      res.status(500).json({ message: "Failed to load room" });
    }
  });

  // ------------------------------------------------------------ patch
  app.patch("/api/rooms/:id", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { room, host } = ctx;
      if (room.status === "ended") return res.status(409).json({ message: "This room has ended.", code: "ROOM_ENDED" });

      const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const merged = {
        title: "title" in b ? b.title : room.title,
        description: "description" in b ? b.description : room.description ?? undefined,
        kind: room.kind, visibility: room.visibility,
        ageLimit: "ageLimit" in b ? b.ageLimit : room.ageLimit,
        capacity: "capacity" in b ? b.capacity : room.capacity,
        noDirectInteractions: "noDirectInteractions" in b ? b.noDirectInteractions : room.noDirectInteractions,
        screenUrl: "screenUrl" in b ? b.screenUrl : undefined,
      };
      const v = validateRoomInput(merged);
      if (!v.ok) return res.status(400).json({ message: `Invalid ${v.field}`, field: v.field });

      const patch: rs.RoomPatch = {};
      if ("title" in b) patch.title = plainText(v.value.title);
      if ("description" in b) patch.description = v.value.description ? plainText(v.value.description) : null;
      if ("capacity" in b) patch.capacity = v.value.capacity;
      if ("noDirectInteractions" in b) patch.noDirectInteractions = v.value.noDirectInteractions;
      if ("ageLimit" in b) {
        if (room.status === "live" && minAgeForLimit(v.value.ageLimit) < minAgeForLimit(room.ageLimit as any)) {
          return res.status(400).json({ message: "You can't lower the age limit while the room is live.", field: "ageLimit" });
        }
        const hc = await hostCheck(host, { visibility: room.visibility, ageLimit: v.value.ageLimit });
        if (!hc.ok && (hc.code === "HOST_BELOW_LIMIT" || hc.code === "AGE_UNKNOWN")) {
          return res.status(403).json({ message: HOST_MESSAGES[hc.code], code: hc.code });
        }
        patch.ageLimit = v.value.ageLimit;
      }
      if ("screenUrl" in b) {
        if (b.screenUrl === null || b.screenUrl === "") patch.screen = null;
        else {
          const r = resolveScreen(String(b.screenUrl));
          if (!r.ok) return res.status(400).json({ message: "That screen link can't be used.", field: "screenUrl", reason: r.reason });
          patch.screen = r.screen;
        }
      }
      const updated = Object.keys(patch).length ? await rs.updateRoom(room.id, patch) : room;
      if ("screen" in patch && updated.status === "live") notifyScreen(room.id, patch.screen ?? null, updated.screenVersion);
      if (patch.ageLimit && updated.status === "live") await enforceAgeLimit(room.id); // raised: send out anyone now under it
      res.json({ room: { ...publicRoom(updated), host: hostSummary(host) } });
    } catch (e) {
      console.error("[rooms] patch failed:", e);
      res.status(500).json({ message: "Failed to update room" });
    }
  });

  // ------------------------------------------------------------ start / end
  app.post("/api/rooms/:id/start", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { room, host } = ctx;
      if (room.status !== "scheduled") return res.status(409).json({ message: room.status === "live" ? "This room is already live." : "This room has ended.", code: "BAD_STATE" });
      if ((await rs.countLiveRoomsByHost(host.id)) >= MAX_LIVE) {
        return res.status(429).json({ message: "You already have a live room. End it before starting another.", code: "LIVE_LIMIT" });
      }
      const live = await rs.setStatus(room.id, "live");
      await rs.upsertMember(room.id, host.id, "host");
      expectHost(room.id); // the host has the grace period to connect to the room, or it ends
      await notifyFollowers(live, host).catch((e) => console.error("[rooms] notify failed:", e));
      res.json({ room: { ...publicRoom(live), host: hostSummary(host) } });
    } catch (e) {
      console.error("[rooms] start failed:", e);
      res.status(500).json({ message: "Failed to start room" });
    }
  });

  app.post("/api/rooms/:id/end", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      if (ctx.room.status === "ended") return res.status(409).json({ message: "This room has already ended.", code: "BAD_STATE" });
      await endRoom(ctx.room.id); // sets status, tells everyone in the room, clears presence and timers
      const ended = (await rs.getRoom(ctx.room.id))!;
      res.json({ room: { ...publicRoom(ended), host: hostSummary(ctx.host) } });
    } catch (e) {
      console.error("[rooms] end failed:", e);
      res.status(500).json({ message: "Failed to end room" });
    }
  });

  app.post("/api/rooms/:id/invite-token", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      if (ctx.room.visibility !== "invite" || ctx.room.status === "ended") return res.status(409).json({ message: "Not an active invite-only room.", code: "BAD_STATE" });
      const inviteToken = newInviteToken();
      await rs.updateRoom(ctx.room.id, { inviteTokenHash: sha256(inviteToken) });
      res.json({ inviteLink: `/rooms/${ctx.room.id}?token=${inviteToken}` });
    } catch (e) {
      console.error("[rooms] invite-token failed:", e);
      res.status(500).json({ message: "Failed to create invite link" });
    }
  });

  // ------------------------------------------------------------ what can I do to this person (slide-out)
  // Booleans only: the client learns what to offer, never the reason (ages, blocks and privacy stay private).
  const inviteBuckets = new Map<string, TokenBucket>();
  async function liveRoomOf(hostId: string) {
    const mine = await rs.listRooms({ scope: "live", viewerId: hostId, limit: 100 });
    return mine.find((r) => r.hostId === hostId && r.visibility !== "invite") ?? null;
  }

  app.get("/api/rooms/:id/members/:userId/actions", requireAuth, async (req, res) => {
    try {
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id))) return res.status(404).json({ message: "Room not found" });
      const targetId = req.params.userId;
      const none = { actions: { interact: false, dm: false, invite: false } };
      if (targetId === req.user!.id || (targetId !== room.hostId && !roomHub.get(room.id, targetId))) return res.json(none);
      const v = await interactionVerdict(room, req.user!.id, targetId);
      // Messages across age groups are a separate, consent-based rule (both people must have allowed it), not the room rule.
      const gap = await ageGapBetween(req.user!.id, targetId);
      const crossAgeDm = !v.ok && gap.gap && gap.blockedBy === null && !room.noDirectInteractions && !(await isBlockedEitherWay(req.user!.id, targetId));
      if (!v.ok && !crossAgeDm) return res.json(none);
      if (!v.ok) return res.json({ actions: { interact: false, dm: true, invite: false } });
      const target = v.target;
      const mine = await liveRoomOf(req.user!.id);
      const invite = !!mine && mine.id !== room.id && resolveRoomPrivacy(target.roomPrivacy).allowInvites
        && canJoinRoom({ age: ageFromDob(target.dateOfBirth) }, mine as any).ok;
      res.json({ actions: { interact: true, dm: true, invite } });
    } catch (e) {
      console.error("[rooms] actions failed:", e);
      res.status(500).json({ message: "Failed to load actions" });
    }
  });

  // Invite someone to the live room you host (public or friends rooms; invite-only rooms share their link instead).
  app.post("/api/rooms/:id/invite/:userId", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { room, host } = ctx;
      const targetId = req.params.userId;
      if (room.status !== "live" || room.visibility === "invite") return res.status(409).json({ message: "You can invite people to a live public or friends room.", code: "BAD_STATE" });
      const refuse = () => res.status(403).json({ message: "You can't invite this person.", code: "NOT_ALLOWED" });
      if (targetId === host.id) return refuse();
      const v = await interactionVerdict({ noDirectInteractions: false }, host.id, targetId);
      if (!v.ok || !resolveRoomPrivacy(v.target.roomPrivacy).allowInvites) return refuse();
      if (!canJoinRoom({ age: ageFromDob(v.target.dateOfBirth) }, room as any).ok) return refuse();
      if (room.visibility === "friends" && !(await mutualFollow(host.id, targetId))) return refuse();
      const key = `${host.id}:${targetId}`;
      let b = inviteBuckets.get(key);
      if (!b) { b = new TokenBucket(1 / 60, 1); inviteBuckets.set(key, b); }
      if (!b.take()) return res.status(429).json({ message: "You just invited them.", code: "RATE_LIMITED" });
      await deliverNotification({
        userId: targetId, type: "room_live", title: `${host.displayName || host.organizationName || host.username} invited you`,
        message: room.title, link: `/rooms/${room.id}`, relatedUserId: host.id, relatedEntityId: room.id,
      });
      res.json({ ok: true });
    } catch (e) {
      console.error("[rooms] invite failed:", e);
      res.status(500).json({ message: "Failed to send invite" });
    }
  });

  // ------------------------------------------------------------ moderation that must survive reconnects
  type ModRole = "host" | "cohost";
  // Room visible to the caller and the caller is its host or a (non-banned) co-host; answers 404/403 itself otherwise.
  async function loadModRoom(req: Request, res: Response): Promise<{ room: Room; role: ModRole } | null> {
    const room = await rs.getRoom(req.params.id);
    if (!room || !(await canViewRoom(room, req.user!.id))) { res.status(404).json({ message: "Room not found" }); return null; }
    const uid = req.user!.id;
    if (room.hostId === uid) return { room, role: "host" };
    const m = await rs.getMember(room.id, uid);
    if (m && !m.banned && m.role === "cohost") return { room, role: "cohost" };
    res.status(403).json({ message: "Only the host or a co-host can do that." });
    return null;
  }
  const roleOf = async (room: Room, userId: string): Promise<"host" | "cohost" | "guest"> =>
    userId === room.hostId ? "host" : roomHub.get(room.id, userId)?.role ?? (await rs.getMember(room.id, userId))?.role as any ?? "guest";

  // Shared by ban/unban: false (response already sent) when the target is not allowed to be acted on.
  async function modTarget(req: Request, res: Response, ctx: { room: Room; role: ModRole }): Promise<string | null> {
    const targetId = req.params.userId;
    if (!(await storage.getUser(targetId))) { res.status(404).json({ message: "User not found" }); return null; }
    const tr = await roleOf(ctx.room, targetId);
    if (targetId === req.user!.id || tr === "host" || (ctx.role === "cohost" && tr === "cohost")) {
      res.status(403).json({ message: "You can't do that to this person." });
      return null;
    }
    return targetId;
  }

  app.post("/api/rooms/:id/members/:userId/ban", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadModRoom(req, res);
      if (!ctx) return;
      const targetId = await modTarget(req, res, ctx);
      if (!targetId) return;
      await applyMod(ctx.room.id, "ban", targetId); // persists, and removes them from the live room if they are in it
      res.json({ ok: true });
    } catch (e) {
      console.error("[rooms] ban failed:", e);
      res.status(500).json({ message: "Failed to ban" });
    }
  });

  app.post("/api/rooms/:id/members/:userId/unban", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadModRoom(req, res);
      if (!ctx) return;
      const targetId = await modTarget(req, res, ctx);
      if (!targetId) return;
      await rs.setMemberFlag(ctx.room.id, targetId, { banned: false });
      res.json({ ok: true });
    } catch (e) {
      console.error("[rooms] unban failed:", e);
      res.status(500).json({ message: "Failed to unban" });
    }
  });

  app.put("/api/rooms/:id/members/:userId/role", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadModRoom(req, res);
      if (!ctx) return;
      if (ctx.role !== "host") return res.status(403).json({ message: "Only the host can change roles." });
      const role = req.body?.role;
      if (role !== "cohost" && role !== "guest") return res.status(400).json({ message: "Invalid role", field: "role" });
      const targetId = req.params.userId;
      if (targetId === ctx.room.hostId) return res.status(400).json({ message: "The host's role can't be changed.", field: "role" });
      const m = await rs.getMember(ctx.room.id, targetId);
      if (!m || m.banned) return res.status(404).json({ message: "That person hasn't joined this room." });
      await rs.setMemberRole(ctx.room.id, targetId, role);
      const live = roomHub.get(ctx.room.id, targetId);
      if (live) live.role = role;
      await afterRoleChange(ctx.room.id, targetId); // a co-host is an implicit speaker, a guest only speaks from the stage: LiveKit follows at once
      roomHub.broadcast(ctx.room.id, { type: "room:mod", action: "role", targetId, role });
      res.json({ ok: true, role });
    } catch (e) {
      console.error("[rooms] role failed:", e);
      res.status(500).json({ message: "Failed to change role" });
    }
  });

  // ------------------------------------------------------------ voice (LiveKit)
  // The host switches voice on for a live room; everyone in the room then asks for a token. Who may speak is decided here
  // (host, co-hosts, guests on stage): LiveKit only enforces what the token and permission updates say.
  app.put("/api/rooms/:id/voice", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false", field: "enabled" });
      if (ctx.room.status !== "live") return res.status(409).json({ message: "Voice is for live rooms.", code: "ROOM_NOT_LIVE" });
      if (enabled && !getVoiceService()) return res.status(503).json({ message: "Voice isn't available right now.", code: "VOICE_UNAVAILABLE" });
      const room = await rs.setVoiceEnabled(ctx.room.id, enabled);
      roomHub.setVoiceOn(room.id, enabled);
      if (!enabled) await shutdownVoice(room.id);
      roomHub.broadcast(room.id, { type: "room:voice", enabled });
      res.json({ room: { ...publicRoom(room), host: hostSummary(ctx.host) } });
    } catch (e) {
      console.error("[rooms] voice switch failed:", e);
      res.status(500).json({ message: "Failed to change voice" });
    }
  });

  app.post("/api/rooms/:id/voice-token", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
        return res.status(404).json({ message: "Room not found" });
      }
      const voice = getVoiceService();
      if (!voice) return res.status(503).json({ message: "Voice isn't available right now.", code: "VOICE_UNAVAILABLE" });
      if (room.status !== "live") return res.status(409).json({ message: "This room isn't live.", code: "ROOM_NOT_LIVE" });
      if (!room.voiceEnabled) return res.status(409).json({ message: "The host hasn't turned voice on.", code: "VOICE_OFF" });
      const member = await rs.getMember(room.id, req.user!.id);
      if (member?.banned) return res.status(403).json({ message: "You can't join this room.", code: "BANNED" });
      const present = roomHub.get(room.id, req.user!.id);
      if (!present) return res.status(403).json({ message: "Join the room first.", code: "NOT_IN_ROOM" });
      const user = await storage.getUser(req.user!.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const canPublish = canPublishNow(room.id, user.id);
      present.publish = canPublish;
      const token = await voice.mintToken({ roomId: room.id, userId: user.id, displayName: user.displayName || user.organizationName || user.username, canPublish });
      res.json({ url: voice.url, token, canPublish, expiresInSec: 60 });
    } catch (e) {
      console.error("[rooms] voice token failed:", e);
      res.status(500).json({ message: "Failed to join voice" });
    }
  });

  // ------------------------------------------------------------ report
  // The last 50 chat lines live only in memory; a report is the one thing that makes them durable (as text on the report).
  function chatExcerpt(roomId: string): string {
    const lines = roomHub.recentChat(roomId).map((l) => {
      const who = (roomHub.get(roomId, l.userId)?.info?.username as string | undefined) ?? l.userId.slice(0, 8);
      return `${new Date(l.at).toISOString().slice(11, 19)} ${who}: ${l.text}`;
    });
    return lines.length ? `\n\n--- last chat lines ---\n${lines.join("\n")}`.slice(0, 8000) : "";
  }

  app.post("/api/rooms/:id/report", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
        return res.status(404).json({ message: "Room not found" });
      }
      const parsed = z.object({
        reason: z.string().trim().min(1).max(100),
        description: z.string().max(1000).optional(),
        type: z.enum(["room", "room_message", "room_user"]).default("room"),
        targetUserId: z.string().max(64).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid report", field: parsed.error.errors[0]?.path[0] ?? "reason" });
      const { reason, description, type, targetUserId } = parsed.data;

      let contentId = room.id;
      if (type !== "room") {
        if (!targetUserId) return res.status(400).json({ message: "Who are you reporting?", field: "targetUserId" });
        const inRoom = targetUserId === room.hostId || !!roomHub.get(room.id, targetUserId) || !!(await rs.getMember(room.id, targetUserId));
        if (!inRoom) return res.status(400).json({ message: "That person isn't in this room.", field: "targetUserId" });
        contentId = `${room.id}:${targetUserId}`;
      }
      await storage.createContentReport({
        reporterId: req.user!.id, contentType: type, contentId, reason,
        description: `${description ? plainText(description) : ""}${chatExcerpt(room.id)}`.trim() || undefined,
      });
      res.json({ message: "Report submitted" });
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ message: "You've already reported this" });
      console.error("[rooms] report failed:", e);
      res.status(500).json({ message: "Failed to submit report" });
    }
  });

  // ------------------------------------------------------------ privacy (per user)
  app.get("/api/users/me/room-privacy", requireAuth, async (req, res) => {
    try {
      const u = await storage.getUser(req.user!.id);
      if (!u) return res.status(404).json({ message: "User not found" });
      // `age` is the caller's own (null when no birthdate): the create-room form needs it to grey out options they can't use.
      res.json({ roomPrivacy: resolveRoomPrivacy(u.roomPrivacy), age: ageFromDob(u.dateOfBirth) });
    } catch (e) {
      console.error("[rooms] room-privacy read failed:", e);
      res.status(500).json({ message: "Failed to load room privacy" });
    }
  });

  app.put("/api/users/me/room-privacy", requireAuth, roomLimiter, async (req, res) => {
    try {
      const v = validateRoomPrivacy(req.body);
      if (!v.ok) return res.status(400).json({ message: "Invalid room privacy", field: v.field });
      const updated = await storage.updateUser(req.user!.id, { roomPrivacy: v.value } as any);
      // Respond only after req.login's session regeneration finishes (see Passport 0.6+ note in users-routes).
      req.login(userToSessionUser(updated), (err) => {
        if (err) {
          console.error("Session refresh error after room privacy update:", err);
          return res.status(500).json({ message: "Saved, but refreshing your session failed. Please reload." });
        }
        res.json({ ...toPublicUser(updated), ...userToSessionUser(updated), roomPrivacy: v.value });
      });
    } catch (e) {
      console.error("[rooms] privacy failed:", e);
      res.status(500).json({ message: "Failed to save room privacy" });
    }
  });
}
