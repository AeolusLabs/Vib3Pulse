// Admin spray hosts + payout steps checks (no writes):   npx tsx scripts/test-rooms-unit-sprayhosts.ts   (also run by npm run test:rooms)
// The list query is read-only; it runs against the configured database, so a typo in the SQL or a missing column fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(p, "utf8");
const hosts = src("server/rooms/adminSprayHosts.ts");

await t("both routes are finance-only", () => {
  assert.match(hosts, /app\.get\("\/api\/admin\/rooms\/spray-hosts", requireRole\(\.\.\.FINANCE\)/);
  assert.match(hosts, /app\.post\("\/api\/admin\/rooms\/spray-hosts\/:userId\/reset-payout", requireRole\(\.\.\.FINANCE\)/);
});
await t("reset needs a reason, refuses while a payout is in flight, takes the account-change lock and is audited", () => {
  assert.match(hosts, /REASON_REQUIRED/);
  assert.match(hosts, /PAYOUT_IN_FLIGHT/);
  assert.match(hosts, /logAdminActivity\(\{[^}]*"spray_host\.reset_payout"/);
  const guard = src("server/identity/payoutNameGuard.ts");
  assert.match(guard, /export async function resetPayoutMatch[\s\S]*?lockAccountChange\(client, userId\)[\s\S]*?clearMatch\(client, userId\)/);
});
await t("the list never selects a legal name, a full number or a subaccount code", () => {
  for (const bad of ["name_enc", "account_number", "paystack_subaccount_code,", "room_verified_subaccount_code,"]) assert.equal(hosts.includes(bad), false, bad);
});
await t("the admin tab and the payout steps are wired", () => {
  assert.match(src("client/src/pages/admin/AdminRooms.tsx"), /\{tab === "hosts" && <SprayHostsTab \/>\}/);
  assert.match(src("client/src/components/rooms/earnings/PayoutAccountView.tsx"), /<PayoutSteps steps=\{\[[\s\S]*?status\.verifiedAdult[\s\S]*?status\.hasVerifiedName[\s\S]*?status\.subaccountReady/);
  assert.ok(src("client/src/pages/SettingsPage.tsx").includes('title: "Get paid"'));
});
await t("the list query runs for every filter against the real schema", async () => {
  const { listSprayHosts, SPRAY_HOST_FILTERS } = await import("../server/rooms/adminSprayHosts");
  for (const f of SPRAY_HOST_FILTERS) {
    const rows = await listSprayHosts(f, "");
    assert.ok(Array.isArray(rows) && rows.length <= 100);
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["bankName", "id", "idVerified", "hasName", "last4", "linked", "payable", "sprayRooms", "username"].sort());
  }
  assert.ok(Array.isArray(await listSprayHosts("all", "zz_no_such_user_%_\\")));
});

console.log(`\n${passed} passed, ${failed} failed`);
const { pool } = await import("../server/storage");
await pool.end().catch(() => {});
process.exit(failed ? 1 : 0);
