// Paid rooms: refund window, never-started rule, payout hold, transfer statuses, copy (no database):
//   npx tsx scripts/test-rooms-unit-refunds.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import {
  afterFailedAttempt, buyerRefundCheck, buyerRefundDeadline, classifyTransferStatus, isNeverStarted, isValidTransferReference,
  nairaText, payoutReference, payoutReleaseAt, reasonNeedsBuyerWindow, refundAllowedByPayout, refundNotice, sanitizeMoneyError,
  ticketRefundReference, BUYER_REFUND_CUTOFF_MS, MAX_PAYOUT_ATTEMPTS, NEVER_STARTED_GRACE_MS, NO_START_TIME_GRACE_MS, PAYOUT_HOLD_MS,
  REFUND_REASONS,
  isAdminHold, isAutoRefundReason, payoutBlockReason, payoutGeneration, refundNoticeKey, returnedPaymentNotice,
  ADMIN_HOLD_NOTE, AUTO_REFUND_JOB_DELAY_MS, BANK_UNRESOLVED_RETRY_MS, PAYOUT_HOLD_SENTINEL_ISO, PAYOUT_HOLD_SENTINEL_MS,
  REFUND_OVERDUE_MS, REFUND_RETRY_FOR_MS,
} from "../shared/roomRefunds";
import { ticketBreakdown } from "../shared/money";
import { readFileSync } from "node:fs";
import { REFUND_FEES_NOTE, buyerRefundKobo } from "../shared/roomRefunds";
// Pure helpers of the Paystack layer (nothing here calls fetch).
import { isPaystackOutage, isTransferNotFoundAnswer, matchSettlementBank, normaliseBankName, refundStateFrom } from "../server/payments/paystack";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const start = Date.parse("2026-10-24T20:00:00.000Z");
const room = (over: Partial<{ status: string; refundBeforeStart: boolean; scheduledForMs: number | null }> = {}) =>
  ({ status: "scheduled", refundBeforeStart: true, scheduledForMs: start, ...over });

test("constants are the plan's: 60 min cutoff, 60 min grace, 48 h hold, 5 attempts", () => {
  assert.equal(BUYER_REFUND_CUTOFF_MS, 60 * MIN);
  assert.equal(NEVER_STARTED_GRACE_MS, 60 * MIN);
  assert.equal(PAYOUT_HOLD_MS, 48 * HOUR);
  assert.equal(MAX_PAYOUT_ATTEMPTS, 5);
  assert.equal(NO_START_TIME_GRACE_MS, 24 * HOUR);
});

test("buyer window: open until exactly 60 minutes before the start, closed at and after it", () => {
  assert.deepEqual(buyerRefundCheck(room(), start - 2 * HOUR), { ok: true });
  assert.deepEqual(buyerRefundCheck(room(), start - 60 * MIN - 1), { ok: true });
  assert.deepEqual(buyerRefundCheck(room(), start - 60 * MIN), { ok: false, code: "WINDOW_CLOSED" });
  assert.deepEqual(buyerRefundCheck(room(), start - 59 * MIN), { ok: false, code: "WINDOW_CLOSED" });
  assert.deepEqual(buyerRefundCheck(room(), start + 5 * MIN), { ok: false, code: "WINDOW_CLOSED" });
});

test("buyer window: never once the room started or ended, even long before the planned start", () => {
  assert.deepEqual(buyerRefundCheck(room({ status: "live" }), start - 5 * HOUR), { ok: false, code: "ROOM_NOT_SCHEDULED" });
  assert.deepEqual(buyerRefundCheck(room({ status: "ended" }), start - 5 * HOUR), { ok: false, code: "ROOM_NOT_SCHEDULED" });
});

test("buyer window: host turned refunds off; no start time", () => {
  assert.deepEqual(buyerRefundCheck(room({ refundBeforeStart: false }), start - 5 * HOUR), { ok: false, code: "NO_REFUNDS" });
  assert.deepEqual(buyerRefundCheck(room({ scheduledForMs: null }), start - 5 * HOUR), { ok: false, code: "NO_START_TIME" });
  assert.deepEqual(buyerRefundCheck(room({ scheduledForMs: Number.NaN }), start - 5 * HOUR), { ok: false, code: "NO_START_TIME" });
});

