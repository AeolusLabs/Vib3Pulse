// Room money screens on the client (phase 6, tasks 6.1 to 6.3, lane P6-BC). Pure: no React, no window, no network,
// no clock reads. Every body the server sends is parsed here and anything that is not the expected shape is treated as
// a failure, never drawn. The server is the authority for every amount, for "settled" (only when Paystack reported it),
// and for who may see what; nothing here adds, splits or recomputes money.
//
// Contracts (docs/superpowers/plans/2026-10-17-rooms-build-06-earnings-and-polish.md, revisions 2026-10-20):
//   GET  /api/rooms/payouts/status            { verifiedAdult, account: { bankName, last4, nameMatches } | null, subaccountReady }
//   POST /api/rooms/payouts/account           body { bankCode, accountNumber }; 403 unverified, 422 NAME_MISMATCH, NO_VERIFIED_NAME
//   GET  /api/users/me/room-earnings?range=   { totals, settledKobo, onItsWayKobo, heldTicketKobo, clawbackOpenKobo, byRoom, nextTicketReleaseAt }
//   GET  /api/users/me/room-payments?cursor=  { items: [{ id, kind, title, amountKobo, vatKobo, at, status }], next }
//   GET  /api/users/me/room-payments/:id/receipt  printable HTML (opened in a new tab, never parsed here)
// Added by this lane (not in the plan, see the lane report): GET /api/rooms/payouts/banks  { banks: [{ name, code }] }.

import { BANK_CODE_RE } from "@shared/roomEarnings";

// ---------------------------------------------------------------- small readers
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;
const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** Short, single-line text from the server; null for anything else. React escapes it when drawn. */
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : null;

// ---------------------------------------------------------------- payout account (6.1)
export interface PayoutAccountView { bankName: string; last4: string; nameMatches: boolean }
export interface PayoutStatus {
  verifiedAdult: boolean; account: PayoutAccountView | null; subaccountReady: boolean;
  /** The server would accept an account from this page now (fix round: false until verified legal names exist). Default false. */
  canLinkAccount: boolean;
  /** A name from the ID is on file for payouts (never the name). An older server never sends it: default false. */
  hasVerifiedName: boolean;
}

/**
 * The account block. Only four digits are ever kept: anything that is not exactly four digits fails the whole status, so
 * a server slip that sent a full account number is never drawn. Other fields the server might add (an account name, a
 * full number) are never read.
 */
export function parsePayoutAccount(v: unknown): PayoutAccountView | null | undefined {
  if (v === null) return null;
  const a = rec(v);
  if (!a) return undefined;
  const bankName = text(a.bankName, 120);
  if (!bankName || typeof a.last4 !== "string" || !/^\d{4}$/.test(a.last4) || typeof a.nameMatches !== "boolean") return undefined;
  return { bankName, last4: a.last4, nameMatches: a.nameMatches };
}

/** GET /api/rooms/payouts/status. Null for any other shape (shown as "could not load", never guessed). */
export function parsePayoutStatus(body: unknown): PayoutStatus | null {
  const b = rec(body);
  if (!b || typeof b.verifiedAdult !== "boolean" || typeof b.subaccountReady !== "boolean") return null;
  const account = parsePayoutAccount(b.account === undefined ? null : b.account);
  if (account === undefined) return null;
  // Read defensively: anything but a real true means the form stays hidden (an older server never sends it).
  return { verifiedAdult: b.verifiedAdult, account, subaccountReady: b.subaccountReady, canLinkAccount: b.canLinkAccount === true, hasVerifiedName: b.hasVerifiedName === true };
}

/**
 * Which payout screen to show:
 * - "unverified": not an ID-verified adult (payouts paused; an older account, if any, is shown by its last four only)
 * - "setup": the server says payouts are set up (subaccountReady, which it now reports only for a name-checked account)
 *   but sent no account details to show (only possible with malformed stored display data). Ready; no claim about
 *   how it was set up, and no form, so a working account is never re-pointed from here.
 * - "none": verified, no account yet, and the server takes one from this page now (the form)
 * - "soon": verified, no account yet, but linking a bank here is not open yet (no form, says so honestly)
 * - "mismatch": an account whose name does not match the ID (the form again only when linking is open)
 * - "pending": account matches but Paystack has not finished setting it up
 * - "ready": verified, matching, set up.
 * `moneyOn` is false while paid rooms and spray are both switched off: linking is then "soon" too.
 */
