// Voice and stage logic for rooms part 3a. No sockets in here: roomSocket.ts maps results to notices, and every function
// that changes who may speak also tells LiveKit (through VoiceService), so the server stays the authority.
//
// Discipline, learned the hard way in review:
//  - Everything that changes a room's stage runs under a per-room lock, so concurrent actions cannot interleave their awaits.
//  - The in-memory stage is updated (and broadcast) BEFORE any slow side effect.
//  - LiveKit is told BEFORE the database is written, and neither failing may skip the other: a revocation must never be lost
//    because a database write threw.
import { applyStage, canBeOnStage, MAX_SPEAKERS, type StageAction, type StageState } from "@shared/stage";
import { applyLive, dropFromLive, emptyLive, type LiveAction } from "@shared/liveScreen";
import { roomHub, type HubMember } from "./RoomHub";
import { getVoiceService, type PublishSource, type VoiceParticipant } from "./voice/voiceService";
import { roomFeatures } from "./features";
import * as rs from "./roomStorage";

const ACTIONS: readonly StageAction[] = ["raise", "lower", "invite", "accept", "remove"];
const log = (what: string) => (e: any) => { console.error(`[voice] ${what} failed:`, e?.message ?? e); };
/** Awaits a promise and logs instead of throwing: used for the side effects of a change that already happened in memory. */
const soft = async (what: string, p: Promise<unknown> | undefined): Promise<boolean> => { try { await p; return true; } catch (e) { log(what)(e); return false; } };

const locks = new Map<string, Promise<unknown>>();
/** Also used by game.ts (ROOMS_GAMING): one lock per room for every stage, live screen and game change. */
export function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(roomId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(roomId, tail);
  void tail.then(() => { if (locks.get(roomId) === tail) locks.delete(roomId); });
  return run;
}

// In a minors' room teens always may speak and adults never may (see canBeOnStage); elsewhere the band rule applies.
const eligible = (m: HubMember, roomId: string) => canBeOnStage({ age: m.age ?? null }, { bands: roomHub.bandsIn(roomId) }, { minorsRoom: roomHub.isMinorsRoom(roomId) }).ok;
const without = (list: string[], id: string) => list.filter((x) => x !== id);

/** Host, co-hosts and guests on stage may publish, as long as the teen rule allows them to speak right now. */
export function canPublishNow(roomId: string, userId: string): boolean {
  const m = roomHub.get(roomId, userId);
  if (!m) return false;
  const speaker = m.role === "host" || m.role === "cohost" || roomHub.stageOf(roomId).stage.includes(userId);
  return speaker && eligible(m, roomId);
}

/** The one person holding the room's live screen may also publish a camera, as long as they may speak right now. */
export function canCameraNow(roomId: string, userId: string): boolean {
  return roomHub.liveVideoOn(roomId) && roomHub.liveOf(roomId).holder === userId && canPublishNow(roomId, userId);
}

// ---------------------------------------------------------------- gaming (ROOMS_GAMING) hooks
const SCREEN_SOURCES: readonly PublishSource[] = ["screen_share", "screen_share_audio"];
const isScreen = (s: PublishSource) => s === "screen_share" || s === "screen_share_audio";

/** A current player of the room's game. Always false while ROOMS_GAMING is off. */
export function isGamePlayer(roomId: string, userId: string): boolean {
  if (!roomFeatures.gaming || !roomHub.gameOn(roomId) || !roomHub.get(roomId, userId)) return false;
  const { teams } = roomHub.gameOf(roomId);
  return teams.A.includes(userId) || teams.B.includes(userId);
}

/** Everything they may publish now: their speaker rights (microphone, the holder's camera) plus, for a player, the screen. */
export function publishSourcesNow(roomId: string, userId: string): PublishSource[] {
  const out: PublishSource[] = [];
  if (canPublishNow(roomId, userId)) out.push("microphone");
  if (canCameraNow(roomId, userId)) out.push("camera");
  if (isGamePlayer(roomId, userId)) out.push(...SCREEN_SOURCES);
  return out;
}

const publishChange = async (roomId: string, userId: string, canPublish: boolean): Promise<boolean> => {
  const m = roomHub.get(roomId, userId);
  if (m) m.publish = canPublish;
  // A game player's grant is the full list (the legacy call would reset it to the microphone and take their screen away).
  if (isGamePlayer(roomId, userId)) return soft("setPublishSources", getVoiceService()?.setPublishSources(roomId, userId, publishSourcesNow(roomId, userId)));
  return soft("setCanPublish", getVoiceService()?.setCanPublish(roomId, userId, canPublish, canPublish && canCameraNow(roomId, userId)));
};