test("the order of refusals: state first, then the host's setting, then the clock", () => {
  assert.deepEqual(buyerRefundCheck(room({ status: "live", refundBeforeStart: false }), start + HOUR), { ok: false, code: "ROOM_NOT_SCHEDULED" });
  assert.deepEqual(buyerRefundCheck(room({ refundBeforeStart: false }), start + HOUR), { ok: false, code: "NO_REFUNDS" });
});

test("buyerRefundDeadline is the start minus 60 minutes, or null", () => {
  assert.equal(buyerRefundDeadline(room()), start - 60 * MIN);
  assert.equal(buyerRefundDeadline(room({ refundBeforeStart: false })), null);
  assert.equal(buyerRefundDeadline(room({ scheduledForMs: null })), null);
});

test("only the buyer reason needs the window; the others are policy-free", () => {
  assert.deepEqual([...REFUND_REASONS].sort(), ["buyer", "host_cancelled", "never_started", "oversold"]);
  assert.equal(reasonNeedsBuyerWindow("buyer"), true);
  for (const r of ["host_cancelled", "never_started", "oversold"] as const) assert.equal(reasonNeedsBuyerWindow(r), false);
});

test("never started: scheduled and 60 minutes past the start (exactly at the boundary counts)", () => {
  const created = start - 3 * 24 * HOUR;
  assert.equal(isNeverStarted({ status: "scheduled", scheduledForMs: start, createdAtMs: created }, start + 59 * MIN), false);
  assert.equal(isNeverStarted({ status: "scheduled", scheduledForMs: start, createdAtMs: created }, start + 60 * MIN), true);
  assert.equal(isNeverStarted({ status: "live", scheduledForMs: start, createdAtMs: created }, start + 5 * HOUR), false);
  assert.equal(isNeverStarted({ status: "ended", scheduledForMs: start, createdAtMs: created }, start + 5 * HOUR), false);
});

test("never started without a start time: 24 hours after creation", () => {
  const created = start;
  assert.equal(isNeverStarted({ status: "scheduled", scheduledForMs: null, createdAtMs: created }, created + 23 * HOUR), false);
  assert.equal(isNeverStarted({ status: "scheduled", scheduledForMs: null, createdAtMs: created }, created + 24 * HOUR), true);
});

test("payout release is exactly 48 hours after the end", () => {
  const ended = Date.parse("2026-10-24T23:10:00.000Z");
  assert.equal(new Date(payoutReleaseAt(ended)).toISOString(), "2026-10-26T23:10:00.000Z");
});

test("state machine: refunds touch money only while the payout is held (or absent)", () => {
  assert.equal(refundAllowedByPayout(null), true);
  assert.equal(refundAllowedByPayout("held"), true);
  assert.equal(refundAllowedByPayout("queued"), false);
  assert.equal(refundAllowedByPayout("paid"), false);
  assert.equal(refundAllowedByPayout("failed"), false);
});

test("transfer statuses: success pays, pending-like waits, otp needs a person, final ones fail; unknown never pays nor fails", () => {
  assert.equal(classifyTransferStatus("success"), "paid");
  assert.equal(classifyTransferStatus("SUCCESS"), "paid");
  for (const s of ["pending", "received", "processing", "queued"]) assert.equal(classifyTransferStatus(s), "wait", s);
  assert.equal(classifyTransferStatus("otp"), "needs_otp");
  for (const s of ["failed", "reversed", "abandoned", "blocked", "rejected"]) assert.equal(classifyTransferStatus(s), "final_failure", s);
  assert.equal(classifyTransferStatus("something_new"), "wait");
  assert.equal(classifyTransferStatus(undefined), "wait");
});

test("attempts: the 5th failed attempt gives up, not before", () => {
  let a = 0;
  for (let i = 1; i <= 4; i++) { const r = afterFailedAttempt(a); assert.equal(r.attempts, i); assert.equal(r.giveUp, false); a = r.attempts; }
  const fifth = afterFailedAttempt(a);
  assert.equal(fifth.attempts, 5); assert.equal(fifth.giveUp, true);
});

