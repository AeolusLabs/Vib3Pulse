// `room:*` messages on the shared /ws server. Every rule is re-checked here from the database; the client's
// slide-out only decides what to offer. Presence lives in RoomHub; bans, mutes and room state are persisted.
import { storage } from "../storage";
import { isBlockedEitherWay } from "../utils/blocks";
import { ageFromDob } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { sanitizePlaybackInput, type NowPlaying } from "@shared/playback";
import { ROOM_LIMITS, ROOM_REACTIONS, resolveRoomPrivacy } from "@shared/rooms";
import { canInteract, canJoinRoom } from "@shared/roomRules";
import type { Room, User } from "@shared/schema";
import * as rs from "./roomStorage";
import { canViewRoom, mutualFollow, plainText, publicRoom } from "./roomAccess";
import { roomHub, type HubMember } from "./RoomHub";
import { TokenBucket } from "./rateLimit";
import { dropFromVoice, handleLive, handleStage, reconcileVoice, restoreStageOnJoin, sweepAllVoiceRooms } from "./stage";
import { getVoiceService } from "./voice/voiceService";
import { roomFeatures } from "./features";

/** Injectable so tests can shorten the host grace period; rates are the documented limits. */
export const tuning = {
  graceMs: 120_000,
  chat: { rate: 1, burst: 5 },
  react: { rate: 3, burst: 3 },
  interact: { rate: 0.5, burst: 1 }, // 1 per 2 s per target
  join: { rate: 0.5, burst: 3 },     // a join is ~6 queries and a broadcast to the whole room
  stage: { rate: 2, burst: 6 },      // raise / lower / accept / invite / remove
  playback: { rate: 4, burst: 8 },   // host play / pause / seek, plus a heartbeat every 5 s
  sweepMs: 10_000,                   // how often LiveKit is compared with the room (0 = off, for tests)
  kickMs: 10 * 60_000,               // a kick keeps the person out this long (a ban is forever)
};

const MEMBER_LIST_CAP = 40;
const OPEN = 1;

export interface RoomClient { send(data: string): void; readyState: number }

/** Sockets that have sent room:join, per user. Messages are accepted only from these; sends fan out to all of them. */
const joinedSockets = new Map<string, Set<RoomClient>>();
type Buckets = { chat: TokenBucket; react: TokenBucket; join: TokenBucket; stage: TokenBucket; playback: TokenBucket; interact: Map<string, TokenBucket>; used: number };
// Not cleared on leave: otherwise leave + rejoin would hand a spammer a fresh burst every cycle. Pruned by age instead.
const buckets = new Map<string, Buckets>();
const kicked = new Map<string, number>(); // `${roomId}:${userId}` -> until (ms)
const joinLocks = new Map<string, Promise<void>>(); // one join at a time per user
const endTimers = new Map<string, ReturnType<typeof setTimeout>>();

const wire = (msg: object) => JSON.stringify(msg);
function fanout(userId: string, msg: object) {
  const data = wire(msg);
  Array.from(joinedSockets.get(userId) ?? []).forEach((s) => { if (s.readyState === OPEN) s.send(data); });
}
const direct = (ws: RoomClient, msg: object) => { if (ws.readyState === OPEN) ws.send(wire(msg)); };
const notice = (ws: RoomClient, code: string) => direct(ws, { type: "room:notice", code });
const refuse = (ws: RoomClient, code: string) => direct(ws, { type: "room:error", code });

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
export async function endRoom(roomId: string): Promise<void> {
  clearTimeout(endTimers.get(roomId));
  endTimers.delete(roomId);
  Array.from(kicked.keys()).forEach((k) => { if (k.startsWith(`${roomId}:`)) kicked.delete(k); });
  const room = await rs.getRoom(roomId);
  if (room && room.status !== "ended") await rs.setStatus(roomId, "ended");
  if (room?.voiceEnabled || roomHub.voiceOn(roomId)) {
    await rs.clearStage(roomId).catch(() => {});
    await getVoiceService()?.deleteRoom(roomId).catch((e) => console.error("[voice] deleteRoom failed:", e?.message ?? e));
  }
  for (const m of roomHub.end(roomId)) {
    joinedSockets.delete(m.userId);
  }
  await rs.markAllLeft(roomId).catch(() => {});
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
  for (const room of await rs.listLiveRooms()) if (!roomHub.get(room.id, room.hostId)) scheduleEnd(room.id);
}