/**
 * Gaming: tells LiveKit what this person may publish now (after they joined or left a team). A removed player whose screen
 * permission LiveKit refused to take back is removed from the session instead, like a camera that cannot be revoked.
 * Call inside the room lock.
 */
export async function publishNowLocked(roomId: string, userId: string): Promise<void> {
  if (!roomHub.get(roomId, userId)) return;
  const ok = await publishChange(roomId, userId, canPublishNow(roomId, userId));
  if (!ok && !isGamePlayer(roomId, userId)) await soft("removeParticipant", getVoiceService()?.removeParticipant(roomId, userId));
}

// game.ts registers these (it imports this file, so this file cannot import it). All run inside the room lock.
type GameHooks = { reconcileLocked(roomId: string): Promise<void>; dropLocked(roomId: string, userId: string): Promise<void> };
let gameHooks: GameHooks | null = null;
export const registerGameHooks = (h: GameHooks) => { gameHooks = h; };
const reconcileGameLocked = async (roomId: string) => { if (roomFeatures.gaming && gameHooks) await gameHooks.reconcileLocked(roomId); };

const onStage = (m: HubMember, roomId: string) => m.role !== "guest" || roomHub.stageOf(roomId).stage.includes(m.userId);

/** When the holder's spot stops being held (epoch ms), or null while they are present (or nobody holds the screen). */
export const liveAway = (roomId: string): number | null => {
  const holder = roomHub.liveOf(roomId).holder;
  return (holder && roomHub.get(roomId, holder)?.away?.until) || null;
};

export const broadcastLive = (roomId: string) => {
  const { holder, asks } = roomHub.liveOf(roomId);
  roomHub.broadcast(roomId, { type: "room:live", holder, asks, away: liveAway(roomId) });
};

// roomSocket owns sockets and timers; when the screen is taken from a holder who is away (host stop, teen rule ...) it must also
// let that member go, since nothing is left to hold. Registered by roomSocket to avoid an import cycle.
let awayReleaser: ((roomId: string, userId: string) => Promise<void>) | null = null;
export const registerAwayReleaser = (fn: (roomId: string, userId: string) => Promise<void>) => { awayReleaser = fn; };
export const releaseIfAway = (roomId: string, userId: string | null) => {
  if (userId && roomHub.get(roomId, userId)?.away) void awayReleaser?.(roomId, userId).catch(log("releaseAway"));
};

/**
 * Keeps the live screen honest after anything changed who is present, on stage or eligible: a holder or asker who is gone,
 * off the stage, turned ineligible (an adult arrived) or whose room lost live video is dropped, and a dropped holder loses the
 * camera in LiveKit. Runs inside the room lock, after the stage and members are already updated in memory.
 */
async function reconcileLiveLocked(roomId: string): Promise<void> {
  const cur = roomHub.liveOf(roomId);
  if (!cur.holder && cur.asks.length === 0) return;
  const liveOn = roomHub.voiceOn(roomId) && roomHub.liveVideoOn(roomId);
  const fine = (id: string) => { const m = roomHub.get(roomId, id); return liveOn && !!m && onStage(m, roomId) && eligible(m, roomId); };
  const next = { holder: cur.holder && fine(cur.holder) ? cur.holder : null, asks: cur.asks.filter(fine) };
  if (next.holder === cur.holder && next.asks.length === cur.asks.length) return;
  roomHub.setLive(roomId, next);
  broadcastLive(roomId);
  if (cur.holder && !next.holder && roomHub.get(roomId, cur.holder)) await publishChange(roomId, cur.holder, canPublishNow(roomId, cur.holder));
  if (cur.holder && !next.holder) releaseIfAway(roomId, cur.holder);
}

const LIVE_ACTIONS: readonly LiveAction[] = ["ask", "withdraw", "grant", "revoke", "stop"];

