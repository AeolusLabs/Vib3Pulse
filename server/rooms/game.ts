// Gamers live (ROOMS_GAMING): the server side of `room:game`. No sockets in here: roomSocket.ts maps results to notices and
// owns the drop timers. Same discipline as stage.ts: every change runs under the room lock (shared with the stage and the
// live screen), memory is updated and broadcast BEFORE LiveKit is told, and LiveKit sources are only ever set by the server.
//
// Players are NOT put on the stage list: the stage means "may use the microphone" (canPublishNow, MAX_SPEAKERS, the teen
// rule), and a player only ever shares a screen. Spraying a player is allowed through spray.ts's own check (isGamePlayer).
import { ageBand } from "@shared/age";
import { applyGame, canPlayGame, dropFromGame, GAME_ACTIONS, newGame, playersOf, type GameAction, type GameState, type GameView, type Side } from "@shared/gameScreen";
import type { Room } from "@shared/schema";
import { roomHub, type HubMember } from "./RoomHub";
import { roomFeatures } from "./features";
import { getInviteState, NO_INVITE, type InviteState } from "./minorsRoom";
import { isGamePlayer, publishNowLocked, registerGameHooks, releaseIfAway, withRoomLock } from "./stage";

export type { GameView };

const ACKED: InviteState = { invited: true, acknowledged: true };

/** The flag is on, the room is a game room, and it has voice and live video on: only then can anyone be added. */
export const gameLive = (roomId: string): boolean =>
  roomFeatures.gaming && roomHub.gameOn(roomId) && roomHub.voiceOn(roomId) && roomHub.liveVideoOn(roomId);

/**
 * Called on a room's first join (and, later, when the host changes the game settings): the hub learns whether the room is a
 * game room. Never while the flag is off; a room that stops being a game room loses its game.
 */
export function syncGameRoom(room: Pick<Room, "id" | "gameFormat" | "gameDropTimeoutMs" | "ageLane">): void {
  if (!roomFeatures.gaming) return;
  const format = room.gameFormat;
  if (format !== 1 && format !== 2 && format !== 3 && format !== 4) { roomHub.setGameOn(room.id, false); return; }
  const lane = room.ageLane === "teen" || room.ageLane === "adult" ? room.ageLane : null;
  const had = roomHub.gameOn(room.id);
  roomHub.setGameOn(room.id, true, { dropMs: room.gameDropTimeoutMs ?? 120_000, ageLane: lane });
  if (!had) roomHub.setGame(room.id, newGame(format));
}

export function gameView(roomId: string): GameView {
  const g = roomHub.gameOf(roomId);
  const away: Record<string, number | null> = {};
  for (const id of playersOf(g)) {
    const a = roomHub.get(roomId, id)?.away;
    if (a) away[id] = a.until > 0 ? a.until : null;
  }
  return { ...g, away };
}

export function broadcastGame(roomId: string): void {
  roomHub.broadcast(roomId, { type: "room:game", game: gameView(roomId) });
}

/** A server-made system chat line about a player (never recorded in the chat ring, like the spray lines). */
export function gameLine(roomId: string, userId: string, text: string, kind: "game_drop" | "game_back"): void {
  roomHub.broadcast(roomId, { type: "room:chat", userId, text, at: Date.now(), system: kind });
}

/** The name the room shows for a member. */
export const nameOf = (m: HubMember | undefined): string => {
  const i = (m?.info ?? {}) as { displayName?: string | null; username?: string | null; organizationName?: string | null };
  return i.displayName || i.organizationName || i.username || "A player";
};

/**
 * canPlayGame for a member present in the room. In a minors' room an adult is only present with an acknowledged invite (the
 * door demands it, and a revoke takes them out), so `fresh` reads the invite again only when asked to (ask and accept).
 */
async function eligible(roomId: string, m: HubMember, fresh: boolean): Promise<boolean> {
  const minors = roomHub.isMinorsRoom(roomId);
  const lane = roomHub.gameInfo(roomId)?.ageLane ?? null;
  const adultInMinors = (minors || lane === "teen") && ageBand(m.age ?? null) === "adult";
  const invite = !adultInMinors ? NO_INVITE : fresh ? await getInviteState(roomId, m.userId) : ACKED;
  return canPlayGame({ age: m.age ?? null }, { bands: roomHub.bandsIn(roomId) }, { minorsRoom: minors, ageLane: lane }, invite).ok;
}
const eligibleNow = (roomId: string, m: HubMember) => eligible(roomId, m, false);

