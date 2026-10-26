// Real second factor required for evidence roles, and Sentry scrubbing (no database):  npx tsx scripts/test-age-review-unit-mfa.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

delete process.env.AGE_REVIEW;
delete process.env.ADMIN_MFA_REQUIRED;
const { storage } = await import("../server/storage");
const { adminGate, mfaTestHooks } = await import("../server/services/adminSecurity");
const { scrubSentryEvent } = await import("../server/sentryScrub");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");

let role = "age_reviewer";
(storage as any).getAdminUser = async (id: string) => ({ id, role, email: "r@x.test", isActive: true });
mfaTestHooks.isEnrolled = async () => true;

async function run(session: Record<string, unknown>, opts: Parameters<typeof adminGate>[0] = {}) {
  const req: any = { session: { adminId: "a1", destroy: () => {}, ...session } };
  let status = 200, body: any = null, nexted = false;
  const res: any = { status(c: number) { status = c; return res; }, json(b: unknown) { body = b; return res; } };
  await adminGate(opts)(req, res, () => { nexted = true; });
  return { status: nexted ? 200 : status, body };
}

await test("a session minted before the flag was on is forced through MFA once the flag is on", async () => {
  // Minted while MFA was not required: login set mfaVerified = true and never mfaPassed.
  const stale = { mfaVerified: true };
  for (const r of ["super_admin", "admin", "age_reviewer"]) {
    role = r;
    delete process.env.AGE_REVIEW;
    assert.equal((await run(stale)).status, 200, `${r}: fine while the flag is off`);
    process.env.AGE_REVIEW = "1";
    try {
      const blocked = await run(stale);
      assert.equal(blocked.status, 403, r); assert.equal(blocked.body.code, "MFA_REQUIRED"); assert.equal(blocked.body.mfa, "verify");
      assert.equal((await run({ mfaVerified: true, mfaPassed: true })).status, 200, `${r}: passes after a real second factor`);
      assert.equal((await run(stale, { allowPendingMfa: true })).status, 200, `${r}: /me, /logout and the MFA endpoints stay reachable`);
      mfaTestHooks.isEnrolled = async () => false;
      assert.equal((await run(stale)).body.mfa, "enroll");
      mfaTestHooks.isEnrolled = async () => true;
    } finally { delete process.env.AGE_REVIEW; }
  }
  role = "finance_manager";
  process.env.AGE_REVIEW = "1";
  try { assert.equal((await run(stale)).status, 200, "other roles are untouched"); } finally { delete process.env.AGE_REVIEW; }
});

await test("verify sets mfaPassed (structure)", () => {
  const s = src("server/routes/admin-social-routes.ts");
  assert.equal((s.match(/req\.session\.mfaPassed = true;/g) ?? []).length, 2, "TOTP/recovery verify and enrolment confirm");
  const login = src("server/admin-routes.ts");
  assert.ok(login.includes("req.session.mfaPassed = false;") && !/mfaPassed = (true|!)/.test(login), "login never grants it");
  assert.ok(s.includes("verified: required ? req.session.mfaPassed === true : !!req.session.mfaVerified"));
});

await test("no MFA required: nothing changes", async () => {
  delete process.env.AGE_REVIEW; delete process.env.ADMIN_MFA_REQUIRED;
  for (const r of ["super_admin", "admin", "age_reviewer", "user_support"]) {
    role = r;
    assert.equal((await run({ mfaVerified: true })).status, 200, r);
    assert.equal((await run({})).status, 200, `${r}: without any flag no MFA is asked for`);
  }
  // The older switch still works on its own and now also needs the real proof.
  process.env.ADMIN_MFA_REQUIRED = "true";
  try {
    role = "super_admin";
    assert.equal((await run({ mfaVerified: false })).body.code, "MFA_REQUIRED");
    assert.equal((await run({ mfaVerified: true, mfaPassed: true })).status, 200);
    role = "admin";
    assert.equal((await run({ mfaVerified: false })).status, 200, "ADMIN_MFA_REQUIRED alone is still super_admin only");
  } finally { delete process.env.ADMIN_MFA_REQUIRED; }
});

await test("Sentry events never carry bodies, cookies or auth headers", () => {
  const event: any = {
    message: "boom",
    request: { url: "/api/age-review/requests/1/evidence", method: "POST", data: { data: "iVBORw0KGgo", documentNumber: "P123" }, cookies: { sid: "s" },
      headers: { Authorization: "Bearer x", Cookie: "sid=1", "X-CSRF-Token": "t", "user-agent": "ua", "content-type": "application/json" } },
  };
  const out = scrubSentryEvent(event);
  assert.equal(out.request.data, undefined); assert.equal(out.request.cookies, undefined);
  assert.deepEqual(Object.keys(out.request.headers).sort(), ["content-type", "user-agent"]);
  assert.equal(out.message, "boom"); assert.equal(out.request.url, "/api/age-review/requests/1/evidence");
  assert.doesNotThrow(() => scrubSentryEvent({} as any));
  const i = src("server/index.ts");
  assert.ok(i.includes("sendDefaultPii: false") && i.includes("beforeSend: (event) => scrubSentryEvent(event)"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
