// Room tickets: the client-safe shapes and pure rules. Shared by the server (server/rooms/tickets.ts) and the client.
// No amounts are computed here: every split comes from ticketBreakdown in shared/money.ts.
import { shortCodeOf } from "./ticketCode";
import { ageFromDob, meetsAgeLimit, type AgeLimit } from "./age";
import { isIdVerifiedAdult } from "./ageVerification";
import { ROOM_LIMITS } from "./rooms";

/** What the buyer is shown for their own ticket. Never the payment reference, never the split. */
export interface RoomTicketView {
  id: string;
  roomId: string;
  /** Short code derived from the ticket id, for example "A3F9-12BC". */
  code: string;
  amountKobo: number;
  status: "paid" | "refunded";
  /** ISO 8601. */
  createdAt: string;
}

/** Why a paid charge was refunded instead of becoming a ticket. Exactly the codes in the issueRoomTicket contract. */
export type RoomTicketRefusal = "SOLD_OUT" | "AMOUNT_MISMATCH" | "INELIGIBLE";

/**
 * Ticket price limits in kobo (1,000 to 100,000 naira). One source: ROOM_LIMITS in shared/rooms.ts (the same numbers the
 * create/PATCH validation uses), so what a host may set and what a buyer may pay can never drift apart.
 */
export const ROOM_TICKET_MIN_KOBO: number = ROOM_LIMITS.ticketMinKobo;
export const ROOM_TICKET_MAX_KOBO: number = ROOM_LIMITS.ticketMaxKobo;

/** A stored price we are willing to charge: an integer of kobo inside the limits. Anything else is treated as "not for sale". */
export function isSellablePrice(priceKobo: unknown): priceKobo is number {
  return typeof priceKobo === "number" && Number.isInteger(priceKobo) && priceKobo >= ROOM_TICKET_MIN_KOBO && priceKobo <= ROOM_TICKET_MAX_KOBO;
}

/** "3f9a12bc-...." -> "3F9A-12BC". Display only: it is not a secret and never grants entry by itself. */
export function ticketCode(ticketId: string): string {
  return shortCodeOf(ticketId);
}

/**
 * The provider's verified charge pays for this ticket only when it is the stored price to the kobo, in naira.
 * Never "at least": an overpayment is refunded too, so a tampered amount can never buy anything.
 */
export function amountMatches(verifiedAmountKobo: unknown, storedPriceKobo: unknown, currency: string | undefined = "NGN"): boolean {
  return currency === "NGN" && isSellablePrice(storedPriceKobo)
    && typeof verifiedAmountKobo === "number" && Number.isInteger(verifiedAmountKobo) && verifiedAmountKobo === storedPriceKobo;
}

/** Every reason a purchase is refused, in the order they are checked (first failing one wins). */
export type PurchaseBlock =
  | "NOT_BOUND"          // the payment reference was not made by us for this room and buyer
  | "BUYER_GONE"         // no such account, or deleted
  | "IS_HOST"
  | "NOT_VERIFIED_ADULT" // not ID-verified, or under 18 (isIdVerifiedAdult)
  | "ROOM_NOT_ADULT"     // a minors' room, or an age limit below 18+: such a room never sells tickets
  | "BELOW_AGE_LIMIT"    // an adult under the room's own limit (for example 19 in a 21+ room)
  | "ROOM_NOT_OPEN"      // not scheduled or live (ended)
  | "ROOM_NOT_APPROVED"  // taken down by moderation
  | "BANNED_OR_BLOCKED"  // banned from the room, or a block either way with the host
  | "NOT_TICKETED"       // no stored price: a free room
  | "PRICE_INVALID"      // a stored price outside the limits (or not an integer): sales paused, the door stays closed
  | "SALES_PAUSED"       // the host may no longer sell (ID verification or payout account gone): sales paused
  | "IS_COHOST"          // a co-host gets in without a ticket (checked at checkout only)
  | "AMOUNT_MISMATCH"    // the verified charge is not the stored price to the kobo, in naira
  | "ALREADY_TICKETED"   // already holds a paid ticket for this room
  | "SOLD_OUT";

