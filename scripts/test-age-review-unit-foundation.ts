// Age review foundation (no database):  npx tsx scripts/test-age-review-unit-foundation.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import { AGE_REVIEW_SCHEMA_SQL } from "../server/identity/ageReviewMigration";
import { encryptEvidence, decryptEvidence, evidenceKeyOk, assertEvidenceKeyForBoot, documentFingerprint, EVIDENCE_DECRYPT_FAILED } from "../server/identity/evidenceCrypto";
import { ageReviewEnabled } from "../server/identity/ageReviewFeatures";
import { adminRoles } from "../shared/schema";
import { toAgeVerification } from "../shared/ageVerification";
import { z } from "zod";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const AAD = "11111111-1111-1111-1111-111111111111:document";
const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const withKey = <T>(k: string | undefined, fn: () => T): T => {
  const prev = process.env.AGE_EVIDENCE_KEY;
  if (k === undefined) delete process.env.AGE_EVIDENCE_KEY; else process.env.AGE_EVIDENCE_KEY = k;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGE_EVIDENCE_KEY; else process.env.AGE_EVIDENCE_KEY = prev; }
};

test("age review schema SQL equals the .sql file", () => {
  const file = readFileSync(join(root, "migrations/add_age_review.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = file.slice(file.indexOf("BEGIN;") + "BEGIN;".length, file.lastIndexOf("COMMIT;")).trim();
  assert.equal(body, AGE_REVIEW_SCHEMA_SQL.trim());
  assert.ok(!/\bdrop\b|\btruncate\b/i.test(AGE_REVIEW_SCHEMA_SQL));
  assert.ok(/ON DELETE CASCADE/.test(AGE_REVIEW_SCHEMA_SQL) && /closed_minor/.test(AGE_REVIEW_SCHEMA_SQL));
});

test("evidence crypto round trip", () => {
  withKey(KEY_A, () => {
    const plain = crypto.randomBytes(5000);
    const enc = encryptEvidence(plain, AAD);
    assert.equal(enc.subarray(0, 3).toString(), "v1:");
    assert.ok(!enc.includes(plain.subarray(0, 32)));
    assert.deepEqual(decryptEvidence(enc, AAD), plain);
    assert.notDeepEqual(encryptEvidence(plain, AAD), enc);
  });
});

test("tamper is detected", () => {
  withKey(KEY_A, () => {
    const enc = encryptEvidence(Buffer.from("hello evidence"), AAD);
    for (const i of [5, 20, enc.length - 1]) {
      const bad = Buffer.from(enc); bad[i] ^= 1;
      assert.throws(() => decryptEvidence(bad, AAD), new RegExp(EVIDENCE_DECRYPT_FAILED));
    }
    assert.throws(() => decryptEvidence(enc.subarray(0, 10), AAD), new RegExp(EVIDENCE_DECRYPT_FAILED));
    assert.throws(() => decryptEvidence(Buffer.concat([Buffer.from("v2:"), enc.subarray(3)]), AAD), new RegExp(EVIDENCE_DECRYPT_FAILED));
  });
});

test("ciphertext moved to another row or kind fails closed", () => {
  withKey(KEY_A, () => {
    const enc = encryptEvidence(Buffer.from("selfie bytes"), "req-1:selfie");
    assert.deepEqual(decryptEvidence(enc, "req-1:selfie"), Buffer.from("selfie bytes"));
    assert.throws(() => decryptEvidence(enc, "req-1:document"), new RegExp(EVIDENCE_DECRYPT_FAILED));
    assert.throws(() => decryptEvidence(enc, "req-2:selfie"), new RegExp(EVIDENCE_DECRYPT_FAILED));
    assert.throws(() => encryptEvidence(Buffer.from("x"), ""), /bad input/);
  });
});

test("boot rule is called from server/index.ts, not only from a lazily loaded module", () => {
  const idx = readFileSync(join(root, "server/index.ts"), "utf8");
  assert.ok(/assertEvidenceKeyForBoot\(ageReviewEnabled\(\), process\.env\)/.test(idx));
});

test("pause cache ignores a read that started before a write (structure)", () => {
  const f = readFileSync(join(root, "server/identity/ageReviewFeatures.ts"), "utf8");
  assert.ok(/const gen = generation;/.test(f) && /if \(gen === generation\) cache =/.test(f) && /generation\+\+;/.test(f));
});

test("wrong key fails closed", () => {
  const enc = withKey(KEY_A, () => encryptEvidence(Buffer.from("secret image"), AAD));
  assert.throws(() => withKey(KEY_B, () => decryptEvidence(enc, AAD)), new RegExp(EVIDENCE_DECRYPT_FAILED));
  assert.throws(() => withKey(undefined, () => decryptEvidence(enc, AAD)), /AGE_EVIDENCE_KEY/);
  assert.throws(() => withKey(undefined, () => encryptEvidence(Buffer.from("x"), AAD)), /AGE_EVIDENCE_KEY/);
});

test("boot refuses in production with flag on and no key, allows flag off", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertEvidenceKeyForBoot(false, prod));
  assert.throws(() => assertEvidenceKeyForBoot(true, prod), /Refusing to start/);
  assert.throws(() => assertEvidenceKeyForBoot(true, { ...prod, AGE_EVIDENCE_KEY: "abc" }), /Refusing to start/);
  assert.doesNotThrow(() => assertEvidenceKeyForBoot(true, { ...prod, AGE_EVIDENCE_KEY: KEY_A }));
  assert.doesNotThrow(() => assertEvidenceKeyForBoot(true, { NODE_ENV: "development" } as NodeJS.ProcessEnv));
  assert.equal(evidenceKeyOk({ AGE_EVIDENCE_KEY: KEY_A } as NodeJS.ProcessEnv), true);
  assert.equal(evidenceKeyOk({} as NodeJS.ProcessEnv), false);
});

