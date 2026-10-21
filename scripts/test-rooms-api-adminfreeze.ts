// Rooms admin freeze endpoints (rooms admin plan, task 5): audited pause switches and host freezes, role rules, idempotence.
// Throwaway database:   npm run test:rooms
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix af_.
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
const controls = await import("../server/rooms/roomControls");

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
const madeUsers: string[] = [], madeRooms: string[] = [], madeAdmins: string[] = [];
let seq = 0;
const mk = async (name: string) => {
  const id = (await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
    values ($1,$2,'social',$3,true,true,'1990-01-01', now() - interval '60 days') returning id`, [`af_${name}${stamp}${++seq}@t.dev`, `af_${name}${stamp}${seq}`, hash]))[0].id as string;
  madeUsers.push(id); return id;
};
const mkAdmin = async (role: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`,
    [`af_admin_${role}${stamp}@t.dev`, `af_admin_${role}${stamp}`, hash, `af ${role}`, role]))[0].id as string;
  madeAdmins.push(id); return id;
};
const mkRoom = async (host: string, status: string) => {
  const id = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, started_at) values ($1,$2,'party','public','18+',$3, case when $3 = 'live' then now() end) returning id`,
    [host, `af room ${++seq}`, status]))[0].id as string;
  madeRooms.push(id); return id;
};
const audits = async (action: string, targetId: string) => q(`select * from admin_activity_logs where action = $1 and target_id = $2`, [action, targetId]);

try {
  const SA = await mkAdmin("super_admin"), FIN = await mkAdmin("finance_manager"), MOD = await mkAdmin("content_moderator");
  const H = await mk("host");

  // ---- global switches
  const cur = await call("GET", "/api/admin/rooms/controls", FIN);
  check("controls: finance_manager can read; both switches start off", cur.status === 200 && cur.json?.spraysPaused === false && cur.json?.ticketsPaused === false && Array.isArray(cur.json?.frozenHosts), JSON.stringify(cur.json));
  check("controls: a content_moderator cannot read or write them", (await call("GET", "/api/admin/rooms/controls", MOD)).status === 403 && (await call("POST", "/api/admin/rooms/controls/sprays_paused", MOD, { on: true, reason: "nope nope" })).status === 403);
  check("controls: signed out is 401", (await call("GET", "/api/admin/rooms/controls", null)).status === 401);
  const noReason = await call("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true });
  check("pause without a reason is 400 REASON_REQUIRED", noReason.status === 400 && noReason.json?.code === "REASON_REQUIRED", JSON.stringify(noReason.json));
  check("pause with a 2-character reason is 400 REASON_REQUIRED", (await call("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "ab" })).json?.code === "REASON_REQUIRED");
  check("an unknown switch is 404", (await call("POST", "/api/admin/rooms/controls/everything", FIN, { on: true, reason: "test reason" })).status === 404);
  const p1 = await call("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "suspected abuse" });
  check("finance_manager can pause spraying", p1.status === 200 && p1.json?.changed === true, JSON.stringify(p1.json));
  check("the pause is live (the controls module reads it)", (await controls.getControl("sprays_paused")) === true && (await call("GET", "/api/admin/rooms/controls", SA)).json?.spraysPaused === true);
  check("pausing writes exactly one audit row with the reason", (await audits("room_control.on", "sprays_paused")).length === 1 && (await audits("room_control.on", "sprays_paused"))[0].reason === "suspected abuse");
  const p2 = await call("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "again again" });
  check("pausing twice is 200 changed:false with no second audit row", p2.status === 200 && p2.json?.changed === false && (await audits("room_control.on", "sprays_paused")).length === 1, JSON.stringify(p2.json));
  const r1 = await call("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: false, reason: "all clear now" });
  check("resuming with a finance_manager is 403 SUPER_ADMIN_ONLY and the pause stays", r1.status === 403 && r1.json?.code === "SUPER_ADMIN_ONLY" && (await controls.getControl("sprays_paused")) === true, JSON.stringify(r1.json));
  const r2 = await call("POST", "/api/admin/rooms/controls/sprays_paused", SA, { on: false, reason: "all clear now" });
  check("super_admin can resume, audited as room_control.off", r2.status === 200 && r2.json?.changed === true && (await controls.getControl("sprays_paused")) === false && (await audits("room_control.off", "sprays_paused")).length === 1, JSON.stringify(r2.json));
  await call("POST", "/api/admin/rooms/controls/tickets_paused", SA, { on: true, reason: "tickets check" });
  check("the ticket switch is independent and works the same", (await controls.getControl("tickets_paused")) === true && (await controls.getControl("sprays_paused")) === false);
  await call("POST", "/api/admin/rooms/controls/tickets_paused", SA, { on: false, reason: "tickets back" });

  // ---- host freeze
  const live = await mkRoom(H, "live");
  const ended = await mkRoom(H, "ended");
  await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1,$2,5000,'held', now() + interval '1 hour')`, [ended, H]);
  const miss = await call("POST", `/api/admin/rooms/hosts/${"00000000-0000-4000-8000-000000000000"}/freeze`, FIN, { reason: "no such host" });
  check("freezing an unknown host is 404", miss.status === 404, JSON.stringify(miss.json));
  check("freezing a junk host id is 404", (await call("POST", "/api/admin/rooms/hosts/not-a-uuid/freeze", FIN, { reason: "no such host" })).status === 404);
  check("a content_moderator cannot freeze a host", (await call("POST", `/api/admin/rooms/hosts/${H}/freeze`, MOD, { reason: "not allowed" })).status === 403);
  check("freeze without a reason is 400 REASON_REQUIRED", (await call("POST", `/api/admin/rooms/hosts/${H}/freeze`, FIN, {})).json?.code === "REASON_REQUIRED");
  const f1 = await call("POST", `/api/admin/rooms/hosts/${H}/freeze`, FIN, { reason: "suspected misconduct" });
  check("finance_manager can freeze: changed, payouts held, the live room stays live", f1.status === 200 && f1.json?.changed === true && f1.json?.held?.held === 1 && f1.json?.endedRooms === 0 && (await q(`select status from rooms where id = $1`, [live]))[0].status === "live", JSON.stringify(f1.json));
  check("the host is frozen and the payout is held to the sentinel", (await controls.isHostFrozen(H)) === true && (await q(`select release_at > '9000-01-01' as held from room_payouts where room_id = $1`, [ended]))[0].held === true);
  check("freezing writes one audit row with the reason", (await audits("room_host.freeze", H)).length === 1 && (await audits("room_host.freeze", H))[0].reason === "suspected misconduct");
  const f2 = await call("POST", `/api/admin/rooms/hosts/${H}/freeze`, FIN, { reason: "again again", endLiveRooms: true });
  check("freezing again is 200 changed:false, no side effects, no second audit row (the live room stays live)", f2.status === 200 && f2.json?.changed === false && (await audits("room_host.freeze", H)).length === 1 && (await q(`select status from rooms where id = $1`, [live]))[0].status === "live", JSON.stringify(f2.json));
  const list = await call("GET", "/api/admin/rooms/controls", FIN);
  check("controls lists the frozen host with the reason", list.json?.frozenHosts?.some((h: any) => h.hostId === H && h.reason === "suspected misconduct"), JSON.stringify(list.json?.frozenHosts));
  const u1 = await call("POST", `/api/admin/rooms/hosts/${H}/unfreeze`, FIN, { reason: "cleared up" });
  check("unfreezing with a finance_manager is 403", u1.status === 403 && (await controls.isHostFrozen(H)) === true, JSON.stringify(u1.json));
  const u2 = await call("POST", `/api/admin/rooms/hosts/${H}/unfreeze`, SA, { reason: "cleared up" });
  check("super_admin can unfreeze: changed, audited", u2.status === 200 && u2.json?.changed === true && (await controls.isHostFrozen(H)) === false && (await audits("room_host.unfreeze", H)).length === 1, JSON.stringify(u2.json));
  check("unfreezing does not release the held payout", (await q(`select release_at > '9000-01-01' as held from room_payouts where room_id = $1`, [ended]))[0].held === true);
  const u3 = await call("POST", `/api/admin/rooms/hosts/${H}/unfreeze`, SA, { reason: "cleared again" });
  check("unfreezing an unfrozen host is 200 changed:false with no audit row", u3.status === 200 && u3.json?.changed === false && (await audits("room_host.unfreeze", H)).length === 1);
  check("unfreeze needs a reason too", (await call("POST", `/api/admin/rooms/hosts/${H}/unfreeze`, SA, {})).json?.code === "REASON_REQUIRED");

  // ---- freeze that also ends the live rooms
  const H2 = await mk("host2");
  const liveA = await mkRoom(H2, "live"), liveB = await mkRoom(H2, "live");
  const f3 = await call("POST", `/api/admin/rooms/hosts/${H2}/freeze`, SA, { reason: "illegal activity suspected", endLiveRooms: true });
  check("freeze with endLiveRooms ends every live room of the host", f3.status === 200 && f3.json?.endedRooms === 2 && (await q(`select status from rooms where id = any($1)`, [[liveA, liveB]])).every((r: any) => r.status === "ended"), JSON.stringify(f3.json));
  check("each ended room has its own admin audit row", (await audits("room.ended_by_admin", liveA)).length === 1 && (await audits("room.ended_by_admin", liveB)).length === 1);
} finally {
  await q(`delete from room_payouts where host_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from room_host_freezes where host_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from room_controls`).catch(() => {});
  await q(`delete from rooms where id = any($1)`, [madeRooms]).catch((e) => console.log(`(cleanup rooms failed: ${e.message})`));
  await q(`delete from users where id = any($1)`, [madeUsers]).catch((e) => console.log(`(cleanup users failed: ${e.message})`));
  server.close(); await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
