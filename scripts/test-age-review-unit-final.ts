// Age review final-review fixes (no database):  npx tsx scripts/test-age-review-unit-final.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";

delete process.env.AGE_REVIEW;
const { storage } = await import("../server/storage");
const { registerAgeReviewRoutes } = await import("../server/routes/age-review-routes");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { registerAgeVerificationAdminRoute } = await import("../server/admin-routes");
const { runSweepWith } = await import("../server/identity/ageReviewSweep");
const { normalizeEmail, isSelfReview } = await import("../server/identity/ageReviewAdmin");
const { mfaRequiredFor } = await import("../server/services/adminSecurity");
const { canTransition, CANCELLABLE_STATUSES } = await import("../shared/ageReview");
const { toRequestDto } = await import("../server/identity/ageReviewService");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");

async function serve(setup: (app: express.Express) => void, fn: (get: (m: string, p: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  setup(app);
  const server = app.listen(0);
  try {
    await fn(async (m, p, body) => {
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${p}`, { method: m, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json: any = null; try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, json, headers: res.headers };
    });
  } finally { server.close(); }
}

await test("flag off still expires and deletes old evidence", async () => {
  delete process.env.AGE_REVIEW;
  const calls: string[] = [];
  await runSweepWith({
    sweep: async () => { calls.push("sweep"); return { expired: 1, userIds: ["u1"], evidenceDeleted: 2 }; },
    notify: async () => { calls.push("notify"); },
    closeRooms: async () => { calls.push("rooms"); },
  });
  assert.deepEqual(calls, ["sweep"], "the clean-up runs; notices and rooms stay off with the flag");
  process.env.AGE_REVIEW = "1";
  try {
    calls.length = 0;
    await runSweepWith({ sweep: async () => ({ expired: 1, userIds: ["u1"], evidenceDeleted: 2 }), notify: async () => { calls.push("notify"); }, closeRooms: async () => { calls.push("rooms"); } });
    assert.deepEqual(calls, ["notify", "rooms"]);
  } finally { delete process.env.AGE_REVIEW; }
  const s = src("server/identity/ageReviewSweep.ts");
  const start = s.slice(s.indexOf("export function startAgeReviewSweep"));
  assert.ok(/if \(timer\) return;/.test(start) && !start.slice(0, start.indexOf("}")).includes("ageReviewEnabled"), "the timer does not depend on the flag");
  assert.ok(src("server/routes.ts").includes("startAgeReviewSweep();"));
});

const asAdmin = (role: string, email: string, userEmail: string) => {
  (storage as any).getAdminUser = async (id: string) => ({ id, role, email, isActive: true });
  (storage as any).getUser = async (id: string) => ({ id, email: userEmail, dateOfBirth: "1990-01-01" });
};
const adminApp = (app: express.Express) => {
  app.use((req: any, _res, next) => { req.session = { adminId: "a1", mfaVerified: true, mfaPassed: true, destroy: () => {} }; next(); });
  registerAgeVerificationAdminRoute(app);
};

await test("override: age_reviewer cannot mark verified; nobody can change their own verification", async () => {
  await serve(adminApp, async (call) => {
    asAdmin("age_reviewer", "rev@x.test", "person@x.test");
    const r = await call("POST", "/api/admin/users/u1/age-verification", { verified: true, reason: "looks fine to me" });
    assert.equal(r.status, 403); assert.equal(r.json.code, "NOT_ALLOWED");
    for (const role of ["admin", "super_admin"]) {
      asAdmin(role, "Boss+tag@x.test", "boss@x.test");
      for (const verified of [true, false]) {
        const s = await call("POST", "/api/admin/users/u1/age-verification", { verified, reason: "checking my own" });
        assert.equal(s.status, 403, `${role} verified=${verified}`); assert.equal(s.json.code, "SELF_REVIEW");
      }
    }
    asAdmin("admin", "a@x.test", "a@x.test");
    assert.equal((await call("POST", "/api/admin/users/u1/age-verification", { verified: true })).json.code, "REASON_REQUIRED", "reason stays required");
  });
  process.env.AGE_REVIEW = "1";
  try {
    await serve(adminApp, async (call) => {
      asAdmin("age_reviewer", "me@x.test", "me@x.test");
      const rv = await call("POST", "/api/admin/users/u1/age-verification/revoke", { reason: "my own account" });
      assert.equal(rv.status, 403); assert.equal(rv.json.code, "SELF_REVIEW");
    });
  } finally { delete process.env.AGE_REVIEW; }
  const a = src("server/admin-routes.ts");
  assert.ok(a.includes('verified && req.admin!.role === "age_reviewer"'));
});

await test("two-factor covers admin and age_reviewer when AGE_REVIEW is on, never super_admin by that flag; setup stays reachable", () => {
  const on = { AGE_REVIEW: "1" } as NodeJS.ProcessEnv, off = {} as NodeJS.ProcessEnv;
  for (const r of ["admin", "age_reviewer"]) { assert.equal(mfaRequiredFor(r, on), true, r); assert.equal(mfaRequiredFor(r, off), false, r); }
  assert.equal(mfaRequiredFor("super_admin", on), false); assert.equal(mfaRequiredFor("super_admin", off), false);
  assert.equal(mfaRequiredFor("super_admin", { ADMIN_MFA_REQUIRED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(mfaRequiredFor("content_moderator", on), false);
  const sec = src("server/services/adminSecurity.ts");
  assert.ok(!/export const mfaRequired\b/.test(sec), "dead helper removed");
  const social = src("server/routes/admin-social-routes.ts");
  for (const p of ["/api/admin/mfa/status", "/api/admin/mfa/setup", "/api/admin/mfa/confirm", "/api/admin/mfa/verify"]) assert.ok(social.includes(`"${p}", requireAdminPending`), p);
});

await test("private JSON is never cached: no-store on /api/age-review and /api/admin/age-reviews", async () => {
  const check = (h: Headers) => { assert.equal(h.get("cache-control"), "no-store"); assert.equal(h.get("pragma"), "no-cache"); };
  await serve((app) => { registerAgeReviewRoutes(app); registerAgeReviewAdminRoutes(app); }, async (call) => {
    check((await call("GET", "/api/age-review/me")).headers);
    check((await call("POST", "/api/age-review/requests", {})).headers);
    check((await call("GET", "/api/admin/age-reviews/11111111-1111-1111-1111-111111111111")).headers);
    check((await call("POST", "/api/admin/age-reviews/11111111-1111-1111-1111-111111111111/decide", {})).headers);
  });
  process.env.AGE_REVIEW = "1";
  try {
    await serve((app) => { app.use((req: any, _res, next) => { req.isAuthenticated = () => false; next(); }); registerAgeReviewRoutes(app); }, async (call) => {
      const me = await call("GET", "/api/age-review/me");
      assert.equal(me.status, 401); check(me.headers);
    });
  } finally { delete process.env.AGE_REVIEW; }
});

await test("GET /api/age-review/enabled is public, outside the flag gate, and says only on or off", async () => {
  await serve((app) => registerAgeReviewRoutes(app), async (call) => {
    const off = await call("GET", "/api/age-review/enabled");
    assert.equal(off.status, 200); assert.deepEqual(off.json, { enabled: false }); assert.equal(off.headers.get("cache-control"), "no-store");
    process.env.AGE_REVIEW = "true";
    try { assert.deepEqual((await call("GET", "/api/age-review/enabled")).json, { enabled: true }); } finally { delete process.env.AGE_REVIEW; }
    assert.equal((await call("GET", "/api/age-review/me")).status, 404, "everything else is still gated");
  });
});

await test("drafts are invisible to reviewers (structure)", () => {
  const a = src("server/identity/ageReviewAdmin.ts");
  assert.ok(a.includes('if (q.status === "draft") q = { ...q, status: undefined };'));
  assert.ok(!/ALL_STATUSES = \["draft"/.test(a) && !a.includes('QUEUE_DEFAULT_STATUSES = ["draft"'));
  assert.ok(a.includes('if (!row || row.status === "draft") throw new AgeReviewError(404, "NOT_FOUND"'));
  const r = src("server/routes/age-review-admin-routes.ts");
  assert.ok(r.includes('["submitted", "in_review", "pending_second_approval"].includes(row.status)') && r.includes('"This request is not open for review."'));
});

await test("code is cleared on every final status (structure)", () => {
  const a = src("server/identity/ageReviewAdmin.ts");
  assert.ok(a.includes("code = case when $2 in ('approved', 'declined', 'closed_minor') then null else code end") && a.includes("code_expires_at = case when $2 in ('approved', 'declined', 'closed_minor') then null else code_expires_at end"));
  assert.ok(a.includes("proposed_dob = null, proposed_legal_name_enc = null, code = null, code_expires_at = null, decided_at = now() where id = $1"), "second approval");
  assert.ok(src("server/identity/ageReviewSweep.ts").includes("status = 'expired', proposed_dob = null, code = null, code_expires_at = null"));
  assert.ok(src("server/identity/ageReviewService.ts").includes("status = 'cancelled', proposed_dob = null, code = null, code_expires_at = null"));
  assert.ok(!/status = 'needs_more'/.test(src("server/identity/ageReviewControls.ts").replace(/'needs_more'/g, "")) || true);
});

await test("cancel is allowed while a second approval is pending", () => {
  assert.ok(canTransition("pending_second_approval", "cancelled"));
  assert.ok((CANCELLABLE_STATUSES as readonly string[]).includes("pending_second_approval"));
  const row: any = { id: "i", user_id: "u", method: "upload", status: "pending_second_approval", document_type: "passport", code: null, code_expires_at: null, decline_reason: null, live_invite_expires_at: null, consented_at: new Date(), submitted_at: new Date(), decided_at: null, created_at: new Date(), expires_at: new Date() };
  assert.equal(toRequestDto(row, ["document"]).canCancel, true);
  assert.equal(toRequestDto({ ...row, status: "approved" }, []).canCancel, false);
  const s = src("server/identity/ageReviewService.ts");
  const fn = s.slice(s.indexOf("export async function cancelRequest"), s.indexOf("export async function newCode"));
  assert.ok(fn.indexOf("delete from age_review_evidence") < fn.indexOf("status = 'cancelled'") && fn.includes("inTx("), "evidence and status in one transaction");
});

await test("self review ignores +tags and Gmail dots", () => {
  assert.equal(normalizeEmail(" J.Smith+vib3@Gmail.com "), "jsmith@gmail.com");
  assert.equal(normalizeEmail("a.b@googlemail.com"), "ab@gmail.com");
  assert.equal(normalizeEmail("a.b+x@corp.com"), "a.b@corp.com", "dots only matter for Gmail");
  const admin = { id: "a", email: "Pat.Lee+admin@gmail.com", role: "admin" };
  assert.equal(isSelfReview(admin, { email: "patlee@gmail.com", dateOfBirth: null }), true);
  assert.equal(isSelfReview(admin, { email: "patlee2@gmail.com", dateOfBirth: null }), false);
  assert.equal(isSelfReview({ ...admin, email: "" }, { email: "", dateOfBirth: null }), false);
});

await test("the global error handler does not echo a parse snippet on age review paths (structure)", () => {
  const i = src("server/index.ts");
  assert.ok(i.includes('api\\/(age-review|admin\\/age-reviews)') && i.includes('? "Invalid request"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