export interface PurchaseInput {
  buyerId: string;
  buyer: { ageVerifiedAt: Date | null; dateOfBirth: string | null; deletedAt?: Date | null } | null | undefined;
  room: {
    hostId: string; status: string; ageLimit: string; minorsRoom: boolean; moderationStatus: string;
    ticketPriceKobo: number | null | undefined; ticketCapacity: number | null | undefined; capacity: number;
  };
  bannedOrBlocked: boolean;
  /** The buyer is a (non-banned) co-host of this room. Passed by checkout only: a co-host never needs to buy. */
  buyerIsCohost?: boolean;
  /**
   * The host may still sell: ID-verified adult with a verified payout account, read fresh. false pauses sales
   * (checkout SALES_PAUSED, a charge that arrives anyway is refunded). Left out: not checked (pure callers).
   */
  hostCanSell?: boolean;
  paidCount: number;       // paid tickets in this room right now
  buyerHasPaid: boolean;   // this buyer already holds a paid ticket in this room
  /** Present when a charge was made (verify / webhook). Absent at checkout, where nothing has been paid yet. */
  payment?: { bound: boolean; amountKobo: number; currency?: string };
  now?: Date;
}

/** The seat limit for a ticketed room: ticketCapacity, else the room capacity. Not a positive integer: no seats (fail closed). */
export function ticketSeatLimit(room: { ticketCapacity: number | null | undefined; capacity: number }): number {
  const cap = room.ticketCapacity ?? room.capacity;
  return Number.isInteger(cap) && cap > 0 ? cap : 0;
}

/**
 * The one purchase rule, used by checkout (before paying) and by issueRoomTicket (after paying, under the room lock).
 * The order matters for privacy: everything about the buyer is checked before anything that says whether the room
 * sells tickets, so a teen or an unverified user gets the same answer for a ticketed and a free room (never a price).
 */
export function checkPurchase(i: PurchaseInput): { ok: true } | { ok: false; code: PurchaseBlock } {
  const no = (code: PurchaseBlock) => ({ ok: false as const, code });
  const now = i.now ?? new Date();
  if (i.payment && !i.payment.bound) return no("NOT_BOUND");
  if (!i.buyer || i.buyer.deletedAt) return no("BUYER_GONE");
  if (i.buyerId === i.room.hostId) return no("IS_HOST");
  if (!isIdVerifiedAdult({ ageVerifiedAt: i.buyer.ageVerifiedAt, dateOfBirth: i.buyer.dateOfBirth }, now)) return no("NOT_VERIFIED_ADULT");
  if (i.bannedOrBlocked) return no("BANNED_OR_BLOCKED");
  if (i.room.minorsRoom || (i.room.ageLimit !== "18+" && i.room.ageLimit !== "21+")) return no("ROOM_NOT_ADULT");
  if (!meetsAgeLimit(ageFromDob(i.buyer.dateOfBirth, now), i.room.ageLimit as AgeLimit)) return no("BELOW_AGE_LIMIT");
  if (i.room.status !== "scheduled" && i.room.status !== "live") return no("ROOM_NOT_OPEN");
  if (i.room.moderationStatus !== "approved") return no("ROOM_NOT_APPROVED");
  if (i.room.ticketPriceKobo === null || i.room.ticketPriceKobo === undefined) return no("NOT_TICKETED");
  if (!isSellablePrice(i.room.ticketPriceKobo)) return no("PRICE_INVALID");
  if (i.hostCanSell === false) return no("SALES_PAUSED");
  if (i.buyerIsCohost) return no("IS_COHOST");
  if (i.payment && !amountMatches(i.payment.amountKobo, i.room.ticketPriceKobo, i.payment.currency ?? "NGN")) return no("AMOUNT_MISMATCH");
  if (i.buyerHasPaid) return no("ALREADY_TICKETED");
  if (i.paidCount >= ticketSeatLimit(i.room)) return no("SOLD_OUT");
  return { ok: true };
}

/** What a paid charge that was refused becomes, in the issueRoomTicket contract. ALREADY_TICKETED is handled apart (duplicate). */
export function refusalOf(code: Exclude<PurchaseBlock, "ALREADY_TICKETED">): RoomTicketRefusal {
  if (code === "AMOUNT_MISMATCH") return "AMOUNT_MISMATCH";
  if (code === "SOLD_OUT") return "SOLD_OUT";
  return "INELIGIBLE";
}
