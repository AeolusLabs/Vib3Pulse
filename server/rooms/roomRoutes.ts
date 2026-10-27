// REST for virtual rooms. Live presence/chat is on the WebSocket (roomSocket.ts); everything that must survive
// reconnects (create, schedule, start/end, bans, reports, privacy) is here and persisted.
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { storage, db, pool } from "../storage";
import { buyerRefundKobo } from "@shared/roomRefunds";
import { requireAuth } from "../middleware";
import { roomLimiter } from "../security";
import { toPublicUser, userToSessionUser } from "../auth";
import { blockedWith, isBlockedEitherWay, profileBlocked } from "../utils/blocks";
import { ageGapBetween } from "../utils/ageGate";
import { deliverNotification } from "../notifications";
import { getConfig } from "../services/moderationConfig";
import { events, follows, users, venues, type Room, type User } from "@shared/schema";
import { ageFromDob, minAgeForLimit } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { ROOM_LIMITS, SPRAY_ENABLE_MESSAGES, resolveRoomDefaults, resolveRoomPrivacy, validateRoomDefaults, validateRoomInput, validateRoomPrivacy } from "@shared/rooms";
import { canEnableSpray, canHostRoom, canJoinRoom, canSellTickets, isMinorsRoomHost, isTicketedRoom, roomCapacity, ticketEligible, type TicketSaleCode } from "@shared/roomRules";
import { isIdVerifiedAdult } from "@shared/ageVerification";
import * as rs from "./roomStorage";
import { canViewRoom, hostRoom, hostSummary, mutualFollow, pinnedPlainText, plainText, publicRoom, sha256, viewerRoom, viewRoom } from "./roomAccess";
import { countPaidTickets, hasPaidTicket, hostCanSellNow, TicketGuardError, updateRoomWithTicketGuard } from "./ticketStorage";
import { hostPayoutReady } from "./payouts";
import { startLiveNotice } from "./liveNotify";
import { registerRoomPayoutRoutes } from "./payoutRoutes";
import { registerRoomEarningsRoutes } from "./earningsRoutes";
import { isSellablePrice } from "@shared/roomTickets";
import * as mr from "./minorsRoom";
import { TokenBucket } from "./rateLimit";
import { getVoiceService } from "./voice/voiceService";
import { afterRoleChange, canCameraNow, canPublishNow, isGamePlayer, publishSourcesNow, shutdownVoice, stopAllLive } from "./stage";
import { laneParentBlocked, sprayToggleCooldown } from "./sprayState";
import { applyMod, endRoom, enforceAgeLimit, enforceTicketFor, expectHost, interactionVerdict, isKicked, notifyScreen, removeFromMinorsRoom, writeRoomSettings } from "./roomSocket";
import { roomHub } from "./RoomHub";
import { GAME_PARTS, roomFeatures } from "./features";
import { sprayAllowed, ticketSalesAllowed } from "./roomControls";
import { getRates } from "./roomRates";
import { clearReminder, hasReminder, setReminder } from "./reminders";
import { registerRoomTicketRoutes } from "./ticketRoutes";
import { registerRoomMoneyRoutes } from "./ticketMoneyRoutes";
import { registerSprayRoutes } from "./sprayRoutes";
import { sprayBlockFor } from "./spray";
import { registerRoomRecapRoutes } from "./recap";
import { validateGameInput, type DropTimeoutMs, type GameFormat } from "@shared/gameScreen";
import { applyGameRoom, gameFitCheck } from "./game";
import * as lanes from "./gameLanes";
import { ingestAvailable, ingressFor, revokePlayerIngress } from "./gameIngress";

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

/** Who is in a live room, for the cards and the lobby: role plus the same public profile bits the scene shows. Never an age. */
const peekOf = (roomId: string, n: number) =>
  roomHub.members(roomId, n).map((m) => ({ userId: m.userId, role: m.role, ...m.info }));

const newInviteToken = () => crypto.randomBytes(24).toString("hex");
const isTeen = (age: number | null) => age !== null && age < 18;
/** A minors' room whose host is 18 or over now: they may finish a live room, but never start one or bring in adults. */
const HOST_NOT_MINOR = { code: "HOST_NOT_MINOR" } as const;

/** Gaming: why someone has no lane in a game room (status, body). The other lane is never mentioned. */
function laneRefusal(code: "NO_AGE" | "TOO_YOUNG" | "NO_LANE"): [number, Record<string, unknown>] {
  if (code === "NO_AGE") return [403, { code: "AGE_UNKNOWN", message: "Add your date of birth in your profile to join rooms.", canJoin: { ok: false, code: "AGE_UNKNOWN" } }];
  if (code === "TOO_YOUNG") return [403, { code: "AGE_LIMIT", message: "You can't join this room.", canJoin: { ok: false, code: "AGE_LIMIT" } }];
  return [404, { code: "NO_LANE", message: "There's no room for your age group here yet." }];
}

/** Gaming: a game room needs live video, which only works up to ROOM_LIMITS.liveVideoMax people. */
const NEEDS_LIVE_VIDEO = { message: "A game room needs live video, which works in rooms of up to 50 people.", field: "gameFormat", reason: "needs_live_video" } as const;
const videoSized = (r: { capacity: number; ticketPriceKobo?: number | null; ticketCapacity?: number | null }) => roomCapacity(r) <= ROOM_LIMITS.liveVideoMax;
const badGameField = (field: string) => ({ message: `Invalid ${field}`, field, reason: "invalid" });

/**
 * What the gaming client may offer. ingest: LIVEKIT_INGRESS is on and the voice service can create an ingress (OBS); teamSpray:
 * spraying is allowed now and team spray is built; lanes: age lanes are built.
 */
async function gameCapabilities(): Promise<{ ingest: boolean; teamSpray: boolean; lanes: boolean }> {
  const svc = getVoiceService();
  return {
    ingest: !!svc && ingestAvailable(),
    teamSpray: GAME_PARTS.teamSpray && (await sprayAllowed()),
    lanes: GAME_PARTS.lanes,
  };
}

export function isHost(room: Room, userId: string) {
  return room.hostId === userId;
}

// Paid rooms: why this host may not sell tickets (403, with the code). Plain words, no prices.
const TICKET_SALE_MESSAGES: Record<TicketSaleCode, string> = {
  FEATURE_OFF: "Paid rooms aren't available yet.",
  HOST_NOT_ADULT: "You need to be 18 or over to sell tickets.",
  HOST_NOT_VERIFIED: "Verify your ID to sell tickets.",
  NO_PAYOUT_ACCOUNT: "Add a bank account on the Payout account page (/rooms/payouts) to sell tickets.",
  ROOM_NOT_ADULT: "Tickets can only be sold for 18+ or 21+ rooms.",
};
const TICKET_GUARD_MESSAGES = {
  TICKETS_SOLD: "Tickets have been sold for this room, so this can't be changed now.",
  CAPACITY_BELOW_SOLD: "You can't set the number of tickets below the number already sold.",
  NOT_SCHEDULED: "You can only start selling tickets before the room starts.",
} as const;

/**
 * May this host sell tickets for a room like this? The switch first (no lookups while paid rooms are off), then the host's
 * age, ID check (isIdVerifiedAdult) and a verified Paystack payout account from organizer_payment_accounts.
 */
async function sellCheck(host: User, room: { ageLimit: string; minorsRoom: boolean }) {
  const hasPayoutAccount = roomFeatures.paidRooms ? await hostPayoutReady(host.id) : false;
  return canSellTickets({ age: ageFromDob(host.dateOfBirth), idVerified: isIdVerifiedAdult(host), hasPayoutAccount }, room, roomFeatures);
}

/** May this host turn spray on? Checked before any ticket rule. The payout lookup only happens while the spray switch is on. */
async function sprayCheck(host: User, room: { ageLimit: string; minorsRoom: boolean }) {
  const hasPayoutAccount = roomFeatures.spray ? await hostPayoutReady(host.id) : false;
  return canEnableSpray({ age: ageFromDob(host.dateOfBirth), idVerified: isIdVerifiedAdult(host), hasPayoutAccount }, room, roomFeatures);
}

