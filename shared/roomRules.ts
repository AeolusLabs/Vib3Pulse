// Room rules as pure functions so the REST routes, the WebSocket handlers and the client agree.
// The client uses them to decide what to offer; the server is always the gate.
import { meetsAgeLimit, minAgeForLimit, sameBand, ageBand, ageFromDob, type AgeLimit } from "./age";
import { isIdVerifiedAdult } from "./ageVerification";
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

/** A room created by a host of this age is a minors' room (17 and under). Unknown age cannot host at all. */
export function isMinorsRoomHost(age: number | null): boolean {
  return age !== null && age < 18;
}

/**
 * The minors' room door: teens, and rooms that are not minors' rooms, are always ok. Adults need a personal invite AND to
 * have acknowledged the warning. Unknown age is always refused here as a fail-safe (the server answers AGE_UNKNOWN first).
 * The host is exempt; the server checks that before calling this.
 */
export function canAdultEnterMinorsRoom(
  user: { age: number | null },
  room: { minorsRoom: boolean },
  invite: { invited: boolean; acknowledged: boolean },
): Check<"MINORS_ROOM" | "MINORS_ROOM_ACK"> {
  if (!room.minorsRoom) return OK;
  if (user.age === null) return no("MINORS_ROOM"); // fail-safe: nobody of unknown age is ever let in, invite or not
  if (user.age < 18) return OK;
  if (!invite.invited) return no("MINORS_ROOM");
  if (!invite.acknowledged) return no("MINORS_ROOM_ACK");
  return OK;
}

// ---------------------------------------------------------------- paid rooms (phase 4)
/** Money only ever happens in an 18+ or 21+ room that is not a minors' room (never in a room open to under 18s). */
export function moneyEligibleRoom(room: { ageLimit: string; minorsRoom?: boolean | null }): boolean {
  return (room.ageLimit === "18+" || room.ageLimit === "21+") && room.minorsRoom !== true;
}

/** A ticketed (paid) room: it has a ticket price. Free rooms have none. */
export function isTicketedRoom(room: { ticketPriceKobo?: number | null }): boolean {
  return typeof room.ticketPriceKobo === "number";
}

/** How many people the room takes: a ticketed room's ticket capacity (ticket holders), else the free room capacity. */
export function roomCapacity(room: { capacity: number; ticketPriceKobo?: number | null; ticketCapacity?: number | null }): number {
  return isTicketedRoom(room) && typeof room.ticketCapacity === "number" ? room.ticketCapacity : room.capacity;
}

export type TicketSaleCode = "FEATURE_OFF" | "HOST_NOT_ADULT" | "HOST_NOT_VERIFIED" | "NO_PAYOUT_ACCOUNT" | "ROOM_NOT_ADULT";

/**
 * May this host sell tickets for this room? First failing rule wins, in this order: the paidRooms switch, host 18 or over,
 * host ID-verified (an ID-verified ADULT: isIdVerifiedAdult), a verified payout account, an 18+ / 21+ room that is not a
 * minors' room. `features` defaults to OFF, so a caller that forgets it is refused (fail closed).
 */
export function canSellTickets(
  host: { age: number | null; idVerified: boolean; hasPayoutAccount: boolean },
  room: { ageLimit: string; minorsRoom?: boolean | null },
  features: { paidRooms: boolean } = { paidRooms: false },
): Check<TicketSaleCode> {
  if (!features.paidRooms) return no("FEATURE_OFF");
  if (host.age === null || host.age < 18) return no("HOST_NOT_ADULT");
  if (!host.idVerified) return no("HOST_NOT_VERIFIED");
  if (!host.hasPayoutAccount) return no("NO_PAYOUT_ACCOUNT");
  if (!moneyEligibleRoom(room)) return no("ROOM_NOT_ADULT");
  return OK;
}

/**
 * May this viewer see a ticket price and buy a ticket for this room? An ID-verified adult (isIdVerifiedAdult), in a
 * money-eligible room (18+ / 21+, not a minors' room), who also meets the room's own age limit (a 19-year-old never sees the
 * price of a 21+ room). Under 18s, unknown age and unverified people: always false.
 */
export function ticketEligible(
  viewer: { ageVerifiedAt: Date | null; dateOfBirth: string | null },
  room: { ageLimit: string; minorsRoom?: boolean | null },
  now: Date = new Date(),
): boolean {
  if (!isIdVerifiedAdult(viewer, now) || !moneyEligibleRoom(room)) return false;
  return meetsAgeLimit(ageFromDob(viewer.dateOfBirth, now), room.ageLimit as AgeLimit);
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
