// Room money controls (admin freeze switches and host freezes), throwaway database:   npm run test:rooms
// Refuses to run unless the database name contains "test", because it creates users.
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
for (const k of ["ROOMS_PAID", "ROOMS_SPRAY"]) delete process.env[k];
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

await import("../server/storage"); // boots ensureSchema
const { roomFeatures } = await import("../server/rooms/features");
const c = await import("../server/rooms/roomControls");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now().toString(36);
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,'1990-01-01', now() - interval '60 days') returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash]))[0].id as string;
const admin = await mk("ctladmin");
const host = await mk("ctlhost");

try {
  check("sprays_paused is off on a fresh database", (await c.getControl("sprays_paused")) === false);
  const on = await c.setControl({ key: "sprays_paused", on: true, adminId: admin, reason: "test pause" });
  check("setControl on: changed", on.changed === true);
  check("sprays_paused reads true right after the write (this process's cache is cleared)", (await c.getControl("sprays_paused")) === true);
  check("setControl with the same value: changed false", (await c.setControl({ key: "sprays_paused", on: true, adminId: admin, reason: "again" })).changed === false);
  check("tickets_paused is independent", (await c.getControl("tickets_paused")) === false);
  await c.setControl({ key: "sprays_paused", on: false, adminId: admin, reason: "resume" });
  check("setControl off: reads false", (await c.getControl("sprays_paused")) === false);

  roomFeatures.spray = false;
  await c.setControl({ key: "sprays_paused", on: false, adminId: admin, reason: "x" });
  check("sprayAllowed is false when the env flag is off, whatever the control", (await c.sprayAllowed()) === false);
  roomFeatures.spray = true;
  check("sprayAllowed is true with the flag on and no pause", (await c.sprayAllowed()) === true);
  await c.setControl({ key: "sprays_paused", on: true, adminId: admin, reason: "pause" });
  check("sprayAllowed is false while paused", (await c.sprayAllowed()) === false);
  roomFeatures.paidRooms = true;
  check("ticketSalesAllowed is true with paidRooms on and no pause", (await c.ticketSalesAllowed()) === true);
  await c.setControl({ key: "tickets_paused", on: true, adminId: admin, reason: "pause" });
  check("ticketSalesAllowed is false while paused", (await c.ticketSalesAllowed()) === false);

  check("host is not frozen at first", (await c.isHostFrozen(host)) === false);
  check("freezeHost: changed", (await c.freezeHost({ hostId: host, adminId: admin, reason: "suspected misconduct" })).changed === true);
  check("freezeHost twice: changed false", (await c.freezeHost({ hostId: host, adminId: admin, reason: "again" })).changed === false);
  check("isHostFrozen is true", (await c.isHostFrozen(host)) === true);
  const list = await c.listFrozenHosts();
  check("listFrozenHosts shows the username and reason", list.some((r) => r.hostId === host && r.username === `ctlhost${stamp}` && r.reason === "suspected misconduct" && r.adminId === admin), JSON.stringify(list));
  check("unfreezeHost: changed", (await c.unfreezeHost({ hostId: host, adminId: admin })).changed === true);
  check("unfreezeHost twice: changed false", (await c.unfreezeHost({ hostId: host, adminId: admin })).changed === false);
  check("isHostFrozen is false again", (await c.isHostFrozen(host)) === false);
} finally {
  await q(`delete from room_host_freezes where host_id = $1`, [host]).catch(() => {});
  await q(`delete from room_controls`).catch(() => {});
  await q(`delete from users where id = any($1)`, [[admin, host]]).catch((e) => console.log(`(cleanup failed: ${e.message})`));
  await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