/** The ticket block of GET /api/rooms/:id (eligible viewers only). Counts and the refund promise only for a ticketed room. */
type TicketBlock = {
  required: boolean; priceKobo: number; held: boolean; soldOut: boolean;
  refundBeforeStart?: boolean; capacity?: number; left?: number; refundKobo?: number;
};

/** For the host of a ticketed room only: are sales paused, and why. Never sent to anyone else. */
async function hostTicketSales(room: Room): Promise<{ paused: boolean; code: "PRICE_INVALID" | "HOST_CANNOT_SELL" | null }> {
  if (!isSellablePrice(room.ticketPriceKobo)) return { paused: true, code: "PRICE_INVALID" };
  if (!(await hostCanSellNow(room.hostId))) return { paused: true, code: "HOST_CANNOT_SELL" };
  return { paused: false, code: null };
}

async function hostCheck(host: User, input: { visibility: Room["visibility"]; ageLimit: Room["ageLimit"] }) {
  return canHostRoom(
    { age: ageFromDob(host.dateOfBirth), accountAgeDays: (Date.now() - new Date(host.createdAt).getTime()) / DAY_MS },
    input as any,
    { minAccountAgeDays: await getConfig("min_account_age_days") },
  );
}

/**
 * The caller's own account age in whole days, and the admin-set minimum for hosting a public room (the same setting
 * hostCheck uses for ACCOUNT_TOO_NEW), so the wizard can explain it before the first refusal. Not sensitive.
 */
/** The two ticket rates a host screen needs for its earnings estimate (percent). */
async function ticketRatesForClients(): Promise<{ ticketPlatformPct: number; ticketReservePct: number }> {
  const r = await getRates();
  return { ticketPlatformPct: r.ticket_platform, ticketReservePct: r.ticket_reserve };
}

async function hostMoneyReadiness(userId: string): Promise<{ adult: boolean; idVerified: boolean; payoutAccount: boolean }> {
  const u = await storage.getUser(userId);
  if (!u) return { adult: false, idVerified: false, payoutAccount: false };
  const age = ageFromDob(u.dateOfBirth);
  return { adult: age !== null && age >= 18, idVerified: isIdVerifiedAdult(u), payoutAccount: await hostPayoutReady(userId) };
}

async function hostingInfo(userId: string): Promise<{ accountAgeDays: number; minAccountAgeDays: number }> {
  const [u, minAccountAgeDays] = await Promise.all([storage.getUser(userId), getConfig("min_account_age_days")]);
  const created = u?.createdAt ? new Date(u.createdAt).getTime() : NaN;
  const accountAgeDays = Number.isNaN(created) ? 0 : Math.max(0, Math.floor((Date.now() - created) / DAY_MS));
  return { accountAgeDays, minAccountAgeDays: Number(minAccountAgeDays) || 0 };
}

/**
 * The "is live" notice to the host's followers (fix round, owner decision: ALL eligible followers, chunked, in the
 * background; the rules are in liveNotify.ts). Never when the host turned "Tell my followers" off. Never throws.
 */