export type PayoutStage = "unverified" | "setup" | "none" | "soon" | "mismatch" | "pending" | "ready";
export const canLinkHere = (s: PayoutStatus, moneyOn = true) => s.canLinkAccount && moneyOn;
export function payoutStage(s: PayoutStatus, moneyOn = true): PayoutStage {
  if (!s.verifiedAdult) return "unverified";
  if (!s.account) return s.subaccountReady ? "setup" : canLinkHere(s, moneyOn) ? "none" : "soon";
  if (!s.account.nameMatches) return "mismatch";
  return s.subaccountReady ? "ready" : "pending";
}
/**
 * What the page leads with, on top of the stage above (which stays as it was):
 * - "needs_age": not an ID-verified adult: verify your age first
 * - "needs_name": a verified adult with no name on file (with or without a linked account), while payouts are on: verify your name for payouts.
 *   An account linked before names existed is shown as "not checked yet" under it, and no bank form is offered until a name exists.
 * - otherwise the stage.
 */
export type PayoutPanel = "needs_age" | "needs_name" | PayoutStage;
export function payoutPanel(s: PayoutStatus, moneyOn = true): PayoutPanel {
  const stage = payoutStage(s, moneyOn);
  if (stage === "unverified") return "needs_age";
  if (moneyOn && !s.hasVerifiedName) return "needs_name";
  return stage;
}
export const VERIFY_AGE_HREF = "/account/settings#verify-age";
export const VERIFY_NAME_HREF = "/account/settings?payouts=1#verify-age";
/** The failures that should offer the payouts check next to the message. */
export const accountFailureCta = (f: AccountFailure): "verify_name" | "recheck" | null =>
  f.code === "NO_VERIFIED_NAME" ? "verify_name" : f.code === "NAME_MISMATCH" || (f.status === 422 && !f.code) ? "recheck" : null;

/** Can receive money now, exactly as the server's subaccountReady says (for a verified adult). */
export const payoutReady = (s: PayoutStatus | null | undefined) => !!s && ["ready", "setup"].includes(payoutStage(s));