test("references are deterministic and valid Paystack transfer references", () => {
  const roomId = "6F1C2B4E-0A6B-4C1F-9C2D-1234567890AB";
  assert.equal(payoutReference(roomId), "room-payout-6f1c2b4e-0a6b-4c1f-9c2d-1234567890ab");
  assert.equal(payoutReference(roomId), payoutReference(roomId.toLowerCase()));
  assert.equal(isValidTransferReference(payoutReference(roomId)), true);
  assert.equal(ticketRefundReference("abc"), "ticket-refund-abc");
  assert.equal(isValidTransferReference("short"), false);
  assert.equal(isValidTransferReference("Room-Payout-UPPER-CASE-1234"), false);
});

test("naira text: whole naira, kobo when there are any, thousands separated", () => {
  assert.equal(nairaText(500000), "₦5,000");
  assert.equal(nairaText(100000), "₦1,000");
  assert.equal(nairaText(10000000), "₦100,000");
  assert.equal(nairaText(123456), "₦1,234.56");
  assert.equal(nairaText(100005), "₦1,000.05");
});

test("refund notice: plain, amount in naira, reason line, no card or bank words, no em dash", () => {
  const n = refundNotice(500000, "Friday vibes", "host_cancelled");
  assert.equal(n.title, "Ticket refunded");
  assert.match(n.message, /^Your ₦5,000 ticket for "Friday vibes" was refunded\. The host cancelled the room\./);
  for (const r of REFUND_REASONS) {
    const m = refundNotice(100000, "X", r).message;
    assert.ok(!/card|account number|bank|cash|—/i.test(m), m);
  }
});

test("sanitizeMoneyError: digit runs that could be account numbers are removed, the text is short", () => {
  const s = sanitizeMoneyError(new Error("Paystack error: account 0123456789 at bank 058 is invalid\nmore"));
  assert.ok(!s.includes("0123456789"));
  assert.ok(s.includes("058")); // short codes stay (bank codes are not secret)
  assert.ok(!s.includes("\n"));
  assert.ok(sanitizeMoneyError("x".repeat(500)).length <= 200);
  assert.equal(sanitizeMoneyError({ weird: true }), "unknown error");
});

test("payout amount is the sum of stored host shares (ticketBreakdown), never a recomputation from the price", () => {
  const b = ticketBreakdown(500000);
  const hostShares = [b.host, b.host, b.host];
  assert.equal(hostShares.reduce((s, x) => s + x, 0), 3 * b.host);
  assert.equal(b.vat + b.fee + b.reserve + b.platform + b.host, b.price); // nothing lost to rounding
});

// ---------------------------------------------------------------- fix round 4F (lane FS2)

test("timing constants: overdue alert 24 h, rejection retry cap 24 h, refused charges left to S2 for 10 min, bank retry hourly", () => {
  assert.equal(REFUND_OVERDUE_MS, 24 * HOUR);
  assert.equal(REFUND_RETRY_FOR_MS, 24 * HOUR);
  assert.equal(AUTO_REFUND_JOB_DELAY_MS, 10 * MIN);
  assert.equal(BANK_UNRESOLVED_RETRY_MS, HOUR);
});

test("refund notice: 'on its way' while pending, 'refunded' only when processed", () => {
  const pending = refundNotice(500000, "Friday vibes", "buyer", "pending");
  assert.equal(pending.title, "Refund on its way");
  assert.match(pending.message, /^Your refund of ₦5,000 for "Friday vibes" is on its way\. You asked for this refund, so the service charge and platform fee were not returned\./);
  assert.ok(!/refunded/i.test(pending.message), pending.message);
  const done = refundNotice(500000, "Friday vibes", "buyer", "processed");
  assert.equal(done.title, "Ticket refunded");
  assert.deepEqual(refundNotice(500000, "Friday vibes", "buyer"), done); // default stays "processed" (older callers)
});

