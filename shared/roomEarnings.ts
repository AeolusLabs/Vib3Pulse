// Rooms phase 6 (tasks 6.1 to 6.3): the money-read contracts and their pure rules. Shared by the server
// (server/rooms/payouts.ts, earnings.ts, receipts.ts) and the client (P6-BC). No database, no provider, no Node APIs.
//
// MONEY RULES
//  - Every amount is an integer of kobo read from a stored row (room_tickets, spray_payments, room_payouts, host_clawbacks).
//    Nothing here is computed from client input. A row whose amount is not a safe non-negative integer throws
//    EarningsDataError: the API answers 500 rather than showing a total that might be wrong.
//  - "Settled" only when Paystack reported it: a room payout row in status 'paid' (settlement.ts marks it paid only after
//    Paystack verified the transfer). Spray shares are split to the subaccount at charge time and we store no provider
//    settlement report for them, so they are always "on its way" (revision A7: never "settled" from an estimate).
//  - A viewer only ever gets their own shares: computeEarnings takes the viewer's id and ignores every row where the viewer
//    is not the host (tickets, payouts, host share of a spray), the stage-guest recipient (guest share), or the clawback's
//    beneficiary, even if a caller passes more rows than it should.
import { isAdminHold } from "./roomRefunds";

// ---------------------------------------------------------------- 6.1 payout account (GET /api/rooms/payouts/status)

/** GET /api/rooms/payouts/status. Never the full account number, never the account name the bank returned. */
export interface RoomPayoutStatus {
  /** ID-verified and 18 or over now (isIdVerifiedAdult). */
  verifiedAdult: boolean;
  /**
   * The account rooms pay into, as connected through POST /api/rooms/payouts/account (name-checked). null when there is
   * none, or when the only account was connected through organiser onboarding (never name-checked, last four never seen
   * by us): the page then asks for an account, and saving it updates that same subaccount.
   */
  account: {
    bankName: string;
    /** Exactly four digits (the client refuses anything else). */
    last4: string;
    /** Always true for an account shown here (a mismatched account is never stored). */
    nameMatches: boolean;
  } | null;
  /** A Paystack subaccount exists with payouts enabled (hostPayoutReady). */
  subaccountReady: boolean;
}

/** Codes POST /api/rooms/payouts/account answers with (besides 200). */
export type PayoutAccountCode =
  | "NOT_VERIFIED"        // 403: not an ID-verified adult
  | "BAD_INPUT"           // 400: bankCode / accountNumber malformed
  | "BAD_BANK"            // 400: the bank code is not on Paystack's list
  | "NO_VERIFIED_NAME"    // 422: no verified legal name is stored for this person (owner item: the ID provider, gate G2)
  | "NAME_MISMATCH"       // 422: the account is not in the verified name, or the number and bank do not match (one answer)
  | "PAYOUT_IN_FLIGHT"    // 409: a payout to the current account is being sent; try again once it lands
  | "RATE_LIMITED"        // 429
  | "PROVIDER_UNAVAILABLE" // 503
  | "SERVER_ERROR";       // 500

/** POST /api/rooms/payouts/account 200 body. */
export interface RoomPayoutAccountResult {
  account: { bankName: string; last4: string; nameMatches: true };
  subaccountReady: boolean;
  /** true when an existing subaccount was updated (second call), false when one was created. */
  updated: boolean;
}

/** Bank account numbers we accept: a 10 digit NUBAN. */
export const ACCOUNT_NUMBER_RE = /^\d{10}$/;
/** Paystack bank codes: short, letters, digits and dashes. Checked against the provider's list as well. */
export const BANK_CODE_RE = /^[A-Za-z0-9-]{2,20}$/;

/** The last four digits of an account number, or "" for anything that is not one. */
export function last4Of(accountNumber: unknown): string {
  return typeof accountNumber === "string" && /^\d{4,}$/.test(accountNumber) ? accountNumber.slice(-4) : "";
}

/**
 * A person's name as comparable tokens: case, spacing, order and diacritics do not matter; apostrophes and hyphens join
 * ("O'Neil" = "ONeil", "Ade-Bayo" = "AdeBayo"); anything that is not a letter separates words. Sorted.
 */
