// Age review decision rules (no database):  npx tsx scripts/test-age-review-unit-decisions.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

process.env.AGE_EVIDENCE_KEY = crypto.randomBytes(32).toString("base64");
const { planDecision, isSelfReview } = await import("../server/identity/ageReviewAdmin");
const { documentFingerprint } = await import("../server/identity/evidenceCrypto");
const { CHECKLIST_KEYS } = await import("../shared/ageReview");
const { AGE_REVIEW_V2_SCHEMA_SQL } = await import("../server/identity/ageReviewMigrationV2");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");

const now = new Date("2026-10-25T12:00:00Z");
const REG = "1990-05-05";
const full = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true]));
const admin = { id: "a1", email: "rev@vib3.test", role: "age_reviewer" };
const superA = { id: "s1", email: "boss@vib3.test", role: "super_admin" };
const req = (o: Record<string, unknown> = {}) => ({ id: "r1", user_id: "u1", method: "upload" as const, status: "in_review", document_type: "passport", registered_dob_snapshot: REG, more_requests: 0, reviewer_id: "a1", proposed_dob: null, ...o });
const user = { email: "person@x.test", dateOfBirth: REG };
const plan = (body: any, o: { admin?: any; req?: any; user?: any; dup?: boolean } = {}) =>
  planDecision({ admin: o.admin ?? admin, req: req(o.req), user: o.user ?? user, body, isDuplicate: async () => o.dup === true, now });
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e: any) { return e.code as string; } };