export interface Bank { name: string; code: string }
/** GET /api/rooms/payouts/banks: `{ banks: [{ name, code }] }`. Bad rows are dropped; a bad body is null. Sorted by name. */
export function parseBanks(body: unknown): Bank[] | null {
  const b = rec(body);
  if (!b || !Array.isArray(b.banks)) return null;
  const seen = new Set<string>();
  const out: Bank[] = [];
  for (const row of b.banks.slice(0, 1000)) {
    const r = rec(row);
    const name = r && text(r.name, 120);
    const code = r && typeof r.code === "string" && BANK_CODE_RE.test(r.code) ? r.code : null; // the server's own rule
    if (!name || !code || seen.has(code)) continue;
    seen.add(code);
    out.push({ name, code });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** A Nigerian account number (NUBAN) is ten digits. Spaces the person typed are taken out; the server checks again. */
export const cleanAccountNumber = (raw: string) => raw.replace(/[\s-]/g, "");
export const accountNumberValid = (raw: string) => /^\d{10}$/.test(cleanAccountNumber(raw));

/** What a refused or unclear POST /api/rooms/payouts/account means for the screen. */
export type AccountFailure = { status: number; code?: string; retryAfterSec?: number };
export const PAYOUT_ERROR = {
  offline: "We could not reach the server, so we do not know if your account was saved. Check your account below before you try again.",
  signIn: "Sign in again to set up payouts.",
  unverified: "Payouts are for ID-verified adults. Verify your ID first, then come back here.",
  nameMismatch: "The name on this bank account does not match the name on your ID. Use an account in your own name.",
  noVerifiedName: "To add a bank account we need to check your name on your ID. Start a payouts check from this page.",
  notFound: "We could not find that account. Check the bank and the 10 digit account number.",
  badBank: "Choose your bank from the list.",
  reload: "That did not go through. Reload the page and try again.",
  rateLimited: "Too many tries. Wait a while and try again.",
  rateLimitedFor: (min: number) => `Too many tries. Try again in ${min} ${min === 1 ? "minute" : "minutes"}.`,
  inFlight: "A payout to your current account is being sent. You can change your account once it has gone through.",
  busy: "Your payout account cannot be changed right now. Try again later.",
  provider: "Paystack did not answer. Try again in a few minutes.",
  featureOff: "Payouts for rooms are not open yet.",
  generic: "Something went wrong. Try again.",
} as const;

/** Plain words for a refused account save. Never the server's own text. */
export function payoutErrorMessage(f: AccountFailure): string {
  const c = f.code ?? "";
  if (f.status === 0) return PAYOUT_ERROR.offline;
  if (c === "NO_VERIFIED_NAME") return PAYOUT_ERROR.noVerifiedName;
  if (c === "NAME_MISMATCH") return PAYOUT_ERROR.nameMismatch;
  if (c === "FEATURE_OFF") return PAYOUT_ERROR.featureOff;
  if (f.status === 429 || c === "RATE_LIMITED") {
    return f.retryAfterSec && f.retryAfterSec > 0 ? PAYOUT_ERROR.rateLimitedFor(Math.max(1, Math.ceil(f.retryAfterSec / 60))) : PAYOUT_ERROR.rateLimited;
  }
  if (f.status === 401) return PAYOUT_ERROR.signIn;
  // Only the server's own NOT_VERIFIED code means "verify your ID"; any other 403 (a stale CSRF token after the retry) is not about the person.
  if (f.status === 403) return c === "NOT_VERIFIED" ? PAYOUT_ERROR.unverified : PAYOUT_ERROR.reload;
  if (c === "BAD_BANK") return PAYOUT_ERROR.badBank;
  if (f.status === 422) return PAYOUT_ERROR.nameMismatch; // the plan's only 422 is the name check
  if (f.status === 409) return /PAYOUT|IN_FLIGHT|QUEUED|HELD/.test(c) ? PAYOUT_ERROR.inFlight : PAYOUT_ERROR.busy;
  if (f.status === 400 || f.status === 404 || /ACCOUNT_NOT_FOUND|INVALID_ACCOUNT|RESOLVE_FAILED|BAD_REQUEST|INVALID/.test(c)) return PAYOUT_ERROR.notFound;
  if (f.status === 502 || f.status === 503 || f.status === 504 || /PROVIDER|PAYSTACK/.test(c)) return PAYOUT_ERROR.provider;
  return PAYOUT_ERROR.generic;
}
/** After any answer that is not a clear success, the stored account may have changed: read the status again. */
export const accountNeedsRefetch = (f: AccountFailure) => f.status === 0 || f.status === 409 || f.status >= 500;

/**
 * A successful save. The server may answer with the whole status, `{ account }`, or nothing useful; whatever it sends,
 * the page reads the status again, so this only picks the last four for the confirmation line.
 */
export function savedAccountOf(body: unknown): PayoutAccountView | null {
  const s = parsePayoutStatus(body);
  if (s?.account) return s.account;
  const b = rec(body);
  const a = b ? parsePayoutAccount(b.account ?? null) : null;
  return a ?? null;
}

export const PAYOUT_COPY = {
  title: "Get paid",
  intro: "Paystack pays you straight to your bank. The name on the account must match your ID.",
  loading: "Loading your payout details",
  loadFailed: "We could not load your payout details.",
  retry: "Try again",
  bankRow: "Bank account",
  bankLine: (bankName: string, last4: string, matches: boolean) => `${bankName}, account ending ${last4}${matches ? " · name matches your ID" : ""}`,
  idRow: "Identity",
  idVerified: "ID checked, 18 or over",
  idMissing: "Not verified yet",
  verified: "Verified",
  notVerified: "Not verified",
  unverifiedTitle: "Verify your ID to get paid",
  unverifiedBody: "Payouts are for ID-verified adults. Your history stays here, but nothing new can be paid to you until your ID is verified.",
  needAgeTitle: "Verify your age first",
  needAgeBody: "Payouts are for verified adults. Once your age is verified you can add a bank account here.",
  needAgeCta: "Verify your age",
  needNameTitle: "Verify your name for payouts",
  needNameBody: "To pay you, we check that your bank account is in your name. A reviewer notes the name on your ID once, and we keep it encrypted. This is only for people who want to receive money.",
  needNameCta: "Verify your name for payouts",
  recheckCta: "Ask for a name recheck",
  notChecked: "Not checked yet",
  notCheckedLine: (bank: string, last4: string) => `${bank} account ending ${last4}. We will check its name once your name is verified.`,
  noneTitle: "Add a bank account",
  noneBody: "Add the account you want sprays and ticket money paid into. It must be in your own name.",
  mismatchTitle: "The name does not match your ID",
  mismatchBody: "The name on this account does not match the name on your ID, so we cannot pay into it. Add an account in your own name.",
  soonTitle: "Adding a bank account here opens soon",
  soonBody: "You cannot add or change a bank account on this page yet. We will let you know when it opens. Nothing you have earned is lost.",
  setupLine: "Your payout account is set up. We cannot show its details right now.",
  setupBody: "You can get paid. To change your account, contact support.",
  pendingTitle: "Almost ready",
  pendingBody: "Your account checks out. Paystack is finishing the set up. This usually takes a few minutes.",
  readyBody: "Sprays settle to your bank the next business day. Ticket money is released 48 hours after the room ends. We never hold your spray money in our own account.",
  bankLabel: "Bank",
  bankPlaceholder: "Choose your bank",
  banksLoading: "Loading banks",
  banksFailed: "We could not load the list of banks. Try again in a moment.",
  numberLabel: "Account number",
  numberHelp: "10 digits. We only ever show the last four.",
  numberInvalid: "Enter the 10 digit account number.",
  save: "Check and save account",
  saving: "Checking with your bank",
  change: "Change bank account",
  cancelChange: "Keep this account",
  changeNote: "A payout already on its way still goes to the account it was sent to.",
  saved: (last4: string) => `Saved. Payouts now go to the account ending ${last4}.`,
  savedPlain: "Saved. Your payout account is updated.",
  earningsLink: "See your earnings",
  paymentsLink: "Your payments and receipts",
} as const;

// ---------------------------------------------------------------- earnings (6.2)
export const EARNINGS_RANGES = ["week", "month", "all"] as const;
export type EarningsRange = (typeof EARNINGS_RANGES)[number];
export const isEarningsRange = (v: unknown): v is EarningsRange => typeof v === "string" && (EARNINGS_RANGES as readonly string[]).includes(v);

export interface EarningsRoom { roomId: string; title: string; sprayKobo: number; ticketKobo: number; at: string }
/**
 * The server's money split (shared/roomEarnings.ts RoomEarnings, computeEarnings), fix round 6H:
 *   onItsWayKobo = sprayDirectKobo + ticketSendingKobo            (only money really on its way to the bank)
 *   needsAttentionKobo: failed or bank-reversed ticket payouts      (its own figure, NOT in onItsWay)
 *   sprayReturnedKobo: shares split to the viewer for sprays refunded or charged back before delivery (its own figure,
 *     NOT in sprayDirect, which holds earned delivered shares only; the clawback takes it back)
 *   settled + onItsWay + needsAttention + held = totals.spray + totals.ticket - clawbackApplied
 * null when an older server sends no split: the single "on its way" row is shown then.
 */
export interface EarningsSplit { sprayDirectKobo: number; ticketSendingKobo: number; needsAttentionKobo: number; sprayReturnedKobo: number }
export interface Earnings {
  totals: { sprayKobo: number; ticketKobo: number };
  settledKobo: number; onItsWayKobo: number; heldTicketKobo: number; clawbackOpenKobo: number;
  split: EarningsSplit | null;
  byRoom: EarningsRoom[];
  nextTicketReleaseAt: string | null;
}

/**
 * GET /api/users/me/room-earnings. Totals and per-room sums are whole kobo and may be below zero (a week of refunds);
 * the four balances (settled, on its way, held, clawback) are never below zero. Anything else fails the whole body.
 */
export function parseEarnings(body: unknown): Earnings | null {
  const b = rec(body);
  if (!b) return null;
  const t = rec(b.totals);
  if (!t || !isInt(t.sprayKobo) || !isInt(t.ticketKobo)) return null;
  for (const k of ["settledKobo", "onItsWayKobo", "heldTicketKobo", "clawbackOpenKobo"] as const) if (!isNonNegInt(b[k])) return null;
  if (!Array.isArray(b.byRoom) || b.byRoom.length > 500) return null;
  const byRoom: EarningsRoom[] = [];
  for (const row of b.byRoom) {
    const r = rec(row);
    if (!r) return null;
    const roomId = typeof r.roomId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.roomId) ? r.roomId : null;
    if (!roomId || !isInt(r.sprayKobo) || !isInt(r.ticketKobo) || !isIso(r.at)) return null;
    byRoom.push({ roomId, title: text(r.title, 200) ?? EARNINGS_COPY.untitled, sprayKobo: r.sprayKobo, ticketKobo: r.ticketKobo, at: r.at });
  }
  const next = b.nextTicketReleaseAt;
  if (next !== null && next !== undefined && !isIso(next)) return null;
  const split = parseEarningsSplit(b);
  if (split === undefined) return null;
  return {
    totals: { sprayKobo: t.sprayKobo, ticketKobo: t.ticketKobo },
    settledKobo: b.settledKobo as number, onItsWayKobo: b.onItsWayKobo as number,
    heldTicketKobo: b.heldTicketKobo as number, clawbackOpenKobo: b.clawbackOpenKobo as number,
    split, byRoom, nextTicketReleaseAt: isIso(next) ? next : null,
  };
}

const SPLIT_KEYS = ["sprayDirectKobo", "ticketSendingKobo", "needsAttentionKobo", "sprayReturnedKobo"] as const;
/**
 * The split fields: all absent is an older server (null); any present must all be whole kobo at or above zero, and
 * sprayDirect + ticketSending must equal onItsWayKobo (the server's own identity). needsAttention and sprayReturned are
 * separate figures with no sum to check here. Anything else fails the whole body (undefined), so a row is never drawn
 * from numbers that do not add up.
 */
export function parseEarningsSplit(b: Record<string, unknown>): EarningsSplit | null | undefined {
  if (SPLIT_KEYS.every((k) => b[k] === undefined)) return null;
  if (!SPLIT_KEYS.every((k) => isNonNegInt(b[k]))) return undefined;
  const s: EarningsSplit = {
    sprayDirectKobo: b.sprayDirectKobo as number, ticketSendingKobo: b.ticketSendingKobo as number,
    needsAttentionKobo: b.needsAttentionKobo as number, sprayReturnedKobo: b.sprayReturnedKobo as number,
  };
  if (s.sprayDirectKobo + s.ticketSendingKobo !== b.onItsWayKobo) return undefined;
  return s;
}

/** The big number: the range's spray and ticket totals as the server sent them (no other sum is made here). */
export const earningsHeadline = (e: Earnings) => e.totals.sprayKobo + e.totals.ticketKobo;
/** Nothing at all to show for this range. */
export const earningsEmpty = (e: Earnings) =>
  e.totals.sprayKobo === 0 && e.totals.ticketKobo === 0 && e.byRoom.length === 0 &&
  e.settledKobo === 0 && e.onItsWayKobo === 0 && e.heldTicketKobo === 0 && e.clawbackOpenKobo === 0 &&
  (e.split === null || (e.split.needsAttentionKobo === 0 && e.split.sprayReturnedKobo === 0)); // never hide a failed payout
/** "Tickets and sprays" / "Tickets" / "Sprays" under a room's name. */
export function roomKindLine(r: Pick<EarningsRoom, "sprayKobo" | "ticketKobo">): string {
  if (r.sprayKobo !== 0 && r.ticketKobo !== 0) return EARNINGS_COPY.kindBoth;
  if (r.ticketKobo !== 0) return EARNINGS_COPY.kindTickets;
  if (r.sprayKobo !== 0) return EARNINGS_COPY.kindSprays;
  return EARNINGS_COPY.kindNone;
}

export const EARNINGS_COPY = {
  title: "Earnings",
  intro: "For hosts and people on stage. Only you can see this.",
  range: { week: "This week", month: "This month", all: "All time" } as Record<EarningsRange, string>,
  rangeLabel: "Earnings period",
  loading: "Loading your earnings",
  loadFailed: "We could not load your earnings.",
  retry: "Try again",
  settled: "Settled to your bank",
  onItsWay: "On its way to your bank",
  onItsWayHelp: "Sprays usually arrive the next business day. We show money as settled only when your bank confirms it.",
  /** Month and all time: older spray money is often already in the bank, so never "next business day" for it. */
  onItsWayLong: "On its way or already in your bank",
  onItsWayLongHelp: "We show money as settled only when your bank confirms it, so some of this may already be in your account.",
  held: "Ticket money, released 48 hours after the room ends",
  nextRelease: (when: string) => `Next release ${when}`,
  /** With the server's split (fix round 6G): sprays, ticket money being sent, and what needs attention, each on its own row. */
  sprayDirect: "Sprays, paid out by Paystack to your bank",
  sprayDirectHelp: "Paystack sends your share straight to your bank, usually the next business day.",
  sprayDirectLong: "Sprays, on their way or already in your bank",
  sprayDirectLongHelp: "Paystack sends your share straight to your bank. We show money as settled only when your bank confirms it.",
  ticketSending: "Ticket money being sent to your bank",
  needsAttention: "Needs attention, we are on it",
  needsAttentionHelp: "A ticket payout did not go through or came back. Our team is following it up. Your money is safe.",
  sprayReturned: "Sprays refunded before they landed",
  sprayReturnedHelp: "Your share of these goes back, taken from your next settlement.",
  clawbackTitle: "A payment was reversed",
  clawbackBody: (amount: string) => `A bank reversed a payment you received. ${amount} will be taken from your next settlement. Nothing else changes.`,
  clawbackLabel: "To be taken off",
  byRoom: "By room",
  kindBoth: "Tickets and sprays",
  kindTickets: "Tickets",
  kindSprays: "Sprays",
  kindNone: "Nothing yet",
  untitled: "A room",
  emptyTitle: "Nothing here yet",
  emptyBody: "When people spray you or buy tickets to your rooms, it shows up here.",
  noAccountTitle: "Add a bank account to get paid",
  noAccountBody: "You need a verified bank account in your own name before anyone can spray you or buy tickets to your rooms.",
  noAccountSoonBody: "You need a verified bank account before anyone can spray you or buy tickets to your rooms. Adding one in the app opens soon.",
  noAccountCta: "Set up payouts",
  payoutLink: "Payout account",
  paymentsLink: "Your payments and receipts",
} as const;

// ---------------------------------------------------------------- payments and receipts (6.3)
export type PaymentKind = "spray" | "ticket" | "refund";
export interface PaymentItem { id: string; kind: PaymentKind; title: string; amountKobo: number; vatKobo: number; at: string; status: string }
export interface PaymentsPage { items: PaymentItem[]; next: string | null }

/** Receipt ids go into a URL path: only plain id characters, so a strange id never builds a strange URL. */
export const receiptIdOk = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
export const receiptUrl = (id: string) => `/api/users/me/room-payments/${encodeURIComponent(id)}/receipt`;

/**
 * GET /api/users/me/room-payments. A refund is never above zero and a payment is never below it; a row that breaks
 * that, or has a bad id, kind, amount or date, fails the whole page (the list is money, so it is shown whole or not at all).
 */
export function parsePaymentsPage(body: unknown): PaymentsPage | null {
  const b = rec(body);
  if (!b || !Array.isArray(b.items) || b.items.length > 200) return null;
  const items: PaymentItem[] = [];
  for (const row of b.items) {
    const r = rec(row);
    if (!r) return null;
    const id = typeof r.id === "string" && receiptIdOk(r.id) ? r.id : null;
    const kind = r.kind === "spray" || r.kind === "ticket" || r.kind === "refund" ? r.kind : null;
    if (!id || !kind || !isInt(r.amountKobo) || !isInt(r.vatKobo) || !isIso(r.at)) return null;
    // Same sign for the amount and its VAT (a refund may carry its VAT as negative or as zero), and VAT never above the amount.
    if (kind === "refund" ? r.amountKobo > 0 || r.vatKobo > 0 : r.amountKobo < 0 || r.vatKobo < 0) return null;
    if (Math.abs(r.vatKobo) > Math.abs(r.amountKobo)) return null;
    const status = typeof r.status === "string" && /^[a-z_]{1,32}$/.test(r.status) ? r.status : "";
    items.push({ id, kind, title: text(r.title, 200) ?? EARNINGS_COPY.untitled, amountKobo: r.amountKobo, vatKobo: r.vatKobo, at: r.at, status });
  }
  const next = b.next;
  if (next !== null && next !== undefined && !(typeof next === "string" && next.length > 0 && next.length <= 512)) return null;
  return { items, next: typeof next === "string" ? next : null };
}

/** Pages in order, each row once (a row that slides onto the next page while scrolling is not shown twice). */
export function mergePayments(pages: readonly PaymentsPage[]): PaymentItem[] {
  const seen = new Set<string>();
  const out: PaymentItem[] = [];
  for (const p of pages) for (const it of p.items) { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  return out;
}

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = { spray: "Spray", ticket: "Ticket", refund: "Refund" };

/** A status in plain words; an unknown status shows nothing rather than a guess. */
export function paymentStatusWord(kind: PaymentKind, status: string): string {
  if (kind === "refund") {
    if (["processed", "refunded", "paid", "succeeded", "success"].includes(status)) return "Back on your card";
    if (["pending", "processing", "queued"].includes(status)) return "On its way back to your card";
    if (status === "failed") return "Refund delayed, we are on it";
    return "";
  }
  if (["paid", "succeeded", "success", "delivered", "captured"].includes(status)) return "Paid";
  // The card was charged; the spray has not landed in the room yet.
  if (status === "processing") return "Paid, on its way to the room";
  if (["pending", "action_required", "charging", "initialized"].includes(status)) return "Waiting for your bank";
  // Being refunded but not done yet: never "Refunded" before the refund line says it is back on the card.
  if (status === "reversing") return "Refund on its way";
  if (status === "refunded" || status === "reversed") return "Refunded";
  if (status === "partially_refunded") return "Partly refunded";
  if (status === "disputed") return "Disputed with your bank";
  if (status === "chargeback") return "Reversed by your bank";
  if (["failed", "declined", "abandoned"].includes(status)) return "Did not go through";
  return "";
}

export const PAYMENTS_COPY = {
  title: "Payments",
  intro: "Tickets and sprays you paid for, and refunds back to your card. Only you can see this.",
  loading: "Loading your payments",
  loadFailed: "We could not load your payments.",
  retry: "Try again",
  more: "Show more",
  loadingMore: "Loading more",
  emptyTitle: "No payments yet",
  emptyBody: "When you buy a ticket or spray someone in a room, the receipt shows up here.",
  vat: (amount: string) => `Includes ${amount} VAT`,
  receipt: "Receipt",
  receiptLabel: (title: string) => `Receipt for ${title}, opens in a new tab`,
  earningsLink: "Earnings",
} as const;

// ---------------------------------------------------------------- shared failure words
/** For a GET that failed: offline, signed out, or anything else. */
export function readFailureMessage(status: number, fallback: string): string {
  if (status === 0) return "You look offline. Check your connection and try again.";
  if (status === 401) return "Sign in again to see this.";
  if (status === 429) return "Too many tries. Wait a moment and try again.";
  return fallback;
}

/** Every sentence these screens use, so one test can check the copy rules over all of them. */
const filled = (v: unknown): string[] => {
  if (typeof v === "function") return [String((v as (...a: unknown[]) => unknown)("₦5,000", 5, true))];
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(filled);
  return [String(v)];
};
export const EARNINGS_UI_COPY: readonly string[] = [
  ...filled(PAYOUT_ERROR), ...filled(PAYOUT_COPY), ...filled(EARNINGS_COPY), ...filled(PAYMENTS_COPY), ...filled(PAYMENT_KIND_LABEL),
  PAYOUT_COPY.bankLine("GTBank", "4821", true), PAYOUT_COPY.bankLine("GTBank", "4821", false),
  ...["paid", "pending", "processing", "reversing", "disputed", "chargeback", "refunded", "partially_refunded", "reversed", "failed", "processed"].flatMap((s) => [paymentStatusWord("ticket", s), paymentStatusWord("refund", s)]),
  readFailureMessage(0, ""), readFailureMessage(401, ""), readFailureMessage(429, ""),
];

/** Account settings shows the "Payout account" row only when the status read worked (HTTP 200 and a body we can use). */
export const payoutLinkVisible = (res: { ok: boolean } | null | undefined): boolean => res?.ok === true;
export const PAYOUT_LINK_COPY = { title: "Payout account", help: "Where tips and ticket money are paid" } as const;