// ---------------------------------------------------------------- leave
async function leaveRoom(userId: string, roomId: string) {
  await dropFromVoice(roomId, userId, true); // leaving keeps the stage right for a reconnect; must run while the room's voice flag still exists
  const m = roomHub.leave(roomId, userId);
  joinedSockets.delete(userId);
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
  if (roomId) await leaveRoom(userId, roomId);
  else joinedSockets.delete(userId);
}

// ---------------------------------------------------------------- join
const JOIN_AGE_CODES = { AGE_UNKNOWN: "AGE_UNKNOWN", AGE_LIMIT: "AGE_LIMIT" } as const;

async function sendState(ws: RoomClient, room: Room, you: HubMember) {
  direct(ws, {
    type: "room:state",
    room: publicRoom(room),
    members: (() => {
      // The list is capped, but the host must always be able to see (and take the mic from) everyone on stage or asking for it.
      const first = roomHub.members(room.id, MEMBER_LIST_CAP);
      const s = roomHub.stageOf(room.id);
      const live = roomHub.liveOf(room.id);
      const wanted = new Set([...s.stage, ...s.hands, ...live.asks, ...(live.holder ? [live.holder] : [])]);
      const have = new Set(first.map((m) => m.userId));
      return [...first, ...roomHub.members(room.id).filter((m) => wanted.has(m.userId) && !have.has(m.userId))].map(memberPayload);
    })(),
    serverNowMs: Date.now(),
    memberCount: roomHub.count(room.id),
    screen: room.screen ?? null,
    you: { role: you.role, muted: you.muted },
    voiceEnabled: room.voiceEnabled,
    ...(() => { const s = roomHub.stageOf(room.id); return { stage: s.stage, hands: s.hands }; })(),
    ...roomHub.liveOf(room.id),
    nowPlaying: room.nowPlaying ?? null,
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
  const roomId = typeof msg.roomId === "string" && msg.roomId.length <= 64 ? msg.roomId : null;
  if (!roomId) return refuse(ws, "NOT_FOUND");
  if (!bucketsFor(userId).join.take()) return notice(ws, "RATE_LIMITED");
  const [room, user, member] = await Promise.all([rs.getRoom(roomId), storage.getUser(userId), rs.getMember(roomId, userId)]);
  if (!room || !user || user.deletedAt || (await storage.getActiveSuspension(userId))) return refuse(ws, "NOT_FOUND");
  if (room.status === "ended") return refuse(ws, "ROOM_ENDED");
  if (room.status !== "live") return refuse(ws, "ROOM_NOT_LIVE");
  if (member?.banned) return refuse(ws, "BANNED");
  if ((kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now()) return refuse(ws, "KICKED");
  const token = typeof msg.inviteToken === "string" ? msg.inviteToken : undefined;
  // Includes the block check: a blocked person gets the same answer as for a room that doesn't exist.
  if (!(await canViewRoom(room, userId, token))) return refuse(ws, "NOT_FOUND");
  const gate = canJoinRoom({ age: ageFromDob(user.dateOfBirth) }, room as any);
  if (!gate.ok) return refuse(ws, JOIN_AGE_CODES[gate.code]);

  const current = roomHub.roomOf(userId);
  if (current && current !== roomId) await leaveRoom(userId, current); // one room at a time

  // Everything above can take a while on a slow database. Re-read what can change meanwhile, then do the
  // capacity check and the hub insert with no await between them, so concurrent joins cannot overshoot.
  const [fresh, freshMember] = await Promise.all([rs.getRoom(roomId), rs.getMember(roomId, userId)]);
  if (ws.readyState !== OPEN) return; // the socket died while we were checking: do not create a ghost
  if (!fresh || fresh.status === "ended") return refuse(ws, "ROOM_ENDED");
  if (fresh.status !== "live") return refuse(ws, "ROOM_NOT_LIVE");
  if (freshMember?.banned) return refuse(ws, "BANNED");
  if ((kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now()) return refuse(ws, "KICKED");
  if (!canJoinRoom({ age: ageFromDob(user.dateOfBirth) }, fresh as any).ok) return refuse(ws, "AGE_LIMIT"); // limit raised meanwhile

  const role = userId === fresh.hostId ? "host" : freshMember?.role === "cohost" ? "cohost" : "guest";
  let me = roomHub.get(roomId, userId);
  const isNew = !me;
  if (!me) {
    if (role === "guest" && roomHub.count(roomId) >= fresh.capacity) return refuse(ws, "ROOM_FULL");
    me = { userId, role, muted: freshMember?.muted ?? false, joinedAt: Date.now(), send: (m) => fanout(userId, m), info: memberInfo(user), age: ageFromDob(user.dateOfBirth) };
    roomHub.join(roomId, me);
    roomHub.setVoiceOn(roomId, fresh.voiceEnabled);
    roomHub.setLiveVideoOn(roomId, fresh.voiceEnabled && fresh.liveVideo);
    roomHub.broadcast(roomId, { type: "room:joined", member: memberPayload(me) }, userId);
  }
  // Register the socket in the same synchronous block as the hub insert: a close during the awaits below must find it,
  // otherwise the member would stay in the room forever.
  let set = joinedSockets.get(userId);
  if (!set) { set = new Set(); joinedSockets.set(userId, set); }
  set.add(ws);
  if (role === "host") { clearTimeout(endTimers.get(roomId)); endTimers.delete(roomId); }
  if (isNew) {
    try {
      await restoreStageOnJoin(roomId, userId, freshMember?.onStage === true);
      await reconcileVoice(roomId); // an adult arriving takes teen speakers off the stage
    } catch (e) { console.error("[voice] join reconcile failed:", e instanceof Error ? e.message : e); }
  }
  if (ws.readyState !== OPEN) return; // closed while we were busy: handleSocketClose already ran and removed them
  await sendState(ws, fresh, me);
  await rs.upsertMember(roomId, userId, role).catch((e) => console.error("[rooms] upsertMember failed:", e));
}

// ---------------------------------------------------------------- moderation (also used by the REST ban route)
export type ModAction = "mute" | "unmute" | "kick" | "ban";

/** Removes a user from the live room and tells everyone. Persisting (ban/mute) is the caller's job. */
async function evict(roomId: string, targetId: string) {
  const tm = roomHub.get(roomId, targetId);
  if (!tm) return;
  await dropFromVoice(roomId, targetId, false); // removed: out of LiveKit and the stage right is gone (before the voice flag can vanish with the last member)
  roomHub.leave(roomId, targetId);
  joinedSockets.delete(targetId);
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
  if (action === "ban") {
    await rs.setMemberFlag(roomId, targetId, { banned: true });
    await rs.setOnStage(roomId, targetId, false);
    // Even if they are not in the room right now: a token they still hold must not get them back into the audio.
    if (!tm) await getVoiceService()?.removeParticipant(roomId, targetId).catch((e) => console.error("[voice] removeParticipant failed:", e?.message ?? e));
  }
  if (action === "kick") kicked.set(`${roomId}:${targetId}`, Date.now() + tuning.kickMs);
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
        if (!bucketsFor(userId).chat.take()) return notice(ws, "RATE_LIMITED");
        const text = plainText(raw);
        if (!text) return;
        const line = { userId, text, at: Date.now() };
        roomHub.recordChat(roomId, line);
        roomHub.broadcast(roomId, { type: "room:chat", ...line });
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
