// `room:*` messages on the shared /ws server. Every rule is re-checked here from the database; the client's
// slide-out only decides what to offer. Presence lives in RoomHub; bans, mutes and room state are persisted.
import { storage } from "../storage";
import { isBlockedEitherWay } from "../utils/blocks";
import { ageFromDob } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { sanitizePlaybackInput, type NowPlaying } from "@shared/playback";
import { HOST_LEAVE_GRACE_MS, minorsWarningFor, ROOM_LIMITS, ROOM_REACTIONS, resolveRoomPrivacy, resolveChatReply, validateChatReply, type MinorsRoomCode, type RoomSettings } from "@shared/rooms";
import { canHostRoom, canInteract, canJoinRoom, isTicketedRoom, roomCapacity } from "@shared/roomRules";
import { hasPaidTicket } from "./ticketStorage";
import type { Room, User } from "@shared/schema";
import * as rs from "./roomStorage";
import { canViewRoom, mutualFollow, plainText, viewerRoom, viewRoom } from "./roomAccess";
import { afterLaneEnded, isLaneParent, resolveLaneRoom } from "./gameLanes";
import { lockAdmits } from "./roomLock";
import { getInviteState, markHostRoomsMinors, minorsGate, NO_INVITE, revokeInvite } from "./minorsRoom";
import { roomHub, type HubMember } from "./RoomHub";
import { TokenBucket } from "./rateLimit";
import { LIVE_HOLD_MS } from "@shared/liveScreen";
import { broadcastLive, dropFromVoice, handleLive, handleStage, liveAway, reconcileVoice, registerAwayReleaser, restoreStageOnJoin, sweepAllVoiceRooms } from "./stage";
import { getVoiceService } from "./voice/voiceService";
import { roomFeatures } from "./features";
import { broadcastGame, gameLine, gameView, handleGame, isGamePlayer, nameOf, syncGameRoom } from "./game";
import { playersOf } from "@shared/gameScreen";
import { MEMBER_LIST_CAP, selectStateMembers, wantedMemberIds } from "./memberList";

/** Injectable so tests can shorten the host grace period; rates are the documented limits. */
export const tuning = {
  graceMs: HOST_LEAVE_GRACE_MS,
  // How long a dropped screen holder keeps the screen before it is released (a stream through a bad connection must not end at the first blip).
  liveGraceMs: Number(process.env.ROOM_LIVE_GRACE_MS) || LIVE_HOLD_MS,
  // Gaming: tests only. When set, replaces a game room's non-zero drop timeout (rooms.game_drop_timeout_ms); 0 (hold) stays 0.
  gameDropMs: null as number | null,
  chat: { rate: 1, burst: 5 },
  react: { rate: 3, burst: 3 },
  interact: { rate: 0.5, burst: 1 }, // 1 per 2 s per target
  join: { rate: 0.5, burst: 3 },     // a join is ~6 queries and a broadcast to the whole room
  stage: { rate: 2, burst: 6 },      // raise / lower / accept / invite / remove
  playback: { rate: 4, burst: 8 },   // host play / pause / seek, plus a heartbeat every 5 s
  sweepMs: 10_000,                   // how often LiveKit is compared with the room (0 = off, for tests)
  kickMs: 10 * 60_000,               // a kick keeps the person out this long (a ban is forever)
  // A locked room still takes back someone who left (or dropped) this recently. Keep kickMs >= lockRejoinMs: a kick that
  // has run out must never leave the kicked person inside the rejoin window (asserted in test-rooms-ws-hostsettings.ts).
  lockRejoinMs: HOST_LEAVE_GRACE_MS,
};

/** Test seams only (never set in production): lets a suite hold a join right after its fresh re-read. */
export const testHooks: { afterFreshRead?: (roomId: string, userId: string) => Promise<void> } = {};

const OPEN = 1;

export interface RoomClient { send(data: string): void; readyState: number }

