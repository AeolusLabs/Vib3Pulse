// Gamers live: who plays, on which team, who is featured, and how a team spray splits. Pure functions so the server, the
// WebSocket handlers and the client agree; the server is always the gate. Behind ROOMS_GAMING (server/rooms/features.ts).
// Spec: docs/superpowers/specs/2026-10-21-rooms-gaming-design.md.
import { ageBand, type AgeBand } from "./age";
import type { Check } from "./roomRules";

export type Side = "A" | "B";
export const SIDES: readonly Side[] = ["A", "B"];

export interface GameState {
  /** Players per side (1v1 ... 4v4). */
  format: 1 | 2 | 3 | 4;
  teams: Record<Side, string[]>;
  /** The host's pick per team (the feed whose sound plays); null when the team is empty. */
  featured: Record<Side, string | null>;
  /** People asking to play, with the side they asked for. One ask per person. */
  asks: Array<{ userId: string; side: Side }>;
  score: [number, number];
}

export type GameAction = "ask" | "withdraw" | "accept" | "decline" | "remove" | "feature" | "score" | "format";
export const GAME_ACTIONS: readonly GameAction[] = ["ask", "withdraw", "accept", "decline", "remove", "feature", "score", "format"];
// NOT_ON_STAGE is kept for the wire contract; applyGame never returns it (owner ruling 2026-10-22: playing is decided by
// canPlayGame, not by the stage, so a player does not have to be on the stage).
export type GameError = "GAME_OFF" | "NOT_ON_STAGE" | "NOT_ALLOWED" | "TEEN_RULE" | "NOT_PRESENT" | "TEAM_FULL" | "NO_CHANGE" | "BAD_VALUE";

/** How long a dropped player keeps their slot (ms): 30 s, 120 s (the default, = LIVE_HOLD_MS), 0 = hold it until the host acts. */
export const DROP_TIMEOUTS_MS = [30_000, 120_000, 0] as const;
export type DropTimeoutMs = (typeof DROP_TIMEOUTS_MS)[number];
export const DEFAULT_DROP_TIMEOUT_MS: DropTimeoutMs = 120_000;
export const isDropTimeout = (v: unknown): v is DropTimeoutMs => (DROP_TIMEOUTS_MS as readonly unknown[]).includes(v);

/** The biggest score a side can show (a stepper, not a ledger). */
export const MAX_SCORE = 999;

/** A fresh, empty game of this format. */
export const newGame = (format: 1 | 2 | 3 | 4): GameState => ({ format, teams: { A: [], B: [] }, featured: { A: null, B: null }, asks: [], score: [0, 0] });

/** Nothing here ever mutates a state it is given (every function returns a copy), so this can be shared. */
export const emptyGame: GameState = newGame(1);

/**
 * May this person play (put their screen into the game)? Not the stage rule (canBeOnStage): a player only shares a screen,
 * never a microphone. Someone of unknown age never plays.
 *  - An adult lane room (ageLane "adult"): adults only.
 *  - A minors' room (the teen lane is one): teens always; an adult only with an acknowledged personal invite from the host
 *    (owner ruling 2026-10-22, screen only, no microphone). The door already demands that invite; this repeats it.
 *  - Any other room: adults always; a teen only when everyone present is a teen (same as the stage rule).
 */
export function canPlayGame(
  user: { age: number | null },
  present: { bands: Array<AgeBand | null> },
  room: { minorsRoom: boolean; ageLane?: "teen" | "adult" | null },
  invite: { invited: boolean; acknowledged: boolean } = { invited: false, acknowledged: false },
): Check<"AGE_UNKNOWN" | "WRONG_LANE" | "NOT_INVITED" | "ADULT_PRESENT"> {
  const band = ageBand(user.age);
  if (!band) return { ok: false, code: "AGE_UNKNOWN" };
  if (room.ageLane === "adult") return band === "adult" ? { ok: true } : { ok: false, code: "WRONG_LANE" };
  if (room.minorsRoom || room.ageLane === "teen") {
    if (band === "teen") return { ok: true };
    return invite.invited && invite.acknowledged ? { ok: true } : { ok: false, code: "NOT_INVITED" };
  }
  if (band === "adult") return { ok: true };
  return present.bands.every((b) => b === "teen") ? { ok: true } : { ok: false, code: "ADULT_PRESENT" };
}

export interface GameContext {
  actorId: string;
  actorRole: "host" | "cohost" | "guest";
  targetId: string;
  targetPresent: boolean;
  /** canPlayGame(...).ok for the target, computed by the caller. */
  targetEligible: boolean;
  /** The flag is on, the room is a game room, and it has voice and live video on. */
  gameOn: boolean;
  side?: Side;
  value?: number;
}

type Result = { ok: true; state: GameState } | { ok: false; code: GameError };
const no = (code: GameError): Result => ({ ok: false, code });
const isMod = (r: GameContext["actorRole"]) => r === "host" || r === "cohost";
const isSide = (s: unknown): s is Side => s === "A" || s === "B";
const without = (list: string[], id: string) => list.filter((x) => x !== id);
const copy = (s: GameState): GameState => ({ format: s.format, teams: { A: [...s.teams.A], B: [...s.teams.B] }, featured: { ...s.featured }, asks: s.asks.map((a) => ({ ...a })), score: [s.score[0], s.score[1]] });

