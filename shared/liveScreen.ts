// Who may put themselves on a room's screen (live camera + mic), as pure functions so the server, the WebSocket handlers
// and the client agree. One person holds the screen at a time. The state lives in memory per room, like the stage.
/** How long a dropped screen holder keeps the screen (2 minutes). The server can override it with ROOM_LIVE_GRACE_MS; the client only uses it for an honest "about" countdown. */
export const LIVE_HOLD_MS = 120_000;

export type LiveAction = "ask" | "withdraw" | "grant" | "revoke" | "stop";
export type LiveError = "LIVE_OFF" | "NOT_ON_STAGE" | "NOT_ALLOWED" | "TEEN_RULE" | "NOT_PRESENT" | "NO_CHANGE";
type Role = "host" | "cohost" | "guest";

export interface LiveState { holder: string | null; asks: string[] }
export const emptyLive: LiveState = { holder: null, asks: [] };

export interface LiveContext {
  actorId: string;
  actorRole: Role;
  targetId: string;
  targetPresent: boolean;
  /** True for the host and co-hosts (implicit speakers) and for a guest on the stage. */
  targetOnStage: boolean;
  /** Who may speak: the same check as speaking (`canBeOnStage`: the teen rule, or in a minors room teens only). */
  targetEligible: boolean;
  liveOn: boolean;
}

type Result = { ok: true; state: LiveState } | { ok: false; code: LiveError };
const no = (code: LiveError): Result => ({ ok: false, code });
const without = (list: string[], id: string) => list.filter((x) => x !== id);
const isMod = (r: Role) => r === "host" || r === "cohost";

export function applyLive(state: LiveState, action: LiveAction, c: LiveContext): Result {
  switch (action) {
    case "ask":
      if (!c.liveOn) return no("LIVE_OFF");
      if (!c.targetOnStage) return no("NOT_ON_STAGE");
      if (!c.targetEligible) return no("TEEN_RULE");
      if (state.holder === c.actorId || state.asks.includes(c.actorId)) return no("NO_CHANGE");
      return { ok: true, state: { ...state, asks: [...state.asks, c.actorId] } };

    case "withdraw":
      if (!state.asks.includes(c.actorId)) return no("NO_CHANGE");
      return { ok: true, state: { ...state, asks: without(state.asks, c.actorId) } };

    case "grant":
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (!c.liveOn) return no("LIVE_OFF");
      if (!c.targetPresent) return no("NOT_PRESENT");
      if (!c.targetOnStage) return no("NOT_ON_STAGE");
      if (!c.targetEligible) return no("TEEN_RULE");
      if (state.holder === c.targetId) return no("NO_CHANGE");
      return { ok: true, state: { holder: c.targetId, asks: without(state.asks, c.targetId) } };

    case "revoke":
      if (!isMod(c.actorRole)) return no("NOT_ALLOWED");
      if (state.holder !== c.targetId) return no("NO_CHANGE");
      return { ok: true, state: { ...state, holder: null } };

    case "stop":
      if (!state.holder) return no("NO_CHANGE");
      if (state.holder !== c.actorId && !isMod(c.actorRole)) return no("NOT_ALLOWED");
      return { ok: true, state: { ...state, holder: null } };
  }
}

/** Someone left the picture (left, removed, lost the stage, turned ineligible): they hold nothing and ask for nothing. */
export function dropFromLive(state: LiveState, userId: string): LiveState {
  return { holder: state.holder === userId ? null : state.holder, asks: without(state.asks, userId) };
}
