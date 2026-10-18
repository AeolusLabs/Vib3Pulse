// `room:*` messages on the shared /ws server. Every rule is re-checked here from the database; the client's
// slide-out only decides what to offer. Presence lives in RoomHub; bans, mutes and room state are persisted.
import { storage } from "../storage";
import { isBlockedEitherWay } from "../utils/blocks";
import { ageFromDob } from "@shared/age";
import { resolveScreen } from "@shared/screen";
import { sanitizePlaybackInput, type NowPlaying } from "@shared/playback";
import { MINORS_ROOM_WARNING, ROOM_LIMITS, ROOM_REACTIONS, resolveRoomPrivacy, resolveChatReply, validateChatReply, type MinorsRoomCode } from "@shared/rooms";
import { canHostRoom, canInteract, canJoinRoom } from "@shared/roomRules";
import type { Room, User } from "@shared/schema";
import * as rs from "./roomStorage";
import { mutualFollow, plainText, publicRoom, viewRoom } from "./roomAccess";
import { getInviteState, markHostRoomsMinors, minorsGate, NO_INVITE, revokeInvite } from "./minorsRoom";
import { roomHub, type HubMember } from "./RoomHub";
import { TokenBucket } from "./rateLimit";
import { LIVE_HOLD_MS } from "@shared/liveScreen";
import { broadcastLive, dropFromVoice, handleLive, handleStage, liveAway, reconcileVoice, registerAwayReleaser, restoreStageOnJoin, sweepAllVoiceRooms } from "./stage";
import { getVoiceService } from "./voice/voiceService";
import { roomFeatures } from "./features";
import { MEMBER_LIST_CAP, selectStateMembers, wantedMemberIds } from "./memberList";

/** Injectable so tests can shorten the host grace period; rates are the documented limits. */
export const tuning = {
  graceMs: 120_000,
  // How long a dropped screen holder keeps the screen before it is released (a stream through a bad connection must not end at the first blip).
  liveGraceMs: Number(process.env.ROOM_LIVE_GRACE_MS) || LIVE_HOLD_MS,
  chat: { rate: 1, burst: 5 },
  react: { rate: 3, burst: 3 },
  interact: { rate: 0.5, burst: 1 }, // 1 per 2 s per target
  join: { rate: 0.5, burst: 3 },     // a join is ~6 queries and a broadcast to the whole room
  stage: { rate: 2, burst: 6 },      // raise / lower / accept / invite / remove
  playback: { rate: 4, burst: 8 },   // host play / pause / seek, plus a heartbeat every 5 s
  sweepMs: 10_000,                   // how often LiveKit is compared with the room (0 = off, for tests)
  kickMs: 10 * 60_000,               // a kick keeps the person out this long (a ban is forever)
};

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
const awayTimers = new Map<string, ReturnType<typeof setTimeout>>(); // `${roomId}:${userId}` of a holder whose connection dropped
const clearAway = (roomId: string, userId: string) => { const k = `${roomId}:${userId}`; clearTimeout(awayTimers.get(k)); awayTimers.delete(k); };

const wire = (msg: object) => JSON.stringify(msg);
function fanout(userId: string, msg: object) {
  const data = wire(msg);
  Array.from(joinedSockets.get(userId) ?? []).forEach((s) => { if (s.readyState === OPEN) s.send(data); });
}
const direct = (ws: RoomClient, msg: object) => { if (ws.readyState === OPEN) ws.send(wire(msg)); };
const notice = (ws: RoomClient, code: string) => direct(ws, { type: "room:notice", code });
const refuse = (ws: RoomClient, code: string) => direct(ws, { type: "room:error", code });
/** Every minors' room refusal carries the one warning text (and nothing about the room). */
const minorsError = (code: MinorsRoomCode) => ({ type: "room:error", code, warning: MINORS_ROOM_WARNING });

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
  Array.from(awayTimers.keys()).forEach((k) => { if (k.startsWith(`${roomId}:`)) { clearTimeout(awayTimers.get(k)); awayTimers.delete(k); } });
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
  const live = await rs.listLiveRooms();
  for (const room of live) if (!roomHub.get(room.id, room.hostId)) scheduleEnd(room.id);
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
  await leaveRoom(userId, roomId);
}

/**
 * The hold ran out, or the screen was taken from someone who is away: they leave exactly as if they had disconnected.
 * Runs on the same per-user chain as joins, and looks again once it has its turn: a holder who came back in the meantime
 * (and has a socket again) must never be removed by a release that was queued before they returned.
 */
async function releaseAwayMember(roomId: string, userId: string): Promise<void> {
  clearAway(roomId, userId);
  const prev = joinLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const me = roomHub.get(roomId, userId);
    if (!me?.away) return;                                  // they came back first
    if ((joinedSockets.get(userId)?.size ?? 0) > 0) return; // a socket of theirs is attached again
    await leaveRoom(userId, roomId);
  });
  const tail = run.then(() => undefined, () => undefined);
  joinLocks.set(userId, tail);
  try { await run; } finally { if (joinLocks.get(userId) === tail) joinLocks.delete(userId); }
}
registerAwayReleaser(releaseAwayMember);

