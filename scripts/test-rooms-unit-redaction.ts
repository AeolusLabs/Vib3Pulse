// Global response redaction of ID-verification columns (no database):   npx tsx scripts/test-rooms-unit-redaction.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";

const { redactSensitiveFields } = await import("../server/security");
const { SENSITIVE_RESPONSE_KEYS } = await import("../server/auth");

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// Run a body through the real middleware and return what res.json would send.
function redact(body: unknown): any {
  let sent: unknown;
  const res: any = { json: (b: unknown) => { sent = b; return res; } };
  redactSensitiveFields({} as any, res, () => {});
  res.json(body);
  return sent;
}

test("camelCase and snake_case age-verification keys are stripped at any depth", () => {
  const out = redact({
    id: "u1",
    ageVerifiedAt: new Date(), ageVerifiedMethod: "admin", age_verified_at: "x", age_verified_method: "admin",
    nested: { list: [{ ageVerifiedAt: "x", keep: 1 }] },
  });
  assert.deepEqual(out, { id: "u1", nested: { list: [{ keep: 1 }] } });
});

test("the owner's own AgeVerification shape (verified/band/at/method) is untouched", () => {
  const shape = { verified: true, band: "adult", at: "2026-01-01T00:00:00.000Z", method: "admin" };
  assert.deepEqual(redact({ ...shape }), shape);
});

test("existing credential keys are still stripped (list not weakened)", () => {
  for (const k of ["passwordHash", "passwordResetToken", "passwordResetExpires", "emailVerificationToken", "emailVerificationExpires", "verifiedPhone", "exactAddress", "inviteToken", "inviteTokenHash", "guestTokenHash", "guestName"]) {
    assert.ok(SENSITIVE_RESPONSE_KEYS.has(k), k);
  }
});

test("age review evidence and fingerprint keys are stripped, the selfie code is kept", () => {
  const out = redact({ id: "r1", code: "ABC234", bytes_enc: "x", bytesEnc: "x", documentFingerprint: "f", document_fingerprint: "f", nested: [{ code: "Z", bytesEnc: "y", documentFingerprint: "g" }] });
  assert.deepEqual(out, { id: "r1", code: "ABC234", nested: [{ code: "Z" }] });
  for (const k of ["bytes_enc", "bytesEnc", "documentFingerprint", "document_fingerprint"]) assert.ok(SENSITIVE_RESPONSE_KEYS.has(k), k);
  assert.ok(!SENSITIVE_RESPONSE_KEYS.has("code"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
