// Who may speak in a room, as pure functions so the server, the WebSocket handlers and the client agree.
// `stage` holds guests who were given the mic; the host and co-hosts are implicit speakers when voice is on.
import { ageBand, type AgeBand } from "./age";
import type { Check } from "./roomRules";

export const MAX_SPEAKERS = 6;

export type StageAction = "raise" | "lower" | "invite" | "accept" | "remove";
export type StageError = "FORBIDDEN" | "STAGE_FULL" | "NOT_ELIGIBLE" | "TARGET_GONE" | "BAD_STATE";
type Role = "host" | "cohost" | "guest";

export interface StageState { stage: string[]; hands: string[]; invited: string[] }

/**
 * Who may speak (stage, mic, live camera). Someone of unknown age never speaks.
 * Normal rooms: adults may always speak; a teen may speak only when everyone present is a teen (an adult in the room, even
 * one who is only listening, blocks it).
 * Minors' rooms (host under 18 at creation): the room is the teens' own. Teens may always speak, whoever is present; adults
 * (who are there only by personal invite) never speak: they listen and chat.
 */
export function canBeOnStage(
  user: { age: number | null },
  present: { bands: Array<AgeBand | null> },
  room: { minorsRoom: boolean } = { minorsRoom: false },
): Check<"AGE_UNKNOWN" | "ADULT_PRESENT" | "MINORS_ROOM_ADULT"> {
  const band = ageBand(user.age);
  if (!band) return { ok: false, code: "AGE_UNKNOWN" };
  if (room.minorsRoom) return band === "teen" ? { ok: true } : { ok: false, code: "MINORS_ROOM_ADULT" };
  if (band === "adult") return { ok: true };
  return present.bands.every((b) => b === "teen") ? { ok: true } : { ok: false, code: "ADULT_PRESENT" };
}

export interface StageContext {
  actorId: string;
  actorRole: Role;
  targetId: string;
  targetRole: Role;
  targetPresent: boolean;
  targetEligible: boolean;
  /** Host plus co-hosts currently in the room: they count toward the speaker cap. */
  implicitSpeakers: number;
  maxSpeakers: number;
}

type Result = { ok: true; state: StageState } | { ok: false; code: StageError };
const no = (code: StageError): Result => ({ ok: false, code });
const without = (list: string[], id: string) => list.filter((x) => x !== id);
const clear = (s: StageState, id: string): StageState => ({ stage: without(s.stage, id), hands: without(s.hands, id), invited: without(s.invited, id) });
const isMod = (r: Role) => r === "host" || r === "cohost";

export function applyStage(state: StageState, action: StageAction, c: StageContext): Result {
  const self = c.actorId === c.targetId;
  const full = c.implicitSpeakers + state.stage.length >= c.maxSpeakers;
  const toStage = (s: StageState): Result => ({ ok: true, state: { stage: [...clear(s, c.targetId).stage, c.targetId], hands: without(s.hands, c.targetId), invited: without(s.invited, c.targetId) } });

  switch (action) {
    case "raise":
      if (!self) return no("FORBIDDEN");
      if (c.actorRole !== "guest" || state.stage.includes(c.targetId)) return no("BAD_STATE");
      if (!c.targetEligible) return no("NOT_ELIGIBLE");
      return { ok: true, state: { ...state, hands: state.hands.includes(c.targetId) ? [...state.hands] : [...state.hands, c.targetId] } };

    case "lower":
      return self ? { ok: true, state: clear(state, c.actorId) } : no("FORBIDDEN");

    case "invite":
      if (!isMod(c.actorRole) || c.targetRole !== "guest") return no("FORBIDDEN");
      if (!c.targetPresent) return no("TARGET_GONE");
      if (!c.targetEligible) return no("NOT_ELIGIBLE");
      if (state.stage.includes(c.targetId)) return no("BAD_STATE");
      return { ok: true, state: { ...state, invited: state.invited.includes(c.targetId) ? [...state.invited] : [...state.invited, c.targetId] } };

    case "accept":
      if (isMod(c.actorRole)) {
        // The host gives speaking rights to anyone present and eligible: a raised hand is only a request, not a requirement.
        if (c.targetRole !== "guest") return no("FORBIDDEN");
        if (!c.targetPresent) return no("TARGET_GONE");
        if (!c.targetEligible) return no("NOT_ELIGIBLE");
        if (state.stage.includes(c.targetId)) return no("BAD_STATE");
        return full ? no("STAGE_FULL") : toStage(state);
      }
      if (!self) return no("FORBIDDEN");
      if (!state.invited.includes(c.targetId)) return no("BAD_STATE");
      if (!c.targetEligible) return no("NOT_ELIGIBLE");
      return full ? no("STAGE_FULL") : toStage(state);

    case "remove":
      if (!isMod(c.actorRole) || c.targetRole === "host" || (c.actorRole === "cohost" && c.targetRole === "cohost")) return no("FORBIDDEN");
      return { ok: true, state: clear(state, c.targetId) };
  }
}