// ---------------------------------------------------------------- join
const JOIN_AGE_CODES = { AGE_UNKNOWN: "AGE_UNKNOWN", AGE_LIMIT: "AGE_LIMIT" } as const;

async function sendState(ws: RoomClient, room: Room, you: HubMember) {
  direct(ws, {
    type: "room:state",
    room: publicRoom(room),
    members: (() => {
      // A full free room is sent whole. Past that, the host must still see (and act on) everyone on stage or asking, and
      // everyone in the recent chat must resolve to a person, or their name would read "Someone" and could not be reported.
      const s = roomHub.stageOf(room.id);
      const live = roomHub.liveOf(room.id);
      const wanted = wantedMemberIds({ stage: s.stage, hands: s.hands, asks: live.asks, holder: live.holder, chat: roomHub.recentChat(room.id) });
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
  // Includes the block check: a blocked person gets the same answer as for a room that doesn't exist. In a minors' room an
  // adult without an acknowledged personal invite is refused here with the warning (an invite link alone is not enough).
  const view = await viewRoom(room, userId, token);
  if (!view.ok) {
    if (view.code === "NOT_FOUND" || view.code === "AGE_UNKNOWN") return refuse(ws, view.code);
    return direct(ws, minorsError(view.code));
  }
  const gate = canJoinRoom({ age: ageFromDob(user.dateOfBirth) }, room as any);
  if (!gate.ok) return refuse(ws, JOIN_AGE_CODES[gate.code]);

  const current = roomHub.roomOf(userId);
  if (current && current !== roomId) await leaveRoom(userId, current); // one room at a time

  // Everything above can take a while on a slow database. Re-read what can change meanwhile, then do the
  // capacity check and the hub insert with no await between them, so concurrent joins cannot overshoot.
  // The minors' room invite is re-read too: a revoke that landed during the awaits above must keep them out.
  // The user is re-read as well: an admin birthdate correction during the awaits must decide with the new age.
  // The invite is always read: the room may become a minors' room (host corrected to under 18) while we wait.
  const [fresh, freshMember, freshInvite, freshUser] = await Promise.all([
    rs.getRoom(roomId), rs.getMember(roomId, userId), getInviteState(roomId, userId), storage.getUser(userId),
  ]);
  const freshAge = ageFromDob(freshUser?.dateOfBirth);
  if (ws.readyState !== OPEN) return; // the socket died while we were checking: do not create a ghost
  if (!fresh || fresh.status === "ended") return refuse(ws, "ROOM_ENDED");
  if (fresh.status !== "live") return refuse(ws, "ROOM_NOT_LIVE");
  if (freshMember?.banned) return refuse(ws, "BANNED");
  if ((kicked.get(`${roomId}:${userId}`) ?? 0) > Date.now()) return refuse(ws, "KICKED");
  if (!freshUser || freshUser.deletedAt) return refuse(ws, "NOT_FOUND");
  if (!canJoinRoom({ age: freshAge }, fresh as any).ok) return refuse(ws, freshAge === null ? "AGE_UNKNOWN" : "AGE_LIMIT"); // limit raised meanwhile
  // The hub flag is set (synchronously) by a host correction right after its UPDATE commits, and is never cleared while the
  // room lives, so a row read that predates the correction cannot let an uninvited adult in. No await from here to the insert.
  const mg = minorsGate({ minorsRoom: fresh.minorsRoom || roomHub.isMinorsRoom(roomId), hostId: fresh.hostId }, userId, freshAge, freshInvite);
  if (!mg.ok) return direct(ws, minorsError(mg.code));

  const role = userId === fresh.hostId ? "host" : freshMember?.role === "cohost" ? "cohost" : "guest";
  let me = roomHub.get(roomId, userId);
  const isNew = !me;
  if (!me) {
    if (role === "guest" && roomHub.count(roomId) >= fresh.capacity) return refuse(ws, "ROOM_FULL");
    me = { userId, role, muted: freshMember?.muted ?? false, joinedAt: Date.now(), send: (m) => fanout(userId, m), info: memberInfo(freshUser), age: freshAge };
    roomHub.join(roomId, me);
    if (fresh.minorsRoom) roomHub.markMinorsRoom(roomId); // before any stage decision for this room
    // Only the first person in sets the room's flags from the database. Once anyone is in, the voice / live-video routes keep
    // them current, and this joiner's row may predate a switch-off: writing it would turn voice or the camera back on.
    if (roomHub.count(roomId) === 1) {
      roomHub.setVoiceOn(roomId, fresh.voiceEnabled);
      roomHub.setLiveVideoOn(roomId, fresh.voiceEnabled && fresh.liveVideo);
    }
    roomHub.broadcast(roomId, { type: "room:joined", member: memberPayload(me) }, userId);
  }
  // Register the socket in the same synchronous block as the hub insert: a close during the awaits below must find it,
  // otherwise the member would stay in the room forever.
  let set = joinedSockets.get(userId);
  if (!set) { set = new Set(); joinedSockets.set(userId, set); }
  set.add(ws);
  if (me.away) { // the holder is back inside the hold window: the stream carries on
    delete me.away;
    clearAway(roomId, userId);
    broadcastLive(roomId);
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
  tm.send(minorsError("MINORS_ROOM")); // the person hears why before being removed
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
 * Every admin birthdate correction ends here. In order: the person's live age in the hub is refreshed (the stage rule reads
 * it), a host now under 18 has their open rooms made minors' rooms, the room they are in is reconciled at once (mic, camera,
 * stage and live screen follow the new age: an adult host of a minors' room loses them, a host corrected to a teen gets them
 * back), and a member who may no longer be in a minors' room is taken out.
 */
export async function applyDobCorrection(userId: string): Promise<void> {
  await (joinLocks.get(userId) ?? Promise.resolve()); // a join in flight finishes first (it re-reads the birthdate itself)
  const user = await storage.getUser(userId);
  if (!user) return;
  const age = ageFromDob(user.dateOfBirth);
  const roomId = roomHub.roomOf(userId);
  const changed = roomId ? roomHub.refreshAge(roomId, userId, age) : false;

  // Rooms they host. An adult (18+) loses every minors' room they host; anyone loses a room they may no longer host.
  await endRoomsHostCannotKeep(user, age);
  if (age !== null && age < 18) await enforceMinorsHost(userId);

  // The room they are in.
  if (roomId && changed) await reconcileVoice(roomId);
  const room = roomId ? await rs.getRoom(roomId) : null;
  if (room && room.status === "live" && room.hostId !== userId && roomHub.get(room.id, userId) && !canJoinRoom({ age }, room as any).ok) {
    await removeForAgeLimit(room.id, userId); // corrected below the room's age limit
  }
  await enforceMinorsRoomFor(userId);
}

/** Message to everyone in a room that is closed because its host's account is under review. Plain, no accusation. */
export const HOST_REVIEW_MESSAGE = "This room has closed because the host's account is being reviewed.";

/**
 * After a birthdate correction: ends (live) or cancels (scheduled) every room of this host that they may no longer host.
 *  - an adult (18 or over) never keeps a minors' room;
 *  - nobody keeps a room they could not create at their corrected age (age limit above them; a teen and a public room).
 * Their other rooms are left alone. One way and idempotent (ended rooms are skipped).
 */
async function endRoomsHostCannotKeep(host: User, age: number | null): Promise<void> {
  const open = (await rs.listOpenRoomsByHost(host.id));
  for (const room of open) {
    const adultInMinorsRoom = room.minorsRoom && (age === null || age >= 18);
    const hc = canHostRoom({ age, accountAgeDays: Number.MAX_SAFE_INTEGER }, { visibility: room.visibility as any, ageLimit: room.ageLimit as any }, { minAccountAgeDays: 0 });
    const cannotHost = !hc.ok && (hc.code === "HOST_BELOW_LIMIT" || hc.code === "TEEN_PUBLIC" || hc.code === "AGE_UNKNOWN");
    if (!adultInMinorsRoom && !cannotHost) continue;
    if (room.status === "live") {
      roomHub.broadcast(room.id, { type: "room:notice", code: "HOST_REVIEW", message: HOST_REVIEW_MESSAGE });
      await endRoom(room.id);
    } else {
      await rs.setStatus(room.id, "ended"); // a scheduled room is cancelled: it can never be started
    }
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
export async function enforceMinorsHost(hostId: string): Promise<string[]> {
  const flagged = await markHostRoomsMinors(hostId);
  for (const r of flagged) {
    if (r.status !== "live") continue;
    // Marked (even if empty) and the members snapshotted in the same synchronous step: anyone inserted before this is in the
    // snapshot and gated below; anyone inserted after it is caught by the re-check at the hub insert in joinOnce.
    roomHub.markMinorsRoom(r.id); // the stage rule switches now: teens may speak, adults may not
    for (const m of roomHub.members(r.id)) {
      if (m.userId === hostId) continue;
      const [u, invite] = await Promise.all([storage.getUser(m.userId), getInviteState(r.id, m.userId)]);
      if (!minorsGate({ minorsRoom: true, hostId }, m.userId, ageFromDob(u?.dateOfBirth), invite).ok) await removeFromMinorsRoom(r.id, m.userId);
    }
    await reconcileVoice(r.id).catch((e) => console.error("[voice] reconcile failed:", e?.message ?? e)); // staged adults off, teens back on mic
  }
  return flagged.map((r) => r.id);
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
        // The quote is only ever taken from the server's own record of the chat, never from client text or names.
        const replyTo = resolveChatReply(roomHub.recentChat(roomId), validateChatReply(msg.replyTo));
        const line = { userId, text, at: Date.now(), ...(replyTo ? { replyTo } : {}) };
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
