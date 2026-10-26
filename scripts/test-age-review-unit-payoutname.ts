// Verified name for payouts (no database):  npx tsx scripts/test-age-review-unit-payoutname.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

process.env.AGE_EVIDENCE_KEY = crypto.randomBytes(32).toString("base64");
const { storage } = await import("../server/storage");
const vn = await import("../server/identity/verifiedName");
const { planDecision } = await import("../server/identity/ageReviewAdmin");
const { decideSchema } = await import("../server/routes/age-review-admin-routes");
const { payoutStatusFor, payoutTestHooks } = await import("../server/rooms/payouts");
const { CONSENT_VERSION, CHECKLIST_KEYS } = await import("../shared/ageReview");
const { PAYOUT_NAMES_SCHEMA_SQL } = await import("../server/identity/payoutNamesMigration");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const code = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e: any) { return e.code as string; } };

const REG = "1990-05-05";
const full = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true]));
const admin = { id: "a1", email: "rev@vib3.test", role: "age_reviewer" };
const req = (o: Record<string, unknown> = {}) => ({ id: "r1", user_id: "u1", method: "upload" as const, status: "in_review", document_type: "passport", registered_dob_snapshot: REG, more_requests: 0, reviewer_id: "a1", proposed_dob: null, wants_payouts: true, ...o });
const user = { email: "person@x.test", dateOfBirth: REG };
const plan = (body: any, o: { req?: any } = {}) => planDecision({ admin, req: req(o.req), user, body, isDuplicate: async () => false, now: new Date("2026-10-26T12:00:00Z") });
const NAME = "Zuriel Quenby Adewale";

await test("consent version v2 is required", () => {
  assert.equal(CONSENT_VERSION, "2026-10-v2");
});

await test("normaliseLegalName: 3..120, letters, spaces, hyphen, apostrophe, dot; whitespace collapsed", () => {
  assert.equal(vn.normaliseLegalName("  Adébáyọ̀   Okafor "), "Adébáyọ̀ Okafor");
  assert.equal(vn.normaliseLegalName("Mary O'Neil-Smith Jr."), "Mary O'Neil-Smith Jr.");
  for (const bad of ["ab", "A1 Smith", "x@y.com z", "Robert'); DROP", "<b>Bob</b> Lee", "", "   ", null, 42, "a".repeat(121), "-Smith John", "John 😀 Smith"]) assert.equal(vn.normaliseLegalName(bad), null, String(bad));
  assert.equal(vn.normaliseLegalName("a".repeat(120)), "a".repeat(120));
});

await test("name stored encrypted, round trip, wrong user AAD fails closed", async () => {
  const rows = new Map<string, Buffer>();
  const db = {
    query: async (q: string, p: unknown[] = []) => {
      if (q.startsWith("insert into user_verified_names")) { rows.set(p[0] as string, p[1] as Buffer); return { rows: [], rowCount: 1 }; }
      if (q.startsWith("select name_enc")) return { rows: rows.has(p[0] as string) ? [{ name_enc: rows.get(p[0] as string) }] : [] };
      if (q.startsWith("select 1")) return { rows: rows.has(p[0] as string) ? [{}] : [] };
      if (q.startsWith("delete from user_verified_names")) return { rows: [], rowCount: rows.delete(p[0] as string) ? 1 : 0 };
      throw new Error(q);
    },
  };
  await vn.setVerifiedName(db, "u1", "  Zuriel  Quenby Adewale ", "r1", "a1");
  const stored = rows.get("u1")!;
  assert.ok(stored.subarray(0, 3).toString() === "v1:" && !stored.includes(Buffer.from("Quenby")), "ciphertext, not text");
  assert.equal(await vn.getVerifiedLegalName("u1", db), NAME);
  assert.equal(await vn.hasVerifiedName("u1", db), true);
  rows.set("u2", stored); // the same ciphertext under another user
  const errs: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  try { assert.equal(await vn.getVerifiedLegalName("u2", db), null); } finally { console.error = orig; }
  assert.ok(errs.length === 1 && errs[0].includes("ALERT") && !errs[0].includes("Quenby") && !errs[0].includes("u2"), "an ALERT without personal data");
  assert.equal(await vn.getVerifiedLegalName("nobody", db), null);
  assert.equal(await vn.deleteVerifiedName("u1", db), true); assert.equal(await vn.hasVerifiedName("u1", db), false);
  await assert.rejects(vn.setVerifiedName(db, "u1", "x", null, null));
  const sealed = vn.sealProposedName(NAME, "r1");
  assert.equal(vn.openProposedName(sealed, "r1"), NAME);
  assert.throws(() => vn.openProposedName(sealed, "r2"), "bound to the request");
});