/** Sockets that have sent room:join, per user. Messages are accepted only from these; sends fan out to all of them. */
const joinedSockets = new Map<string, Set<RoomClient>>();
type Buckets = { chat: TokenBucket; react: TokenBucket; join: TokenBucket; stage: TokenBucket; playback: TokenBucket; interact: Map<string, TokenBucket>; used: number };
// Not cleared on leave: otherwise leave + rejoin would hand a spammer a fresh burst every cycle. Pruned by age instead.
const buckets = new Map<string, Buckets>();
const kicked = new Map<string, number>(); // `${roomId}:${userId}` -> until (ms)
/** Kicked from this room and the kick has not run out yet (also checked by the co-host PATCH route). */
export const isKicked = (roomId: string, userId: string) => (kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now();
const joinLocks = new Map<string, Promise<void>>(); // one join at a time per user
const endTimers = new Map<string, ReturnType<typeof setTimeout>>();
const awayTimers = new Map<string, ReturnType<typeof setTimeout>>(); // `${roomId}:${userId}` of a holder (or game player) whose connection dropped
const clearAway = (roomId: string, userId: string) => { const k = `${roomId}:${userId}`; clearTimeout(awayTimers.get(k)); awayTimers.delete(k); };

const wire = (msg: object) => JSON.stringify(msg);
function fanout(userId: string, msg: object) {
  const data = wire(msg);
  Array.from(joinedSockets.get(userId) ?? []).forEach((s) => { if (s.readyState === OPEN) s.send(data); });
}
const direct = (ws: RoomClient, msg: object) => { if (ws.readyState === OPEN) ws.send(wire(msg)); };
const notice = (ws: RoomClient, code: string) => direct(ws, { type: "room:notice", code });
const refuse = (ws: RoomClient, code: string) => direct(ws, { type: "room:error", code });
/** Every minors' room refusal carries the one warning text (and nothing about the room); a teen lane its own wording (gaming). */
const minorsError = (code: MinorsRoomCode, room?: { ageLane?: string | null } | null) => ({ type: "room:error", code, warning: minorsWarningFor(room) });

// ---------------------------------------------------------------- host settings (pinned message, slow mode, lock)
/**
 * The live settings of each live room, so the chat path needs no query. Written by notifySettings after every committed
 * change (empty room or not), and by the first join of a room that has no entry yet (set-if-absent, from that join's fresh
 * row, so it can never overwrite a newer value). Kept while the room is live, removed when it ends.
 */
const roomSettings = new Map<string, RoomSettings>();
const settingsFromRow = (r: Pick<Room, "pinnedMessage" | "slowModeSec" | "locked">): RoomSettings =>
  ({ pinnedMessage: r.pinnedMessage ?? null, slowModeSec: r.slowModeSec ?? 0, locked: r.locked === true });
/** The settings the room has now: the live copy if there is one, else the row. */
const settingsOf = (room: Pick<Room, "id" | "pinnedMessage" | "slowModeSec" | "locked">): RoomSettings => roomSettings.get(room.id) ?? settingsFromRow(room);
function rememberSettings(roomId: string, s: RoomSettings) {
  if (roomSettings.size > 2000 && !roomSettings.has(roomId)) {
    // Safety valve only (entries normally go when the room ends): forget rooms nobody is in; their next join reads the row.
    Array.from(roomSettings.keys()).forEach((id) => { if (roomHub.count(id) === 0) roomSettings.delete(id); });
  }
  roomSettings.set(roomId, s);
}

/** Read-only views for the test suites (memory checks): nothing here can change state. */
export const roomSocketInternals = {
  hasSettings: (roomId: string) => roomSettings.has(roomId),
  hasSlowClock: (roomId: string) => slowChats.has(roomId),
};

/** Tells everyone in the room the current settings (and records them for the chat and join paths). Call after every committed change. */
export function notifySettings(room: Pick<Room, "id" | "pinnedMessage" | "slowModeSec" | "locked">): void {
  const s = settingsFromRow(room);
  rememberSettings(room.id, s);
  roomHub.broadcast(room.id, { type: "room:settings", ...s });
}

const settingsChains = new Map<string, Promise<void>>();
/**
 * Runs one settings write for a room at a time, and broadcasts the row it returned before the next write starts, so two
 * quick changes can never be announced in the wrong order (the last one announced is always the last one committed).
 */
export async function writeRoomSettings(roomId: string, write: () => Promise<Room>): Promise<Room> {
  const prev = settingsChains.get(roomId) ?? Promise.resolve();
  const run = prev.then(write).then((row) => { if (row?.status === "live") notifySettings(row); return row; });
  const tail = run.then(() => undefined, () => undefined);
  settingsChains.set(roomId, tail);
  try { return await run; } finally { if (settingsChains.get(roomId) === tail) settingsChains.delete(roomId); }
}

/**
 * Slow mode: when each person last chatted, per room and per USER (all their tabs share it). Host and co-hosts are exempt.
 * Dropped when the room empties or ends; old entries are pruned as a room's map grows, so nothing accumulates.
 */
const slowChats = new Map<string, Map<string, number>>();
const SLOW_MAX_MS = 30_000; // the longest slow mode (SLOW_MODES): older entries can never refuse anything
function forgetSlowIfEmpty(roomId: string) { if (roomHub.count(roomId) === 0) slowChats.delete(roomId); }

/** Milliseconds this person must still wait before chatting (0 = may chat now). */
function slowModeWait(roomId: string, userId: string, slowModeSec: number, now: number): number {
  if (slowModeSec <= 0) return 0;
  const last = slowChats.get(roomId)?.get(userId);
  if (last === undefined) return 0;
  const windowMs = slowModeSec * 1000;
  const left = last + windowMs - now;
  return left > 0 ? Math.min(windowMs, Math.max(1, Math.ceil(left))) : 0;
}
function recordSlowChat(roomId: string, userId: string, now: number) {
  let m = slowChats.get(roomId);
  if (!m) { m = new Map(); slowChats.set(roomId, m); }
  if (m.size > 2 * ROOM_LIMITS.capacityMaxPaid) {
    const cutoff = now - SLOW_MAX_MS;
    Array.from(m.entries()).forEach(([k, at]) => { if (at < cutoff) m!.delete(k); });
  }
  m.set(userId, now);
}

const BUCKET_TTL_MS = 10 * 60_000;
const bucketsFor = (userId: string) => {
  let b = buckets.get(userId);
  if (!b) {
    if (buckets.size > 2000) {
      const cutoff = Date.now() - BUCKET_TTL_MS;
      Array.from(buckets.entries()).forEach(([k, v]) => { if (v.used < cutoff) buckets.delete(k); });
    }
    b = {
      chat: new TokenBucket(tuning.chat.rate, tuning.chat.burst), react: new TokenBucket(tuning.react.rate, tuning.react.burst),
      join: new TokenBucket(tuning.join.rate, tuning.join.burst), stage: new TokenBucket(tuning.stage.rate, tuning.stage.burst), playback: new TokenBucket(tuning.playback.rate, tuning.playback.burst), interact: new Map(), used: 0,
    };
    buckets.set(userId, b);
  }
  b.used = Date.now();
  return b;
};

function memberInfo(u: User) {
  return { username: u.username, displayName: u.displayName, organizationName: u.organizationName, avatarUrl: u.avatarUrl, avatar: u.avatar ?? null };
}
const memberPayload = (m: HubMember) => ({ userId: m.userId, role: m.role, muted: m.muted, joinedAt: m.joinedAt, ...m.info });

// ---------------------------------------------------------------- end / grace
export async function endRoom(roomId: string, opts: { hostReview?: boolean } = {}): Promise<void> {
  clearTimeout(endTimers.get(roomId));
  endTimers.delete(roomId);
  Array.from(kicked.keys()).forEach((k) => { if (k.startsWith(`${roomId}:`)) kicked.delete(k); });
  Array.from(awayTimers.keys()).forEach((k) => { if (k.startsWith(`${roomId}:`)) { clearTimeout(awayTimers.get(k)); awayTimers.delete(k); } });
  const room = await rs.getRoom(roomId);
  if (room && room.status !== "ended") await rs.setStatus(roomId, "ended");
  // Paid rooms: schedule the host's payout (room went live) or refund every ticket (it never started, or it was closed for
  // a host review: opts.hostReview, never paid out). Never throws; imported lazily so the money modules stay out of this
  // module's import cycle.
  if (room) await import("./settlement").then((m) => m.afterRoomEnded(roomId, { hostReview: opts.hostReview === true })).catch((e) => console.error("[rooms] after-end money step failed:", e?.message ?? e));
  if (room?.voiceEnabled || roomHub.voiceOn(roomId)) {
    await rs.clearStage(roomId).catch(() => {});
    await getVoiceService()?.deleteRoom(roomId).catch((e) => console.error("[voice] deleteRoom failed:", e?.message ?? e));
  }
  // Phase 6 recap: persist the busiest moment this process saw before the hub forgets the room (never lowers the column).
  // Review r3 m8: a room that went live always gets a peak of at least 1 (its host was in it), even when this process's hub
  // saw nobody (auto-ended after a restart, or ended by another instance). peak_members IS NULL then means only "ended
  // before tracking existed" (the recap's untracked marker). raisePeak never lowers a bigger value another process wrote.
  const peak = roomHub.peakOf(roomId);
  const floor = room?.startedAt ? Math.max(peak, 1) : peak;
  if (room && floor > 0) await rs.raisePeak(roomId, floor).catch((e) => console.error("[rooms] peak write on end failed:", roomId, e?.message ?? e));
  for (const m of roomHub.end(roomId)) {
    joinedSockets.delete(m.userId);
  }
  roomSettings.delete(roomId);
  slowChats.delete(roomId);
  await rs.markAllLeft(roomId).catch(() => {});
  // Gaming: the last lane of a game room to end takes the game room with it (whatever the flag says now: never left live).
  if (room?.parentRoomId) await afterLaneEnded(room.parentRoomId);
}

/** The host is gone (left, crashed, server restarted): end the room unless they come back within the grace period. */
function scheduleEnd(roomId: string) {
  clearTimeout(endTimers.get(roomId));
  const t = setTimeout(() => { endRoom(roomId).catch((e) => console.error("[rooms] auto-end failed:", e)); }, tuning.graceMs);
  t.unref?.();
  endTimers.set(roomId, t);
}

/** A room was just started over REST: its host has the grace period to show up on the socket, or the room ends. */
export function expectHost(roomId: string) { scheduleEnd(roomId); }

/** After a restart nobody is in the hub: any live room whose host does not reconnect in time is ended. */
export async function rehydrateLiveRooms(): Promise<void> {
  const live = await rs.listLiveRooms();
  // Gaming: a game room with a live lane is never joined (its host is in their lane), so it is not timed out here; its last
  // lane ending ends it (afterLaneEnded).
  const parentsWithLiveLane = new Set(live.map((r) => r.parentRoomId).filter((x): x is string => !!x));
  for (const room of live) if (!parentsWithLiveLane.has(room.id) && !roomHub.get(room.id, room.hostId)) scheduleEnd(room.id);
  await sweepMinorsVoiceAtBoot(live).catch((e) => console.error("[voice] boot sweep failed:", e?.message ?? e));
}

/**
 * LiveKit sessions outlive a restart, and the regular sweep only covers rooms with someone in the hub. At boot, every live
 * minors' room with voice on drops any LiveKit participant who is not a teen (adults never speak there; unknown age never
 * speaks). Teens are left connected; everyone rejoins the hub through the gated room:join as usual.
 */
export async function sweepMinorsVoiceAtBoot(live: Room[]): Promise<void> {
  const svc = getVoiceService();
  if (!svc) return;
  const err = (what: string) => (e: unknown) => console.error(`[voice] boot sweep ${what} failed:`, e instanceof Error ? e.message : e);
  for (const room of live) {
    try {
      if (!room.minorsRoom || !room.voiceEnabled) continue;
      const present = await svc.listParticipants(room.id);
      for (const p of present) {
        try {
          const age = ageFromDob((await storage.getUser(p.identity))?.dateOfBirth);
          if (age === null || age >= 18) await svc.removeParticipant(room.id, p.identity);
        } catch (e) { err("participant")(e); } // one participant failing never stops the others
      }
    } catch (e) { err("room")(e); } // nor one room the rest
  }
}

// ---------------------------------------------------------------- leave
async function leaveRoom(userId: string, roomId: string) {
  clearAway(roomId, userId);
  await dropFromVoice(roomId, userId, true); // leaving keeps the stage right for a reconnect; must run while the room's voice flag still exists
  const m = roomHub.leave(roomId, userId);
  joinedSockets.delete(userId);
  forgetSlowIfEmpty(roomId);
  await rs.markLeft(roomId, userId).catch(() => {});
  if (!m) return;
  roomHub.broadcast(roomId, { type: "room:left", userId });
  await reconcileVoice(roomId).catch((e) => console.error("[voice] reconcile failed:", e?.message ?? e)); // an adult leaving can give teen hosts their voice back
  if (m.role === "host") scheduleEnd(roomId);
}

export async function handleSocketClose(userId: string, ws: RoomClient): Promise<void> {
  const set = joinedSockets.get(userId);
  if (!set?.has(ws)) return;
  set.delete(ws);
  Array.from(set).forEach((x) => { if (x.readyState !== OPEN) set.delete(x); }); // sockets that died mid-join
  if (set.size > 0) return; // another tab of theirs is still in the room
  const roomId = roomHub.roomOf(userId);
  if (!roomId) { joinedSockets.delete(userId); return; }
  // The person on the live screen keeps their spot while their connection comes back (a performer must not lose the stream to a blip).
  const me = roomHub.get(roomId, userId);
  if (me && roomHub.liveVideoOn(roomId) && roomHub.liveOf(roomId).holder === userId) {
    me.away = { until: Date.now() + tuning.liveGraceMs };
    broadcastLive(roomId);
    clearAway(roomId, userId);
    const t = setTimeout(() => { releaseAwayMember(roomId, userId).catch((e) => console.error("[rooms] away release failed:", e)); }, tuning.liveGraceMs);
    t.unref?.();
    awayTimers.set(`${roomId}:${userId}`, t);
    return;
  }
  // Gaming: a player keeps their slot ("Reconnecting") for the room's drop timeout; 0 = held until the host acts (no timer).
  if (me && isGamePlayer(roomId, userId)) {
    const set = roomHub.gameInfo(roomId)?.dropMs ?? LIVE_HOLD_MS;
    // A host is never held forever: the room must still end if they never come back (then the usual grace runs as well).
    const ms = set > 0 ? (tuning.gameDropMs ?? set) : me.role === "host" ? tuning.graceMs : 0;
    me.away = { until: ms > 0 ? Date.now() + ms : 0 };
    broadcastGame(roomId);
    clearAway(roomId, userId);
    if (ms > 0) {
      const t = setTimeout(() => { releaseDroppedPlayer(roomId, userId).catch((e) => console.error("[rooms] game drop release failed:", e)); }, ms);
      t.unref?.();
      awayTimers.set(`${roomId}:${userId}`, t);
    }
    return;
  }
  await leaveRoom(userId, roomId);
}

/** Gaming: a player's drop timeout ran out. If they really are let go (they did not come back first), the room is told. */
async function releaseDroppedPlayer(roomId: string, userId: string): Promise<void> {
  const name = nameOf(roomHub.get(roomId, userId));
  if (await releaseAwayMember(roomId, userId)) gameLine(roomId, userId, `${name} has dropped out`, "game_drop");
}

/**
 * The hold ran out, or the screen was taken from someone who is away: they leave exactly as if they had disconnected.
 * Runs on the same per-user chain as joins, and looks again once it has its turn: a holder who came back in the meantime
 * (and has a socket again) must never be removed by a release that was queued before they returned.
 */
async function releaseAwayMember(roomId: string, userId: string): Promise<boolean> {
  clearAway(roomId, userId);
  const prev = joinLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const me = roomHub.get(roomId, userId);
    if (!me?.away) return false;                                  // they came back first
    if ((joinedSockets.get(userId)?.size ?? 0) > 0) return false; // a socket of theirs is attached again
    await leaveRoom(userId, roomId);
    return true;
  });
  const tail = run.then(() => undefined, () => undefined);
  joinLocks.set(userId, tail);
  try { return await run; } finally { if (joinLocks.get(userId) === tail) joinLocks.delete(userId); }
}
registerAwayReleaser(async (roomId, userId) => { await releaseAwayMember(roomId, userId); });