/** Handles one `room:live` message. Returns a refusal code for roomSocket to send as a notice. */
export function handleLive(userId: string, roomId: string, msg: any): Promise<{ ok: true } | { ok: false; code: string }> {
  return withRoomLock(roomId, async () => {
    const action = msg?.action as LiveAction;
    if (!LIVE_ACTIONS.includes(action)) return { ok: false as const, code: "BAD_REQUEST" };
    const actor = roomHub.get(roomId, userId);
    if (!actor) return { ok: false as const, code: "NOT_IN_ROOM" };
    // asking and withdrawing are always about yourself; grant, revoke and stop name their target (or default to yourself when
    // they leave it out). A target that is there but is not an id is refused: it must never be read as "yourself".
    const named = action !== "ask" && action !== "withdraw" && msg.targetId !== undefined;
    if (named && !(typeof msg.targetId === "string" && msg.targetId.length > 0 && msg.targetId.length <= 64)) return { ok: false as const, code: "BAD_REQUEST" };
    const targetId: string = named ? msg.targetId : userId;
    const target = roomHub.get(roomId, targetId);
    const before = roomHub.liveOf(roomId);
    const r = applyLive(before, action, {
      actorId: userId, actorRole: actor.role, targetId, targetPresent: !!target,
      targetOnStage: !!target && onStage(target, roomId), targetEligible: !!target && eligible(target, roomId),
      liveOn: roomHub.voiceOn(roomId) && roomHub.liveVideoOn(roomId),
    });
    if (!r.ok) return { ok: false as const, code: r.code };

    roomHub.setLive(roomId, r.state);
    broadcastLive(roomId);
    if (before.holder && before.holder !== r.state.holder) releaseIfAway(roomId, before.holder);
    // The old holder loses the camera before the new one gets it: never two cameras at once.
    for (const id of [before.holder, r.state.holder]) {
      if (!id || before.holder === r.state.holder || !roomHub.get(roomId, id)) continue;
      const ok = await publishChange(roomId, id, canPublishNow(roomId, id));
      // LiveKit refused to take the camera from the old holder: remove them instead, so two cameras are never live at once.
      if (!ok && id === before.holder) await soft("removeParticipant", getVoiceService()?.removeParticipant(roomId, id));
    }
    return { ok: true as const };
  });
}

/** Live video was switched off (or the room lost voice): nobody holds the screen or is waiting for it, and the camera goes. */
export function stopAllLive(roomId: string): Promise<void> {
  return withRoomLock(roomId, async () => {
    await reconcileGameLocked(roomId); // no live video, no game: every player and ask goes
    const cur = roomHub.liveOf(roomId);
    if (!cur.holder && cur.asks.length === 0) return;
    roomHub.setLive(roomId, emptyLive);
    broadcastLive(roomId);
    if (cur.holder && roomHub.get(roomId, cur.holder)) await publishChange(roomId, cur.holder, canPublishNow(roomId, cur.holder));
    releaseIfAway(roomId, cur.holder);
  });
}

const broadcastStage = (roomId: string) => {
  const { stage, hands } = roomHub.stageOf(roomId);
  roomHub.broadcast(roomId, { type: "room:stage", stage, hands });
};

/** Handles one `room:stage` message. Returns a refusal code for roomSocket to send as a notice. */
export function handleStage(userId: string, roomId: string, msg: any): Promise<{ ok: true } | { ok: false; code: string }> {
  return withRoomLock(roomId, async () => {
    const action = msg?.action as StageAction;
    if (!ACTIONS.includes(action)) return { ok: false as const, code: "BAD_REQUEST" };
    if (!roomHub.voiceOn(roomId)) return { ok: false as const, code: "VOICE_OFF" };
    const actor = roomHub.get(roomId, userId);
    if (!actor) return { ok: false as const, code: "NOT_IN_ROOM" };
    const targetId = typeof msg.targetId === "string" && msg.targetId ? msg.targetId : userId;
    const target = roomHub.get(roomId, targetId);

    const before = roomHub.stageOf(roomId);
    const r = applyStage(before, action, {
      actorId: userId, actorRole: actor.role, targetId, targetRole: target?.role ?? "guest",
      targetPresent: !!target, targetEligible: target ? eligible(target, roomId) : false,
      implicitSpeakers: roomHub.members(roomId).filter((m) => m.role === "host" || m.role === "cohost").length, maxSpeakers: MAX_SPEAKERS,
    });
    if (!r.ok) return { ok: false as const, code: r.code };

    roomHub.setStage(roomId, r.state);
    broadcastStage(roomId);
    if (action === "invite" && target) {
      const s = roomHub.stageOf(roomId);
      target.send({ type: "room:stage", stage: s.stage, hands: s.hands, invitedYou: true });
    }
    const added = r.state.stage.filter((id) => !before.stage.includes(id));
    const removed = before.stage.filter((id) => !r.state.stage.includes(id));
    for (const id of added) { await publishChange(roomId, id, true); await soft("setOnStage", rs.setOnStage(roomId, id, true)); }
    for (const id of removed) { await publishChange(roomId, id, false); await soft("setOnStage", rs.setOnStage(roomId, id, false)); }
    await reconcileLiveLocked(roomId);
    await reconcileGameLocked(roomId);
    return { ok: true as const };
  });
}

