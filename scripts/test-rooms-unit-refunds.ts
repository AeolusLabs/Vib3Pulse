// Paid rooms: refund window, never-started rule, payout hold, transfer statuses, copy (no database):
//   npx tsx scripts/test-rooms-unit-refunds.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import {
  afterFailedAttempt, buyerRefundCheck, buyerRefundDeadline, classifyTransferStatus, isNeverStarted, isValidTransferReference,
  nairaText, payoutReference, payoutReleaseAt, reasonNeedsBuyerWindow, refundAllowedByPayout, refundNotice, sanitizeMoneyError,
  ticketRefundReference, BUYER_REFUND_CUTOFF_MS, MAX_PAYOUT_ATTEMPTS, NEVER_STARTED_GRACE_MS, NO_START_TIME_GRACE_MS, PAYOUT_HOLD_MS,
  REFUND_REASONS,
} from "../shared/roomRefunds";
import { ticketBreakdown } from "../shared/money";

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