await test("legalName required when wantsPayouts (NAME_REQUIRED) and refused otherwise (NAME_NOT_REQUESTED)", async () => {
  const v = { outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1" };
  assert.equal(await code(plan(v)), "NAME_REQUIRED");
  assert.equal(await code(plan({ ...v, legalName: "   " })), "NAME_REQUIRED");
  assert.equal(await code(plan({ ...v, legalName: "x1 y" })), "BAD_REQUEST");
  assert.equal((await plan({ ...v, legalName: ` ${NAME} ` })).storeName, NAME);
  assert.equal(await code(plan({ ...v, legalName: NAME }, { req: { wants_payouts: false } })), "NAME_NOT_REQUESTED");
  assert.equal((await plan(v, { req: { wants_payouts: false } })).storeName, null);
  assert.ok(decideSchema.safeParse({ outcome: "verify", legalName: NAME }).success && decideSchema.parse({ outcome: "verify", legalName: NAME }).legalName === NAME, "the route schema keeps legalName");
});

await test("birthdate change holds the name; declines, minors and teen corrections never store one", async () => {
  const bc = { outcome: "birthdate_change", checklist: full, idBirthdate: "1988-02-02", documentNumber: "A1" };
  assert.equal(await code(plan(bc)), "NAME_REQUIRED");
  const p = await plan({ ...bc, legalName: NAME });
  assert.equal(p.holdName, NAME); assert.equal(p.storeName, null); assert.equal(p.finalStatus, "pending_second_approval");
  const teen = await plan({ outcome: "teen_correction", idBirthdate: "2012-01-01", legalName: NAME });
  assert.equal(teen.storeName, null); assert.equal(teen.holdName, null); assert.equal(teen.deleteName, true);
  const dec = await plan({ outcome: "decline", declineReason: "other", legalName: NAME });
  assert.equal(dec.storeName, null); assert.equal(dec.holdName, null);
  const minor = await plan({ outcome: "not_eligible_minor", idBirthdate: "2012-01-01", legalName: NAME }, { req: { registered_dob_snapshot: "2012-01-01" } });
  assert.equal(minor.storeName, null);
});

await test("name never in any log, error, audit or notification (structure)", async () => {
  // Error messages from the plan never echo the input.
  for (const body of [{ outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1", legalName: "Qx9 Zed" }, { outcome: "verify", checklist: full, idBirthdate: REG, documentNumber: "A1", legalName: "   " }]) {
    try { await plan(body); assert.fail("should refuse"); } catch (e: any) { assert.ok(!/Qx9|Zed/.test(e.message)); }
  }
  const a = src("server/identity/ageReviewAdmin.ts");
  assert.ok(a.includes('${result.payouts ? " payouts=true" : ""}'));
  assert.ok(!/audit\([^)]*(legalName|storeName|holdName|proposed_legal)/.test(a));
  const vnSrc = src("server/identity/verifiedName.ts");
  for (const line of vnSrc.split("\n").filter((l) => /console\./.test(l))) assert.ok(!/name|clean/i.test(line.replace(/ALERT a stored verified name could not be decrypted/, "")), line);
  assert.ok(!/legalName|verifiedName|storeName/.test(src("server/identity/ageReviewNotify.ts")));
  // No route returns it: nothing selects name_enc outside the module.
  for (const f of ["server/rooms/payoutRoutes.ts", "server/routes/age-review-routes.ts", "server/routes/age-review-admin-routes.ts", "server/identity/ageReviewService.ts"]) assert.ok(!/name_enc|getVerifiedLegalName/.test(src(f)), f);
});

await test("completing a payouts review keeps the original age_verified_at (applyAccount)", async () => {
  const calls: unknown[] = [];
  const keepGet = (storage as any).getUser, keepSet = (storage as any).setAgeVerification;
  try {
    (storage as any).setAgeVerification = async (...a: unknown[]) => { calls.push(a); };
    const { applyAccountForTests } = await import("../server/identity/ageReviewAdmin");
    (storage as any).getUser = async () => ({ ageVerifiedAt: new Date("2026-01-15") });
    assert.equal(await applyAccountForTests("a", "u", { kind: "verify", method: "admin_upload" }), false);
    assert.deepEqual(calls, [], "an existing verification is left alone (and never compensated away)");
    (storage as any).getUser = async () => ({ ageVerifiedAt: null });
    assert.equal(await applyAccountForTests("a", "u", { kind: "verify", method: "admin_upload" }), true);
    assert.equal(calls.length, 1);
  } finally { (storage as any).getUser = keepGet; (storage as any).setAgeVerification = keepSet; }
});

await test("name is stored in the decision transaction and cleared on every final status (structure)", () => {
  const a = src("server/identity/ageReviewAdmin.ts");
  const fn = a.slice(a.indexOf("export async function decide"), a.indexOf("export async function compensateAccountChange"));
  assert.ok(fn.indexOf('c.query("begin")') < fn.indexOf("setVerifiedName(c,") && fn.indexOf("setVerifiedName(c,") < fn.indexOf('c.query("commit")'));
  assert.ok(fn.includes("deleteVerifiedName(req.user_id, c)"));
  assert.ok(fn.includes("proposed_legal_name_enc = case when $2 in ('approved', 'declined', 'closed_minor') then null"));
  const sa = a.slice(a.indexOf("export async function secondApprove"), a.indexOf("async function getDetailRequestOnly"));
  assert.ok(sa.includes("openProposedName(r.proposed_legal_name_enc, id)") && sa.includes("proposed_legal_name_enc = null") && sa.indexOf("setVerifiedName(c,") < sa.indexOf('c.query("commit")'));
  assert.ok(src("server/identity/ageReviewSweep.ts").includes("proposed_legal_name_enc = null"));
  assert.ok(src("server/identity/ageReviewService.ts").includes("proposed_legal_name_enc = null"));
  assert.ok(src("server/identity/ageReviewControls.ts").includes("proposed_legal_name_enc = case when status = 'pending_second_approval' then null"));
});

await test("revoke, old clear, teen correction, birthdate correction and account deletion delete the name (structure)", () => {
  const r = src("server/admin-routes.ts");
  assert.ok(r.includes("await deleteVerifiedName(user.id); // the stored legal name goes with the verification"));
  assert.ok(r.includes("if (!verified) await deleteVerifiedName(user.id)"));
  assert.ok(src("server/services/dobCorrection.ts").includes("deleteVerifiedName(a.userId)"));
  const sw = src("server/identity/ageReviewSweep.ts");
  assert.ok(sw.slice(sw.indexOf("export async function purgeUserAgeReview")).includes("deleteVerifiedName(userId)"));
  assert.ok(src("server/storage.ts").slice(src("server/storage.ts").indexOf("async softDeleteUser")).includes("purgeUserAgeReview(userId)"));
  assert.ok(PAYOUT_NAMES_SCHEMA_SQL.includes("user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE"), "hard delete cascades");
});

await test("payout status reports hasVerifiedName (and canLinkAccount follows it)", async () => {
  const keep = { u: (storage as any).getUser, a: (storage as any).getOrganizerPaymentAccount };
  const names = new Map<string, string>();
  payoutTestHooks.verifiedName = (id) => names.get(id) ?? null;
  const verifiedUser = { id: "u1", deletedAt: null, ageVerifiedAt: new Date(), dateOfBirth: "1990-01-01" };
  (storage as any).getUser = async () => verifiedUser;
  (storage as any).getOrganizerPaymentAccount = async () => undefined;
  try {
    let s = await payoutStatusFor("u1");
    assert.equal(s.hasVerifiedName, false); assert.equal(s.canLinkAccount, false); assert.equal(s.verifiedAdult, true);
    names.set("u1", NAME);
    s = await payoutStatusFor("u1");
    assert.equal(s.hasVerifiedName, true); assert.equal(s.canLinkAccount, true);
    assert.ok(!JSON.stringify(s).includes("Quenby"), "never the name");
    (storage as any).getUser = async () => ({ ...verifiedUser, ageVerifiedAt: null });
    s = await payoutStatusFor("u1");
    assert.equal(s.hasVerifiedName, true); assert.equal(s.canLinkAccount, false, "no verified adult, no linking");
  } finally { delete payoutTestHooks.verifiedName; (storage as any).getUser = keep.u; (storage as any).getOrganizerPaymentAccount = keep.a; }
  const p = src("server/rooms/payouts.ts");
  assert.ok(p.includes("To add a bank account we need to check your name on your ID. Start a payouts check from this page."));
  assert.ok(p.includes("const verifiedName = await verifiedLegalNameOf(userId);"));
});

await test("migration SQL equals the .sql file, is additive and has the required shape", () => {
  const file = src("migrations/add_payout_names.sql").replace(/\r\n/g, "\n");
  assert.equal(file.slice(file.indexOf("BEGIN;") + 6, file.lastIndexOf("COMMIT;")).trim(), PAYOUT_NAMES_SCHEMA_SQL.trim());
  assert.ok(!/drop |delete from|truncate|rename/i.test(PAYOUT_NAMES_SCHEMA_SQL));
  assert.ok(/name_enc bytea NOT NULL/.test(PAYOUT_NAMES_SCHEMA_SQL) && /wants_payouts boolean NOT NULL DEFAULT false/.test(PAYOUT_NAMES_SCHEMA_SQL) && /proposed_legal_name_enc bytea/.test(PAYOUT_NAMES_SCHEMA_SQL));
  assert.ok(src("server/storage.ts").includes("PAYOUT_NAMES_SCHEMA_SQL"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