test("fingerprint is stable, normalised and not reversible (differs per type)", () => {
  withKey(KEY_A, () => {
    const f = documentFingerprint("passport", "A12-345 678");
    assert.match(f, /^[0-9a-f]{64}$/);
    assert.equal(documentFingerprint("passport", "a12345678"), f);
    assert.equal(documentFingerprint("passport", "  A12 345-678 "), f);
    assert.notEqual(documentFingerprint("national_id", "A12345678"), f);
    assert.notEqual(documentFingerprint("passport", "A12345679"), f);
    assert.ok(!f.includes("A12345678") && !f.toLowerCase().includes("a12345678"));
    const other = withKey(KEY_B, () => documentFingerprint("passport", "A12345678"));
    assert.notEqual(other, f);
  });
  assert.throws(() => withKey(undefined, () => documentFingerprint("passport", "A1")), /AGE_EVIDENCE_KEY/);
});

test("flag parses only 1/true", () => {
  const on = (v?: string) => ageReviewEnabled({ AGE_REVIEW: v } as NodeJS.ProcessEnv);
  assert.equal(on("1"), true);
  assert.equal(on("true"), true);
  for (const v of [undefined, "", "0", "false", "TRUE", "yes", " 1", "on"]) assert.equal(on(v), false, String(v));
});

test("age_reviewer accepted by the admin role enum", () => {
  assert.ok((adminRoles as readonly string[]).includes("age_reviewer"));
  assert.equal(z.enum(adminRoles).safeParse("age_reviewer").success, true);
  assert.equal(z.enum(adminRoles).safeParse("nope").success, false);
});

test("method union maps in toAgeVerification", () => {
  const at = new Date();
  const dob = "1990-01-01";
  for (const m of ["admin", "provider", "admin_upload", "admin_live"]) {
    assert.equal(toAgeVerification({ ageVerifiedAt: at, ageVerifiedMethod: m, dateOfBirth: dob }).method, m);
  }
  assert.equal(toAgeVerification({ ageVerifiedAt: at, ageVerifiedMethod: "bogus", dateOfBirth: dob }).method, null);
  assert.equal(toAgeVerification({ ageVerifiedAt: null, ageVerifiedMethod: "admin_live", dateOfBirth: dob }).method, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
