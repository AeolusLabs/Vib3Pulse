// Age review pure rules (no database):  npx tsx scripts/test-age-review-unit-rules.ts
import assert from "node:assert/strict";
import { CODE_ALPHABET, CODE_LENGTH, attemptState, canTransition, generateCode, isOpenStatus, registeredEligibility } from "../shared/ageReview";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const now = new Date("2026-10-25T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3600_000);

test("registeredEligibility covers under 18, no dob, adult", () => {
  assert.equal(registeredEligibility("2012-01-01", now), "under_18");
  assert.equal(registeredEligibility("2008-10-26", now), "under_18");
  assert.equal(registeredEligibility("2008-10-25", now), "ok");
  assert.equal(registeredEligibility(null, now), "no_dob");
  assert.equal(registeredEligibility("garbage", now), "no_dob");
  assert.equal(registeredEligibility("1990-05-05", now), "ok");
});

test("attemptState: 3 declines in 30 days block, 24 h gap", () => {
  assert.deepEqual(attemptState([], now), { attemptsLeft: 3, retryAfter: null });
  const one = attemptState([{ status: "declined", decidedAt: ago(2) }], now);
  assert.equal(one.attemptsLeft, 2);
  assert.equal(one.retryAfter!.getTime(), ago(2).getTime() + 24 * 3600_000);
  assert.equal(attemptState([{ status: "declined", decidedAt: ago(25) }], now).retryAfter, null);
  const three = attemptState([{ status: "declined", decidedAt: ago(30) }, { status: "declined", decidedAt: ago(100) }, { status: "declined", decidedAt: ago(200) }], now);
  assert.equal(three.attemptsLeft, 0);
  assert.equal(three.retryAfter!.getTime(), ago(200).getTime() + 30 * 24 * 3600_000);
  const old = attemptState([{ status: "declined", decidedAt: ago(24 * 31) }, { status: "cancelled", decidedAt: ago(1) }, { status: "expired", decidedAt: ago(1) }], now);
  assert.deepEqual(old, { attemptsLeft: 3, retryAfter: null });
});

test("generateCode uses the alphabet and length 6", () => {
  for (let i = 0; i < 300; i++) {
    const c = generateCode();
    assert.equal(c.length, CODE_LENGTH);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
  }
  assert.equal(generateCode(() => 0), "AAAAAA");
});

test("status transitions and open set", () => {
  assert.ok(canTransition("draft", "submitted") && canTransition("needs_more", "submitted"));
  assert.ok(!canTransition("approved", "draft") && !canTransition("cancelled", "submitted") && !canTransition("draft", "approved"));
  assert.ok(isOpenStatus("pending_second_approval") && !isOpenStatus("closed_minor"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
