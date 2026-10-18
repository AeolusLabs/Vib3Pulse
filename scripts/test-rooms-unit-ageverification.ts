// ID-verification rule (no database):   npx tsx scripts/test-rooms-unit-ageverification.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { isIdVerifiedAdult, toAgeVerification } from "../shared/ageVerification";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); };
const at = new Date("2026-01-01T00:00:00Z");

test("verified + 30 years old is a verified adult", () => assert.equal(isIdVerifiedAdult({ ageVerifiedAt: at, dateOfBirth: yearsAgo(30) }), true));
test("verified + 17 years old is not", () => assert.equal(isIdVerifiedAdult({ ageVerifiedAt: at, dateOfBirth: yearsAgo(17) }), false));
test("not verified + 30 years old is not", () => assert.equal(isIdVerifiedAdult({ ageVerifiedAt: null, dateOfBirth: yearsAgo(30) }), false));
test("verified but no birthdate is not", () => assert.equal(isIdVerifiedAdult({ ageVerifiedAt: at, dateOfBirth: null }), false));
test("toAgeVerification: shape has no birthdate and reports the band", () => {
  const v = toAgeVerification({ ageVerifiedAt: at, ageVerifiedMethod: "admin", dateOfBirth: yearsAgo(30) });
  assert.deepEqual(v, { verified: true, band: "adult", at: at.toISOString(), method: "admin" });
  assert.deepEqual(toAgeVerification({ ageVerifiedAt: null, ageVerifiedMethod: null, dateOfBirth: yearsAgo(30) }), { verified: false, band: null, at: null, method: null });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
