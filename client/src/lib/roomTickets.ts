// Paid room tickets on the client (phase 4, task 4.7; fix round 4F). Pure: no React, no window, no network, no clock reads
// (storage is passed in where it is needed). The server is the gate for everything here: who may buy, the price, the
// charge, refunds and payouts. This file only mirrors the shared rules so the screens never offer what the server will
// refuse, and never show a price it did not send.
import { DEFAULT_RATES, ticketBreakdown } from "@shared/money";
import { ROOM_LIMITS } from "@shared/rooms";
import { BUYER_REFUND_CUTOFF_MS, buyerRefundCheck, type BuyerRefundCode } from "@shared/roomRefunds";
import type { RoomPayoutView, RoomTicketBlock, RoomTicketSummary, RoomTicketView } from "./roomsApi";

// ---------------------------------------------------------------- limits
/** The ticket limits come from shared/rooms.ts ROOM_LIMITS (the server validates with the same numbers). The rest is UI only. */
export const TICKET_LIMITS = {
  minKobo: ROOM_LIMITS.ticketMinKobo,           // 1,000 naira
  maxKobo: ROOM_LIMITS.ticketMaxKobo,           // 100,000 naira
  capacityMin: ROOM_LIMITS.ticketCapacityMin,   // 20
  capacityMax: ROOM_LIMITS.ticketCapacityMax,   // 150
  priceStepNaira: 500,
  capacityStep: 10,
  defaultPriceNaira: 5_000,
  defaultCapacity: 100,
} as const;

// ---------------------------------------------------------------- money display
const MINUS = "−"; // a real minus sign, not a dash

/**
 * "₦5,000" from 500000 kobo. For prices only (the buyer pays exactly this): whole naira show no decimals, and a price
 * that is not whole (only possible through the API) shows two, so a charge is never misstated.
 */