// ---------------------------------------------------------------- join
/** Gaming: null when this is not a game room with lanes; else the viewer's lane, or the code to refuse with. */
async function routeToLane(roomId: string, userId: string, token: string | undefined): Promise<{ roomId: string } | { refuse: string } | null> {
  if (!(await isLaneParent(roomId))) return null;
  const parent = await rs.getRoom(roomId);
  if (!parent || !(await canViewRoom(parent, userId, token))) return { refuse: "NOT_FOUND" };
  if (parent.status === "ended") return { refuse: "ROOM_ENDED" };
  const r = await resolveLaneRoom(roomId, userId);
  if ("roomId" in r) return r;
  return { refuse: r.refused === "NO_AGE" ? "AGE_UNKNOWN" : r.refused === "TOO_YOUNG" ? "AGE_LIMIT" : "NO_LANE" };
}

const JOIN_AGE_CODES = { AGE_UNKNOWN: "AGE_UNKNOWN", AGE_LIMIT: "AGE_LIMIT" } as const;

/**
 * Is there room for one more guest? A free room counts everyone against its capacity (as before).
 * A ticketed room never refuses a ticket holder: every paid seat is honoured, whoever else is inside (a co-host made a
 * guest, a guest whose refund is still being enforced). Paid tickets can never exceed the ticket capacity (the issue path
 * counts them under the room row lock and the PATCH guard never lowers capacity below them), so holders alone cannot
 * overfill it. A guest without a ticket never reaches this check in a ticketed room (TICKET_REQUIRED first); if one ever
 * did, guests are counted against the ticket capacity (fail closed).
 * Synchronous (hub only), so it can sit between the door checks and the hub insert.
 */
export function roomIsFull(roomId: string, room: Room, holdsTicket: boolean): boolean {
  if (!isTicketedRoom(room)) return roomHub.count(roomId) >= room.capacity;
  if (holdsTicket) return false;
  return roomHub.members(roomId).filter((m) => m.role === "guest").length >= roomCapacity(room);
}

async function sendState(ws: RoomClient, room: Room, you: HubMember) {
  direct(ws, {
    type: "room:state",
    // The settings as the room has them now (a change that landed during the join is already in the live copy).
    room: { ...viewerRoom(room), ...settingsOf(room) },
    members: (() => {
      // A full free room is sent whole. Past that, the host must still see (and act on) everyone on stage or asking, and
      // everyone in the recent chat must resolve to a person, or their name would read "Someone" and could not be reported.
      const s = roomHub.stageOf(room.id);
      const live = roomHub.liveOf(room.id);
      // Gaming: players and people asking to play are wanted too (none while the flag is off).
      const g = roomFeatures.gaming ? roomHub.gameOf(room.id) : null;
      const gameIds = g ? [...playersOf(g), ...g.asks.map((a) => a.userId)] : [];
      const wanted = wantedMemberIds({ stage: s.stage, hands: s.hands, asks: [...live.asks, ...gameIds], holder: live.holder, chat: roomHub.recentChat(room.id) });
      return selectStateMembers(roomHub.members(room.id), MEMBER_LIST_CAP, wanted).map(memberPayload);
    })(),
    serverNowMs: Date.now(),
    memberCount: roomHub.count(room.id),
    screen: room.screen ?? null,
    you: { role: you.role, muted: you.muted },
    voiceEnabled: room.voiceEnabled,
    ...(() => { const s = roomHub.stageOf(room.id); return { stage: s.stage, hands: s.hands }; })(),
    ...roomHub.liveOf(room.id),
    away: liveAway(room.id),
    nowPlaying: room.nowPlaying ?? null,
    // Gaming: only while the flag is on and the room is a game room, so every other room:state is unchanged.
    ...(roomFeatures.gaming && roomHub.gameOn(room.id) ? { game: gameView(room.id) } : {}),
  });
}