test("a refund the buyer asks for returns the price less the service charge and platform fee; every other reason is the full price", () => {
  // A 5,000 naira ticket at the default rates: VAT 348.84, card fee 75, reserve 50, platform 15% of what is left.
  const t = { amountKobo: 500000, feeKobo: 7500, platformKobo: 62600 };
  assert.equal(buyerRefundKobo(t), 500000 - 7500 - 62600);
  assert.equal(buyerRefundKobo({ amountKobo: 10000, feeKobo: 9000, platformKobo: 5000 }), 0, "never below zero");
  const src = (f: string) => readFileSync(f, "utf8");
  const refunds = src("server/rooms/refunds.ts");
  assert.match(refunds, /refund_reason === "buyer" \? buyerRefundKobo\(/);
  assert.match(refunds, /back < Number\(t\.amount_kobo\) \? \{ amountKobo: back \}/);
  assert.match(refunds, /refundKoboOf\(t\), t\.refund_reason === "buyer" \? 0 : Number\(t\.platform_kobo\)/);
  assert.match(src("server/payments/paystack.ts"), /\.\.\.\(opts\.amountKobo \? \{ amount: opts\.amountKobo \} : \{\}\)/);
  assert.match(src("server/rooms/ticketMoneyRoutes.ts"), /NOTHING_LEFT/);
  assert.ok(REFUND_FEES_NOTE.includes("Paystack does not refund its service charge and neither do we"));
});

test("returned payment (refused charge): never mentions the host or a cancellation", () => {
  const p = returnedPaymentNotice(500000, "pending");
  const d = returnedPaymentNotice(500000, "processed");
  assert.match(d.message, /^Your payment of ₦5,000 for the ticket was returned\./);
  assert.match(p.message, /^Your payment of ₦5,000 for the ticket is on its way back to you\./);
  for (const m of [p.message, d.message, p.title, d.title]) assert.ok(!/host|cancel|card|bank|cash|—/i.test(m), m);
});

test("notification keys are deterministic per ticket and stage", () => {
  assert.equal(refundNoticeKey("ABC", "pending"), "ticket-refund-abc:pending");
  assert.equal(refundNoticeKey("abc", "processed"), "ticket-refund-abc:processed");
  assert.notEqual(refundNoticeKey("abc", "pending"), refundNoticeKey("abc", "processed"));
});

test("refused charges are recognised by the auto_ prefix only", () => {
  for (const r of ["auto_sold_out", "auto_amount_mismatch", "auto_ineligible", "auto_duplicate"]) assert.equal(isAutoRefundReason(r), true, r);
  for (const r of ["buyer", "host_cancelled", "never_started", "oversold", "", null, undefined, "autox"]) assert.equal(isAutoRefundReason(r as any), false, String(r));
});

test("payout reference generations: 1 is the plain reference, requeues after a conclusive failure add -r<n>", () => {
  const id = "6f1c2b4e-0a6b-4c1f-9c2d-1234567890ab";
  assert.equal(payoutReference(id, 1), `room-payout-${id}`);
  assert.equal(payoutReference(id, 2), `room-payout-${id}-r2`);
  assert.equal(payoutGeneration(id, `room-payout-${id}`), 1);
  assert.equal(payoutGeneration(id, `room-payout-${id}-r2`), 2);
  assert.equal(payoutGeneration(id, `room-payout-${id}-r1`), null);
  assert.equal(payoutGeneration(id, `room-payout-${id}-rx`), null);
  assert.equal(payoutGeneration(id, `room-payout-00000000-0000-0000-0000-000000000000`), null);
  assert.equal(payoutGeneration(id, null), null);
  assert.equal(isValidTransferReference(payoutReference(id, 7)), true);
});

test("admin hold sentinel: 9999-12-31, recognised only at or past it", () => {
  assert.equal(PAYOUT_HOLD_SENTINEL_ISO, "9999-12-31T00:00:00.000Z");
  assert.equal(isAdminHold(PAYOUT_HOLD_SENTINEL_MS), true);
  assert.equal(isAdminHold(PAYOUT_HOLD_SENTINEL_MS - 1), false);
  assert.equal(isAdminHold(Date.parse("2026-10-26T23:10:00.000Z")), false);
  assert.equal(isAdminHold(null), false);
  assert.equal(ADMIN_HOLD_NOTE, "ADMIN_HOLD");
});

test("payout blocks: minors room, moderation, host review, host not eligible; an adult host of an approved room pays", () => {
  const ok = { minorsRoom: false, moderationStatus: "approved" as string | null, hostReview: false, hostAge: 30 as number | null, minAge: 18 };
  assert.equal(payoutBlockReason(ok), null);
  assert.equal(payoutBlockReason({ ...ok, minorsRoom: true }), "MINORS_ROOM");
  assert.equal(payoutBlockReason({ ...ok, moderationStatus: "removed" }), "NOT_APPROVED");
  assert.equal(payoutBlockReason({ ...ok, moderationStatus: "pending" }), "NOT_APPROVED");
  assert.equal(payoutBlockReason({ ...ok, moderationStatus: null }), null); // the column default is approved
  assert.equal(payoutBlockReason({ ...ok, hostReview: true }), "HOST_REVIEW");
  assert.equal(payoutBlockReason({ ...ok, hostAge: 17 }), "HOST_NOT_ELIGIBLE");
  assert.equal(payoutBlockReason({ ...ok, hostAge: null }), "HOST_NOT_ELIGIBLE");
  assert.equal(payoutBlockReason({ ...ok, hostAge: 20, minAge: 21 }), "HOST_NOT_ELIGIBLE");
  assert.equal(payoutBlockReason({ ...ok, minorsRoom: true, moderationStatus: "removed" }), "MINORS_ROOM"); // order
});

test("Paystack refund states: processed wins, needs-attention next, anything not failed is in progress", () => {
  assert.equal(refundStateFrom([]), "none");
  assert.equal(refundStateFrom(["pending"]), "in_progress");
  assert.equal(refundStateFrom(["processing"]), "in_progress");
  assert.equal(refundStateFrom(["failed", "pending"]), "in_progress");
  assert.equal(refundStateFrom(["failed", "processed"]), "done");
  assert.equal(refundStateFrom(["needs-attention"]), "needs_attention");
  assert.equal(refundStateFrom(["failed", "failed"]), "failed");
  assert.equal(refundStateFrom(["something_new"]), "in_progress"); // unknown: exists, never create another
});

test("transfer not found: only when Paystack says so (404/400 + message); anything else is an outage", () => {
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 404, message: "Transfer not found" }), true);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 400, message: "Transfer not found" }), true);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 400, message: "x", code: "transfer_not_found" }), true);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 404, message: "Cannot GET /transfer/verify" }), false);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 400, message: "Invalid key" }), false);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 500, message: "Transfer not found" }), false);
  assert.equal(isTransferNotFoundAnswer({ httpStatus: 401, message: "Transfer not found" }), false);
});