export function formatNaira(kobo: number): string {
  if (!Number.isFinite(kobo)) return "₦0";
  const k = Math.round(kobo);
  const sign = k < 0 ? MINUS : "";
  const abs = Math.abs(k);
  const whole = abs % 100 === 0;
  const naira = (abs / 100).toLocaleString("en-US", whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}₦${naira}`;
}

/**
 * Whole naira for sums and estimates (host sales, the earnings estimate). Earnings use "floor" so they are never
 * overstated; deductions use "ceil" so costs are never understated.
 */
export function formatNairaWhole(kobo: number, how: "floor" | "round" | "ceil" = "round"): string {
  if (!Number.isFinite(kobo)) return "₦0";
  const n = Math[how](kobo / 100);
  const sign = n < 0 ? MINUS : "";
  return `${sign}₦${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** "−₦21,806" for a deduction line: whole naira, rounded up, always shown as taken away whatever sign it arrives with. */
export const formatDeduction = (kobo: number) => `${MINUS}${formatNairaWhole(Math.abs(kobo), "ceil")}`;

// ---------------------------------------------------------------- who sees what
/**
 * Reads the `ticket` block of GET /api/rooms/:id. The server sends it ONLY to viewers who can view the room and are
 * ticket-eligible adults. Anything missing or malformed is treated as absent, which means no price and no ticket UI.
 */
export function parseTicketBlock(x: unknown): RoomTicketBlock | null {
  if (!x || typeof x !== "object") return null;
  const t = x as Record<string, unknown>;
  if (typeof t.required !== "boolean" || typeof t.held !== "boolean" || typeof t.soldOut !== "boolean") return null;
  if (typeof t.priceKobo !== "number" || !Number.isInteger(t.priceKobo) || t.priceKobo <= 0) return null;
  const block: RoomTicketBlock = { required: t.required, priceKobo: t.priceKobo, held: t.held, soldOut: t.soldOut };
  // Optional extras (fix round 4F), only when the server sends them in the right shape.
  if (typeof t.left === "number" && Number.isInteger(t.left) && t.left >= 0) block.left = t.left;
  if (typeof t.capacity === "number" && Number.isInteger(t.capacity) && t.capacity > 0) block.capacity = t.capacity;
  if (typeof t.refundBeforeStart === "boolean") block.refundBeforeStart = t.refundBeforeStart;
  return block;
}

/**
 * What the ticket screens show for this viewer:
 * - "none": no price, no ticket UI (no block, a free room, or the host / a co-host, who never buy).
 * - "buy": the ticket page with Get ticket.
 * - "soldout": the ticket page, button off.
 * - "held": they have a ticket (waiting room, or the lobby once live).
 */
export type TicketGate = "none" | "buy" | "soldout" | "held";
export function ticketGate(ticket: unknown, role: "host" | "cohost" | "guest" | null | undefined): TicketGate {
  const t = parseTicketBlock(ticket);
  if (!t || !t.required) return "none";
  if (role === "host" || role === "cohost") return "none";
  if (t.held) return "held";
  return t.soldOut ? "soldout" : "buy";
}
/** A price may be drawn only on the ticket page, only from the server's block. */
export const showsPrice = (gate: TicketGate) => gate === "buy" || gate === "soldout";

/**
 * After the socket refused the join with TICKET_REQUIRED: the ticket page when the server sent a block (a refunded ticket
 * looks the same as none), otherwise the plain refusal with no price. Never infers a price from anything else.
 */
export function afterTicketRefusal(ticket: unknown): "page" | "plain" {
  const t = parseTicketBlock(ticket);
  return t && t.required ? "page" : "plain";
}

// ---------------------------------------------------------------- the return from Paystack
/** Exactly the shape server/rooms/ticketReference.ts makes: vib3rt_<24 hex nonce>_<32 hex MAC>. Anything else is ignored. */
export const TICKET_REF_SHAPE = /^vib3rt_[0-9a-f]{24}_[0-9a-f]{32}$/;
/** The payment reference on the way back to /rooms/:id. Our own `ref` first; Paystack also adds `reference` and `trxref`. */
export function returnRef(search: string): string | null {
  const p = new URLSearchParams(search);
  for (const k of ["ref", "reference", "trxref"]) {
    const v = (p.get(k) ?? "").trim();
    if (TICKET_REF_SHAPE.test(v)) return v;
  }
  return null;
}
/** The same search string without the payment reference, so a reload does not verify again (it is safe if it does). */
export function searchWithoutRef(search: string): string {
  const p = new URLSearchParams(search);
  for (const k of ["ref", "reference", "trxref"]) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Only ever leave for a Paystack page over https, or our own origin (the dev fixture). Anything else is refused. */
export function safeCheckoutUrl(url: unknown, origin: string): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url, origin);
    if (u.origin === origin) return u.toString();
    if (u.protocol === "https:" && (u.hostname === "paystack.com" || u.hostname.endsWith(".paystack.com"))) return u.toString();
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the invite token across the Paystack trip
// Checkout, refund and cancel are gated on canViewRoom(room, user, ?token=). The server keeps the token out of the
// Paystack return URL (it would be handed to Paystack), so the page keeps it in sessionStorage for this tab.
type TokenStore = Pick<Storage, "getItem" | "setItem">;
export const inviteTokenKey = (roomId: string) => `room-invite:${roomId}`;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;
export function rememberInviteToken(store: TokenStore | null | undefined, roomId: string, token: string | null | undefined): void {
  if (!store || !token || !TOKEN_SHAPE.test(token)) return;
  try { store.setItem(inviteTokenKey(roomId), token); } catch { /* storage off: the URL token still works until the redirect */ }
}
export function recallInviteToken(store: TokenStore | null | undefined, roomId: string): string | undefined {
  if (!store) return undefined;
  try {
    const v = store.getItem(inviteTokenKey(roomId));
    return v && TOKEN_SHAPE.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
/** The URL's ?token= first, then the one kept for this room before the Paystack trip. */
export function inviteTokenFor(search: string, store: TokenStore | null | undefined, roomId: string): string | undefined {
  const fromUrl = new URLSearchParams(search).get("token");
  if (fromUrl) return fromUrl;
  return recallInviteToken(store, roomId);
}
/** "?token=..." for the ticket calls, or "" when there is no token. */
export const withToken = (token: string | null | undefined) => (token ? `?token=${encodeURIComponent(token)}` : "");

// ---------------------------------------------------------------- refusals in plain words
export type TicketPhase = "checkout" | "verify" | "refund" | "summary" | "cancel";
export interface TicketFailure { status: number; code?: string }

export const TICKET_ERROR = {
  offline: "Couldn't reach Vib3Pulse. Check your connection and try again.",
  rateLimited: "You're doing that too fast. Please try again in a bit.",
  notFound: "This room isn't available.",
  signIn: "Sign in again to buy a ticket.",
  signInVerify: "Sign in again to finish getting your ticket. You will never be charged twice.",
  signInGeneric: "Sign in again, then try once more.",
  // checkout
  featureOff: "Tickets are not on sale yet.",
  notEligible: "You can't buy a ticket for this room.",
  isHost: "You host this room, so you don't need a ticket.",
  notTicketed: "This room doesn't sell tickets.",
  ended: "This room has ended.",
  notOnSale: "Tickets aren't on sale right now.",
  alreadyTicketed: "You already have a ticket for this room.",
  soldOut: "This room is sold out.",
  roomLocked: "The host has paused ticket sales.",
  salesPaused: "Ticket sales are paused for this room.",
  checkoutGeneric: "Couldn't start the payment. Try again.",
  // verify
  badRef: "This payment link isn't valid.",
  paymentNotFound: "We couldn't find this payment on your account.",
  notPaid: "Your payment hasn't gone through. If you paid, try again in a moment. If not, you have not been charged.",
  verifySoldOut: "The last ticket went just before your payment. Your money is on its way back to your card.",
  verifyMismatch: "Something did not match on your payment, so it is being refunded to your card.",
  verifyIneligible: "We couldn't give you a ticket for this room, so your payment is being refunded to your card.",
  verifyRefunded: "This ticket was refunded.",
  verifyGeneric: "Couldn't confirm your ticket yet. Try again. You will never be charged twice.",
  // refund, summary, cancel
  refundGeneric: "Couldn't refund your ticket. Try again.",
  summaryGeneric: "Couldn't load your ticket sales. Try again.",
  notHost: "Only the host can see ticket sales.",
  cancelNotHost: "Only the host can cancel this room.",
  cancelLive: "A live room can't be cancelled. End it instead.",
  cancelBadState: "This room can't be cancelled now.",
  cancelGeneric: "Couldn't cancel the room. Try again.",
} as const;

/** Checkout 409 codes, in the buyer's words. Any 409 also reloads the room (the page may be stale). */
const CHECKOUT_409: Record<string, string> = {
  IS_HOST: TICKET_ERROR.isHost,
  NOT_TICKETED: TICKET_ERROR.notTicketed,
  ROOM_ENDED: TICKET_ERROR.ended,
  NOT_ON_SALE: TICKET_ERROR.notOnSale,
  ALREADY_TICKETED: TICKET_ERROR.alreadyTicketed,
  SOLD_OUT: TICKET_ERROR.soldOut,
  ROOM_LOCKED: TICKET_ERROR.roomLocked,
  SALES_PAUSED: TICKET_ERROR.salesPaused,
};
/** Verify 409s: the charge was refused and is being refunded (the server answers refunded: true with these). */
const VERIFY_409: Record<string, string> = {
  SOLD_OUT: TICKET_ERROR.verifySoldOut,
  AMOUNT_MISMATCH: TICKET_ERROR.verifyMismatch,
  INELIGIBLE: TICKET_ERROR.verifyIneligible,
};

/** Plain words for a refused ticket call. Never the server's own text, so every line follows the copy rules. */
export function ticketErrorMessage(f: TicketFailure, phase: TicketPhase): string {
  const c = f.code;
  if (f.status === 0) return TICKET_ERROR.offline;
  if (f.status === 429 || c === "RATE_LIMITED") return TICKET_ERROR.rateLimited;
  if (f.status === 401) return phase === "checkout" ? TICKET_ERROR.signIn : phase === "verify" ? TICKET_ERROR.signInVerify : TICKET_ERROR.signInGeneric;
  switch (phase) {
    case "checkout":
      if (c === "FEATURE_OFF") return TICKET_ERROR.featureOff;
      if (f.status === 404) return c === "NOT_ELIGIBLE" ? TICKET_ERROR.notEligible : TICKET_ERROR.notFound;
      if (f.status === 409 && c && CHECKOUT_409[c]) return CHECKOUT_409[c];
      return TICKET_ERROR.checkoutGeneric; // 5xx / 502 CHECKOUT_FAILED and anything unknown
    case "verify":
      if (f.status === 400) return TICKET_ERROR.badRef;
      if (f.status === 404) return TICKET_ERROR.paymentNotFound;
      if (f.status === 402 || c === "NOT_PAID") return TICKET_ERROR.notPaid;
      if (f.status === 409 && c && VERIFY_409[c]) return VERIFY_409[c];
      return TICKET_ERROR.verifyGeneric; // 502 VERIFY_FAILED, 500 VERIFY_ERROR and anything unknown
    case "refund":
      if (c && REFUND_REFUSAL[c]) return REFUND_REFUSAL[c];
      if (f.status === 404) return TICKET_ERROR.notFound;
      return TICKET_ERROR.refundGeneric;
    case "summary":
      if (f.status === 403) return TICKET_ERROR.notHost;
      if (f.status === 404) return TICKET_ERROR.notFound;
      return TICKET_ERROR.summaryGeneric;
    case "cancel":
      if (f.status === 403) return TICKET_ERROR.cancelNotHost;
      if (f.status === 404) return TICKET_ERROR.notFound;
      if (c === "ROOM_LIVE") return TICKET_ERROR.cancelLive;
      if (c === "BAD_STATE") return TICKET_ERROR.cancelBadState;
      return TICKET_ERROR.cancelGeneric;
  }
}

/** After a refused checkout: any 409 means the room changed under the page (sold out, ended, you host it...): reload it. */
export const checkoutNeedsRefetch = (f: TicketFailure) => f.status === 409;
/** After a refused cancel: the room's state changed, reload it. */
export const cancelNeedsRefetch = (f: TicketFailure) => f.status === 409;

/**
 * Whether "Try again" makes sense after a refused verify. Not for a bad or foreign reference, nor a refused charge that is
 * already being refunded, nor a signed-out buyer (they sign in instead). Yes for not-paid-yet and provider hiccups.
 */
export function verifyRetryable(f: TicketFailure): boolean {
  if (f.status === 400 || f.status === 401 || f.status === 404) return false;
  if (f.status === 409 && !!f.code && !!VERIFY_409[f.code]) return false;
  return true;
}

/** What a 2xx verify body means. Only a ticket with status "paid" is "You are in"; a refunded one says so. */
export type VerifyOutcome =
  | { kind: "paid"; ticket: RoomTicketView; duplicateRefunded: boolean }
  | { kind: "refunded" }
  | { kind: "bad" };
export function verifyOutcome(body: unknown): VerifyOutcome {
  if (!body || typeof body !== "object") return { kind: "bad" };
  const b = body as Record<string, unknown>;
  const t = b.ticket as Record<string, unknown> | null | undefined;
  if (!t || typeof t !== "object" || typeof t.code !== "string" || !t.code) return { kind: "bad" };
  if (t.status === "refunded") return { kind: "refunded" };
  if (t.status !== "paid") return { kind: "bad" };
  return { kind: "paid", ticket: t as unknown as RoomTicketView, duplicateRefunded: b.duplicateRefunded === true };
}

/** Codes a POST/PATCH room answers about ticket fields (canSellTickets, the sale guard, the live guard), in the host's words. */
export const TICKET_CREATE_ERROR: Record<string, string> = {
  FEATURE_OFF: "Paid rooms are not available yet.",
  HOST_NOT_ADULT: "You need to be 18 to sell tickets.",
  HOST_NOT_VERIFIED: "Verify your ID before you sell tickets.",
  NO_PAYOUT_ACCOUNT: "Add a bank account in your own name on the Payout account page (/rooms/payouts) before you sell tickets.",
  ROOM_NOT_ADULT: "Tickets are only for 18+ and 21+ rooms.",
  TICKETS_SOLD: "Tickets are sold, so the price, age limit and refunds can't change.",
  CAPACITY_BELOW_SOLD: "You can't have fewer tickets than you have sold.",
  NOT_SCHEDULED: "You can only start selling tickets before the room goes live.",
};
export const TICKET_FIELDS = ["ticketPriceKobo", "ticketCapacity", "refundBeforeStart"] as const;
/** A refusal that belongs to the price step: a ticket code or a ticket field. */
export function isTicketFailure(f: { code?: string; field?: string }): boolean {
  return (!!f.code && f.code in TICKET_CREATE_ERROR) || (!!f.field && (TICKET_FIELDS as readonly string[]).includes(f.field));
}
export function ticketCreateMessage(f: { code?: string; field?: string }): string | null {
  if (f.code && TICKET_CREATE_ERROR[f.code]) return TICKET_CREATE_ERROR[f.code];
  if (f.field === "ticketPriceKobo") return PRICE_COPY.priceRange;
  if (f.field === "ticketCapacity") return PRICE_COPY.capacityRange;
  if (f.field === "refundBeforeStart") return PRICE_COPY.refundBad;
  return null;
}
/** Whether a wizard error belongs to one of the price step's own fields (otherwise the step shows it in a general box). */
export const isPriceStepField = (field: string | undefined | null) => !!field && (TICKET_FIELDS as readonly string[]).includes(field);
/** Where focus goes for a ticket field in error (the price step's own ids). */
export function ticketFieldSelectors(field: string): string[] {
  if (field === "ticketPriceKobo") return ["#wiz-price"];
  if (field === "ticketCapacity") return ["#wiz-ticket-cap"];
  if (field === "refundBeforeStart") return ["#wiz-refund"];
  return [];
}

// ---------------------------------------------------------------- waiting room clock
/** "12:08" under an hour, "2:05:09" under a day, then "2d 3h". Zero or less: "00:00". */
export function waitingClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}:${p2(m)}:${p2(sec)}`;
  return `${p2(m)}:${p2(sec)}`;
}
/** Every second under a day; once a minute beyond that (the clock only shows hours there). */
export const waitingTickMs = (ms: number | null) => (ms !== null && ms > 86_400_000 ? 60_000 : 1000);

// ---------------------------------------------------------------- refunds
export { BUYER_REFUND_CUTOFF_MS };

export const REFUND_COPY = {
  button: "Refund my ticket",
  confirmTitle: "Refund your ticket?",
  confirmBody: (price: string) => `You get ${price} back on your card and lose your place in the room. It can take a few days to show.`,
  confirmYes: "Refund ticket",
  confirmNo: "Keep my ticket",
  working: "Refunding",
  done: "Your ticket is refunded. It can take a few days to show on your card.",
  pending: "Your refund is on its way. It can take a few days to show on your card.",
  already: "This ticket was already refunded.",
  closedRefunded: "This ticket was already refunded.",
} as const;

/**
 * Why a refund is refused, by code: the shared rule's codes (buyerRefundCheck, used for the button) and the refund
 * route's own 404/409 codes (server/rooms/ticketMoneyRoutes.ts). One line per code.
 */
export const REFUND_REFUSAL: Record<BuyerRefundCode | "PAYOUT_RELEASED" | "BAD_STATE" | "REFUND_IN_PROGRESS" | "NO_TICKET", string> & Record<string, string> = {
  ROOM_NOT_SCHEDULED: "Refunds close when the room starts.",
  NO_REFUNDS: "The host does not offer refunds before the start. If the room does not start, you are refunded automatically.",
  NO_START_TIME: "This room has no start time, so there is no refund window. If the room does not start, you are refunded automatically.",
  WINDOW_CLOSED: "Refunds closed 1 hour before the start.",
  PAYOUT_RELEASED: "This ticket can't be refunded any more.",
  BAD_STATE: "This ticket can't be refunded.",
  REFUND_IN_PROGRESS: "Your refund is already being processed.",
  NO_TICKET: "You don't have a ticket to refund.",
};

export type RefundWindow = { open: true; closesAt: number } | { open: false; reason: string };

/**
 * Whether the buyer may ask for a refund now, by the shared rule (shared/roomRefunds.ts buyerRefundCheck, which the server
 * uses too). An unknown refundBeforeStart (the server did not send it) is left to the server: the button stays on.
 */
export function refundWindow(
  room: { status: "scheduled" | "live" | "ended"; scheduledFor: string | null; refundBeforeStart?: boolean },
  ticketStatus: "paid" | "refunded" | null | undefined,
  now: number,
): RefundWindow {
  if (ticketStatus === "refunded") return { open: false, reason: REFUND_COPY.closedRefunded };
  const parsed = room.scheduledFor ? Date.parse(room.scheduledFor) : NaN;
  const scheduledForMs = Number.isNaN(parsed) ? null : parsed;
  const chk = buyerRefundCheck({ status: room.status, refundBeforeStart: room.refundBeforeStart !== false, scheduledForMs }, now);
  if (!chk.ok) return { open: false, reason: REFUND_REFUSAL[chk.code] };
  return { open: true, closesAt: (scheduledForMs as number) - BUYER_REFUND_CUTOFF_MS };
}

/** What a 2xx refund body means for the buyer. A refund not yet confirmed by the provider is "on its way". */
export function refundOutcome(body: unknown): { kind: "refunded" | "already" | "pending"; text: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.result === "pending" || ((b.result === "refunded" || b.result === "already") && b.settled === false)) return { kind: "pending", text: REFUND_COPY.pending };
  if (b.result === "refunded") return { kind: "refunded", text: REFUND_COPY.done };
  if (b.result === "already") return { kind: "already", text: REFUND_COPY.already };
  return null;
}

/** The refund promise on the ticket page. The "1 hour" line only when the server said the host offers it. */
export function refundPromise(room: { scheduledFor: string | null; refundBeforeStart?: boolean }): string {
  const auto = "If the room does not start, you are refunded automatically.";
  if (room.refundBeforeStart === true && room.scheduledFor) return `Full refund up to 1 hour before. ${auto}`;
  return auto;
}

// ---------------------------------------------------------------- ticket page copy
export const TICKET_COPY = {
  getTicket: (price: string) => `Get ticket · ${price}`,
  soldOut: "Sold out",
  includesVat: "Price includes VAT",
  ticketsLeft: "Tickets left",
  leftOf: (left: number, cap: number) => `${left} of ${cap}`,
  onSale: "On sale",
  includes: "Includes",
  includesWhat: "Live room, chat and reactions",
  hostedBy: (name: string) => `Hosted by ${name}`,
  redirecting: "Taking you to Paystack",
  pageLabel: "Ticket for this room",
  plainRefusal: "You need a ticket to join this room.",
  checkoutTitle: "Checking your payment",
  checkoutBody: "This takes a few seconds. Please keep this page open.",
  retry: "Try again",
  signIn: "Sign in",
  backToTicket: "Back to the ticket",
  confirmedTitle: "You are in",
  duplicateRefunded: "You already had a ticket; the second payment is being refunded.",
  ticketTag: "Ticket",
  codeLabel: "Ticket code",
  codeHelp: "Your ticket lives on your account. You don't need to show this code to get in.",
  continue: "Continue",
  waitingTag: "Ticket confirmed",
  waitingUntil: (host: string) => `until ${host} goes live`,
  waitingSoon: (host: string) => `${host} is getting ready`,
  waitingNoTime: (host: string) => `${host} will go live soon.`,
  waitingLive: "The room is live. Join now.",
  join: "Join room",
  checking: "Checking",
} as const;

/** "62 of 100", or "On sale" when the server did not say how many are left (the block's counts are optional). */
export function ticketsLeftText(t: Pick<RoomTicketBlock, "left" | "capacity" | "soldOut">): string {
  if (t.soldOut) return TICKET_COPY.soldOut;
  if (typeof t.left === "number" && typeof t.capacity === "number") return TICKET_COPY.leftOf(t.left, t.capacity);
  return TICKET_COPY.onSale;
}

// ---------------------------------------------------------------- the wizard's price step
export interface TicketDraft {
  /** The host switched Paid room on in the features step. */
  on: boolean;
  /** Whole naira, as typed (the payload sends kobo). NaN while the box is empty. */
  priceNaira: number;
  capacity: number;
  refundBeforeStart: boolean;
}
export const defaultTicketDraft = (): TicketDraft => ({
  on: false, priceNaira: TICKET_LIMITS.defaultPriceNaira, capacity: TICKET_LIMITS.defaultCapacity, refundBeforeStart: true,
});

export const PRICE_COPY = {
  title: "Set the price",
  paidLabel: "Paid room",
  paidHelp: "Guests buy a ticket to get in. 18+ and 21+ rooms only.",
  paidNeedsId: "Verify your ID before you sell tickets.",
  priceLabel: "Ticket price in naira",
  lower: "Lower price",
  raise: "Raise price",
  capacityLabel: "Tickets available",
  fewer: "Fewer tickets",
  more: "More tickets",
  priceRange: `Pick a price between ${formatNaira(TICKET_LIMITS.minKobo)} and ${formatNaira(TICKET_LIMITS.maxKobo)}.`,
  capacityRange: `Pick between ${TICKET_LIMITS.capacityMin} and ${TICKET_LIMITS.capacityMax} tickets.`,
  refundBad: "Pick whether guests can get a refund before the start.",
  perTicket: "You earn per ticket",
  ifHalf: (n: number) => `If ${n} sell`,
  about: (v: string) => `about ${v}`,
  feesNote: (platformPct: number) => `After VAT (7.5%), card fees and a fraud reserve, we take ${platformPct}%. Price includes VAT.`,
  refundLabel: "Refund up to 1 hour before",
  refundHelp: "If the room never starts, everyone is refunded automatically.",
  payoutTitle: "Payouts",
  payoutBody: "Ticket money is held until 48 hours after the room ends, then paid to your payout account.",
  videoOver: `Live video works in rooms of up to ${ROOM_LIMITS.liveVideoMax} people, so with more tickets than that this room has voice only.`,
  videoNeedsFewer: `Live video works in rooms of up to ${ROOM_LIMITS.liveVideoMax} people. Sell ${ROOM_LIMITS.liveVideoMax} tickets or fewer to use it.`,
  reviewTicket: "Ticket",
  reviewTickets: (n: number) => `${n} tickets`,
} as const;

/** Live video is refused above this many ticket holders (lane S1). True when this draft leaves no room for it. */
export const ticketsTooManyForVideo = (d: Pick<TicketDraft, "on" | "capacity">) =>
  d.on && !(Number.isFinite(d.capacity) && d.capacity <= ROOM_LIMITS.liveVideoMax);

/** The step's clamps for the stepper buttons (typing is checked, not clamped, so a host sees what they typed). */
export const clampPriceNaira = (n: number) =>
  Math.min(TICKET_LIMITS.maxKobo / 100, Math.max(TICKET_LIMITS.minKobo / 100, Number.isFinite(n) ? Math.round(n) : TICKET_LIMITS.defaultPriceNaira));
export const clampTicketCapacity = (n: number) =>
  Math.min(TICKET_LIMITS.capacityMax, Math.max(TICKET_LIMITS.capacityMin, Number.isFinite(n) ? Math.round(n) : TICKET_LIMITS.defaultCapacity));

/** Kobo for a whole-naira price, or null when it is not a whole number in range. */
export function priceKoboOf(priceNaira: number): number | null {
  if (!Number.isInteger(priceNaira)) return null;
  const kobo = priceNaira * 100;
  return kobo >= TICKET_LIMITS.minKobo && kobo <= TICKET_LIMITS.maxKobo ? kobo : null;
}

/** The price step's own check before Continue. */
export function ticketDraftProblem(d: TicketDraft): { field: string; reason: string } | null {
  if (!d.on) return null;
  if (priceKoboOf(d.priceNaira) === null) return { field: "ticketPriceKobo", reason: PRICE_COPY.priceRange };
  if (!Number.isInteger(d.capacity) || d.capacity < TICKET_LIMITS.capacityMin || d.capacity > TICKET_LIMITS.capacityMax) {
    return { field: "ticketCapacity", reason: PRICE_COPY.capacityRange };
  }
  return null;
}

/**
 * The live earnings estimate, from shared/money.ts ticketBreakdown only (the server uses the same). "If half sell" uses
 * half the tickets, rounded. Null while the price is not valid. Shown in whole naira, rounded down (formatNairaWhole floor).
 */
export interface TicketRatesConfig { ticketPlatformPct: number; ticketReservePct: number }

export function earningsEstimate(priceNaira: number, capacity: number, rates?: TicketRatesConfig): { perTicketKobo: number; half: number; halfKobo: number } | null {
  const kobo = priceKoboOf(priceNaira);
  if (kobo === null) return null;
  // The saved rates from /api/rooms/config; until they load (or on an older server) today's defaults.
  const host = ticketBreakdown(kobo, rates ? { ...DEFAULT_RATES, ticket_platform: rates.ticketPlatformPct, ticket_reserve: rates.ticketReservePct } : DEFAULT_RATES).host;
  const half = Math.max(1, Math.round((Number.isFinite(capacity) ? capacity : TICKET_LIMITS.defaultCapacity) / 2));
  return { perTicketKobo: host, half, halfKobo: host * half };
}
/** "about ₦3,762": the estimate in whole naira, never more than the host would get. */
export const estimateText = (kobo: number) => PRICE_COPY.about(formatNairaWhole(kobo, "floor"));

/** Ticket fields of the create payload. Empty unless the price step is enabled AND switched on AND valid. */
export interface TicketPayload { ticketPriceKobo: number; ticketCapacity: number; refundBeforeStart: boolean }
export function ticketPayload(d: TicketDraft | undefined, enabled: boolean): TicketPayload | Record<string, never> {
  if (!enabled || !d || !d.on) return {};
  const kobo = priceKoboOf(d.priceNaira);
  // An invalid price is still sent as typed (in kobo) so the server names the field, like the schedule does.
  return {
    ticketPriceKobo: kobo ?? Math.round((Number.isFinite(d.priceNaira) ? d.priceNaira : 0) * 100),
    ticketCapacity: d.capacity,
    refundBeforeStart: d.refundBeforeStart === true,
  };
}

/** Whether the wizard shows the paid switch and the price step: the paidRooms flag on and money not locked for this room. */
export const priceStepAvailable = (paidRoomsFlag: boolean, moneyLocked: string | null | undefined) => paidRoomsFlag === true && moneyLocked === null;

// ---------------------------------------------------------------- host sales
export const SALES_COPY = {
  open: "Tickets",
  title: "Tickets",
  desc: "Ticket sales for this room.",
  sold: "Tickets sold",
  of: (cap: number) => `of ${cap}`,
  refunded: (n: number) => (n === 1 ? "1 ticket refunded" : `${n} tickets refunded`),
  gross: "Gross",
  costs: "VAT, card fees, reserve",
  platform: "Platform share", // no fixed percent: past tickets keep the rate they were sold at
  earn: "You earn",
  heldUntil: (when: string) => `Held until ${when}, then paid out. Late sales and refunds change these numbers.`,
  heldAfterEnd: "Paid out 48 hours after the room ends. Late sales and refunds change these numbers.",
  paidOn: (when: string) => `Paid out on ${when}.`,
  soldOut: "Sold out",
  cancel: "Cancel room and refund everyone",
  cancelTitle: "Cancel this room?",
  cancelBody: "It won't start, and everyone with a ticket gets a full refund to their card.",
  cancelYes: "Cancel and refund",
  cancelNo: "Keep the room",
  cancelled: "Room cancelled. Everyone with a ticket is being refunded.",
} as const;

/**
 * The host's sheet lines from the summary route, in whole naira. Costs are the stored VAT, card fee and reserve sums
 * (rounded up), the platform share is rounded up, and what the host earns is rounded down, so it is never overstated.
 */
export function salesLines(s: RoomTicketSummary): { gross: string; costs: string; platform: string; earn: string } {
  return {
    gross: formatNairaWhole(s.grossKobo, "round"),
    costs: formatDeduction(s.vatKobo + s.feeKobo + s.reserveKobo),
    platform: formatDeduction(s.platformKobo),
    earn: formatNairaWhole(s.hostKobo, "floor"),
  };
}
/** Sold out once paid tickets reach the room's ticket capacity (the host's own room carries it; the summary does not). */
export const salesSoldOut = (sold: number, capacity: number | null | undefined) =>
  typeof capacity === "number" && capacity > 0 && sold >= capacity;

/** The payout line under the numbers. */
export function salesReleaseLine(payout: RoomPayoutView | null, when: (iso: string) => string): string {
  if (payout?.paidAt) return SALES_COPY.paidOn(when(payout.paidAt));
  if (payout?.releaseAt) return SALES_COPY.heldUntil(when(payout.releaseAt));
  return SALES_COPY.heldAfterEnd;
}

/**
 * Reads the summary route's body, `{ summary: { ... } }`; null for anything that is not that shape. Fields the server
 * may add later (refusedCharges) are ignored.
 */
export function parseSummary(body: unknown): RoomTicketSummary | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).summary;
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const keys = ["sold", "refunded", "grossKobo", "vatKobo", "feeKobo", "reserveKobo", "platformKobo", "hostKobo"] as const;
  for (const k of keys) if (!int(s[k])) return null;
  const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  let payout: RoomPayoutView | null = null;
  const p = s.payout;
  if (p && typeof p === "object") {
    const q = p as Record<string, unknown>;
    if (typeof q.status === "string" && int(q.amountKobo)) payout = { status: q.status, amountKobo: q.amountKobo, releaseAt: iso(q.releaseAt), paidAt: iso(q.paidAt) };
  }
  return {
    sold: s.sold as number, refunded: s.refunded as number,
    grossKobo: s.grossKobo as number, vatKobo: s.vatKobo as number, feeKobo: s.feeKobo as number, reserveKobo: s.reserveKobo as number,
    platformKobo: s.platformKobo as number, hostKobo: s.hostKobo as number,
    payout,
  };
}

// ---------------------------------------------------------------- amber contrast
/** WCAG relative luminance of an sRGB hex colour ("#F59E0B"). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new RangeError(`not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** "32 95% 52%" (the CSS variable form in index.css) as "#rrggbb". */
export function hslTripletToHex(triplet: string): string {
  const m = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(triplet);
  if (!m) throw new RangeError(`not an hsl triplet: ${triplet}`);
  const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  return "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
/**
 * Amber is drawn ONLY as a fill (bg-secondary) with its own text colour (text-secondary-foreground), never as text on the
 * page background: amber text on the light background is about 2:1. These are the class strings every money moment uses
 * (price chip, earnings, the ticket). Decorative surfaces such as the ticket cover use the violet primary only.
 */
export const AMBER = {
  fill: "bg-secondary text-secondary-foreground",
  chip: "inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground",
  button: "bg-secondary text-secondary-foreground hover:bg-secondary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
  tint: "border border-secondary/60 bg-secondary/10",
} as const;

/** Every sentence these screens use, so one test can check the copy rules over all of them. */
const filled = (v: unknown): string => (typeof v === "function" ? String((v as unknown as (...a: unknown[]) => unknown)("Dayo", 50)) : String(v));
export const TICKET_UI_COPY: readonly string[] = [
  ...Object.values(TICKET_ERROR), ...Object.values(TICKET_CREATE_ERROR), ...Object.values(REFUND_REFUSAL),
  ...Object.values(REFUND_COPY).map(filled), ...Object.values(TICKET_COPY).map(filled),
  ...Object.values(PRICE_COPY).map(filled), ...Object.values(SALES_COPY).map(filled),
  refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: true }), refundPromise({ scheduledFor: null }),
];