/** The side this person plays on, or null. */
export const sideOf = (s: GameState, userId: string): Side | null => (s.teams.A.includes(userId) ? "A" : s.teams.B.includes(userId) ? "B" : null);
/** Every player, team A first. */
export const playersOf = (s: GameState): string[] => [...s.teams.A, ...s.teams.B];

/** Takes someone out of the game entirely: team, ask and featured (the next member of their team takes over, or nobody). */
export function dropFromGame(state: GameState, userId: string): GameState {
  const next = copy(state);
  next.asks = next.asks.filter((a) => a.userId !== userId);
  for (const side of SIDES) {
    if (!next.teams[side].includes(userId)) continue;
    next.teams[side] = without(next.teams[side], userId);
    if (next.featured[side] === userId) next.featured[side] = next.teams[side][0] ?? null;
  }
  return next;
}

export function applyGame(state: GameState, action: GameAction, c: GameContext): Result {
  const self = c.actorId === c.targetId;
  const s = copy(state);
  switch (action) {
    case "ask": {
      if (!self) return no("NOT_ALLOWED");
      if (!c.gameOn) return no("GAME_OFF");
      if (!c.targetEligible) return no("TEEN_RULE");
      if (!isSide(c.side)) return no("BAD_VALUE");
      if (sideOf(s, c.targetId)) return no("NO_CHANGE");
      const had = s.asks.find((a) => a.userId === c.targetId);
      if (had?.side === c.side) return no("NO_CHANGE");
      s.asks = [...s.asks.filter((a) => a.userId !== c.targetId), { userId: c.targetId, side: c.side }];
      return { ok: true, state: s };
    }

    case "withdraw": {
      if (!self) return no("NOT_ALLOWED");
      if (!s.asks.some((a) => a.userId === c.targetId)) return no("NO_CHANGE");
      s.asks = s.asks.filter((a) => a.userId !== c.targetId);
      return { ok: true, state: s };
    }

    case "accept": {
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!c.gameOn) return no("GAME_OFF");
      if (!c.targetPresent) return no("NOT_PRESENT");
      if (!c.targetEligible) return no("TEEN_RULE");
      // The host may put anyone present and eligible in: an ask is only a request. The side named wins over the asked side.
      const side = isSide(c.side) ? c.side : s.asks.find((a) => a.userId === c.targetId)?.side;
      if (!side) return no("BAD_VALUE");
      const current = sideOf(s, c.targetId);
      if (current === side) return no("NO_CHANGE");
      if (s.teams[side].length >= s.format) return no("TEAM_FULL");
      const moved = current ? dropFromGame(s, c.targetId) : s; // switching sides: out of the old team first
      moved.asks = moved.asks.filter((a) => a.userId !== c.targetId);
      moved.teams[side] = [...moved.teams[side], c.targetId];
      if (!moved.featured[side]) moved.featured[side] = c.targetId; // the first player of a side is featured
      return { ok: true, state: moved };
    }

    case "decline": {
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!s.asks.some((a) => a.userId === c.targetId)) return no("NO_CHANGE");
      s.asks = s.asks.filter((a) => a.userId !== c.targetId);
      return { ok: true, state: s };
    }

    case "remove": {
      // A host or co-host removes anyone; a player may always remove themselves (their own "Stop sharing" lands here).
      if (!self && !isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!sideOf(s, c.targetId) && !s.asks.some((a) => a.userId === c.targetId)) return no("NO_CHANGE");
      return { ok: true, state: dropFromGame(s, c.targetId) };
    }

    case "feature": {
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!c.gameOn) return no("GAME_OFF");
      const side = sideOf(s, c.targetId);
      if (!side) return no("NOT_PRESENT");
      if (s.featured[side] === c.targetId) return no("NO_CHANGE");
      s.featured[side] = c.targetId;
      return { ok: true, state: s };
    }

    case "score": {
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!c.gameOn) return no("GAME_OFF");
      if (!isSide(c.side) || !Number.isInteger(c.value) || (c.value as number) < 0 || (c.value as number) > MAX_SCORE) return no("BAD_VALUE");
      const i = c.side === "A" ? 0 : 1;
      if (s.score[i] === c.value) return no("NO_CHANGE");
      s.score[i] = c.value as number;
      return { ok: true, state: s };
    }

    case "format": {
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!c.gameOn) return no("GAME_OFF");
      const v = c.value;
      if (v !== 1 && v !== 2 && v !== 3 && v !== 4) return no("BAD_VALUE");
      if (v === s.format) return no("NO_CHANGE");
      if (s.teams.A.length > v || s.teams.B.length > v) return no("TEAM_FULL"); // remove players first
      s.format = v;
      return { ok: true, state: s };
    }

    default:
      return no("BAD_VALUE"); // a stray action string from the wire
  }
}

/**
 * A team spray split equally: floor(amount / n) each, the remainder (under n kobo) to the featured player when they are in the
 * list, else to the first id. Shares always sum to the amount. Duplicate ids count once; an empty list returns {}.
 * Throws on an amount that is not a whole, non-negative number of kobo (money: fail loudly, never guess).
 */
export function splitShares(amountKobo: number, memberIds: string[], featuredId: string | null): Record<string, number> {
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 0) throw new RangeError("splitShares: amount must be whole kobo");
  const ids = Array.from(new Set(memberIds));
  if (ids.length === 0) return {};
  const each = Math.floor(amountKobo / ids.length);
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = each;
  const rest = amountKobo - each * ids.length;
  out[featuredId !== null && ids.includes(featuredId) ? featuredId : ids[0]] += rest;
  return out;
}