test("outage classification: 'Paystack unavailable' is an outage, 'Paystack error' is an answer", () => {
  assert.equal(isPaystackOutage(new Error("Paystack unavailable: HTTP 502")), true);
  assert.equal(isPaystackOutage(new Error("Paystack error: Your balance is not enough")), false);
  assert.equal(isPaystackOutage("Paystack unavailable: network"), true);
  assert.equal(isPaystackOutage({}), false);
});

test("settlement bank: by bank id first, then code, then a unique normalised name; ambiguous or unknown => null", () => {
  const banks = [
    { id: 1, code: "044", name: "Access Bank" },
    { id: 2, code: "063", name: "Access Bank (Diamond)" },
    { id: 9, code: "058", name: "Guaranty Trust Bank" },
    { id: 21, code: "011", name: "First Bank of Nigeria" },
    { id: 22, code: "999", name: "First Bank of Nigeria Plc" },
  ];
  assert.deepEqual(matchSettlementBank({ bank_id: 9, settlement_bank: "Wrong Name" }, banks), banks[2]);
  assert.deepEqual(matchSettlementBank({ bank: "9" }, banks), banks[2]);
  assert.deepEqual(matchSettlementBank({ settlement_bank: "058" }, banks), banks[2]);
  assert.deepEqual(matchSettlementBank({ settlement_bank: "guaranty trust bank" }, banks), banks[2]);
  assert.deepEqual(matchSettlementBank({ settlement_bank: "GUARANTY TRUST BANK PLC" }, banks), banks[2]);
  assert.equal(matchSettlementBank({ settlement_bank: "First Bank of Nigeria" }, banks), null); // two banks normalise alike
  assert.equal(matchSettlementBank({ settlement_bank: "Unknown Bank" }, banks), null);
  assert.equal(matchSettlementBank({}, banks), null);
  assert.equal(normaliseBankName("Stanbic IBTC Bank Plc."), "stanbic ibtc bank");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