/** Applies a new game: memory and broadcast first, then LiveKit for everyone who joined or left a team. Inside the lock. */
async function commitLocked(roomId: string, before: GameState, next: GameState): Promise<void> {
  roomHub.setGame(roomId, next);
  broadcastGame(roomId);
  const was = new Set(playersOf(before)), now = new Set(playersOf(next));
  const changed = [...playersOf(next).filter((id) => !was.has(id)), ...playersOf(before).filter((id) => !now.has(id))];
  for (const id of changed) await publishNowLocked(roomId, id);
  // A removed player whose connection is down has no slot left to hold: let them go now.
  for (const id of playersOf(before)) if (!now.has(id)) releaseIfAway(roomId, id);
}

const same = (a: GameState, b: GameState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Keeps the game honest after anything changed who is present or eligible (an adult arrived in a mixed room, live video or
 * voice went off, the room stopped being a game room): anyone who may no longer play or ask is dropped. Inside the lock.
 */
async function reconcileGameLocked(roomId: string): Promise<void> {
  const cur = roomHub.gameOf(roomId);
  const ids = [...playersOf(cur), ...cur.asks.map((a) => a.userId)];
  if (ids.length === 0) return;
  const live = gameLive(roomId);
  let next = cur;
  for (const id of ids) {
    const m = roomHub.get(roomId, id);
    if (!live || !m || !(await eligibleNow(roomId, m))) next = dropFromGame(next, id);
  }
  if (same(next, cur)) return;
  await commitLocked(roomId, cur, next);
}

/** Someone is leaving the room (left, kicked, banned, released after a drop): out of the game. Inside the lock. */
async function dropLocked(roomId: string, userId: string): Promise<void> {
  const cur = roomHub.gameOf(roomId);
  const next = dropFromGame(cur, userId);
  if (same(next, cur)) return;
  roomHub.setGame(roomId, next);
  broadcastGame(roomId); // their LiveKit grant goes with removeParticipant (dropFromVoice), right after this
}

registerGameHooks({ reconcileLocked: reconcileGameLocked, dropLocked });

/** Re-checks the game for a room (outside the lock). */
export const reconcileGame = (roomId: string): Promise<void> => withRoomLock(roomId, () => reconcileGameLocked(roomId));

export { isGamePlayer };

/**
 * Handles one `room:game` message: `{ type: "room:game", action, targetId?, side?, value? }`. Returns a refusal code for
 * roomSocket to send as a notice. Flag off: FEATURE_OFF, whatever the message (a stale client after the flag was turned off).
 */
export function handleGame(userId: string, roomId: string, msg: unknown): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!roomFeatures.gaming) return Promise.resolve({ ok: false as const, code: "FEATURE_OFF" });
  return withRoomLock(roomId, async () => {
    const m = (msg ?? {}) as { action?: unknown; targetId?: unknown; side?: unknown; value?: unknown };
    const action = m.action as GameAction;
    if (!GAME_ACTIONS.includes(action)) return { ok: false as const, code: "BAD_REQUEST" };
    const actor = roomHub.get(roomId, userId);
    if (!actor) return { ok: false as const, code: "NOT_IN_ROOM" };
    if (!roomHub.gameOn(roomId)) return { ok: false as const, code: "GAME_OFF" };
    // ask and withdraw are always about yourself; the rest name their target or default to yourself. A target that is there
    // but is not an id is refused: it must never be read as "yourself".
    const named = action !== "ask" && action !== "withdraw" && m.targetId !== undefined;
    if (named && !(typeof m.targetId === "string" && m.targetId.length > 0 && m.targetId.length <= 64)) return { ok: false as const, code: "BAD_REQUEST" };
    if (m.side !== undefined && m.side !== "A" && m.side !== "B") return { ok: false as const, code: "BAD_VALUE" };
    if (m.value !== undefined && typeof m.value !== "number") return { ok: false as const, code: "BAD_VALUE" };
    const targetId: string = named ? (m.targetId as string) : userId;
    const target = roomHub.get(roomId, targetId);
    const needsEligibility = action === "ask" || action === "accept";

    const before = roomHub.gameOf(roomId);
    const r = applyGame(before, action, {
      actorId: userId, actorRole: actor.role, targetId, targetRole: target?.role ?? "guest", targetPresent: !!target,
      targetEligible: !!target && needsEligibility && (await eligible(roomId, target, true)),
      gameOn: gameLive(roomId), side: m.side as Side | undefined, value: m.value as number | undefined,
    });
    if (!r.ok) return { ok: false as const, code: r.code };
    await commitLocked(roomId, before, r.state);
    return { ok: true as const };
  });
}
