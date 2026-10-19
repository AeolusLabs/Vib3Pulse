// Paid room tickets on the client (phase 4, task 4.7). Pure: no React, no window, no network, no clock reads.
// The server is the gate for everything here: who may buy, the price, the charge, refunds and payouts. This file only
// mirrors the shared rules so the screens never offer what the server will refuse, and never show a price it did not send.
import { TICKET_PLATFORM_PCT, ticketBreakdown } from "@shared/money";
import { ROOM_LIMITS } from "@shared/rooms";
import type { RoomTicketBlock, RoomTicketSummary } from "./roomsApi";

// ---------------------------------------------------------------- limits
/**
 * Mirror of the ticket limits in shared/rooms.ts (lane S1: ticketMinKobo, ticketMaxKobo, ticketCapacityMin, ticketCapacityMax).
 * Kept here so this lane builds on its own; a test checks they match once shared/rooms.ts has them.
 */
export const TICKET_LIMITS = {
  minKobo: 100_000,          // 1,000 naira
  maxKobo: 10_000_000,       // 100,000 naira
  capacityMin: 20,
  capacityMax: ROOM_LIMITS.capacityMaxPaid, // 150
  priceStepNaira: 500,
  capacityStep: 10,
  defaultPriceNaira: 5_000,
  defaultCapacity: 100,
} as const;

// ---------------------------------------------------------------- money display
const MINUS = "−"; // a real minus sign, not a dash

