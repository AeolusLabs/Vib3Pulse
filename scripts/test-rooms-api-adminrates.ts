// Admin rates endpoints (rooms rates plan, task 5): read, change (super-admin only), validation, audit, history.
// Throwaway database:   npm run test:rooms
// Refuses to run unless the database name contains "test", because it creates admins.
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
delete process.env.ADMIN_MFA_REQUIRED;

await import("../server/storage");
const { registerRoomsAdminRoutes } = await import("../server/rooms/adminRoutes");
const rates = await import("../server/rooms/roomRates");
const { DEFAULT_RATES, RATE_LIMITS } = await import("../shared/money");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const adminApp = express();
adminApp.use(express.json());
adminApp.use((req: any, _res, next) => { const id = req.header("x-test-admin"); req.session = { adminId: id || undefined, destroy: (cb?: () => void) => cb?.() }; next(); });
registerRoomsAdminRoutes(adminApp);
const server = adminApp.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, path: string, as: string | null, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(as ? { "x-test-admin": as } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const madeAdmins: string[] = [];
const mkAdmin = async (role: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`,
    [`ar_admin_${role}${stamp}@t.dev`, `ar_admin_${role}${stamp}`, hash, `ar ${role}`, role]))[0].id as string;
  madeAdmins.push(id); return id;
};
const audits = async (key: string) => q(`select * from admin_activity_logs where action = 'room_rate.set' and target_id = $1`, [key]);
const logRows = async (key: string) => q(`select * from room_rate_changes where key = $1`, [key]);

try {
  await q(`delete from room_rates`); await q(`delete from room_rate_changes`);
  const SA = await mkAdmin("super_admin"), FIN = await mkAdmin("finance_manager"), MOD = await mkAdmin("content_moderator");

  // ---- read
  const g = await call("GET", "/api/admin/rooms/rates", FIN);
  check("a finance_manager can read the rates, defaults, limits and history", g.status === 200 && JSON.stringify(g.json?.rates) === JSON.stringify(DEFAULT_RATES) && JSON.stringify(g.json?.defaults) === JSON.stringify(DEFAULT_RATES)
    && JSON.stringify(g.json?.limits) === JSON.stringify(RATE_LIMITS) && Array.isArray(g.json?.changes) && g.json.changes.length === 0, JSON.stringify(g.json));
  check("a content_moderator cannot read the rates", (await call("GET", "/api/admin/rooms/rates", MOD)).status === 403);
  check("signed out is 401", (await call("GET", "/api/admin/rooms/rates", null)).status === 401);

  // ---- who may change
  check("a finance_manager cannot change a rate (403) and nothing is saved", (await call("PUT", "/api/admin/rooms/rates/ticket_platform", FIN, { value: 12, reason: "finance tries" })).status === 403 && (await rates.getRates()).ticket_platform === 15);
  check("a content_moderator cannot change a rate (403)", (await call("PUT", "/api/admin/rooms/rates/ticket_platform", MOD, { value: 12, reason: "moderator tries" })).status === 403);
  check("signed out cannot change a rate (401)", (await call("PUT", "/api/admin/rooms/rates/ticket_platform", null, { value: 12, reason: "nobody tries" })).status === 401);

  // ---- validation
  check("an unknown rate is 404", (await call("PUT", "/api/admin/rooms/rates/vat", SA, { value: 5, reason: "not editable" })).status === 404);
  check("VAT and card fees are not editable rates (404)", (await call("PUT", "/api/admin/rooms/rates/card_fee", SA, { value: 5, reason: "not editable" })).status === 404);
  for (const bad of ["12", -1, 50.01, 1.234, null, undefined, { v: 1 }]) {
    const r = await call("PUT", "/api/admin/rooms/rates/ticket_platform", SA, { value: bad, reason: "bad value test" });
    check(`value ${JSON.stringify(bad) ?? "missing"} is 400 BAD_VALUE and nothing is saved`, r.status === 400 && r.json?.code === "BAD_VALUE" && (await rates.getRates()).ticket_platform === 15, JSON.stringify(r.json));
  }
  check("a reserve above 10 is refused", (await call("PUT", "/api/admin/rooms/rates/spray_reserve", SA, { value: 10.01, reason: "too high" })).json?.code === "BAD_VALUE");
  const noReason = await call("PUT", "/api/admin/rooms/rates/ticket_platform", SA, { value: 12 });
  check("a missing reason is 400 REASON_REQUIRED", noReason.status === 400 && noReason.json?.code === "REASON_REQUIRED", JSON.stringify(noReason.json));
  check("a 2-character reason is 400 REASON_REQUIRED", (await call("PUT", "/api/admin/rooms/rates/ticket_platform", SA, { value: 12, reason: "ab" })).json?.code === "REASON_REQUIRED");
  check("nothing was audited or logged by any refused request", (await audits("ticket_platform")).length === 0 && (await logRows("ticket_platform")).length === 0);

  // ---- a real change
  const ok = await call("PUT", "/api/admin/rooms/rates/ticket_platform", SA, { value: 12.5, reason: "launch promotion for new hosts" });
  check("a super_admin can change a rate: 200 changed:true with the new value", ok.status === 200 && ok.json?.changed === true && ok.json?.key === "ticket_platform" && ok.json?.value === 12.5, JSON.stringify(ok.json));
  check("the new rate is live (the rates module reads it) and nothing else moved", (await rates.getRates()).ticket_platform === 12.5 && (await rates.getRates()).spray_platform_note === 15);
  const a1 = await audits("ticket_platform");
  check("exactly one audit row with the reason and before/after", a1.length === 1 && a1[0].reason === "launch promotion for new hosts" && JSON.parse(a1[0].details).before === 15 && JSON.parse(a1[0].details).after === 12.5 && a1[0].target_type === "room_rate", JSON.stringify(a1));
  const l1 = await logRows("ticket_platform");
  check("exactly one change-log row for it", l1.length === 1 && Number(l1[0].before_value) === 15 && Number(l1[0].after_value) === 12.5 && l1[0].admin_id === SA);
  const same = await call("PUT", "/api/admin/rooms/rates/ticket_platform", SA, { value: 12.5, reason: "saving the same value" });
  check("saving the same value is 200 changed:false with no new audit or log row", same.status === 200 && same.json?.changed === false && (await audits("ticket_platform")).length === 1 && (await logRows("ticket_platform")).length === 1, JSON.stringify(same.json));

  // ---- history
  await call("PUT", "/api/admin/rooms/rates/spray_platform_note", SA, { value: 28, reason: "note price test" });
  const g2 = await call("GET", "/api/admin/rooms/rates", FIN);
  check("GET shows the saved rates, the defaults unchanged, and the history newest first", g2.json?.rates?.ticket_platform === 12.5 && g2.json?.rates?.spray_platform_note === 28 && g2.json?.defaults?.ticket_platform === 15
    && g2.json?.changes?.length === 2 && g2.json.changes[0].key === "spray_platform_note" && g2.json.changes[0].reason === "note price test" && g2.json.changes[1].key === "ticket_platform", JSON.stringify(g2.json?.changes));
  check("the history carries who changed it", g2.json?.changes?.[0]?.adminId === SA);
} finally {
  await q(`delete from room_rates`).catch(() => {});
  await q(`delete from room_rate_changes`).catch(() => {});
  server.close(); await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