export function personNameTokens(name: unknown): string[] {
  if (typeof name !== "string") return [];
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’`\-]/g, "")
    .replace(/[^\p{L}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort();
}

/**
 * Does the bank's account name belong to the verified person? Strict on purpose (fail closed): both names have at least
 * two words and the same words, in any order, any case, with or without accents. A missing middle name is a mismatch
 * (owner question in the lane report).
 */
export function namesMatch(verifiedName: unknown, bankAccountName: unknown): boolean {
  const a = personNameTokens(verifiedName);
  const b = personNameTokens(bankAccountName);
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

// ---------------------------------------------------------------- 6.2 earnings (GET /api/users/me/room-earnings)

export const EARNINGS_RANGES = ["week", "month", "all"] as const;
export type EarningsRange = (typeof EARNINGS_RANGES)[number];
export const isEarningsRange = (x: unknown): x is EarningsRange => typeof x === "string" && (EARNINGS_RANGES as readonly string[]).includes(x);

/** Start of the range in UTC ms: this calendar week (from Monday 00:00 UTC), this calendar month, or null for all time. */
export function rangeStartMs(range: EarningsRange, nowMs: number): number | null {
  if (range === "all") return null;
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (range === "month") return Date.UTC(y, m, 1);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(y, m, d.getUTCDate() - sinceMonday);
}

export interface EarningsRoomRow { id: string; title: string }
/** room_tickets joined with rooms.host_id. Every status is passed; only 'paid' counts. */
export interface EarningsTicketRow { id: string; roomId: string; hostId: string; hostKobo: number; status: string; createdAtMs: number }
/** spray_payments where the viewer is the host or the recipient. Only delivered shares count. */
export interface EarningsSprayRow {
  id: string; roomId: string; hostId: string; recipientId: string; hostKobo: number; guestKobo: number | null; status: string; deliveredAtMs: number | null;
}
/** room_payouts of the viewer. */
export interface EarningsPayoutRow { roomId: string; hostId: string; status: string; amountKobo: number; releaseAtMs: number }
/** host_clawbacks where the viewer is the beneficiary (the person who owes it). */
export interface EarningsClawbackRow { beneficiaryId: string; amountKobo: number; recoveredKobo: number; status: string }

export interface EarningsInput {
  viewerId: string;
  rooms: EarningsRoomRow[];
  tickets: EarningsTicketRow[];
  sprays: EarningsSprayRow[];
  payouts: EarningsPayoutRow[];
  clawbacks: EarningsClawbackRow[];
}

export interface RoomEarningsByRoom { roomId: string; title: string; sprayKobo: number; ticketKobo: number; at: string }

/**
 * GET /api/users/me/room-earnings?range=week|month|all. The plan's shape plus one additive field, clawbackAppliedKobo.
 * Always true (any range):  settledKobo + onItsWayKobo + heldTicketKobo
 *                             = totals.sprayKobo + totals.ticketKobo - clawbackAppliedKobo
 * clawbackOpenKobo is what is still owed now (not range filtered).
 */
export interface RoomEarnings {
  /** What the viewer earned in the range: delivered spray shares, and host shares of tickets still paid (refunds excluded). */
  totals: { sprayKobo: number; ticketKobo: number };
  /** Ticket money Paystack confirmed transferred (room payout 'paid'), net of clawbacks taken from it. */
  settledKobo: number;
  /** Spray shares (split at charge time, no provider settlement report), and ticket payouts being sent (or failed, waiting for finance). */
  onItsWayKobo: number;
  /** Ticket money still held (room not ended, inside the 48 hour hold, or on an admin hold). */
  heldTicketKobo: number;
  /** Clawbacks the viewer still owes (amount minus recovered, open rows only). */
  clawbackOpenKobo: number;
  /** Additive: clawbacks taken out of the viewer's ticket payouts for tickets in the range. */
  clawbackAppliedKobo: number;
  /** Rooms where the viewer earned in the range, as host or as a stage guest who was sprayed. Newest first, at most 100. */
  byRoom: RoomEarningsByRoom[];
  /** The earliest release of a held payout (admin holds left out), or null. */
  nextTicketReleaseAt: string | null;
}

/** A stored row we cannot trust (an amount that is not a safe non-negative integer, an unknown payout status). */
export class EarningsDataError extends Error {
  constructor(what: string) { super(`earnings: unusable stored row (${what})`); this.name = "EarningsDataError"; }
}

const kobo = (n: unknown, what: string): number => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new EarningsDataError(what);
  return n;
};

const PAYOUT_STATUSES = new Set(["held", "queued", "paid", "failed"]);
/** Spray statuses whose delivered share counts as earned. A disputed spray that WAS delivered stays earned; its chargeback is a clawback. */
const EARNED_SPRAY = new Set(["delivered", "disputed"]);
export const BY_ROOM_MAX = 100;

/**
 * The viewer's earnings from stored rows. Pure and deterministic (property-tested with generated histories in
 * scripts/test-rooms-unit-earnings.ts).
 *
 * Tickets: a room's paid tickets go to the bucket of its payout: no payout or 'held' -> held; 'queued' or 'failed' -> on its
 * way; 'paid' -> settled. When the payout left the hold, settlement took the open clawbacks out of it (applyClawbacks):
 * applied = gross - payout.amount_kobo (gross = the paid tickets' host shares, fixed from 'queued' on). That deduction is
 * spread over the room's tickets newest first, so each ticket has a net value and a range can include part of a room while
 * the sums stay exact.
 */
export function computeEarnings(input: EarningsInput, opts: { range: EarningsRange; nowMs: number }): RoomEarnings {
  const viewer = input.viewerId;
  const start = rangeStartMs(opts.range, opts.nowMs);
  const inRange = (ms: number | null) => ms !== null && Number.isFinite(ms) && (start === null || ms >= start);

  const titles = new Map<string, string>();
  for (const r of input.rooms) titles.set(r.id, typeof r.title === "string" ? r.title : "");

  const payouts = new Map<string, EarningsPayoutRow>();
  let nextRelease: number | null = null;
  for (const p of input.payouts) {
    if (p.hostId !== viewer) continue;
    if (!PAYOUT_STATUSES.has(p.status)) throw new EarningsDataError(`payout status ${String(p.status)}`);
    kobo(p.amountKobo, "payout amount");
    payouts.set(p.roomId, p);
    if (p.status === "held" && Number.isFinite(p.releaseAtMs) && !isAdminHold(p.releaseAtMs)) {
      nextRelease = nextRelease === null ? p.releaseAtMs : Math.min(nextRelease, p.releaseAtMs);
    }
  }

  const out: RoomEarnings = {
    totals: { sprayKobo: 0, ticketKobo: 0 },
    settledKobo: 0, onItsWayKobo: 0, heldTicketKobo: 0, clawbackOpenKobo: 0, clawbackAppliedKobo: 0,
    byRoom: [], nextTicketReleaseAt: nextRelease === null ? null : new Date(nextRelease).toISOString(),
  };
  const rooms = new Map<string, { sprayKobo: number; ticketKobo: number; atMs: number }>();
  const touch = (roomId: string, atMs: number) => {
    let r = rooms.get(roomId);
    if (!r) { r = { sprayKobo: 0, ticketKobo: 0, atMs }; rooms.set(roomId, r); }
    if (atMs > r.atMs) r.atMs = atMs;
    return r;
  };

  // ---- tickets, grouped by room
  const byRoom = new Map<string, EarningsTicketRow[]>();
  for (const t of input.tickets) {
    if (t.hostId !== viewer || t.status !== "paid") continue;
    kobo(t.hostKobo, "ticket host share");
    const list = byRoom.get(t.roomId);
    if (list) list.push(t); else byRoom.set(t.roomId, [t]);
  }
  for (const [roomId, list] of Array.from(byRoom.entries())) {
    const p = payouts.get(roomId);
    const left = p !== undefined && p.status !== "held";
    const gross = list.reduce((n, t) => n + t.hostKobo, 0);
    let toAllocate = left ? Math.max(0, gross - p!.amountKobo) : 0;
    // Newest first (created_at desc, id desc): deterministic.
    const ordered = list.slice().sort((a, b) => (b.createdAtMs - a.createdAtMs) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const t of ordered) {
      const taken = Math.min(t.hostKobo, toAllocate);
      toAllocate -= taken;
      if (!inRange(t.createdAtMs)) continue;
      const net = t.hostKobo - taken;
      out.totals.ticketKobo += t.hostKobo;
      out.clawbackAppliedKobo += taken;
      if (!p || p.status === "held") out.heldTicketKobo += net;
      else if (p.status === "paid") out.settledKobo += net;
      else out.onItsWayKobo += net; // queued (being sent) or failed (finance follows up): never "settled"
      touch(roomId, t.createdAtMs).ticketKobo += t.hostKobo;
    }
  }

  // ---- sprays: the viewer's share of each delivered spray
  for (const s of input.sprays) {
    if (!EARNED_SPRAY.has(s.status) || s.deliveredAtMs === null) continue;
    let share = 0;
    if (s.hostId === viewer) share += kobo(s.hostKobo, "spray host share");
    if (s.recipientId === viewer && s.recipientId !== s.hostId && s.guestKobo !== null) share += kobo(s.guestKobo, "spray guest share");
    if (share <= 0 || !inRange(s.deliveredAtMs)) continue;
    out.totals.sprayKobo += share;
    out.onItsWayKobo += share;
    touch(s.roomId, s.deliveredAtMs).sprayKobo += share;
  }

  // ---- clawbacks still owed (current, not range filtered)
  for (const c of input.clawbacks) {
    if (c.beneficiaryId !== viewer || c.status !== "open") continue;
    const amount = kobo(c.amountKobo, "clawback amount");
    const recovered = kobo(c.recoveredKobo, "clawback recovered");
    out.clawbackOpenKobo += Math.max(0, amount - recovered);
  }

  out.byRoom = Array.from(rooms.entries())
    .sort((a, b) => (b[1].atMs - a[1].atMs) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, BY_ROOM_MAX)
    .map(([roomId, r]) => ({ roomId, title: titles.get(roomId) ?? "", sprayKobo: r.sprayKobo, ticketKobo: r.ticketKobo, at: new Date(r.atMs).toISOString() }));
  return out;
}

// ---------------------------------------------------------------- 6.3 payer history and receipts

export type RoomPaymentKind = "spray" | "ticket" | "refund";
/**
 * Item statuses, in the words the client's paymentStatusWord knows: ticket paid | refunded (a refused charge too: its refund
 * line follows); spray processing | delivered | refunded | disputed | failed; refund pending (on its way) | refunded.
 */
export type RoomPaymentStatus = "paid" | "refunded" | "processing" | "delivered" | "disputed" | "failed" | "pending";

/** One line of GET /api/users/me/room-payments. Refunds are negative. Never a recipient, a host or a payment reference. */
export interface RoomPaymentItem {
  id: string;
  kind: RoomPaymentKind;
  /** The room title (plain text; the client renders it as text). */
  title: string;
  amountKobo: number;
  vatKobo: number;
  /** ISO 8601: when it was paid (a refund: when the refund was confirmed, else when the purchase was made). */
  at: string;
  status: RoomPaymentStatus;
  /** Additive: the spray tier of a spray (or a spray refund). */
  tier?: string;
  /** Additive: what a refund line refunds. */
  refundOf?: "spray" | "ticket";
}

export interface RoomPaymentsPage { items: RoomPaymentItem[]; next: string | null }

/** Item id prefixes: ticket, ticket refund, spray, spray refund. Chosen so a refund sorts just above its purchase (id desc). */
export const ITEM_PREFIXES = ["tk", "tr", "sp", "sr"] as const;
export type ItemPrefix = (typeof ITEM_PREFIXES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseItemId(id: unknown): { prefix: ItemPrefix; rowId: string } | null {
  if (typeof id !== "string" || id.length !== 39) return null;
  const prefix = id.slice(0, 2) as ItemPrefix;
  const rowId = id.slice(3);
  if (!(ITEM_PREFIXES as readonly string[]).includes(prefix) || id[2] !== "_" || !UUID_RE.test(rowId)) return null;
  return { prefix, rowId };
}

/** Opaque to the client: "<created_at in microseconds>.<item id>". Strictly parsed; anything else is null (400). */
export function encodePaymentsCursor(atUs: string, itemId: string): string {
  return `${atUs}.${itemId}`;
}
export function decodePaymentsCursor(cursor: unknown): { atUs: string; itemId: string } | null {
  if (typeof cursor !== "string" || cursor.length > 80) return null;
  const m = /^(\d{1,18})\.(.+)$/.exec(cursor);
  if (!m || !parseItemId(m[2])) return null;
  return { atUs: m[1], itemId: m[2] };
}

/** "VP-TK-3F9A12BC45DE": the receipt number, derived from the item id (not a secret, not a payment reference). */
export function receiptNumberOf(itemId: string): string {
  const p = parseItemId(itemId);
  if (!p) return "";
  return `VP-${p.prefix.toUpperCase()}-${p.rowId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/** Every character that could open markup or an attribute, as an entity. */
export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"'`=\/]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "₦5,000.50", "-₦5,000" (integer kobo; a fraction never appears). */
export function nairaLabel(k: number): string {
  if (!Number.isSafeInteger(k)) return "";
  const abs = Math.abs(k);
  const whole = Math.trunc(abs / 100);
  const rest = abs % 100;
  return `${k < 0 ? "-" : ""}₦${whole.toLocaleString("en-NG")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

export interface ReceiptBusiness { name: string; address: string; taxId: string; email: string }
export interface ReceiptData {
  itemId: string;
  kind: RoomPaymentKind;
  refundOf?: "spray" | "ticket";
  /** "Room ticket", "Spray: Money bag", "Refund: room ticket"... */
  itemLabel: string;
  roomTitle: string;
  amountKobo: number;
  vatKobo: number;
  atMs: number;
  status: RoomPaymentStatus;
  cardLast4: string | null;
  business: ReceiptBusiness;
}

const STATUS_WORDS: Record<RoomPaymentStatus, string> = {
  paid: "Paid", refunded: "Refunded", processing: "Processing", delivered: "Delivered",
  disputed: "Disputed with your bank", failed: "Not completed", pending: "Refund on its way",
};

function receiptDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * The printable receipt page. Every interpolated value is escaped (room titles are user text). No script, no external
 * resource (the route sends CSP default-src 'none' with inline styles only). Never a host's or recipient's details: the
 * room title is the only thing about the room.
 */
export function renderReceiptHtml(r: ReceiptData): string {
  const e = escapeHtml;
  const card = r.cardLast4 && /^\d{4}$/.test(r.cardLast4) ? `Card ending ${r.cardLast4}` : "";
  const rows: Array<[string, string]> = [
    ["Receipt number", receiptNumberOf(r.itemId)],
    ["Date", receiptDate(r.atMs)],
    ["Item", r.itemLabel],
    ["Room", r.roomTitle],
    ["Amount", nairaLabel(r.amountKobo)],
    ["VAT included (7.5%)", nairaLabel(r.vatKobo)],
    ["Status", STATUS_WORDS[r.status] ?? ""],
    ...(card ? [["Paid with", card] as [string, string]] : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Receipt ${e(receiptNumberOf(r.itemId))}</title>
<style>
:root{color-scheme:light}
body{margin:0;background:#fff;color:#111;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}
.biz{color:#444;font-size:.9rem;margin-bottom:24px;white-space:pre-line}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 0;border-bottom:1px solid #ddd;vertical-align:top;overflow-wrap:anywhere}
th{font-weight:500;color:#444;width:45%}
.note{color:#444;font-size:.85rem;margin-top:24px}
@media print{main{padding:0}}
</style></head>
<body><main>
<h1>${r.kind === "refund" ? "Refund receipt" : "Receipt"}</h1>
<div class="biz">${e(r.business.name)}
${e(r.business.address)}
Tax ID: ${e(r.business.taxId)}
${e(r.business.email)}</div>
<table><tbody>
${rows.map(([k, v]) => `<tr><th scope="row">${e(k)}</th><td>${e(v)}</td></tr>`).join("\n")}
</tbody></table>
<p class="note">Amounts are in Nigerian naira and include VAT. To keep a copy, use your browser's print or save as PDF.</p>
</main></body></html>`;
}