/**
 * Someone left the voice picture. `keepRight` is for a plain disconnect: the stage right stays in the database so a
 * reconnect restores it; a kick, ban, age-out or removal clears it. Either way they are removed from the LiveKit session.
 * Call this BEFORE they leave the hub (the room's voice flag disappears with its last member).
 */
export function dropFromVoice(roomId: string, userId: string, keepRight: boolean): Promise<void> {
  return withRoomLock(roomId, async () => {
    if (roomFeatures.gaming) await gameHooks?.dropLocked(roomId, userId); // out of the game (team, ask) whatever voice says
    if (!roomHub.voiceOn(roomId)) return;
    const s = roomHub.stageOf(roomId);
    const next: StageState = { stage: without(s.stage, userId), hands: without(s.hands, userId), invited: without(s.invited, userId) };
    if (next.stage.length !== s.stage.length || next.hands.length !== s.hands.length || next.invited.length !== s.invited.length) {
      roomHub.setStage(roomId, next);
      broadcastStage(roomId);
    }
    const live = roomHub.liveOf(roomId);
    const liveNext = dropFromLive(live, userId);
    if (liveNext.holder !== live.holder || liveNext.asks.length !== live.asks.length) { roomHub.setLive(roomId, liveNext); broadcastLive(roomId); } // the camera goes with removeParticipant below
    await soft("removeParticipant", getVoiceService()?.removeParticipant(roomId, userId));
    if (!keepRight) await soft("setOnStage", rs.setOnStage(roomId, userId, false));
  });
}

/**
 * Re-checks the teen rule after anyone joins or leaves. A teen guest who may no longer speak (an adult arrived) loses the
 * stage and any raised hand; a teen host or co-host keeps the role but their publish permission follows the rule.
 */
export function reconcileVoice(roomId: string): Promise<void> {
  return withRoomLock(roomId, async () => {
    if (!roomHub.voiceOn(roomId)) return;
    const s = roomHub.stageOf(roomId);
    const next: StageState = { stage: [...s.stage], hands: [...s.hands], invited: [...s.invited] };
    const demoted: string[] = [];
    const toggles: Array<[string, boolean]> = [];
    for (const m of roomHub.members(roomId)) {
      const ok = eligible(m, roomId);
      if (m.role === "guest") {
        if (ok) continue;
        const had = next.stage.includes(m.userId);
        if (!had && !next.hands.includes(m.userId) && !next.invited.includes(m.userId)) continue;
        next.stage = without(next.stage, m.userId); next.hands = without(next.hands, m.userId); next.invited = without(next.invited, m.userId);
        if (had) demoted.push(m.userId);
      } else if (m.publish !== undefined && m.publish !== ok) {
        toggles.push([m.userId, ok]);
      }
    }
    // memory first, then the slow part
    if (next.stage.length !== s.stage.length || next.hands.length !== s.hands.length || next.invited.length !== s.invited.length) {
      roomHub.setStage(roomId, next);
      broadcastStage(roomId);
    }
    for (const id of demoted) { await publishChange(roomId, id, false); await soft("setOnStage", rs.setOnStage(roomId, id, false)); }
    for (const [id, ok] of toggles) await publishChange(roomId, id, ok);
    await reconcileLiveLocked(roomId);
    await reconcileGameLocked(roomId); // an adult arriving takes a teen player out of a mixed room's game
  });
}

/** A stage guest who reconnects gets the stage back if the teen rule still allows it AND there is a seat. Hands are never restored. */
export function restoreStageOnJoin(roomId: string, userId: string, wasOnStage: boolean): Promise<void> {
  return withRoomLock(roomId, async () => {
    if (!wasOnStage || !roomHub.voiceOn(roomId)) return;
    const m = roomHub.get(roomId, userId);
    if (!m || m.role !== "guest") return;
    const s = roomHub.stageOf(roomId);
    if (s.stage.includes(userId)) return;
    const implicit = roomHub.members(roomId).filter((x) => x.role === "host" || x.role === "cohost").length;
    if (!eligible(m, roomId) || implicit + s.stage.length >= MAX_SPEAKERS) { await soft("setOnStage", rs.setOnStage(roomId, userId, false)); return; } // no seat any more
    roomHub.setStage(roomId, { ...s, stage: [...s.stage, userId] });
    broadcastStage(roomId);
  });
}