await test("verify needs a full checklist", async () => {
  assert.equal(await code(plan({ outcome: "verify", checklist: { ...full, faceMatches: false }, idBirthdate: REG, documentNumber: "A1" })), "CHECKLIST_INCOMPLETE");
  assert.equal(await code(plan({ outcome: "verify", idBirthdate: REG, documentNumber: "A1" })), "CHECKLIST_INCOMPLETE");
  const p = await plan({ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" });
  assert.equal(p.finalStatus, "approved");
  assert.deepEqual(p.account, { kind: "verify", method: "admin_upload" });
  assert.equal((await plan({ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" }, { req: { method: "live" } })).account?.kind, "verify");
});

await test("verify refuses a birthdate mismatch", async () => {
  assert.equal(await code(plan({ outcome: "verify", checklist: full, idBirthdate: "1991-05-05", documentNumber: "A1" })), "BIRTHDATE_MISMATCH");
  assert.equal(await code(plan({ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" }, { user: { ...user, dateOfBirth: "1980-01-01" } })), "WRONG_STATE");
  assert.equal(await code(plan({ outcome: "verify", checklist: full, idBirthdate: REG })), "BAD_REQUEST");
});

await test("verify stores a fingerprint and never the number", async () => {
  const p = await plan({ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: " ab-12 3 " });
  assert.equal(p.fingerprint, documentFingerprint("passport", "AB123"));
  assert.ok(!JSON.stringify(p).includes("AB123") && !JSON.stringify(p).toLowerCase().includes("ab-12"));
  const ad = src("server/identity/ageReviewAdmin.ts");
  assert.ok(!/documentNumber[^;\n]*(INSERT|insert|update age_review)/.test(ad));
});

await test("same document on a second account is refused, override needs super_admin and a reason", async () => {
  const b = { outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" };
  assert.equal(await code(plan(b, { dup: true })), "DUPLICATE_DOCUMENT");
  assert.equal(await code(plan({ ...b, overrideDuplicate: { reason: "same person, new account" } }, { dup: true })), "NOT_ALLOWED");
  assert.equal(await code(plan({ ...b, overrideDuplicate: { reason: "same person, new account" } }, { dup: true, admin: superA })), "none");
});

await test("teen correction moves the account and clears verification", async () => {
  const p = await plan({ outcome: "teen_correction", idBirthdate: "2012-01-01" });
  assert.deepEqual(p.account, { kind: "correct_dob", dob: "2012-01-01", reason: "age review: ID shows under 18" });
  assert.equal(p.finalStatus, "declined"); assert.equal(p.outcome, "teen_correction"); assert.equal(p.dobMatch, false); assert.equal(p.notify, "teen_moved");
  assert.equal(p.deleteEvidence, true);
  assert.equal(await code(plan({ outcome: "teen_correction", idBirthdate: "1985-01-01" })), "BIRTHDATE_MISMATCH");
  assert.ok(/correctDateOfBirth/.test(src("server/identity/ageReviewAdmin.ts")) && /clears verification|setAgeVerification\(userId, \{ verified: false \}\)/.test(src("server/identity/ageReviewAdmin.ts")));
});

await test("birthdate change waits for a different super_admin", async () => {
  const p = await plan({ outcome: "birthdate_change", idBirthdate: "1988-02-02" });
  assert.equal(p.finalStatus, "pending_second_approval"); assert.equal(p.account, null); assert.equal(p.proposedDob, "1988-02-02"); assert.equal(p.deleteEvidence, false);
  assert.equal(await code(plan({ outcome: "birthdate_change", idBirthdate: REG })), "BIRTHDATE_MISMATCH");
  assert.equal(await code(plan({ outcome: "birthdate_change", idBirthdate: "2012-02-02" })), "BIRTHDATE_MISMATCH");
});

await test("second approver must differ", () => {
  const s = src("server/identity/ageReviewAdmin.ts");
  const fn = s.slice(s.indexOf("export async function secondApprove"));
  assert.ok(/r\.reviewer_id === admin\.id\) throw new AgeReviewError\(403, "SECOND_APPROVER_MUST_DIFFER"/.test(fn));
  assert.ok(/admin\.role !== "super_admin"\) throw new AgeReviewError\(403, "NOT_ALLOWED"/.test(fn));
});

await test("approve applies the correction then verifies; reject leaves the account unchanged", () => {
  const s = src("server/identity/ageReviewAdmin.ts");
  const fn = s.slice(s.indexOf("export async function secondApprove"), s.indexOf("async function getDetailRequestOnly"));
  const i = [fn.indexOf("if (body.approve) {"), fn.indexOf('kind: "correct_dob"'), fn.indexOf("setAgeVerification(r.user_id, { verified: true"), fn.indexOf('client') >= 0 ? 0 : 0, fn.indexOf('c.query("begin")')];
  assert.ok(i[0] >= 0 && i[1] > i[0] && i[2] > i[1] && i[4] > i[2], "correction, then verify, then the transaction");
  // Account calls sit only inside the approve branch.
  assert.equal((fn.match(/applyAccount\(/g) ?? []).length, 1);
  assert.ok(fn.indexOf("applyAccount(") > fn.indexOf("if (body.approve) {") && fn.indexOf("applyAccount(") < fn.indexOf('c.query("begin")'));
});

await test("needs_more max 2", async () => {
  const p = await plan({ outcome: "needs_more" }, { req: { more_requests: 1 } });
  assert.equal(p.finalStatus, "needs_more"); assert.equal(p.bumpMore, true); assert.equal(p.deleteEvidence, false);
  assert.equal(await code(plan({ outcome: "needs_more" }, { req: { more_requests: 2 } })), "WRONG_STATE");
  assert.equal(await code(plan({ outcome: "needs_more" }, { req: { method: "live" } })), "WRONG_STATE");
});

await test("decline requires a reason code", async () => {
  assert.equal(await code(plan({ outcome: "decline" })), "REASON_REQUIRED");
  assert.equal(await code(plan({ outcome: "decline", declineReason: "nope" })), "REASON_REQUIRED");
  const p = await plan({ outcome: "decline", declineReason: "looks_edited" });
  assert.equal(p.finalStatus, "declined"); assert.equal(p.declineReason, "looks_edited"); assert.equal(p.deleteEvidence, true);
  const m = await plan({ outcome: "not_eligible_minor" });
  assert.equal(m.finalStatus, "closed_minor"); assert.equal(m.deleteEvidence, true);
});

await test("every final outcome deletes evidence in the same transaction (structure)", async () => {
  for (const o of [{ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" }, { outcome: "teen_correction", idBirthdate: "2012-01-01" }, { outcome: "decline", declineReason: "other" }, { outcome: "not_eligible_minor" }]) {
    assert.equal((await plan(o)).deleteEvidence, true, o.outcome);
  }
  const s = src("server/identity/ageReviewAdmin.ts");
  const fn = s.slice(s.indexOf("export async function decide"), s.indexOf("export async function secondApprove"));
  const order = ['c.query("begin")', "delete from age_review_evidence", "update age_review_requests set status", 'c.query("commit")'].map((x) => fn.indexOf(x));
  assert.ok(order.every((i) => i >= 0) && order.join() === [...order].sort((a, b) => a - b).join());
  assert.ok(/rollback/.test(fn) && /ALERT account change applied but the request update failed/.test(fn), "a failure rolls everything back and shouts");
  assert.ok(fn.indexOf("applyAccount(") < fn.indexOf('c.query("begin")'), "account change first, under the advisory lock");
  assert.ok(/pg_advisory_lock/.test(s));
});

await test("self review refused", async () => {
  assert.equal(isSelfReview({ ...admin, email: "Person@X.test" }, user), true);
  assert.equal(isSelfReview(admin, user), false);
  assert.equal(await code(plan({ outcome: "decline", declineReason: "other" }, { admin: { ...admin, email: "PERSON@x.test" } })), "SELF_REVIEW");
  assert.equal(await code(plan({ outcome: "decline", declineReason: "other" }, { req: { status: "approved" } })), "WRONG_STATE");
});

await test("decisions audited without birthdates or numbers (structure)", () => {
  const s = src("server/identity/ageReviewAdmin.ts");
  const calls = [...s.matchAll(/audit\(admin\.id, "([^"]+)", id, `([^`]*)`/g)];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(!/idBirthdate|documentNumber|fingerprint|proposed|dob|note/i.test(c[2]), c[2]);
  assert.ok(/age_review\.decide/.test(s));
});

await test("v2 migration SQL equals the .sql file and is additive", () => {
  const file = src("migrations/add_age_review_v2.sql").replace(/\r\n/g, "\n");
  const body = file.slice(file.indexOf("BEGIN;") + 6, file.lastIndexOf("COMMIT;")).trim();
  assert.equal(body, AGE_REVIEW_V2_SCHEMA_SQL.trim());
  assert.ok(/ADD COLUMN IF NOT EXISTS proposed_dob text/.test(body) && !/drop|delete/i.test(body));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