async function doJoin(ws: RoomClient, userId: string, msg: any) {
  // One join at a time per user: two concurrent joins (two tabs, two rooms) would otherwise interleave their awaits.
  const prev = joinLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(() => joinOnce(ws, userId, msg)).catch((e) => { console.error("[rooms] join failed:", e); refuse(ws, "SERVER_ERROR"); });
  const tail = run.then(() => undefined);
  joinLocks.set(userId, tail);
  await run;
  if (joinLocks.get(userId) === tail) joinLocks.delete(userId);
}

async function joinOnce(ws: RoomClient, userId: string, msg: any) {
  let roomId = typeof msg.roomId === "string" && msg.roomId.length <= 64 ? msg.roomId : null;
  if (!roomId) return refuse(ws, "NOT_FOUND");
  if (!bucketsFor(userId).join.take()) return notice(ws, "RATE_LIMITED");
  // Gaming: a game room with age lanes is never joined itself. Someone who may see it goes to their own lane (by the date of
  // birth on file), and from here on that lane's own door decides everything, exactly like a direct join of the lane.
  if (roomFeatures.gaming) {
    const routed = await routeToLane(roomId, userId, typeof msg.inviteToken === "string" ? msg.inviteToken : undefined);
    if (routed && "refuse" in routed) return refuse(ws, routed.refuse);
    if (routed) roomId = routed.roomId;
  }
  const [room, user, member] = await Promise.all([rs.getRoom(roomId), storage.getUser(userId), rs.getMember(roomId, userId)]);
  if (!room || !user || user.deletedAt || (await storage.getActiveSuspension(userId))) return refuse(ws, "NOT_FOUND");
  if (room.status === "ended") return refuse(ws, "ROOM_ENDED");
  if (room.status !== "live") return refuse(ws, "ROOM_NOT_LIVE");
  if (member?.banned) return refuse(ws, "BANNED");
  if ((kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now()) return refuse(ws, "KICKED");
  const token = typeof msg.inviteToken === "string" ? msg.inviteToken : undefined;
  // Includes the block check: a blocked person gets the same answer as for a room that doesn't exist. In a minors' room an
  // adult without an acknowledged personal invite is refused here with the warning (an invite link alone is not enough).
  const view = await viewRoom(room, userId, token);
  if (!view.ok) {
    if (view.code === "NOT_FOUND" || view.code === "AGE_UNKNOWN") return refuse(ws, view.code);
    return direct(ws, minorsError(view.code, room));
  }
  const gate = canJoinRoom({ age: ageFromDob(user.dateOfBirth) }, room as any);
  if (!gate.ok) return refuse(ws, JOIN_AGE_CODES[gate.code]);

  // Lock pre-check, BEFORE the joiner is taken out of the room they are in: someone the lock refuses must stay where they
  // are. Same rule and exemptions as the authoritative check at the hub insert below, which still decides from fresh reads.
  // The live copy is the newest value when there is one (written right after every committed change), else this row read.
  if (!roomHub.get(roomId, userId) && (roomSettings.get(roomId)?.locked ?? room.locked) === true) {
    // If the hub knows the room became a minors' room after this row was read, the minors' gate below must speak first
    // (the lock never answers in its place there), so the pre-check stands aside.
    if (room.minorsRoom || !roomHub.isMinorsRoom(roomId)) {
      const age = ageFromDob(user.dateOfBirth);
      // In a minors' room, viewRoom above only lets an adult through with an acknowledged personal invite.
      const invite = room.minorsRoom && age !== null && age >= 18 ? { invited: true, acknowledged: true } : NO_INVITE;
      const admits = lockAdmits({ userId, room, member, minorsRoom: room.minorsRoom, age, invite, now: Date.now(), rejoinMs: tuning.lockRejoinMs });
      if (!admits) return refuse(ws, "ROOM_LOCKED");
    }
  }

  // Paid rooms, pre-check: after the minors' gate, the age limit and the lock, and BEFORE the joiner is taken out of the room
  // they are in (someone without a ticket stays where they are). The bare code only: never a price. Stands aside when the hub
  // knows the room became a minors' room after this row was read (the minors' gate below must speak first). The
  // authoritative check is next to the hub insert, on fresh reads.
  if (isTicketedRoom(room) && userId !== room.hostId && !(member && !member.banned && member.role === "cohost")
    && (room.minorsRoom || !roomHub.isMinorsRoom(roomId))
    && !(await hasPaidTicket(roomId, userId))) {
    return refuse(ws, "TICKET_REQUIRED");
  }

  const current = roomHub.roomOf(userId);
  if (current && current !== roomId) await leaveRoom(userId, current); // one room at a time

  // Everything above can take a while on a slow database. Re-read what can change meanwhile, then do the
  // capacity check and the hub insert with no await between them, so concurrent joins cannot overshoot.
  // The minors' room invite is re-read too: a revoke that landed during the awaits above must keep them out.
  // The user is re-read as well: an admin birthdate correction during the awaits must decide with the new age.
  // The invite is always read: the room may become a minors' room (host corrected to under 18) while we wait.
  // The paid ticket is re-read too: a ticket refunded during the awaits above must not admit.
  const [fresh, freshMember, freshInvite, freshUser, freshTicket] = await Promise.all([
    rs.getRoom(roomId), rs.getMember(roomId, userId), getInviteState(roomId, userId), storage.getUser(userId), hasPaidTicket(roomId, userId),
  ]).catch(async (e) => {
    // The host's own lookup failed: nothing can be trusted about this room's flag. Fail closed: close it (neutral notice).
    if (userId === room.hostId) await endForHostReview(roomId).catch((e2) => console.error("[rooms] closing a room after a host lookup failure failed:", e2));
    throw e;
  });
  if (testHooks.afterFreshRead) await testHooks.afterFreshRead(roomId, userId);
  const freshAge = ageFromDob(freshUser?.dateOfBirth);
  if (ws.readyState !== OPEN) return; // the socket died while we were checking: do not create a ghost
  if (!fresh || fresh.status === "ended") return refuse(ws, "ROOM_ENDED");
  if (fresh.status !== "live") return refuse(ws, "ROOM_NOT_LIVE");
  if (freshMember?.banned) return refuse(ws, "BANNED");
  if ((kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now()) return refuse(ws, "KICKED");
  if (!freshUser || freshUser.deletedAt) return refuse(ws, "NOT_FOUND");
  if (!canJoinRoom({ age: freshAge }, fresh as any).ok) return refuse(ws, freshAge === null ? "AGE_UNKNOWN" : "AGE_LIMIT"); // limit raised meanwhile
  // Host-age invariant, checked at the door whatever the correction job did or failed to do (it can fail, and it cannot see a
  // room whose host is disconnected): a minors' room never has an adult host, and a teen host's room is always a minors' room.
  // Fail closed: any problem closes the room with the neutral notice.
  if (userId === fresh.hostId) {
    try {
      const hostIsTeen = freshAge !== null && freshAge < 18;
      if (fresh.minorsRoom && !hostIsTeen) {
        await endForHostReview(roomId);
        return refuse(ws, "ROOM_ENDED");
      }
      if (hostIsTeen && !fresh.minorsRoom) {
        // Flag it (database and hub) and take out every adult without an acknowledged invite. The warning is right here: the
        // room genuinely is a teen host's.
        const problems: DobStepFailure[] = [];
        const flagged = await enforceMinorsHost(userId, problems);
        if (problems.length || !flagged.includes(roomId)) {
          await endForHostReview(roomId);
          return refuse(ws, "ROOM_ENDED");
        }
        fresh.minorsRoom = true;
      }
    } catch (e) {
      console.error(`[rooms] host-age check failed (user ${userId}, room ${roomId}):`, e);
      await endForHostReview(roomId).catch((e2) => console.error("[rooms] closing the room failed:", e2));
      return refuse(ws, "ROOM_ENDED");
    }
  }
  // The hub flag is set (synchronously) by a host correction right after its UPDATE commits, and is never cleared while the
  // room lives, so a row read that predates the correction cannot let an uninvited adult in. No await from here to the insert.
  const mg = minorsGate({ minorsRoom: fresh.minorsRoom || roomHub.isMinorsRoom(roomId), hostId: fresh.hostId }, userId, freshAge, freshInvite);
  if (!mg.ok) return direct(ws, minorsError(mg.code, fresh));
  // Room lock, decided here next to the minors' gate: still no await from here to the hub insert. Only NEW joiners are
  // stopped (someone already in the hub is a second tab or a reconnect). A lock that committed while we were awaiting is in
  // the fresh row or in the live copy (notifySettings runs right after the write), so either one saying "locked" locks.
  // Who still gets in (roomLock.ts): host, co-hosts, an acknowledged adult invite to a minors' room, a member of this live
  // session back within the rejoin window. NOT the invite link: in an invite-only room every joiner holds it.
  if (!roomHub.get(roomId, userId) && (fresh.locked || roomSettings.get(roomId)?.locked === true)) {
    const admits = lockAdmits({
      userId, room: fresh, member: freshMember, minorsRoom: fresh.minorsRoom || roomHub.isMinorsRoom(roomId),
      age: freshAge, invite: freshInvite, now: Date.now(), rejoinMs: tuning.lockRejoinMs,
    });
    if (!admits) return refuse(ws, "ROOM_LOCKED");
  }
  // Paid rooms: the ticket check, last of the door checks (after the minors' gate, the age limit and the lock), still with
  // no await before the hub insert. Decided from the fresh reads: a ticket refunded before them does not admit, and a room
  // made ticketed meanwhile is respected. Host and co-hosts (fresh member row) never need one; banned and kicked people were
  // refused above. Applies to a second tab too (a refunded holder's new tab is refused; enforceTicketFor removes the rest).
  if (isTicketedRoom(fresh) && userId !== fresh.hostId && freshMember?.role !== "cohost" && !freshTicket) return refuse(ws, "TICKET_REQUIRED");

  const role = userId === fresh.hostId ? "host" : freshMember?.role === "cohost" ? "cohost" : "guest";
  let me = roomHub.get(roomId, userId);
  const isNew = !me;
  if (!me) {
    if (role === "guest" && roomIsFull(roomId, fresh, freshTicket)) return refuse(ws, "ROOM_FULL");
    me = { userId, role, muted: freshMember?.muted ?? false, joinedAt: Date.now(), send: (m) => fanout(userId, m), info: memberInfo(freshUser), age: freshAge };
    roomHub.join(roomId, me);
    if (fresh.minorsRoom) roomHub.markMinorsRoom(roomId); // before any stage decision for this room
    // Phase 6 recap: a new busiest moment is written at once (conditional, never lowers it), fire-and-forget, no await.
    const peak = roomHub.recordPeak(roomId);
    if (peak !== null) void rs.raisePeak(roomId, peak).catch((e) => console.error("[rooms] peak write failed:", roomId, e?.message ?? e));
    // Only the first person in sets the room's flags from the database. Once anyone is in, the voice / live-video routes keep
    // them current, and this joiner's row may predate a switch-off: writing it would turn voice or the camera back on.
    if (roomHub.count(roomId) === 1) {
      roomHub.setVoiceOn(roomId, fresh.voiceEnabled);
      roomHub.setLiveVideoOn(roomId, fresh.voiceEnabled && fresh.liveVideo);
      syncGameRoom(fresh); // gaming: nothing while the flag is off
    }
    roomHub.broadcast(roomId, { type: "room:joined", member: memberPayload(me) }, userId);
  }
  // Set only if absent: a newer value written by notifySettings is never replaced by this join's (possibly older) row.
  if (!roomSettings.has(roomId)) rememberSettings(roomId, settingsFromRow(fresh));
  // Register the socket in the same synchronous block as the hub insert: a close during the awaits below must find it,
  // otherwise the member would stay in the room forever.
  let set = joinedSockets.get(userId);
  if (!set) { set = new Set(); joinedSockets.set(userId, set); }
  set.add(ws);
  if (me.away) { // the holder is back inside the hold window: the stream carries on
    const player = isGamePlayer(roomId, userId); // gaming: a player back inside their drop timeout keeps the slot
    delete me.away;
    clearAway(roomId, userId);
    if (!player || roomHub.liveOf(roomId).holder === userId) broadcastLive(roomId);
    if (player) { broadcastGame(roomId); gameLine(roomId, userId, `${nameOf(me)} is back`, "game_back"); }
  }
  if (role === "host") { clearTimeout(endTimers.get(roomId)); endTimers.delete(roomId); }
  if (isNew) {
    me.ready = (async () => {
      try {
        await restoreStageOnJoin(roomId, userId, freshMember?.onStage === true);
        await reconcileVoice(roomId); // an adult arriving takes teen speakers off the stage
      } catch (e) { console.error("[voice] join reconcile failed:", e instanceof Error ? e.message : e); }
    })();
    await me.ready;
  }
  if (ws.readyState !== OPEN) return; // closed while we were busy: handleSocketClose already ran and removed them
  // The joiner is told the room's flags as the hub has them, not as their (possibly older) row had them.
  await sendState(ws, { ...fresh, voiceEnabled: roomHub.voiceOn(roomId), liveVideo: roomHub.liveVideoOn(roomId) }, me);
  await rs.upsertMember(roomId, userId, role).catch((e) => console.error("[rooms] upsertMember failed:", e));
}

// ---------------------------------------------------------------- moderation (also used by the REST ban route)
export type ModAction = "mute" | "unmute" | "kick" | "ban";

/** Removes a user from the live room and tells everyone. Persisting (ban/mute) is the caller's job. */
async function evict(roomId: string, targetId: string) {
  const tm = roomHub.get(roomId, targetId);
  if (!tm) return;
  clearAway(roomId, targetId); // a kicked or banned holder who was away has no hold left to run out
  await dropFromVoice(roomId, targetId, false); // removed: out of LiveKit and the stage right is gone (before the voice flag can vanish with the last member)
  roomHub.leave(roomId, targetId);
  joinedSockets.delete(targetId);
  forgetSlowIfEmpty(roomId);
  await rs.markLeft(roomId, targetId).catch(() => {});
  roomHub.broadcast(roomId, { type: "room:left", userId: targetId });
  await reconcileVoice(roomId).catch((e) => console.error("[voice] reconcile failed:", e?.message ?? e));
}

/** Applies a moderation action. The caller has already authorised the actor. */
export async function applyMod(roomId: string, action: ModAction, targetId: string): Promise<void> {
  const tm = roomHub.get(roomId, targetId);
  if (action === "mute" || action === "unmute") {
    await rs.setMemberFlag(roomId, targetId, { muted: action === "mute" });
    if (tm) tm.muted = action === "mute";
    roomHub.broadcast(roomId, { type: "room:mod", action, targetId });
    return;
  }
  if (action === "ban" || action === "kick") roomHub.markUnquotable(roomId, targetId); // lines stay for reports, but cannot be quoted
  if (action === "ban") {
    await rs.setMemberFlag(roomId, targetId, { banned: true });
    await revokeInvite(roomId, targetId); // a ban ends a minors' room adult invite for good: unbanning does not bring it back
    await rs.setOnStage(roomId, targetId, false);
    // Even if they are not in the room right now: a token they still hold must not get them back into the audio.
    if (!tm) await getVoiceService()?.removeParticipant(roomId, targetId).catch((e) => console.error("[voice] removeParticipant failed:", e?.message ?? e));
  }
  if (action === "kick") {
    kicked.set(`${roomId}:${targetId}`, Date.now() + tuning.kickMs);
    // A kicked co-host comes back (if ever) as a guest: no pinned-message edits, no co-host pass through a lock.
    await dropCohostRole(roomId, targetId);
    if (tm && tm.role === "cohost") tm.role = "guest";
  }
  if (tm) {
    tm.send({ type: "room:mod", action, targetId }); // the target hears it before being removed
    roomHub.broadcast(roomId, { type: "room:mod", action, targetId }, targetId);
    await evict(roomId, targetId);
  }
}

async function doMod(ws: RoomClient, userId: string, roomId: string, msg: any) {
  const me = roomHub.get(roomId, userId);
  const action = msg.action as ModAction;
  const targetId = typeof msg.targetId === "string" ? msg.targetId : "";
  if (!me || (me.role !== "host" && me.role !== "cohost")) return notice(ws, "FORBIDDEN");
  if (!["mute", "unmute", "kick", "ban"].includes(action) || !targetId) return notice(ws, "BAD_REQUEST");
  const room = await rs.getRoom(roomId);
  if (!room) return notice(ws, "NOT_FOUND");
  const tm = roomHub.get(roomId, targetId);
  const targetRole = targetId === room.hostId ? "host" : tm?.role ?? (await rs.getMember(roomId, targetId))?.role ?? "guest";
  if (targetId === userId || targetRole === "host" || (me.role === "cohost" && targetRole === "cohost")) return notice(ws, "FORBIDDEN");
  if (!tm && action !== "ban") return notice(ws, "TARGET_GONE");
  await applyMod(roomId, action, targetId);
}

// ---------------------------------------------------------------- interact
/** The one place that decides whether `actor` may do a direct thing to `target`: used by the socket and by the REST helpers. */
export async function interactionVerdict(room: Pick<Room, "noDirectInteractions">, actorId: string, targetId: string) {
  // Checked first so a block can't be inferred from a different answer in rooms that allow no direct interaction at all.
  if (room.noDirectInteractions) return { ok: false as const, code: "ROOM_NO_DIRECT" };
  const [actorU, targetU, blocked, mutual] = await Promise.all([
    storage.getUser(actorId), storage.getUser(targetId), isBlockedEitherWay(actorId, targetId), mutualFollow(actorId, targetId),
  ]);
  if (!actorU || !targetU) return { ok: false as const, code: "TARGET_GONE" };
  const v = canInteract(
    { age: ageFromDob(actorU.dateOfBirth), privacy: resolveRoomPrivacy(actorU.roomPrivacy) },
    { age: ageFromDob(targetU.dateOfBirth), privacy: resolveRoomPrivacy(targetU.roomPrivacy) },
    { noDirectInteractions: room.noDirectInteractions }, { blocked, mutualFollow: mutual },
  );
  if (v.ok) return { ok: true as const, target: targetU };
  // Neither a block nor an age band is ever revealed to the person acting: both read as the target's privacy setting.
  return { ok: false as const, code: v.code === "BLOCKED" || v.code === "AGE_BAND" ? "PRIVACY" : v.code };
}

async function doInteract(ws: RoomClient, userId: string, roomId: string, msg: any) {
  const targetId = typeof msg.targetId === "string" ? msg.targetId : "";
  const kind = msg.kind;
  if ((kind !== "wave" && kind !== "reaction") || !targetId || targetId === userId) return notice(ws, "BAD_REQUEST");
  if (kind === "reaction" && !ROOM_REACTIONS.includes(msg.emoji)) return; // dropped
  const target = roomHub.get(roomId, targetId);
  if (!target) return notice(ws, "TARGET_GONE");

  const b = bucketsFor(userId);
  let tb = b.interact.get(targetId);
  if (!tb) { tb = new TokenBucket(tuning.interact.rate, tuning.interact.burst); b.interact.set(targetId, tb); }
  if (!tb.take()) return notice(ws, "RATE_LIMITED");

  const room = await rs.getRoom(roomId);
  if (!room) return notice(ws, "TARGET_GONE");
  const verdict = await interactionVerdict(room, userId, targetId);
  if (!verdict.ok) return notice(ws, verdict.code);

  const out = { type: "room:interact", fromId: userId, targetId, kind, ...(kind === "reaction" ? { emoji: msg.emoji } : {}) };
  if (kind === "wave") roomHub.broadcast(roomId, out);
  else target.send(out);
}

/** The door policy was raised on a live room: anyone inside who no longer meets it is sent out now. */
export async function enforceAgeLimit(roomId: string): Promise<void> {
  const room = await rs.getRoom(roomId);
  if (!room) return;
  for (const m of roomHub.members(roomId)) {
    if (m.userId === room.hostId) continue;
    const u = await storage.getUser(m.userId);
    if (u && canJoinRoom({ age: ageFromDob(u.dateOfBirth) }, room as any).ok) continue;
    m.send({ type: "room:error", code: "AGE_LIMIT" });
    await evict(roomId, m.userId);
  }
}

/**
 * Minors' room: takes an adult who may no longer be there out of the live room, with the warning. Waits for any join of
 * theirs that is in flight first (joins run one at a time per user), so a join that read the invite just before it was
 * revoked is undone here instead of slipping in; a join that starts later reads the revoke and is refused.
 */
export async function removeFromMinorsRoom(roomId: string, userId: string): Promise<void> {
  await (joinLocks.get(userId) ?? Promise.resolve());
  await dropCohostRole(roomId, userId);
  const tm = roomHub.get(roomId, userId);
  if (!tm) {
    // Not in the room: a voice token they may still hold must not get them back into the audio.
    await getVoiceService()?.removeParticipant(roomId, userId).catch((e) => console.error("[voice] removeParticipant failed:", e?.message ?? e));
    return;
  }
  roomHub.markUnquotable(roomId, userId);
  tm.send(minorsError("MINORS_ROOM", { ageLane: roomHub.gameInfo(roomId)?.ageLane ?? null })); // the person hears why before being removed
  await evict(roomId, userId);
}

/** A birthdate was corrected: if that person is in a minors' room they may no longer be let into, they are taken out. */
export async function enforceMinorsRoomFor(userId: string): Promise<void> {
  await (joinLocks.get(userId) ?? Promise.resolve()); // a join in flight finishes first (it re-reads the birthdate itself)
  const roomId = roomHub.roomOf(userId);
  if (!roomId) return;
  const [room, user, invite] = await Promise.all([rs.getRoom(roomId), storage.getUser(userId), getInviteState(roomId, userId)]);
  if (!room?.minorsRoom || !user) return;
  if (!minorsGate(room, userId, ageFromDob(user.dateOfBirth), invite).ok) await removeFromMinorsRoom(roomId, userId);
}

/**
 * Paid rooms: call after a ticket is refunded (server/rooms/refunds.ts). Waits for any join of theirs in flight (that join
 * may have read the ticket before the refund committed), then, if they are in that ticketed room as a guest and no longer
 * hold a paid ticket, tells them TICKET_REQUIRED (no price) and removes them. Host and co-hosts are never removed by this.
 * Returns true when someone was removed.
 */
export async function enforceTicketFor(roomId: string, userId: string): Promise<boolean> {
  await (joinLocks.get(userId) ?? Promise.resolve());
  const tm = roomHub.get(roomId, userId);
  if (!tm || tm.role !== "guest") return false;
  const [room, paid] = await Promise.all([rs.getRoom(roomId), hasPaidTicket(roomId, userId)]);
  if (!room || room.hostId === userId || !isTicketedRoom(room) || paid) return false;
  const now = roomHub.get(roomId, userId);
  if (!now || now.role !== "guest") return false; // left, or was made a co-host, while we looked
  now.send({ type: "room:error", code: "TICKET_REQUIRED" });
  await evict(roomId, userId);
  return true;
}

/** A step (or one room or member inside a step) of a birthdate correction that threw. roomId is null when there is no room. */
export type DobStepFailure = { step: string; roomId: string | null };

/** Thrown by applyDobCorrection after every step has run, when at least one failed. The birthdate itself is already saved. */
export class DobCorrectionIncomplete extends Error {
  readonly failedRoomIds: string[];
  constructor(readonly failures: DobStepFailure[]) {
    const ids = Array.from(new Set(failures.map((f) => f.roomId).filter((x): x is string => !!x)));
    super(`ROOMS_NOT_UPDATED: ${failures.length} step(s) failed${ids.length ? `; rooms: ${ids.join(", ")}` : ""}`);
    this.name = "DobCorrectionIncomplete";
    this.failedRoomIds = ids;
  }
}

/**
 * Runs one piece of a birthdate correction on its own: a throw is logged with the user id and room id, recorded in
 * `failures`, and the caller carries on with the next piece. Returns undefined when it threw.
 */
async function attempt<T>(failures: DobStepFailure[], userId: string, step: string, roomId: string | null, fn: () => Promise<T>, onFail?: () => Promise<void>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[rooms] birthdate correction step "${step}" failed (user ${userId}, room ${roomId ?? "none"}):`, e);
    failures.push({ step, roomId });
    if (onFail) await onFail().catch((e2) => console.error(`[rooms] fail-closed fallback for "${step}" failed (user ${userId}, room ${roomId ?? "none"}):`, e2));
    return undefined;
  }
}

/** Plain notice to a person removed because a safety check could not be completed. Says nothing about ages or the room. */
export const REVIEW_REMOVED_MESSAGE = "You were removed from this room while an account change was applied. You can try to join again.";

/** Fail closed: a member whose check could not be completed is taken out (they can come back through the gated join). A host is never taken out here. */
async function evictFailClosed(roomId: string | null, userId: string): Promise<void> {
  if (!roomId) return;
  const tm = roomHub.get(roomId, userId);
  if (!tm || tm.role === "host") return;
  tm.send({ type: "room:notice", code: "REVIEW", message: REVIEW_REMOVED_MESSAGE });
  await dropCohostRole(roomId, userId).catch(() => {});
  await evict(roomId, userId);
}

/** Closes a room for a reviewed host with the neutral notice (no ages, no mention of under 18s). */
async function endForHostReview(roomId: string): Promise<void> {
  roomHub.broadcast(roomId, { type: "room:notice", code: "HOST_REVIEW", message: HOST_REVIEW_MESSAGE });
  await endRoom(roomId, { hostReview: true }); // paid rooms: the host is not paid out; every ticket is refunded
}

/** Fail closed: when the host's rooms cannot be read or flagged, every room the hub knows this person hosts is closed neutrally. */
async function endHostedRoomsFailClosed(hostId: string, failures: DobStepFailure[], step: string): Promise<void> {
  for (const id of roomHub.roomsHostedBy(hostId)) await attempt(failures, hostId, step, id, () => endForHostReview(id));
}

/**
 * Every admin birthdate correction ends here. The person's live age in the hub is refreshed first (the stage rule reads it).
 * Then the protective steps: a host now under 18 has their open rooms made minors' rooms and uninvited adults are taken out;
 * rooms the host may no longer keep are ended. Then the softer ones: the room they are in is reconciled (mic, camera, stage
 * and live screen follow the new age), a member below the room's age limit leaves, and a member who may no longer be in a
 * minors' room is taken out.
 *
 * Each step, and each room inside a step, runs on its own: one that throws is logged and recorded, and the rest still run.
 * If anything failed, DobCorrectionIncomplete is thrown at the end with the failed room ids. Every step is idempotent, so
 * running the correction again finishes whatever failed.
 */
export async function applyDobCorrection(userId: string): Promise<void> {
  await (joinLocks.get(userId) ?? Promise.resolve()); // a join in flight finishes first (it re-reads the birthdate itself)
  const user = await storage.getUser(userId);
  if (!user) return;
  const age = ageFromDob(user.dateOfBirth);
  const roomId = roomHub.roomOf(userId);
  if (roomId) roomHub.refreshAge(roomId, userId, age);
  const failures: DobStepFailure[] = [];

  // Protective first: the rooms they host. Rooms they may no longer host are closed FIRST, with the neutral review notice, so
  // nobody in them ever sees the under-18s warning (which would tell them the host is a child). Flagging skips ended rooms.
  await endRoomsHostCannotKeep(user, age, failures); // an adult loses minors' rooms; anyone loses a room they may no longer host
  if (age !== null && age < 18) await enforceMinorsHost(userId, failures); // flag the rest, take out uninvited adults

  // Softer: the room they are in.
  if (roomId) {
    // Runs even when the age did not change this time: it is idempotent, and a re-run after a failure must still do it.
    await attempt(failures, userId, "reconcile voice", roomId, () => reconcileVoice(roomId));
    await attempt(failures, userId, "age limit", roomId, async () => {
      const room = await rs.getRoom(roomId);
      if (room && room.status === "live" && room.hostId !== userId && roomHub.get(room.id, userId) && !canJoinRoom({ age }, room as any).ok) {
        await removeForAgeLimit(room.id, userId); // corrected below the room's age limit
      }
    }, () => evictFailClosed(roomId, userId));
  }
  await attempt(failures, userId, "minors room member", roomId, () => enforceMinorsRoomFor(userId), () => evictFailClosed(roomHub.roomOf(userId), userId));

  if (failures.length) throw new DobCorrectionIncomplete(failures);
}

/** Message to everyone in a room that is closed because its host's account is under review. Plain, no accusation. */
export const HOST_REVIEW_MESSAGE = "This room has closed because the host's account is being reviewed.";

/**
 * After a birthdate correction: ends (live) or cancels (scheduled) every room of this host that they may no longer host.
 *  - an adult (18 or over) never keeps a minors' room;
 *  - nobody keeps a room they could not create at their corrected age (age limit above them; a teen and a public room).
 * Their other rooms are left alone. One way and idempotent (ended rooms are skipped).
 */
async function endRoomsHostCannotKeep(host: User, age: number | null, failures: DobStepFailure[] = []): Promise<void> {
  // If the list cannot be read, fail closed: every room the hub knows this person hosts is closed.
  const open = await attempt(failures, host.id, "list host rooms", null, () => rs.listOpenRoomsByHost(host.id), () => endHostedRoomsFailClosed(host.id, failures, "end hosted room (list failed)"));
  for (const room of open ?? []) {
    await attempt(failures, host.id, "end room host cannot keep", room.id, async () => {
      const adultInMinorsRoom = room.minorsRoom && (age === null || age >= 18);
      const hc = canHostRoom({ age, accountAgeDays: Number.MAX_SAFE_INTEGER }, { visibility: room.visibility as any, ageLimit: room.ageLimit as any }, { minAccountAgeDays: 0 });
      const cannotHost = !hc.ok && (hc.code === "HOST_BELOW_LIMIT" || hc.code === "TEEN_PUBLIC" || hc.code === "AGE_UNKNOWN");
      if (!adultInMinorsRoom && !cannotHost) return;
      if (room.status === "scheduled" && (await rs.cancelScheduledRoom(room.id))) return; // cancelled: it can never be started
      await endForHostReview(room.id); // live, or it went live while we were deciding
    });
  }
}

/** A member corrected below the room's age limit leaves it now, told why (same code as a raised limit). */
async function removeForAgeLimit(roomId: string, userId: string): Promise<void> {
  await dropCohostRole(roomId, userId);
  const tm = roomHub.get(roomId, userId);
  if (!tm) return;
  tm.send({ type: "room:error", code: "AGE_LIMIT" });
  await evict(roomId, userId);
}

/** Someone removed by a safety rule does not keep a co-host role for a later return (same as the invite-revoke route). */
async function dropCohostRole(roomId: string, userId: string): Promise<void> {
  const m = await rs.getMember(roomId, userId);
  if (m?.role === "cohost") await rs.setMemberRole(roomId, userId, "guest");
}

/**
 * A host's birthdate was corrected to under 18: every room of theirs that has not ended becomes a minors' room (one way,
 * never cleared), and in each live one anyone who may no longer be there (adults without an acknowledged invite, unknown
 * age) is taken out with the warning. Returns the ids of the rooms that were flagged.
 */
export async function enforceMinorsHost(hostId: string, failures: DobStepFailure[] = []): Promise<string[]> {
  // If the flag cannot be written, fail closed: every room the hub knows this person hosts is closed (neutral notice).
  const flagged = await attempt(failures, hostId, "flag minors rooms", null, () => markHostRoomsMinors(hostId), () => endHostedRoomsFailClosed(hostId, failures, "end hosted room (flag failed)"));
  for (const r of flagged ?? []) {
    if (r.status !== "live") continue;
    // Marked (even if empty) and the members snapshotted in the same synchronous step: anyone inserted before this is in the
    // snapshot and gated below; anyone inserted after it is caught by the re-check at the hub insert in joinOnce.
    roomHub.markMinorsRoom(r.id); // the stage rule switches now: teens may speak, adults may not
    for (const m of roomHub.members(r.id)) {
      if (m.userId === hostId) continue;
      await attempt(failures, hostId, "remove uninvited member", r.id, async () => {
        const [u, invite] = await Promise.all([storage.getUser(m.userId), getInviteState(r.id, m.userId)]);
        if (!minorsGate({ minorsRoom: true, hostId }, m.userId, ageFromDob(u?.dateOfBirth), invite).ok) await removeFromMinorsRoom(r.id, m.userId);
      }, () => evictFailClosed(r.id, m.userId)); // the check could not be made: out they go (they can rejoin through the gated join)
    }
    await attempt(failures, hostId, "reconcile voice", r.id, () => reconcileVoice(r.id)); // staged adults off, teens back on mic
  }
  return (flagged ?? []).map((r) => r.id);
}

// ---------------------------------------------------------------- screen
/** A new screen is a new thing to play: tell the room the screen, its version (for playback messages) and that playback reset. */
export function notifyScreen(roomId: string, screen: unknown, screenVersion: number) {
  roomHub.broadcast(roomId, { type: "room:screen", screen, screenVersion });
  roomHub.broadcast(roomId, { type: "room:playback", nowPlaying: null, serverNowMs: Date.now() });
}

async function doScreen(ws: RoomClient, userId: string, roomId: string, msg: any) {
  const me = roomHub.get(roomId, userId);
  if (!me || (me.role !== "host" && me.role !== "cohost")) return notice(ws, "FORBIDDEN");
  const input = typeof msg.screen === "string" ? msg.screen : typeof msg.screen?.url === "string" ? msg.screen.url : null;
  if (msg.screen !== null && !roomFeatures.linkScreens) return notice(ws, "FEATURE_OFF");
  if (msg.screen === null) {
    const cleared = await rs.updateRoom(roomId, { screen: null });
    return notifyScreen(roomId, null, cleared.screenVersion);
  }
  const r = input ? resolveScreen(input) : null;
  if (!r || !r.ok) return notice(ws, "INVALID_SCREEN");
  const updated = await rs.updateRoom(roomId, { screen: r.screen });
  notifyScreen(roomId, r.screen, updated.screenVersion);
}

// ---------------------------------------------------------------- playback sync
async function doPlayback(ws: RoomClient, userId: string, roomId: string, msg: any) {
  if (!roomFeatures.linkScreens) return notice(ws, "FEATURE_OFF");
  const me = roomHub.get(roomId, userId);
  if (!me || (me.role !== "host" && me.role !== "cohost")) return notice(ws, "FORBIDDEN");
  if (!bucketsFor(userId).playback.take()) return notice(ws, "RATE_LIMITED");
  const room = await rs.getRoom(roomId);
  if (!room || room.status !== "live") return notice(ws, "NOT_FOUND");
  const p = sanitizePlaybackInput(msg, room.screenVersion);
  if (!p.ok) return notice(ws, "BAD_REQUEST"); // junk, or a message about a screen that has since been replaced
  const now = Date.now();
  const np: NowPlaying = { v: 1, screenVersion: room.screenVersion, state: p.state, positionMs: p.positionMs, atServerMs: now, ...(p.state === "cue" ? { startAtServerMs: now + (p.inMs ?? 5000) } : {}) };
  await rs.setNowPlaying(roomId, np);
  roomHub.broadcast(roomId, { type: "room:playback", nowPlaying: np, serverNowMs: Date.now() });
}

// ---------------------------------------------------------------- entry point
export async function handleRoomMessage(ws: RoomClient, userId: string, msg: any): Promise<void> {
  try {
    if (msg.type === "room:join") return await doJoin(ws, userId, msg);
    if (msg.type === "room:leave") {
      await (joinLocks.get(userId) ?? Promise.resolve()); // a leave must not slip past a join that is still in flight
      const roomId = roomHub.roomOf(userId);
      if (roomId) await leaveRoom(userId, roomId);
      return;
    }
    const roomId = roomHub.roomOf(userId);
    if (!roomId || !joinedSockets.get(userId)?.has(ws)) return notice(ws, "NOT_IN_ROOM");
    const me = roomHub.get(roomId, userId)!;

    switch (msg.type) {
      case "room:chat": {
        const raw = typeof msg.text === "string" ? msg.text : "";
        if (raw.trim().length < 1 || raw.length > ROOM_LIMITS.chat) return;
        if (me.muted) return notice(ws, "MUTED");
        // Slow mode: per person across all their tabs (keyed by user, not socket), host and co-hosts exempt. Checked before
        // the rate limiter so a refused line does not use up a token. No await in this case: two tabs cannot interleave.
        const now = Date.now();
        const exempt = me.role === "host" || me.role === "cohost";
        const slowSec = exempt ? 0 : (roomSettings.get(roomId)?.slowModeSec ?? 0);
        const wait = slowModeWait(roomId, userId, slowSec, now);
        if (wait > 0) return direct(ws, { type: "room:notice", code: "SLOW_MODE", retryMs: wait });
        if (!bucketsFor(userId).chat.take()) return notice(ws, "RATE_LIMITED");
        const text = plainText(raw);
        if (!text) return;
        if (!exempt) recordSlowChat(roomId, userId, now);
        // The quote is only ever taken from the server's own record of the chat, never from client text or names.
        const replyTo = resolveChatReply(roomHub.recentChat(roomId), validateChatReply(msg.replyTo));
        const line = { userId, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
        roomHub.recordChat(roomId, line);
        roomHub.broadcast(roomId, { type: "room:chat", ...line });
        // Phase 6 recap: the sender's own count, in memory only (batched to the database, review r2 I1).
        rs.countChatLine(roomId, userId);
        return;
      }
      case "room:react": {
        if (!ROOM_REACTIONS.includes(msg.emoji)) return;
        if (!bucketsFor(userId).react.take()) return notice(ws, "RATE_LIMITED");
        roomHub.broadcast(roomId, { type: "room:react", userId, emoji: msg.emoji });
        return;
      }
      case "room:interact": return await doInteract(ws, userId, roomId, msg);
      case "room:screen": return await doScreen(ws, userId, roomId, msg);
      case "room:playback": return await doPlayback(ws, userId, roomId, msg);
      case "room:stage": {
        if (!bucketsFor(userId).stage.take()) return notice(ws, "RATE_LIMITED");
        const r = await handleStage(userId, roomId, msg);
        if (!r.ok) notice(ws, r.code);
        return;
      }
      case "room:live": {
        if (!bucketsFor(userId).stage.take()) return notice(ws, "RATE_LIMITED");
        const r = await handleLive(userId, roomId, msg);
        if (!r.ok) notice(ws, r.code);
        return;
      }
      case "room:mod": return await doMod(ws, userId, roomId, msg);
      case "room:game": {
        // Gaming: refused whole while the flag is off (a stale client after the flag was turned off gets the same answer).
        if (!roomFeatures.gaming) return notice(ws, "FEATURE_OFF");
        if (!bucketsFor(userId).stage.take()) return notice(ws, "RATE_LIMITED");
        const r = await handleGame(userId, roomId, msg);
        if (!r.ok) notice(ws, r.code);
        return;
      }
    }
  } catch (e) {
    console.error("[rooms] socket handler failed:", e);
    notice(ws, "SERVER_ERROR");
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** Compares LiveKit with the room every few seconds and removes anyone who should not be there (token replay after a ban or removal). */
export function startVoiceSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { if (tuning.sweepMs > 0 && getVoiceService()) sweepAllVoiceRooms().catch((e) => console.error("[voice] sweep failed:", e?.message ?? e)); }, 10_000);
  sweepTimer.unref?.();
}
