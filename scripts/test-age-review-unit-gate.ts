// age_reviewer least privilege (no database; the admin lookup is stubbed):  npx tsx scripts/test-age-review-unit-gate.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { storage } = await import("../server/storage");
const { requireStaffNotReviewer, requireAdminPending, adminGate } = await import("../server/services/adminSecurity");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let role = "age_reviewer";
(storage as any).getAdminUser = async (id: string) => ({ id, role, isActive: true });

async function run(gate: (req: any, res: any, next: () => void) => Promise<unknown>) {
  const req: any = { session: { adminId: "a1", destroy: () => {} } };
  let status = 200, nexted = false;
  const res: any = { status(c: number) { status = c; return res; }, json() { return res; } };
  await gate(req, res, () => { nexted = true; });
  return nexted ? 200 : status;
}

await test("age_reviewer gets 403 on stats and organizer routes and passes /me", async () => {
  role = "age_reviewer";
  assert.equal(await run(requireStaffNotReviewer), 403);
  assert.equal(await run(requireAdminPending), 200); // /me and /logout use requireAdminPending
  assert.equal(await run(adminGate({ roles: ["super_admin", "admin", "age_reviewer"] })), 200);
});

await test("every other admin role still passes the staff gate", async () => {
  for (const r of ["super_admin", "admin", "content_moderator", "user_support", "event_reviewer", "finance_manager", "analytics_viewer"]) {
    role = r;
    assert.equal(await run(requireStaffNotReviewer), 200, r);
  }
});

await test("the dashboard routes use the staff gate (structure)", () => {
  const s = readFileSync(join(root, "server/admin-routes.ts"), "utf8");
  for (const p of ["/api/admin/stats", "/api/admin/analytics/overview", "/api/admin/meta/filters", "/api/admin/health", "/api/admin/cache-stats",
    "/api/admin/social/dashboard", "/api/admin/social/organizers", "/api/admin/social/costs", "/api/admin/social/platforms", "/api/admin/social/stale-connections"]) {
    assert.ok(s.includes(`"${p}", requireStaffNotReviewer,`), p);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