/** The host changed someone's role: a co-host is an implicit speaker, a guest only speaks from the stage. LiveKit must follow at once. */
export function afterRoleChange(roomId: string, userId: string): Promise<void> {
  return withRoomLock(roomId, async () => {
    if (!roomHub.voiceOn(roomId)) return;
    const s = roomHub.stageOf(roomId);
    const next: StageState = { stage: without(s.stage, userId), hands: without(s.hands, userId), invited: without(s.invited, userId) };
    if (next.stage.length !== s.stage.length || next.hands.length !== s.hands.length || next.invited.length !== s.invited.length) {
      roomHub.setStage(roomId, next);
      broadcastStage(roomId);
    }
    if (roomHub.get(roomId, userId)) await publishChange(roomId, userId, canPublishNow(roomId, userId));
    await soft("setOnStage", rs.setOnStage(roomId, userId, false));
    await reconcileLiveLocked(roomId);
    await reconcileGameLocked(roomId);
  });
}

/**
 * LiveKit and the room can disagree (a removed person rejoins with a token that has not expired, a permission change raced a
 * connect). The room is the authority: anyone LiveKit has who is not in the room is removed, and publish rights are corrected.
 */
export function sweepVoice(roomId: string): Promise<void> {
  return withRoomLock(roomId, async () => {
    const svc = getVoiceService();
    if (!svc || !roomHub.voiceOn(roomId)) return;
    let present: VoiceParticipant[];
    try { present = await svc.listParticipants(roomId); } catch (e) { log("listParticipants")(e); return; }
    for (const p of present) {
      if (!roomHub.get(roomId, p.identity)) { await soft("removeParticipant", svc.removeParticipant(roomId, p.identity)); continue; }
      // Permissions alone do not stop a track that is already up: a camera nobody may publish is removed along with its owner.
      if (p.hasCamera && !canCameraNow(roomId, p.identity)) { await soft("removeParticipant", svc.removeParticipant(roomId, p.identity)); continue; }
      if (roomFeatures.gaming) {
        // Gaming (sweepGame): a screen track from anyone who is not a current player is removed with its owner (a permission
        // change alone does not prove the track stopped); a player's grant must be exactly what publishSourcesNow says.
        const player = isGamePlayer(roomId, p.identity);
        if (!player && p.publishing?.some(isScreen)) { await soft("removeParticipant", svc.removeParticipant(roomId, p.identity)); continue; }
        if (player || p.sources?.some(isScreen)) {
          const want = publishSourcesNow(roomId, p.identity);
          const have = p.sources ?? [];
          if (want.length !== have.length || want.some((x) => !have.includes(x))) await publishChange(roomId, p.identity, canPublishNow(roomId, p.identity));
          continue;
        }
      }
      const want = canPublishNow(roomId, p.identity);
      if (p.canPublish !== want || p.canCamera !== canCameraNow(roomId, p.identity)) await publishChange(roomId, p.identity, want);
    }
  });
}

export async function sweepAllVoiceRooms(): Promise<void> {
  for (const roomId of roomHub.voiceRooms()) await sweepVoice(roomId).catch(log("sweep"));
}

/** Voice was switched off (or the room ended): nobody is on stage any more and the LiveKit session is closed. */
export async function shutdownVoice(roomId: string): Promise<void> {
  const holder = roomHub.liveOf(roomId).holder;
  roomHub.setStage(roomId, { stage: [], hands: [], invited: [] });
  roomHub.setVoiceOn(roomId, false);
  roomHub.setLive(roomId, emptyLive);
  roomHub.setLiveVideoOn(roomId, false);
  await reconcileGameLocked(roomId); // voice and live video are off: the game empties (LiveKit's session goes below anyway)
  broadcastStage(roomId);
  broadcastLive(roomId);
  roomHub.broadcast(roomId, { type: "room:livevideo", enabled: false });
  releaseIfAway(roomId, holder); // a holder whose connection was down has nothing left to hold: let them go now, not in two minutes
  await soft("deleteRoom", getVoiceService()?.deleteRoom(roomId));
  await soft("clearStage", rs.clearStage(roomId));
  await soft("setLiveVideo", rs.setLiveVideo(roomId, false));
}
