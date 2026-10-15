// Room rules as pure functions so the REST routes, the WebSocket handlers and the client agree.
// The client uses them to decide what to offer; the server is always the gate.
import { meetsAgeLimit, minAgeForLimit, sameBand, ageBand, type AgeLimit } from "./age";
import type { RoomPrivacy, RoomVisibility } from "./rooms";

export type Check<C extends string> = { ok: true } | { ok: false; code: C };
const OK = { ok: true } as const;
const no = <C extends string>(code: C): Check<C> => ({ ok: false, code });

/** The bouncer. Unknown age enters nothing. */
export function canJoinRoom(user: { age: number | null }, room: { ageLimit: AgeLimit }): Check<"AGE_UNKNOWN" | "AGE_LIMIT"> {
  if (user.age === null) return no("AGE_UNKNOWN");
  return meetsAgeLimit(user.age, room.ageLimit) ? OK : no("AGE_LIMIT");
}

/** First failing rule wins, in this order: block, room flag, target's privacy, age band. */
export function canInteract(
  actor: { age: number | null; privacy: RoomPrivacy },
  target: { age: number | null; privacy: RoomPrivacy },
  room: { noDirectInteractions: boolean },
  rel: { blocked: boolean; mutualFollow: boolean },
): Check<"BLOCKED" | "ROOM_NO_DIRECT" | "PRIVACY" | "AGE_BAND"> {
  if (rel.blocked) return no("BLOCKED");
  if (room.noDirectInteractions) return no("ROOM_NO_DIRECT");
  const mode = target.privacy.interactions;
  if (mode === "none" || (mode === "mutuals" && !rel.mutualFollow)) return no("PRIVACY");
  if (!sameBand(actor.age, target.age)) return no("AGE_BAND");
  return OK;
}

export function canHostRoom(
  host: { age: number | null; accountAgeDays: number },
  input: { visibility: RoomVisibility; ageLimit: AgeLimit },
  cfg: { minAccountAgeDays: number },
): Check<"AGE_UNKNOWN" | "HOST_BELOW_LIMIT" | "TEEN_PUBLIC" | "ACCOUNT_TOO_NEW"> {
  if (host.age === null) return no("AGE_UNKNOWN");
  if (host.age < minAgeForLimit(input.ageLimit)) return no("HOST_BELOW_LIMIT");
  if (input.visibility === "public") {
    if (ageBand(host.age) === "teen") return no("TEEN_PUBLIC");
    if (host.accountAgeDays < cfg.minAccountAgeDays) return no("ACCOUNT_TOO_NEW");
  }
  return OK;
}