function notifyFollowers(room: Room, host: User): void {
  startLiveNotice(room, host);
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
  // Phase 6 money reads FIRST: /api/rooms/payouts/* must never be taken by a /api/rooms/:id route.
  registerRoomPayoutRoutes(app); // payout account: status, banks, account (task 6.1)
  registerRoomEarningsRoutes(app); // earnings, payments, receipts (tasks 6.2, 6.3)
  registerRoomTicketRoutes(app); // paid room tickets: checkout + verify (phase 4, task 4.3)
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

      // Gaming (ROOMS_GAMING): the game fields are read only while the flag is on; otherwise they are ignored like any unknown key.
      let game: { gameFormat?: GameFormat | null; gameDropTimeoutMs?: DropTimeoutMs } = {};
      if (roomFeatures.gaming) {
        const g = validateGameInput(req.body ?? {});
        if (!g.ok) return res.status(400).json(badGameField(g.field));
        game = g.value;
        // The room is created before it is live, so voice and live video cannot be on yet: what is checked here is that live
        // video will be possible (size; only a ticketed room's ticket capacity can exceed ROOM_LIMITS.liveVideoMax). The game itself only runs while voice and live video are on (game.ts gameLive).
        if (typeof game.gameFormat === "number" && !videoSized(v.value)) return res.status(400).json(NEEDS_LIVE_VIDEO);
        if (req.body?.lanes !== undefined && typeof req.body.lanes !== "boolean") return res.status(400).json(badGameField("lanes"));
        if (req.body?.lanes === true && typeof game.gameFormat !== "number") return res.status(400).json({ message: "Age lanes are for game rooms.", field: "lanes", reason: "needs_game" });
      }
      const withLanes = roomFeatures.gaming && req.body?.lanes === true;
      const hc = await hostCheck(host, v.value);
      if (!hc.ok) return res.status(403).json({ message: HOST_MESSAGES[hc.code], code: hc.code });
      // Paid room: only an adult, ID-verified host with a payout account, only with paid rooms switched on.
      const minorsRoom = isMinorsRoomHost(ageFromDob(host.dateOfBirth));
      if (v.value.sprayEnabled === true) {
        const spray = await sprayCheck(host, { ageLimit: v.value.ageLimit, minorsRoom });
        if (!spray.ok) return res.status(403).json({ message: SPRAY_ENABLE_MESSAGES[spray.code], code: spray.code });
      }
      if (typeof v.value.ticketPriceKobo === "number") {
        const sell = await sellCheck(host, { ageLimit: v.value.ageLimit, minorsRoom });
        if (!sell.ok) return res.status(403).json({ message: TICKET_SALE_MESSAGES[sell.code], code: sell.code });
      }

      let screen = null;
      if (v.value.screenUrl && !roomFeatures.linkScreens) return res.status(400).json({ message: "Link screens are switched off for now.", field: "screenUrl", reason: "disabled" });
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
      const createInput: rs.CreateRoomInput = {
        ...v.value,
        title: plainText(v.value.title),
        description: v.value.description ? plainText(v.value.description) : undefined,
        pinnedMessage: pinnedPlainText(v.value.pinnedMessage), // plain text, cut to 200 after the tags are gone
        screen,
        inviteTokenHash: inviteToken ? sha256(inviteToken) : undefined,
        // Decided here from the host's age today, never from the request body; never changes afterwards.
        minorsRoom,
        ...game,
      };
      if (withLanes) {
        // Gaming: the game room (it only routes) and the creator's own age lane, in one transaction (gameLanes.ts).
        try {
          const made = await lanes.createGameRoomWithLane(host, createInput);
          return res.status(201).json({
            room: { ...hostRoom(made.parent), host: hostSummary(host) }, lane: { ...hostRoom(made.lane), host: hostSummary(host) },
            ...(inviteToken ? { inviteLink: `/rooms/${made.parent.id}?token=${inviteToken}` } : {}),
          });
        } catch (e) {
          if (e instanceof lanes.LaneError) return res.status(e.status).json(e.body);
          throw e;
        }
      }
      const room = await rs.createRoom(host.id, createInput);
      // Not named "inviteToken": the global response redaction strips that key from every body on purpose.
      res.status(201).json({ room: { ...hostRoom(room), host: hostSummary(host) }, ...(inviteToken ? { inviteLink: `/rooms/${room.id}?token=${inviteToken}` } : {}) });
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
      const [hosts, viewer] = await Promise.all([
        hostIds.length ? db.select().from(users).where(inArray(users.id, hostIds)) : Promise.resolve([] as User[]),
        storage.getUser(req.user!.id),
      ]);
      const byId = new Map(hosts.map((h) => [h.id, hostSummary(h)]));
      // A ticket price (priceMinor, kobo) only for a ticketed room and a viewer who may buy it (ID-verified adult, room
      // 18+/21+ and not a minors' room, viewer meets its age limit). Everyone else gets no priceMinor key at all.
      const priceFor = (r: Room) => (viewer && isTicketedRoom(r) && ticketEligible(viewer, r) ? { priceMinor: r.ticketPriceKobo } : {});
      // Gaming: a game room with age lanes shows the viewer's own lane only (its count and its people); never the other lane.
      const laneOf = roomFeatures.gaming ? await viewerLanes(list, viewer) : new Map<string, string | null>();
      const shown = (r: Room) => (laneOf.has(r.id) ? laneOf.get(r.id) ?? null : r.id);
      const rooms = list.map((r) => {
        const id = shown(r);
        return { ...publicRoom(r), ...priceFor(r), host: byId.get(r.hostId) ?? null, memberCount: id ? roomHub.count(id) : 0, peek: id ? peekOf(id, 5) : [] };
      });
      rooms.sort((a, b) => (a.status === b.status && a.status === "live" ? b.memberCount - a.memberCount : 0)); // busiest live rooms first (stable otherwise)
      res.json({ rooms });
    } catch (e) {
      console.error("[rooms] list failed:", e);
      res.status(500).json({ message: "Failed to load rooms" });
    }
  });

  /** For the rooms list: each listed game room with lanes -> the id of the viewer's lane in it (null = none for their age). */
  async function viewerLanes(list: Room[], viewer: User | undefined): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const byParent = await lanes.openLanesOf(list.filter((r) => r.gameFormat !== null && !r.parentRoomId).map((r) => r.id));
    const lane = lanes.laneForAge(ageFromDob(viewer?.dateOfBirth));
    byParent.forEach((children, parentId) => out.set(parentId, children.find((c) => c.ageLane === lane)?.id ?? null));
    return out;
  }

  // ------------------------------------------------------------ config (must stay above /api/rooms/:id)
  // Public switches and limits for any signed-in user, plus the caller's own hosting numbers (host). Only these fields:
  // never secrets or provider keys.
  app.get("/api/rooms/config", requireAuth, async (req, res) => {
    try {
      const paidRooms = await ticketSalesAllowed(), spray = await sprayAllowed();
      res.json({
        // `gaming` only appears while ROOMS_GAMING is on, so the flag-off body stays byte-identical.
        features: { paidRooms, spray, ...(roomFeatures.gaming ? { gaming: true } : {}) },
        limits: ROOM_LIMITS,
        currency: "NGN",
        region: "NG",
        // Only the two ticket rates the host screens need for their earnings estimate; no spray rate and nothing else.
        rates: await ticketRatesForClients(),
        host: await hostingInfo(req.user!.id),
        // The caller's own readiness to take money (paid rooms and spray), absent while both switches are off.
        ...(roomFeatures.paidRooms || roomFeatures.spray ? { hostMoneyReadiness: await hostMoneyReadiness(req.user!.id) } : {}),
        // Gaming capabilities, only while ROOMS_GAMING is on (absent otherwise, so the flag-off body is unchanged).
        ...(roomFeatures.gaming ? { game: await gameCapabilities() } : {}),
      });
    } catch (e) {
      console.error("[rooms] config failed:", e);
      res.status(500).json({ message: "Failed to load rooms settings" });
    }
  });

  // ------------------------------------------------------------ get
  app.get("/api/rooms/:id", requireAuth, async (req, res) => {
    try {
      let room = await rs.getRoom(req.params.id);
      const token = typeof req.query.token === "string" ? req.query.token : undefined;
      // Gaming: a game room with age lanes is never shown itself. A viewer who may see it is answered with their own lane
      // (by date of birth on file); the other lane is never named. Decided before anything about the room is revealed.
      let routed: { parentRoomId: string } | null = null;
      if (room && roomFeatures.gaming && (await lanes.isLaneParent(room.id))) {
        if (!(await canViewRoom(room, req.user!.id, token))) return res.status(404).json({ message: "Room not found" });
        const r = await lanes.resolveLaneRoom(room.id, req.user!.id);
        if ("refused" in r) { const [status, body] = laneRefusal(r.refused); return res.status(status).json(body); }
        routed = { parentRoomId: room.id };
        room = await rs.getRoom(r.roomId);
      } else if (room && roomFeatures.gaming && room.parentRoomId && !(await lanes.mayUseLane(room, req.user!.id))) {
        return res.status(404).json({ message: "Room not found" }); // the other lane, by its id: as if it did not exist
      }
      const view = room ? await viewRoom(room, req.user!.id, token) : ({ ok: false, code: "NOT_FOUND" } as const);
      if (!room || (!view.ok && view.code === "NOT_FOUND")) return res.status(404).json({ message: "Room not found" });
      // Minors' room, not let in: the reason and the warning only. No title, host, members or counts.
      if (!view.ok && view.code === "AGE_UNKNOWN") {
        return res.status(403).json({ code: "AGE_UNKNOWN", message: "Add your date of birth in your profile to join rooms.", canJoin: { ok: false, code: "AGE_UNKNOWN" } });
      }
      if (!view.ok) return res.status(403).json(mr.minorsDenialBody(view.code as "MINORS_ROOM" | "MINORS_ROOM_ACK", room));
      const [viewer, host, member] = await Promise.all([storage.getUser(req.user!.id), storage.getUser(room.hostId), rs.getMember(room.id, req.user!.id)]);
      const gate = canJoinRoom({ age: ageFromDob(viewer?.dateOfBirth) }, room as any);
      const canJoin = member?.banned ? { ok: false, code: "BANNED" } : gate;
      const self = isHost(room, req.user!.id);
      // Paid rooms: the ticket block exists ONLY for a viewer who may view the room (viewRoom passed above, so never someone
      // the minors' gate refused) AND may buy (ticketEligible: ID-verified adult, 18+/21+ room that is not a minors' room,
      // meets its age limit). Teens, unknown age and unverified people never get the key, so they never see a price.
      // required: this viewer needs a ticket to get in (host and co-hosts never do). soldOut: paid tickets reached capacity.
      // A viewer banned from the room gets no block at all (no price, no counts): they cannot buy or get in.
      // For a ticketed room the block also carries refundBeforeStart, capacity (the ticket capacity) and left
      // (max(0, capacity - paid tickets)); a free 18+/21+ room carries none of them (required false, priceKobo 0).
      let ticket: TicketBlock | null = null;
      if (viewer && !member?.banned && ticketEligible(viewer, room)) {
        const ticketed = isTicketedRoom(room);
        const exempt = self || (!!member && member.role === "cohost");
        if (ticketed) {
          const [held, sold] = await Promise.all([hasPaidTicket(room.id, req.user!.id), countPaidTickets(room.id)]);
          // What they would get back if they ask for a refund (exact, from their ticket): the price less the service charge and platform fee.
          const mine = held ? (await pool.query(`select amount_kobo, fee_kobo, platform_kobo from room_tickets where room_id = $1 and user_id = $2 and status = 'paid' limit 1`, [room.id, req.user!.id])).rows[0] as { amount_kobo: number; fee_kobo: number; platform_kobo: number } | undefined : undefined;
          const capacity = roomCapacity(room);
          ticket = {
            required: !exempt, priceKobo: room.ticketPriceKobo ?? 0, held, soldOut: sold >= capacity,
            refundBeforeStart: room.refundBeforeStart !== false, capacity, left: Math.max(0, capacity - sold),
            ...(mine ? { refundKobo: buyerRefundKobo({ amountKobo: Number(mine.amount_kobo), feeKobo: Number(mine.fee_kobo), platformKobo: Number(mine.platform_kobo) }) } : {}),
          };
        } else {
          ticket = { required: false, priceKobo: 0, held: false, soldOut: false };
        }
      }
      // The host of a ticketed room is told when sales are paused and why (a buyer only ever sees SALES_PAUSED at
      // checkout): a stored price outside the limits, or the host's ID verification / payout account is gone.
      const ticketSales = self && isTicketedRoom(room) ? await hostTicketSales(room) : null;
      // Spraying (phase 5): present ONLY for a viewer who passes payer eligibility in a live money room; never enabled: false.
      const spray = await sprayBlockFor(room, req.user!.id).catch((e) => { console.error("[rooms:spray] spray block failed:", e?.message ?? e); return null; });
      res.json({
        room: self ? hostRoom(room, roomFeatures.spray && await laneParentBlocked(room)) : viewerRoom(room), host: host ? hostSummary(host) : null, canJoin, memberCount: roomHub.count(room.id), peek: peekOf(room.id, 8),
        you: self ? { role: "host" } : member && !member.banned ? { role: member.role } : null,
        reminderSet: await hasReminder(routed?.parentRoomId ?? room.id, req.user!.id), // this viewer's own flag only (a game room's reminder is the game room's)
        ...(ticket ? { ticket } : {}),
        ...(ticketSales ? { ticketSales } : {}),
        ...(spray ? { spray } : {}),
        ...(routed ? { lane: { parentRoomId: routed.parentRoomId, roomId: room.id, ageLane: room.ageLane } } : {}),
      });
    } catch (e) {
      console.error("[rooms] get failed:", e);
      res.status(500).json({ message: "Failed to load room" });
    }
  });

  // ------------------------------------------------------------ reminder (self only)
  // Invisible rooms (including a minors' room an adult has no acknowledged invite to) answer 404 like a missing one.
  async function reminderRoom(req: Request, res: Response): Promise<Room | null> {
    const room = await rs.getRoom(req.params.id);
    if (!room || !(await canViewRoom(room, req.user!.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
      res.status(404).json({ message: "Room not found" }); return null;
    }
    return room;
  }
  app.put("/api/rooms/:id/reminder", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await reminderRoom(req, res);
      if (!room) return;
      if (room.status !== "scheduled") return res.status(409).json({ message: "This room is not waiting to start.", code: "BAD_STATE" });
      await setReminder(room.id, req.user!.id);
      res.json({ reminder: true });
    } catch (e) {
      console.error("[rooms] reminder set failed:", e);
      res.status(500).json({ message: "Failed to set the reminder" });
    }
  });
  app.delete("/api/rooms/:id/reminder", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await reminderRoom(req, res);
      if (!room) return;
      await clearReminder(room.id, req.user!.id);
      res.json({ reminder: false });
    } catch (e) {
      console.error("[rooms] reminder clear failed:", e);
      res.status(500).json({ message: "Failed to clear the reminder" });
    }
  });

  // ------------------------------------------------------------ patch
  app.patch("/api/rooms/:id", requireAuth, roomLimiter, async (req, res) => {
    try {
      const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const uid = req.user!.id;
      const found = await rs.getRoom(req.params.id);
      let ctx: { room: Room; host: User } | null;
      if (!found || found.hostId === uid) ctx = await loadHostRoom(req, res);
      else {
        // Not the host. A co-host may change the pinned message and nothing else; anyone else gets the old answer.
        if (!(await canViewRoom(found, uid, typeof req.query.token === "string" ? req.query.token : undefined))) return res.status(404).json({ message: "Room not found" });
        const m = await rs.getMember(found.id, uid);
        const keys = Object.keys(b);
        const onlyPinned = keys.length > 0 && keys.every((k) => k === "pinnedMessage");
        // A kick also resets the role to guest; the kick check covers a role write that failed or has not landed yet.
        if (!m || m.banned || m.role !== "cohost" || !onlyPinned || isKicked(found.id, uid)) return res.status(403).json({ message: "Only the host can do that." });
        const hostRow = await storage.getUser(found.hostId);
        if (!hostRow) return res.status(404).json({ message: "Room not found" });
        ctx = { room: found, host: hostRow };
      }
      if (!ctx) return;
      const { room, host } = ctx;
      if (room.status === "ended") return res.status(409).json({ message: "This room has ended.", code: "ROOM_ENDED" });

      const merged = {
        title: "title" in b ? b.title : room.title,
        description: "description" in b ? b.description : room.description ?? undefined,
        kind: room.kind, visibility: room.visibility,
        ageLimit: "ageLimit" in b ? b.ageLimit : room.ageLimit,
        capacity: "capacity" in b ? b.capacity : room.capacity,
        noDirectInteractions: "noDirectInteractions" in b ? b.noDirectInteractions : room.noDirectInteractions,
        screenUrl: "screenUrl" in b ? b.screenUrl : undefined,
        pinnedMessage: "pinnedMessage" in b ? b.pinnedMessage : undefined,
        slowModeSec: "slowModeSec" in b ? b.slowModeSec : undefined,
        // Paid rooms: the stored values unless sent, so "both or neither" and "18+/21+ only" are checked on the result.
        ticketPriceKobo: "ticketPriceKobo" in b ? b.ticketPriceKobo : room.ticketPriceKobo ?? null,
        ticketCapacity: "ticketCapacity" in b ? b.ticketCapacity : room.ticketCapacity ?? null,
        refundBeforeStart: "refundBeforeStart" in b ? b.refundBeforeStart : undefined,
        sprayEnabled: "sprayEnabled" in b ? b.sprayEnabled : undefined,
      };
      const v = validateRoomInput(merged);
      if (!v.ok) return res.status(400).json({ message: `Invalid ${v.field}`, field: v.field });
      if ("locked" in b && typeof b.locked !== "boolean") return res.status(400).json({ message: "Invalid locked", field: "locked" });

      const patch: rs.RoomPatch = {};
      // Host settings. The pinned message is stored as plain text (never HTML), cut to 200 after the tags are stripped.
      if ("pinnedMessage" in b) patch.pinnedMessage = pinnedPlainText(v.value.pinnedMessage);
      if ("slowModeSec" in b && v.value.slowModeSec !== undefined) patch.slowModeSec = v.value.slowModeSec;
      if ("locked" in b) patch.locked = b.locked === true;
      const settingsChanged = "pinnedMessage" in patch || "slowModeSec" in patch || "locked" in patch;
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
      // Gaming (ROOMS_GAMING, host only: the co-host path above refuses any key but pinnedMessage). Flag off: ignored.
      if (roomFeatures.gaming && ("gameFormat" in b || "gameDropTimeoutMs" in b)) {
        const g = validateGameInput(b);
        if (!g.ok) return res.status(400).json(badGameField(g.field));
        if (g.value.gameFormat !== undefined) {
          if (g.value.gameFormat !== null) {
            // A live room must have voice and live video on now; a scheduled one must be small enough for live video (only a
            // ticketed room can be bigger: a free room's capacity is capped at ROOM_LIMITS.capacityMax = liveVideoMax). Checked
            // before the ticket checks, so the answer is the same whether or not this host may sell.
            const ok = room.status === "live" ? room.voiceEnabled && room.liveVideo : videoSized(v.value);
            if (!ok) return res.status(400).json(NEEDS_LIVE_VIDEO);
          }
          if (g.value.gameFormat === null && (room.parentRoomId || (await lanes.isLaneParent(room.id)))) {
            return res.status(409).json({ message: "A game room with age lanes stays a game room.", code: "LANE_ROOM" });
          }
          if (room.status === "live") {
            const fit = gameFitCheck(room.id, g.value.gameFormat);
            if (fit === "TEAM_FULL") return res.status(409).json({ message: "A team has more players than that. Remove players first.", code: "TEAM_FULL" });
            if (fit === "GAME_IN_PROGRESS") return res.status(409).json({ message: "Remove the players before switching the game off.", code: "GAME_IN_PROGRESS" });
          }
          patch.gameFormat = g.value.gameFormat;
        }
        if (g.value.gameDropTimeoutMs !== undefined) patch.gameDropTimeoutMs = g.value.gameDropTimeoutMs;
      }
      // Spray opt-in: turning it on needs the host checks (before the ticket ones); turning it off is always allowed. The spray
      // gate reads the row on every spray, so a live room follows at once; an in-flight paid spray still delivers.
      if ("sprayEnabled" in b && v.value.sprayEnabled !== undefined && v.value.sprayEnabled !== room.sprayEnabled) {
        // An admin switch-off is the admin's alone to undo: a host can only turn spraying off, never on, while it stands.
        if (v.value.sprayEnabled && (room.sprayAdminBlocked === true || await laneParentBlocked(room))) {
          return res.status(403).json({ message: "Spray is turned off by the platform for this room.", code: "SPRAY_ADMIN_BLOCKED" });
        }
        if (v.value.sprayEnabled) {
          const spray = await sprayCheck(host, { ageLimit: v.value.ageLimit, minorsRoom: room.minorsRoom });
          if (!spray.ok) return res.status(403).json({ message: SPRAY_ENABLE_MESSAGES[spray.code], code: spray.code });
        }
        // Live rooms: only turning ON is slowed (OFF is never refused); the window starts after a successful write, below.
        if (v.value.sprayEnabled && room.status === "live") {
          const retryMs = sprayToggleCooldown.retryMs(room.id);
          if (retryMs > 0) return res.status(429).json({ code: "SPRAY_TOGGLE_COOLDOWN", message: "You switched spraying a moment ago. Try again in a few seconds.", retryMs });
        }
        patch.sprayEnabled = v.value.sprayEnabled;
      }
      // Paid rooms. Selling (or changing a sale) needs the same host checks as creating. Once any ticket is sold the price,
      // the free/paid switch, the age limit and the refund promise are fixed, and the ticket capacity never goes below the
      // tickets sold. Those two are decided in the write itself, under the room row lock (updateRoomWithTicketGuard).
      let ticketGuard: { lockedBySale: boolean; capacity: number | null; requireScheduled?: boolean } | null = null;
      {
        const newPrice = v.value.ticketPriceKobo ?? null, newCap = v.value.ticketCapacity ?? null;
        const priceChange = "ticketPriceKobo" in b && newPrice !== (room.ticketPriceKobo ?? null);
        const capChange = "ticketCapacity" in b && newCap !== (room.ticketCapacity ?? null);
        const ageChange = "ageLimit" in b && v.value.ageLimit !== room.ageLimit && isTicketedRoom(room);
        const refundOff = "refundBeforeStart" in b && v.value.refundBeforeStart === false && room.refundBeforeStart !== false;
        // Free -> paid only before the room starts: people already inside a live room hold no ticket and would take the
        // paid seats. Checked here for a clear answer and again under the room row lock (the start may land meanwhile).
        const becomingTicketed = newPrice !== null && !isTicketedRoom(room);
        if (becomingTicketed && room.status !== "scheduled") {
          return res.status(409).json({ message: TICKET_GUARD_MESSAGES.NOT_SCHEDULED, code: "NOT_SCHEDULED" });
        }
        if (newPrice !== null && (priceChange || capChange)) {
          const sell = await sellCheck(host, { ageLimit: v.value.ageLimit, minorsRoom: room.minorsRoom });
          if (!sell.ok) return res.status(403).json({ message: TICKET_SALE_MESSAGES[sell.code], code: sell.code });
        }
        if (priceChange) patch.ticketPriceKobo = newPrice;
        if (capChange) patch.ticketCapacity = newCap;
        if ("refundBeforeStart" in b && v.value.refundBeforeStart !== undefined) patch.refundBeforeStart = v.value.refundBeforeStart;
        if (priceChange || capChange || ageChange || refundOff) {
          ticketGuard = { lockedBySale: priceChange || ageChange || refundOff, capacity: capChange ? newCap : null, requireScheduled: becomingTicketed };
        }
      }
      if ("screenUrl" in b) {
        if (b.screenUrl === null || b.screenUrl === "") patch.screen = null;
        else if (!roomFeatures.linkScreens) return res.status(400).json({ message: "Link screens are switched off for now.", field: "screenUrl", reason: "disabled" });
        else {
          const r = resolveScreen(String(b.screenUrl));
          if (!r.ok) return res.status(400).json({ message: "That screen link can't be used.", field: "screenUrl", reason: r.reason });
          patch.screen = r.screen;
        }
      }
      // A settings change goes through the per-room queue, which also tells everyone in a live room (room:settings).
      const guard = ticketGuard;
      const write = () => (guard ? updateRoomWithTicketGuard(room.id, patch, guard) : rs.updateRoom(room.id, patch));
      let updated: Room;
      try {
        updated = !Object.keys(patch).length ? room
          : settingsChanged || ("sprayEnabled" in patch && roomFeatures.spray) ? await writeRoomSettings(room.id, write)
          : await write();
      } catch (e) {
        if (e instanceof TicketGuardError) return res.status(409).json({ message: TICKET_GUARD_MESSAGES[e.code], code: e.code });
        throw e;
      }
      if ("sprayEnabled" in patch && updated.status === "live") sprayToggleCooldown.mark(room.id);
      if ("screen" in patch && updated.status === "live") notifyScreen(room.id, patch.screen ?? null, updated.screenVersion);
      if (patch.ageLimit && updated.status === "live") await enforceAgeLimit(room.id); // raised: send out anyone now under it
      if (updated.status === "live" && ("gameFormat" in patch || "gameDropTimeoutMs" in patch)) await applyGameRoom(updated); // the hub follows
      // The ticket settings go back to the host only (a co-host editing the pinned message gets the viewer room).
      res.json({ room: { ...(uid === room.hostId ? hostRoom(updated, roomFeatures.spray && await laneParentBlocked(updated)) : viewerRoom(updated)), host: hostSummary(host) } });
    } catch (e) {
      console.error("[rooms] patch failed:", e);
      res.status(500).json({ message: "Failed to update room" });
    }
  });

  // ------------------------------------------------------------ start / end
  app.post("/api/rooms/:id/start", requireAuth, roomLimiter, async (req, res) => {
    let wentLive = false; // set once the conditional write succeeded: from then on a failure must not leave the room live
    let startedId: string | null = null; // the room actually started (a game room starts the host's lane)
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { host } = ctx;
      let { room } = ctx;
      // Gaming: a game room with lanes is never live on its own. Starting it starts the host's own lane (and the game room).
      if (roomFeatures.gaming && (await lanes.isLaneParent(room.id))) {
        const own = await lanes.ownLane(room.id, host.id);
        if (!own) return res.status(409).json({ message: "You don't have a lane in this game room.", code: "NO_LANE" });
        room = own;
      }
      if (room.status !== "scheduled") return res.status(409).json({ message: room.status === "live" ? "This room is already live." : "This room has ended.", code: "BAD_STATE" });
      if (room.minorsRoom && !isTeen(ageFromDob(host.dateOfBirth))) {
        return res.status(403).json({ ...HOST_NOT_MINOR, message: "This room was set up for under 18s, so it can't be started now. Create a new room instead." });
      }
      if ((await rs.countLiveRoomsByHost(host.id)) >= MAX_LIVE) {
        return res.status(429).json({ message: "You already have a live room. End it before starting another.", code: "LIVE_LIMIT" });
      }
      // A teen host's room must never go live as an ordinary room (a correction job that failed may have left it unflagged):
      // flag it BEFORE it goes live. One way, never cleared.
      if (isTeen(ageFromDob(host.dateOfBirth)) && !room.minorsRoom) await mr.markHostRoomsMinors(host.id);
      // Checked in the write: a room that was ended since we read it (for example by a birthdate correction) stays ended.
      let live = await rs.startScheduledRoom(room.id);
      if (!live) return res.status(409).json({ message: "This room can't be started now.", code: "BAD_STATE" });
      wentLive = true;
      startedId = room.id;
      expectHost(room.id); // the host has the grace period to connect to the room, or it ends (a timer on every path from here)
      // The host's age may have been corrected after the first read. Look again now that the room is live: an adult host never
      // keeps a live minors' room, and a teen host never keeps an unflagged one, whatever the order of events was.
      const fresh = await storage.getUser(host.id);
      const freshTeen = !!fresh && isTeen(ageFromDob(fresh.dateOfBirth));
      if (live.minorsRoom && !freshTeen) {
        await endRoom(room.id);
        return res.status(403).json({ ...HOST_NOT_MINOR, message: "This room was set up for under 18s, so it can't be started now. Create a new room instead." });
      }
      if (!live.minorsRoom && freshTeen) {
        await mr.markHostRoomsMinors(host.id);
        live = { ...live, minorsRoom: true };
      }
      if (live.minorsRoom) roomHub.markMinorsRoom(room.id);
      await rs.upsertMember(room.id, host.id, "host");
      // Gaming: a lane going live takes its game room live (never joinable, no host timer: it lives while a lane does).
      // Followers are told about the game room when the game room's host starts their lane (the link routes each person to
      // their own lane); a lane opened by someone else announces that lane, under its own rules.
      const parent = roomFeatures.gaming && live.parentRoomId ? await lanes.startParentOf(live) : null;
      notifyFollowers(parent && parent.hostId === host.id ? parent : live, host); // background (never delays the answer)
      res.json({ room: { ...viewerRoom(live), host: hostSummary(host) } });
    } catch (e) {
      console.error("[rooms] start failed:", e);
      // Fail closed: a room that went live must not stay live without a grace timer when a later step threw.
      if (wentLive) await endRoom(startedId ?? req.params.id).catch((e2) => console.error("[rooms] ending a room that failed to start also failed:", e2));
      res.status(500).json({ message: "Failed to start room" });
    }
  });

  app.post("/api/rooms/:id/end", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      if (ctx.room.status === "ended") return res.status(409).json({ message: "This room has already ended.", code: "BAD_STATE" });
      // Gaming: ending a game room ends every lane in it first (each lane's people are told by their own lane).
      if (roomFeatures.gaming && (await lanes.isLaneParent(ctx.room.id))) {
        for (const c of await lanes.laneChildren(ctx.room.id)) if (c.status !== "ended") await endRoom(c.id);
      }
      if ((await rs.getRoom(ctx.room.id))?.status !== "ended") await endRoom(ctx.room.id); // sets status, tells everyone in the room, clears presence and timers
      const ended = (await rs.getRoom(ctx.room.id))!;
      res.json({ room: { ...viewerRoom(ended), host: hostSummary(ctx.host) } });
    } catch (e) {
      console.error("[rooms] end failed:", e);
      res.status(500).json({ message: "Failed to end room" });
    }
  });

  // ------------------------------------------------------------ gaming: OBS / RTMP ingest (LIVEKIT_INGRESS)
  // A current player of this room gets their own ingest point (the same one on every call). Everyone else gets one fixed 403.
  // The stream key is in this response only: never logged, never in room:state or a broadcast, never in an error.
  app.post("/api/rooms/:id/game/ingress", requireAuth, roomLimiter, async (req, res) => {
    const refused = () => res.status(403).json({ message: "Only a player in this game can stream with OBS.", code: "NOT_ALLOWED" });
    try {
      if (!ingestAvailable()) return res.status(404).json({ message: "Not found" });
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id))) return res.status(404).json({ message: "Room not found" });
      if (room.status !== "live" || !isGamePlayer(room.id, req.user!.id)) return refused();
      const i = await ingressFor(room.id, req.user!.id);
      if (!isGamePlayer(room.id, req.user!.id)) { await revokePlayerIngress(room.id, req.user!.id); return refused(); } // removed meanwhile
      res.set("Cache-Control", "no-store");
      res.json({ url: i.url, streamKey: i.streamKey });
    } catch {
      console.error("[rooms:ingress] route failed"); // never the error itself: it may carry the request
      res.status(500).json({ message: "Streaming with OBS isn't available right now." });
    }
  });

  // ------------------------------------------------------------ gaming: open the other age lane of a game room
  // Body { lane: "teen" | "adult", visibility?: "friends" | "invite" (teen lane; default friends) }. The lane's host is the
  // caller, who must be of that age (a teen for the teen lane) and the game room's host or one of their mutual follows.
  app.post("/api/rooms/:id/lanes", requireAuth, roomLimiter, async (req, res) => {
    try {
      if (!roomFeatures.gaming) return res.status(404).json({ message: "Not found" });
      const parent = await rs.getRoom(req.params.id);
      if (!parent || !(await canViewRoom(parent, req.user!.id)) || !(await lanes.isLaneParent(parent.id))) return res.status(404).json({ message: "Room not found" });
      const lane = req.body?.lane;
      if (lane !== "teen" && lane !== "adult") return res.status(400).json({ message: "Invalid lane", field: "lane" });
      const vis = req.body?.visibility ?? (lane === "teen" ? "friends" : parent.visibility);
      if (lane === "teen" ? vis !== "friends" && vis !== "invite" : vis !== parent.visibility) return res.status(400).json({ message: "Invalid visibility", field: "visibility" });
      const me = await storage.getUser(req.user!.id);
      if (!me) return res.status(404).json({ message: "User not found" });
      const ageLimit = lanes.laneAgeLimit(parent.ageLimit as any, lane);
      if (ageLimit) {
        const hc = await hostCheck(me, { visibility: vis, ageLimit });
        if (!hc.ok && hc.code !== "ACCOUNT_TOO_NEW") return res.status(403).json({ message: HOST_MESSAGES[hc.code], code: hc.code });
      }
      // An invite-only adult lane shares the game room's link; an invite-only teen lane gets its own link.
      const ownToken = lane === "teen" && vis === "invite" ? newInviteToken() : undefined;
      const tokenHash = ownToken ? sha256(ownToken) : vis === "invite" ? parent.inviteTokenHash ?? undefined : undefined;
      const made = await lanes.openLane(parent, me, lane, vis, me.id === parent.hostId || (await mutualFollow(me.id, parent.hostId)), tokenHash);
      res.status(201).json({ room: { ...hostRoom(made, roomFeatures.spray && await laneParentBlocked(made)), host: hostSummary(me) }, ...(ownToken ? { inviteLink: `/rooms/${made.id}?token=${ownToken}` } : {}) });
    } catch (e) {
      if (e instanceof lanes.LaneError) return res.status(e.status).json(e.body);
      console.error("[rooms] open lane failed:", e);
      res.status(500).json({ message: "Failed to open the lane" });
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
      if (roomFeatures.gaming && room.parentRoomId && !(await lanes.mayUseLane(room, req.user!.id))) return res.status(404).json({ message: "Room not found" });
      const targetId = req.params.userId;
      // Anyone who is not in the room (or is yourself) gets one fixed answer, so this endpoint cannot be used to probe blocks on arbitrary users.
      const none = { actions: { interact: false, dm: false, invite: false, profile: true } };
      if (targetId === req.user!.id || (targetId !== room.hostId && !roomHub.get(room.id, targetId))) return res.json(none);
      // profile: only for someone present in the room. View profile is offered unless either of you has blocked the other.
      const profile = !(await profileBlocked(req.user!.id, targetId));
      const noneHere = { actions: { interact: false, dm: false, invite: false, profile } };
      const v = await interactionVerdict(room, req.user!.id, targetId);
      // Messages across age groups are a separate, consent-based rule (both people must have allowed it), not the room rule.
      const gap = await ageGapBetween(req.user!.id, targetId);
      const crossAgeDm = !v.ok && gap.gap && gap.blockedBy === null && !room.noDirectInteractions && !(await isBlockedEitherWay(req.user!.id, targetId));
      if (!v.ok && !crossAgeDm) return res.json(noneHere);
      if (!v.ok) return res.json({ actions: { interact: false, dm: true, invite: false, profile } });
      const target = v.target;
      const mine = await liveRoomOf(req.user!.id);
      // A minors' room is never offered to an adult this way: adults need the personal invite (and it says nothing of the room).
      const invite = !!mine && mine.id !== room.id && resolveRoomPrivacy(target.roomPrivacy).allowInvites
        && canJoinRoom({ age: ageFromDob(target.dateOfBirth) }, mine as any).ok
        && (!mine.minorsRoom || isTeen(ageFromDob(target.dateOfBirth)));
      res.json({ actions: { interact: true, dm: true, invite, profile } });
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
      // This invite names the room. Adults get into a minors' room only through the personal adult invite, which does not.
      if (room.minorsRoom && !isTeen(ageFromDob(v.target.dateOfBirth))) return refuse();
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

  // ------------------------------------------------------------ minors' rooms: personal adult invites
  // A room whose host was under 18 at creation admits adults only with one of these, acknowledged by the adult. Never a link.
  const adultInviteBuckets = new Map<string, TokenBucket>(); // per host: invites created or renewed
  const adultNotifyBuckets = new Map<string, TokenBucket>(); // per host and adult: at most one notification a minute
  const takeFrom = (m: Map<string, TokenBucket>, key: string, rate: number, burst: number) => {
    let b = m.get(key);
    if (!b) { if (m.size > 5000) m.clear(); b = new TokenBucket(rate, burst); m.set(key, b); }
    return b.take();
  };
  const notFoundRoom = { ok: false, code: "NOT_FOUND" } as const;

  // Registered before /adult-invites/:userId so "acknowledge" is never read as a user id.
  app.post("/api/rooms/:id/adult-invites/acknowledge", requireAuth, roomLimiter, async (req, res) => {
    try {
      const uid = req.user!.id;
      const room = await rs.getRoom(req.params.id);
      const view = room ? await viewRoom(room, uid) : notFoundRoom;
      if (!room || (!view.ok && view.code === "NOT_FOUND")) return res.status(404).json({ message: "Room not found" });
      if (room.status === "ended") return res.status(409).json({ message: "This room has ended.", code: "ROOM_ENDED" });
      if (view.ok) {
        if (!room.minorsRoom || room.hostId === uid || !(await mr.getInviteState(room.id, uid)).invited) {
          return res.status(409).json({ message: "Nothing to acknowledge.", code: "NOT_NEEDED" });
        }
        return res.json({ ok: true, acknowledged: true }); // already acknowledged: the first time is kept
      }
      if (view.code === "AGE_UNKNOWN") {
        return res.status(403).json({ code: "AGE_UNKNOWN", message: "Add your date of birth in your profile to join rooms.", canJoin: { ok: false, code: "AGE_UNKNOWN" } });
      }
      if (view.code === "MINORS_ROOM") return res.status(403).json(mr.minorsDenialBody("MINORS_ROOM", room));
      // MINORS_ROOM_ACK: invited, not yet acknowledged. The request body is ignored: the act of calling is the acknowledgement.
      // An invite from a host who is 18 or over now no longer opens the room (adults already inside may stay until it ends).
      if (!isTeen(ageFromDob((await storage.getUser(room.hostId))?.dateOfBirth))) return res.status(403).json(mr.minorsDenialBody("MINORS_ROOM", room));
      const at = await mr.acknowledgeInvite(room.id, uid);
      if (!at) return res.status(403).json(mr.minorsDenialBody("MINORS_ROOM", room)); // revoked in the meantime
      res.json({ ok: true, acknowledged: true });
    } catch (e) {
      console.error("[rooms] adult invite acknowledge failed:", e);
      res.status(500).json({ message: "Failed to save" });
    }
  });

  app.get("/api/rooms/:id/adult-invites", requireAuth, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const rows = ctx.room.minorsRoom ? await mr.listActiveInvites(ctx.room.id) : [];
      // Public profile bits only (hostSummary goes through toPublicUser); never an age or a birthdate.
      res.json({ invites: rows.map((r) => ({ user: hostSummary(r.user), invitedAt: r.createdAt, acknowledged: r.acknowledgedAt !== null })) });
    } catch (e) {
      console.error("[rooms] adult invite list failed:", e);
      res.status(500).json({ message: "Failed to load invites" });
    }
  });

  app.post("/api/rooms/:id/adult-invites/:userId", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { room, host } = ctx;
      if (!room.minorsRoom) return res.status(409).json({ message: "Only rooms for under 18s need adult invites.", code: "NOT_MINORS_ROOM" });
      if (room.status === "ended") return res.status(409).json({ message: "This room has ended.", code: "ROOM_ENDED" });
      if (!isTeen(ageFromDob(host.dateOfBirth))) return res.status(403).json({ ...HOST_NOT_MINOR, message: "Only hosts under 18 can invite adults to this room." });
      const targetId = req.params.userId;
      // One answer for every refusal: the host never learns whether the person is blocked, banned, suspended, a teen or unknown.
      const refuse = () => res.status(403).json({ message: "You can't invite this person.", code: "NOT_ALLOWED" });
      if (targetId === host.id || targetId.length > 64) return refuse();
      const [target, blocked, member, suspended] = await Promise.all([
        storage.getUser(targetId), isBlockedEitherWay(host.id, targetId), rs.getMember(room.id, targetId), storage.getActiveSuspension(targetId),
      ]);
      if (!target || target.deletedAt || blocked || member?.banned || suspended) return refuse();
      const age = ageFromDob(target.dateOfBirth);
      if (age === null || age < 18) return refuse(); // teens need no invite; unknown age enters nothing
      if (!resolveRoomPrivacy(target.roomPrivacy).allowInvites) return refuse();
      if (!canJoinRoom({ age }, room as any).ok) return refuse();
      if (!takeFrom(adultInviteBuckets, host.id, 1 / 30, 10)) return res.status(429).json({ message: "Too many invites. Try again in a minute.", code: "RATE_LIMITED" });
      const state = await mr.upsertInvite(room.id, targetId, host.id);
      if (takeFrom(adultNotifyBuckets, `${host.id}:${targetId}`, 1 / 60, 1)) {
        // Never the room title: until they have read and acknowledged the warning they may not see anything about the room.
        await deliverNotification({
          userId: targetId, type: "room_live", title: `${host.displayName || host.organizationName || host.username} invited you to a room`,
          message: "Open it to read a safety notice before you join.", link: `/rooms/${room.id}`, relatedUserId: host.id, relatedEntityId: room.id,
        }).catch((e) => console.error("[rooms] adult invite notify failed:", e));
      }
      res.json({ ok: true, invite: { userId: targetId, acknowledged: state.acknowledged } });
    } catch (e) {
      console.error("[rooms] adult invite failed:", e);
      res.status(500).json({ message: "Failed to send invite" });
    }
  });

  app.delete("/api/rooms/:id/adult-invites/:userId", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const { room, host } = ctx;
      const targetId = req.params.userId;
      if (targetId === host.id || targetId.length > 64) return res.status(403).json({ message: "You can't do that to this person." });
      const revoked = await mr.revokeInvite(room.id, targetId);
      if (room.minorsRoom) {
        const target = await storage.getUser(targetId);
        if (!target || !isTeen(ageFromDob(target.dateOfBirth))) {
          // The co-host role came with the invite: it goes with it, so a later re-invite does not bring it back.
          const m = await rs.getMember(room.id, targetId);
          if (m?.role === "cohost") await rs.setMemberRole(room.id, targetId, "guest");
          await removeFromMinorsRoom(room.id, targetId); // waits for any join of theirs in flight, then removes them with the warning
        }
      }
      res.json({ ok: true, revoked });
    } catch (e) {
      console.error("[rooms] adult invite revoke failed:", e);
      res.status(500).json({ message: "Failed to revoke invite" });
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
      if (role === "cohost" && ctx.room.minorsRoom) {
        // An adult co-host in a minors' room needs the same acknowledged personal invite as any adult guest, and a host who
        // is 18 or over now cannot make any adult a co-host.
        const [tu, inv, hostU] = await Promise.all([storage.getUser(targetId), mr.getInviteState(ctx.room.id, targetId), storage.getUser(ctx.room.hostId)]);
        if (!tu || !mr.minorsGate(ctx.room, targetId, ageFromDob(tu.dateOfBirth), inv).ok) {
          return res.status(403).json({ message: "Adults need your personal invite first.", code: "NOT_ALLOWED" });
        }
        if (!isTeen(ageFromDob(tu.dateOfBirth)) && !isTeen(ageFromDob(hostU?.dateOfBirth))) {
          return res.status(403).json({ ...HOST_NOT_MINOR, message: "Only hosts under 18 can make an adult a co-host in this room." });
        }
      }
      await rs.setMemberRole(ctx.room.id, targetId, role);
      const live = roomHub.get(ctx.room.id, targetId);
      if (live) live.role = role;
      await afterRoleChange(ctx.room.id, targetId); // a co-host is an implicit speaker, a guest only speaks from the stage: LiveKit follows at once
      roomHub.broadcast(ctx.room.id, { type: "room:mod", action: "role", targetId, role });
      // Paid rooms: a co-host got in without a ticket. Made a guest, they must hold one like every other guest, or they
      // are sent out (TICKET_REQUIRED, no price). enforceTicketFor waits for any join of theirs in flight and does nothing
      // in a free room, for a ticket holder, or for someone not in the room.
      if (role === "guest") {
        await enforceTicketFor(ctx.room.id, targetId).catch((e) => console.error("[rooms] ticket check after demotion failed:", e));
      }
      res.json({ ok: true, role });
    } catch (e) {
      console.error("[rooms] role failed:", e);
      res.status(500).json({ message: "Failed to change role" });
    }
  });

  // ------------------------------------------------------------ voice (LiveKit)
  // The host switches voice on for a live room; everyone in the room then asks for a token. Who may speak is decided here
  // (host, co-hosts, guests on stage): LiveKit only enforces what the token and permission updates say.
  // The host switches live camera + mic streaming on or off. It rides on voice (same LiveKit session), and only rooms small
  // enough for everyone to receive video may have it.
  app.put("/api/rooms/:id/live-video", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false", field: "enabled" });
      if (ctx.room.status !== "live") return res.status(409).json({ message: "Live video is for live rooms.", code: "ROOM_NOT_LIVE" });
      if (enabled) {
        if (!ctx.room.voiceEnabled) return res.status(409).json({ message: "Turn voice on first.", code: "VOICE_OFF" });
        if (!getVoiceService()) return res.status(503).json({ message: "Live video isn't available right now.", code: "LIVE_UNAVAILABLE" });
        if (roomCapacity(ctx.room) > ROOM_LIMITS.liveVideoMax) return res.status(400).json({ message: `Live video works in rooms of up to ${ROOM_LIMITS.liveVideoMax} people.`, field: "liveVideo", reason: "too_large" });
      }
      const room = enabled ? await rs.enableLiveVideo(ctx.room.id) : await rs.setLiveVideo(ctx.room.id, false);
      if (!room) return res.status(409).json({ message: "Turn voice on first.", code: "VOICE_OFF" }); // voice went off since we looked
      // Voice may have gone off after our write (its route has then already cleared the flag): never switch it back on behind that.
      const on = enabled && roomHub.voiceOn(room.id);
      roomHub.setLiveVideoOn(room.id, on);
      roomHub.broadcast(room.id, { type: "room:livevideo", enabled: on });
      if (!enabled) await stopAllLive(room.id);
      res.json({ room: { ...viewerRoom(room), host: hostSummary(ctx.host) } });
    } catch (e) {
      console.error("[rooms] live video switch failed:", e);
      res.status(500).json({ message: "Failed to change live video" });
    }
  });

  app.put("/api/rooms/:id/voice", requireAuth, roomLimiter, async (req, res) => {
    try {
      const ctx = await loadHostRoom(req, res);
      if (!ctx) return;
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be true or false", field: "enabled" });
      if (ctx.room.status !== "live") return res.status(409).json({ message: "Voice is for live rooms.", code: "ROOM_NOT_LIVE" });
      if (enabled && !getVoiceService()) return res.status(503).json({ message: "Voice isn't available right now.", code: "VOICE_UNAVAILABLE" });
      const room = await rs.setVoiceEnabled(ctx.room.id, enabled); // off also persists live video off, in the same write
      roomHub.setVoiceOn(room.id, enabled);
      if (!enabled) await shutdownVoice(room.id);
      roomHub.broadcast(room.id, { type: "room:voice", enabled });
      res.json({ room: { ...viewerRoom(room), host: hostSummary(ctx.host) } });
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
      await present.ready; // a joiner who just arrived is still being checked against the teen rule: no token (no video, no audio) until it is done
      if (roomHub.get(room.id, req.user!.id) !== present) return res.status(403).json({ message: "Join the room first.", code: "NOT_IN_ROOM" });
      const user = await storage.getUser(req.user!.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const canPublish = canPublishNow(room.id, user.id);
      present.publish = canPublish;
      const token = await voice.mintToken({ roomId: room.id, userId: user.id, displayName: user.displayName || user.organizationName || user.username, canPublish, camera: canCameraNow(room.id, user.id), ...(isGamePlayer(room.id, user.id) ? { sources: publishSourcesNow(room.id, user.id) } : {}) }); // a game player (ROOMS_GAMING) also gets the screen
      res.json({ url: voice.url, token, canPublish, expiresInSec: 60 });
    } catch (e) {
      console.error("[rooms] voice token failed:", e);
      res.status(500).json({ message: "Failed to join voice" });
    }
  });

  // ------------------------------------------------------------ report
  // The last 50 chat lines live only in memory; a report is the one thing that makes them durable (as text on the report).
  function chatExcerpt(roomId: string): string {
    // Author and quoted person are named the same way: their username while they are in the room, else their full id
    // (an 8-character prefix could not be looked up by a moderator).
    const nameOf = (userId: string) => (roomHub.get(roomId, userId)?.info?.username as string | undefined) ?? userId;
    const lines = roomHub.recentChat(roomId).map((l) => {
      const q = l.replyTo ? ` (replying to ${nameOf(l.replyTo.userId)}: ${l.replyTo.text})` : "";
      return `${new Date(l.at).toISOString().slice(11, 19)} ${nameOf(l.userId)}: ${l.text}${q}`;
    });
    return lines.length ? `\n\n--- last chat lines ---\n${lines.join("\n")}`.slice(0, 8000) : "";
  }

  app.post("/api/rooms/:id/report", requireAuth, roomLimiter, async (req, res) => {
    try {
      const room = await rs.getRoom(req.params.id);
      if (!room || !(await canViewRoom(room, req.user!.id, typeof req.query.token === "string" ? req.query.token : undefined))) {
        return res.status(404).json({ message: "Room not found" });
      }
      // Gaming: a report about a lane comes only from that lane's own people (its chat excerpt never reaches the other lane's reports).
      if (roomFeatures.gaming && room.parentRoomId && !(await lanes.mayUseLane(room, req.user!.id))) return res.status(404).json({ message: "Room not found" });
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

  // ------------------------------------------------------------ hosting defaults (per user): what the create form starts with
  app.get("/api/users/me/room-defaults", requireAuth, async (req, res) => {
    try {
      const u = await storage.getUser(req.user!.id);
      if (!u) return res.status(404).json({ message: "User not found" });
      res.json({ roomDefaults: resolveRoomDefaults(u.roomDefaults) });
    } catch (e) {
      console.error("[rooms] room-defaults read failed:", e);
      res.status(500).json({ message: "Failed to load hosting defaults" });
    }
  });

  app.put("/api/users/me/room-defaults", requireAuth, roomLimiter, async (req, res) => {
    try {
      const v = validateRoomDefaults(req.body);
      if (!v.ok) return res.status(400).json({ message: "Invalid hosting defaults", field: v.field });
      await storage.updateUser(req.user!.id, { roomDefaults: v.value } as any);
      res.json({ roomDefaults: v.value });
    } catch (e) {
      console.error("[rooms] room-defaults save failed:", e);
      res.status(500).json({ message: "Failed to save hosting defaults" });
    }
  });

  // Own ID-verification status only (the AgeVerification shape; never the birthdate).
  app.get("/api/users/me/age-verification", requireAuth, async (req, res) => {
    try {
      const { ageVerifier } = await import("../identity/ageVerification");
      res.json(await ageVerifier.status(req.user!.id));
    } catch (e) {
      console.error("[rooms] age-verification read failed:", e);
      res.status(500).json({ message: "Failed to load age verification" });
    }
  });

  app.put("/api/users/me/room-privacy", requireAuth, roomLimiter, async (req, res) => {
    try {
      // An older client that does not send notifyFriendsLive keeps the stored choice (never silently turned back on).
      const current = await storage.getUser(req.user!.id);
      if (!current) return res.status(404).json({ message: "User not found" });
      const v = validateRoomPrivacy(req.body, resolveRoomPrivacy(current.roomPrivacy));
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

  registerRoomMoneyRoutes(app); // paid rooms: refund, cancel, sales summary (lane S3)
  registerSprayRoutes(app); // spraying (phase 5): spray, status, limits, saved card
  registerRoomRecapRoutes(app); // recaps (phase 6): GET /api/rooms/:id/recap
}
