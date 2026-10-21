// Stored rates and the change log (rooms rates plan, task 2). Throwaway database:   npm run test:rooms
// Refuses to run unless the database name contains "test", because it creates users.
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

await import("../server/storage"); // boots ensureSchema
const { DEFAULT_RATES } = await import("../shared/money");
const r = await import("../server/rooms/roomRates");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now().toString(36);
const admins: string[] = [];
const mkAdmin = async (n: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,'super_admin') returning id`, [`rt_${n}${stamp}@t.dev`, `rt_${n}${stamp}`, hash, `rt ${n}`]))[0].id as string;
  admins.push(id); return id;
};

try {
  await q(`delete from room_rates`); await q(`delete from room_rate_changes`);
  const A = await mkAdmin("a"), B = await mkAdmin("b");
  check("a fresh database returns the defaults", JSON.stringify(await r.getRates()) === JSON.stringify(DEFAULT_RATES), JSON.stringify(await r.getRates()));
  const s1 = await r.setRate({ key: "ticket_platform", value: 12, adminId: A, reason: "launch promotion" });
  check("setRate: changed, before 15, after 12", s1.changed === true && s1.before === 15 && s1.after === 12, JSON.stringify(s1));
  check("getRates shows the new value at once (this process's cache is cleared)", (await r.getRates()).ticket_platform === 12);
  check("the other rates are untouched", (await r.getRates()).spray_platform_note === 30 && (await r.getRates()).ticket_reserve === 1);
  const s2 = await r.setRate({ key: "ticket_platform", value: 12, adminId: A, reason: "again again" });
  check("saving the same value again is changed:false and adds no log row", s2.changed === false && (await q(`select 1 from room_rate_changes`)).length === 1, JSON.stringify(s2));
  let threw = 0;
  for (const bad of [-1, 50.01, 1.234, NaN, "12" as any]) { try { await r.setRate({ key: "ticket_platform", value: bad, adminId: A, reason: "bad value" }); } catch { threw++; } }
  try { await r.setRate({ key: "nope" as any, value: 5, adminId: A, reason: "bad key" }); } catch { threw++; }
  check("out-of-range, junk and unknown-key values throw and save nothing", threw === 6 && (await r.getRates()).ticket_platform === 12 && (await q(`select 1 from room_rate_changes`)).length === 1, String(threw));
  await r.setRate({ key: "spray_reserve", value: 3.25, adminId: B, reason: "tighter reserve" });
  check("decimals up to two places are kept exactly", (await r.getRates()).spray_reserve === 3.25);
  const log = await r.listRateChanges();
  check("the change log is newest first with key, before, after, reason and admin", log.length === 2 && log[0].key === "spray_reserve" && log[0].before === 2.5 && log[0].after === 3.25 && log[0].reason === "tighter reserve" && log[0].adminId === B
    && log[1].key === "ticket_platform" && log[1].before === 15 && log[1].after === 12 && typeof log[0].at === "string", JSON.stringify(log));
  check("the history carries the admin's display name (or a safe fallback), never just an id", log[0].adminName === "rt b" && log[1].adminName === "rt a", JSON.stringify(log.map((l) => l.adminName)));
  await q(`insert into room_rate_changes (key, before_value, after_value, reason, admin_id) values ('ticket_platform', 12, 13, 'orphan row', 'no-such-admin')`);
  check("a change by an admin that no longer exists shows as 'Unknown admin'", (await r.listRateChanges(5)).some((l) => l.reason === "orphan row" && l.adminName === "Unknown admin"));
  await q(`delete from room_rate_changes where reason = 'orphan row'`);
  check("listRateChanges honours the limit", (await r.listRateChanges(1)).length === 1);

  // two admins at once on the same key: both land in the log in order, the last committed value stands
  await Promise.all([
    r.setRate({ key: "spray_platform_bag", value: 18, adminId: A, reason: "race one" }),
    r.setRate({ key: "spray_platform_bag", value: 22, adminId: B, reason: "race two" }),
  ]);
  const raceLog = (await q(`select before_value::float8 as b, after_value::float8 as a from room_rate_changes where key = 'spray_platform_bag' order by created_at, id`));
  const final = (await r.getRates()).spray_platform_bag;
  check("concurrent saves on one key: two log rows that chain (second before = first after) and the final value is the last after",
    raceLog.length === 2 && raceLog[0].b === 20 && raceLog[1].b === raceLog[0].a && final === raceLog[1].a && [18, 22].includes(final), JSON.stringify([raceLog, final]));
  const cleared = await q(`select count(*)::int as n from room_rates`);
  check("stored rows exist only for changed keys", cleared[0].n === 3, JSON.stringify(cleared));
} finally {
  await q(`delete from room_rates`).catch(() => {});
  await q(`delete from room_rate_changes`).catch(() => {});
  await q(`delete from admin_users where id = any($1)`, [admins]).catch(() => {});
  await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