/** "₦5,000" from 500000 kobo. Whole naira show no decimals; anything else shows two. The only naira formatter for tickets. */
export function formatNaira(kobo: number): string {
  if (!Number.isFinite(kobo)) return "₦0";
  const k = Math.round(kobo);
  const sign = k < 0 ? MINUS : "";
  const abs = Math.abs(k);
  const whole = abs % 100 === 0;
  const naira = (abs / 100).toLocaleString("en-US", whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}₦${naira}`;
}

/** "−₦21,806" for a deduction line (always shown as taken away, whatever the sign it arrives with). */
export const formatDeduction = (kobo: number) => `${MINUS}${formatNaira(Math.abs(kobo))}`;

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
  // Optional counts, only when the server sends them as whole numbers.
  if (typeof t.left === "number" && Number.isInteger(t.left) && t.left >= 0) block.left = t.left;
  if (typeof t.capacity === "number" && Number.isInteger(t.capacity) && t.capacity > 0) block.capacity = t.capacity;
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
/** The payment reference on the way back to /rooms/:id. Our own `ref` first; Paystack also adds `reference` and `trxref`. */
export function returnRef(search: string): string | null {
  const p = new URLSearchParams(search);
  for (const k of ["ref", "reference", "trxref"]) {
    const v = (p.get(k) ?? "").trim();
    if (v && v.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(v)) return v;
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

/** Only ever leave for a Paystack page over https, or our own origin (the mock provider). Anything else is refused. */
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

// ---------------------------------------------------------------- refusals in plain words
export type TicketPhase = "checkout" | "verify" | "refund" | "summary" | "cancel";
export interface TicketFailure { status: number; code?: string }

export const TICKET_ERROR = {
  offline: "Couldn't reach Vib3Pulse. Check your connection and try again.",
  rateLimited: "You're doing that too fast. Please try again in a bit.",
  notFound: "This room isn't available.",
  featureOff: "Tickets are not on sale yet.",
  alreadyTicketed: "You already have a ticket for this room.",
  soldOut: "This room is sold out.",
  ineligible: "You can't buy a ticket for this room.",
  ended: "This room has ended.",
  started: "This room has already started.",
  checkoutGeneric: "Couldn't start the payment. Try again.",
  verifyPending: "Your payment is still being confirmed. Try again in a moment.",
  verifyFailed: "Your payment did not go through. You have not been charged.",
  verifySoldOut: "The last ticket went just before your payment. Your money is on its way back to your card.",
  verifyMismatch: "Something did not match on your payment, so it is being refunded to your card.",
  verifyIneligible: "Tickets are for verified adults, so your payment is being refunded to your card.",
  verifyGeneric: "Couldn't confirm your ticket yet. Try again. You will never be charged twice.",
  refundClosed: "Refunds for this room have closed.",
  refundNone: "You don't have a ticket to refund.",
  refundGeneric: "Couldn't refund your ticket. Try again.",
  summaryGeneric: "Couldn't load your ticket sales. Try again.",
  cancelGeneric: "Couldn't cancel the room. Try again.",
  notHost: "Only the host can see ticket sales.",
} as const;

/** Plain words for a refused ticket call. Never the server's own text, so every line follows the copy rules. */
export function ticketErrorMessage(f: TicketFailure, phase: TicketPhase): string {
  const c = f.code;
  if (f.status === 0) return TICKET_ERROR.offline;
  if (f.status === 429 || c === "RATE_LIMITED") return TICKET_ERROR.rateLimited;
  if (c === "FEATURE_OFF") return TICKET_ERROR.featureOff;
  if (phase === "verify") {
    if (c === "SOLD_OUT" || c === "OVERSOLD") return TICKET_ERROR.verifySoldOut;
    if (c === "AMOUNT_MISMATCH") return TICKET_ERROR.verifyMismatch;
    if (c === "INELIGIBLE") return TICKET_ERROR.verifyIneligible;
    if (c === "PAYMENT_PENDING" || c === "PENDING") return TICKET_ERROR.verifyPending;
    if (c === "PAYMENT_FAILED" || c === "DECLINED" || c === "ABANDONED") return TICKET_ERROR.verifyFailed;
    if (f.status === 404 && !c) return TICKET_ERROR.notFound;
    return TICKET_ERROR.verifyGeneric;
  }
  if (phase === "refund") {
    if (c === "REFUND_CLOSED" || c === "NOT_ALLOWED" || c === "not_allowed") return TICKET_ERROR.refundClosed;
    if (c === "NO_TICKET" || f.status === 404) return TICKET_ERROR.refundNone;
    return TICKET_ERROR.refundGeneric;
  }
  if (phase === "summary") return f.status === 403 ? TICKET_ERROR.notHost : TICKET_ERROR.summaryGeneric;
  if (phase === "cancel") return TICKET_ERROR.cancelGeneric;
  // checkout
  if (c === "ALREADY_TICKETED" || (f.status === 409 && !c)) return TICKET_ERROR.alreadyTicketed;
  if (c === "SOLD_OUT") return TICKET_ERROR.soldOut;
  if (c === "INELIGIBLE" || c === "AGE_LIMIT" || c === "NOT_VERIFIED") return TICKET_ERROR.ineligible;
  if (c === "ROOM_ENDED") return TICKET_ERROR.ended;
  if (c === "ROOM_STARTED") return TICKET_ERROR.started;
  if (f.status === 404) return TICKET_ERROR.notFound;
  return TICKET_ERROR.checkoutGeneric;
}

/** Codes a POST/PATCH room answers about ticket fields (canSellTickets and the limits), in the host's words. */
export const TICKET_CREATE_ERROR: Record<string, string> = {
  FEATURE_OFF: "Paid rooms are not available yet.",
  HOST_NOT_ADULT: "You need to be 18 to sell tickets.",
  HOST_NOT_VERIFIED: "Verify your ID before you sell tickets.",
  NO_PAYOUT_ACCOUNT: "Connect a payout account in your organizer settings before you sell tickets.",
  ROOM_NOT_ADULT: "Tickets are only for 18+ and 21+ rooms.",
  PRICE_LOCKED: "The price can't change once tickets are sold.",
  CAPACITY_BELOW_SOLD: "You can't have fewer tickets than you have sold.",
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
/** Buyer refunds close this long before the scheduled start (server/rooms/refunds.ts, task 4.5). */
export const REFUND_CLOSE_MS = 60 * 60_000;

export type RefundWindow = { open: true; closesAt: number } | { open: false; reason: string };
export const REFUND_COPY = {
  button: "Refund my ticket",
  confirmTitle: "Refund your ticket?",
  confirmBody: (price: string) => `You get ${price} back on your card and lose your place in the room. It can take a few days to show.`,
  confirmYes: "Refund ticket",
  confirmNo: "Keep my ticket",
  working: "Refunding",
  done: "Your ticket is refunded. It can take a few days to show on your card.",
  already: "This ticket was already refunded.",
  closedStarted: "Refunds close when the room starts.",
  closedHour: "Refunds closed 1 hour before the start.",
  closedNoSchedule: "This room started straight away, so there is no refund window.",
  closedHost: "The host does not offer refunds before the start. If the room does not start, you are refunded automatically.",
  closedRefunded: "This ticket was already refunded.",
} as const;

/**
 * Whether the buyer may ask for a refund now. Mirrors the server rule: only before scheduledFor minus 60 minutes, only
 * when the host offered it (refundBeforeStart), only for a paid ticket in a room that has not started. An unknown
 * refundBeforeStart (older room payloads) is left to the server, which answers not_allowed if it is off.
 */
export function refundWindow(
  room: { status: "scheduled" | "live" | "ended"; scheduledFor: string | null; refundBeforeStart?: boolean },
  ticketStatus: "paid" | "refunded" | null | undefined,
  now: number,
): RefundWindow {
  if (ticketStatus === "refunded") return { open: false, reason: REFUND_COPY.closedRefunded };
  if (room.refundBeforeStart === false) return { open: false, reason: REFUND_COPY.closedHost };
  if (room.status !== "scheduled") return { open: false, reason: REFUND_COPY.closedStarted };
  const start = room.scheduledFor ? Date.parse(room.scheduledFor) : NaN;
  if (Number.isNaN(start)) return { open: false, reason: REFUND_COPY.closedNoSchedule };
  const closesAt = start - REFUND_CLOSE_MS;
  if (now >= closesAt) return { open: false, reason: REFUND_COPY.closedHour };
  return { open: true, closesAt };
}

/** The refund promise on the ticket page. The automatic refund if the room never starts is always true (task 4.5 job). */
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
  backToTicket: "Back to the ticket",
  confirmedTitle: "You are in",
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
  feesNote: `After VAT (7.5%), card fees and a fraud reserve, we take ${TICKET_PLATFORM_PCT}%. Price includes VAT.`,
  refundLabel: "Refund up to 1 hour before",
  refundHelp: "If the room never starts, everyone is refunded automatically.",
  payoutTitle: "Payouts",
  payoutBody: "Ticket money is held until 48 hours after the room ends, then paid to your payout account.",
  reviewTicket: "Ticket",
  reviewTickets: (n: number) => `${n} tickets`,
} as const;

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
 * half the tickets, rounded. Null while the price is not valid.
 */
export function earningsEstimate(priceNaira: number, capacity: number): { perTicketKobo: number; half: number; halfKobo: number } | null {
  const kobo = priceKoboOf(priceNaira);
  if (kobo === null) return null;
  const host = ticketBreakdown(kobo).host;
  const half = Math.max(1, Math.round((Number.isFinite(capacity) ? capacity : TICKET_LIMITS.defaultCapacity) / 2));
  return { perTicketKobo: host, half, halfKobo: host * half };
}

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
  gross: "Gross",
  costs: "VAT, card fees, reserve",
  platform: `Platform ${TICKET_PLATFORM_PCT}%`,
  earn: "You earn",
  heldUntil: (when: string) => `Held until ${when}, then paid out. Late sales and refunds change these numbers.`,
  heldAfterEnd: "Paid out 48 hours after the room ends. Late sales and refunds change these numbers.",
  soldOut: "Sold out",
  cancel: "Cancel room and refund everyone",
  cancelTitle: "Cancel this room?",
  cancelBody: "It won't start, and everyone with a ticket gets a full refund to their card.",
  cancelYes: "Cancel and refund",
  cancelNo: "Keep the room",
  cancelled: "Room cancelled. Everyone with a ticket is being refunded.",
} as const;

/** The host's sheet lines from the summary route. The costs line is what is left between gross and the two shares. */
export function salesLines(s: RoomTicketSummary): { gross: string; costs: string; platform: string; earn: string } {
  const costs = Math.max(0, s.grossKobo - s.platformKobo - s.hostKobo);
  return { gross: formatNaira(s.grossKobo), costs: formatDeduction(costs), platform: formatDeduction(s.platformKobo), earn: formatNaira(s.hostKobo) };
}

/** Reads the summary body; null for anything that is not the shape we expect. */
export function parseSummary(x: unknown): RoomTicketSummary | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!int(s.sold) || !int(s.grossKobo) || !int(s.platformKobo) || !int(s.hostKobo) || !int(s.capacity) || typeof s.soldOut !== "boolean") return null;
  const releaseAt = typeof s.releaseAt === "string" && !Number.isNaN(Date.parse(s.releaseAt)) ? s.releaseAt : null;
  return { sold: s.sold as number, grossKobo: s.grossKobo as number, platformKobo: s.platformKobo as number, hostKobo: s.hostKobo as number, releaseAt, capacity: s.capacity as number, soldOut: s.soldOut };
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
 * page background: amber text on the light background is about 2:1. These are the class strings every money moment uses.
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
  ...Object.values(TICKET_ERROR), ...Object.values(TICKET_CREATE_ERROR),
  ...Object.values(REFUND_COPY).map(filled), ...Object.values(TICKET_COPY).map(filled),
  ...Object.values(PRICE_COPY).map(filled), ...Object.values(SALES_COPY).map(filled),
  refundPromise({ scheduledFor: "2026-10-20T20:00:00Z", refundBeforeStart: true }), refundPromise({ scheduledFor: null }),
];
