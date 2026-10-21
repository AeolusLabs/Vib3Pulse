// Rooms admin read endpoints (rooms admin plan, task 4): live rooms, usage overview, spray breakdown, role gates.
// Throwaway database:   npm run test:rooms
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix as_.
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
const get = async (path: string, as: string | null) => {
  const res = await fetch(base + path, { headers: as ? { "x-test-admin": as } : {} });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const madeUsers: string[] = [], madeRooms: string[] = [], madeAdmins: string[] = [];
let seq = 0;
const mk = async (name: string) => {
  const id = (await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
    values ($1,$2,'social',$3,true,true,'1990-01-01', now() - interval '60 days') returning id`, [`as_${name}${stamp}${++seq}@t.dev`, `as_${name}${stamp}${seq}`, hash]))[0].id as string;
  madeUsers.push(id); return id;
};
const mkAdmin = async (role: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`,
    [`as_admin_${role}${stamp}@t.dev`, `as_admin_${role}${stamp}`, hash, `as ${role}`, role]))[0].id as string;
  madeAdmins.push(id); return id;
};
const mkRoom = async (host: string, title: string, o: { status: string; startedDaysAgo?: number; peak?: number | null; age?: string; price?: number | null }) => {
  const id = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, started_at, ended_at, peak_members, ticket_price_kobo, ticket_capacity, created_at)
    values ($1,$2,'party','public',$3,$4,
      case when $5::int is null then null else now() - ($5::int * interval '1 day') end,
      case when $4 = 'ended' then now() - ($5::int * interval '1 day') + interval '1 hour' else null end,
      $6, $7::int, case when $7::int is null then null else 50 end,
      now() - (coalesce($5::int, 0) * interval '1 day'))
    returning id`, [host, title, o.age ?? "18+", o.status, o.startedDaysAgo ?? null, o.peak ?? null, o.price ?? null]))[0].id as string;
  madeRooms.push(id); return id;
};
const spray = async (roomId: string, hostId: string, payerId: string, tier: string, amount: number, status: string, daysAgo: number) => {
  const vat = Math.floor(amount * 0.07), fee = Math.floor(amount * 0.015), reserve = Math.floor(amount * 0.025), platform = Math.floor(amount * 0.2);
  const host = amount - vat - fee - reserve - platform;
  await q(`insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, delivered_at, reversed_at, created_at)
    values ($1,$2,$3,$4,$5,$4,$6,$7::bigint,$7::int,$8,$9,$10,$11,$12,'paystack',$13,$14,
      case when $14 = 'delivered' then now() - ($15::int * interval '1 day') end,
      case when $14 = 'reversed' then now() - ($15::int * interval '1 day') end,
      now() - ($15::int * interval '1 day'))`,
    [`as-${stamp}-${++seq}`, `h${seq}`, roomId, hostId, payerId, tier, amount, vat, fee, reserve, platform, host, `vib3rs_as${stamp}${seq}`, status, daysAgo]);
  return { vat, fee, reserve, platform, host };
};

try {
  const SA = await mkAdmin("super_admin"), FIN = await mkAdmin("finance_manager"), MOD = await mkAdmin("content_moderator"), SUP = await mkAdmin("user_support");
  const H = await mk("host"), H2 = await mk("host2"), P1 = await mk("p1"), P2 = await mk("p2");
  const live = await mkRoom(H, "as live room", { status: "live", startedDaysAgo: 0, peak: 7, price: 500000 });
  const ended = await mkRoom(H, "as ended room", { status: "ended", startedDaysAgo: 2, peak: 12 });
  await mkRoom(H2, "as scheduled room", { status: "scheduled" });
  await controls.freezeHost({ hostId: H2, adminId: SA, reason: "test" });
  const live2 = await mkRoom(H2, "as frozen host live", { status: "live", startedDaysAgo: 0, peak: 3 });

  // sprays: 3 delivered (note 500 and bundle 1,000 today; note 500 two days ago in the ended room), 1 reversed, 1 pending (ignored)
  const s1 = await spray(live, H, P1, "note", 50000, "delivered", 0);
  const s2 = await spray(live, H, P2, "bundle", 100000, "delivered", 0);
  const s3 = await spray(ended, H, P1, "note", 50000, "delivered", 2);
  await spray(live, H, P2, "note", 70000, "reversed", 0);
  await spray(live, H, P1, "note", 50000, "pending", 0);

  // ---- live rooms
  const lv = await get("/api/admin/rooms/live", MOD);
  const rows: any[] = lv.json?.rooms ?? [];
  check("live rooms: a moderator sees the two live rooms and no scheduled or ended one", lv.status === 200 && rows.some((r) => r.id === live) && rows.some((r) => r.id === live2) && !rows.some((r) => r.id === ended), JSON.stringify(lv.json));
  const lrow = rows.find((r) => r.id === live);
  check("live rooms: title, host username, age limit, member count, ticketed and hostFrozen are present", lrow?.title === "as live room" && lrow.hostUsername.startsWith("as_host") && lrow.ageLimit === "18+" && typeof lrow.members === "number" && lrow.ticketed === true && lrow.hostFrozen === false, JSON.stringify(lrow));
  check("live rooms: a frozen host's room is flagged", rows.find((r) => r.id === live2)?.hostFrozen === true);
  check("live rooms: super_admin allowed, finance_manager 403, user_support 403, signed out 401", (await get("/api/admin/rooms/live", SA)).status === 200 && (await get("/api/admin/rooms/live", FIN)).status === 403 && (await get("/api/admin/rooms/live", SUP)).status === 403 && (await get("/api/admin/rooms/live", null)).status === 401);

  // ---- spray breakdown
  const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const range = `from=${day(30)}&to=${day(0)}`;
  const sp = await get(`/api/admin/rooms/sprays?${range}`, FIN);
  const t = sp.json?.totals;
  const sum = (k: "vat" | "fee" | "reserve" | "platform" | "host") => s1[k] + s2[k] + s3[k];
  check("sprays: totals count only delivered rows", sp.status === 200 && t?.count === 3 && t.grossKobo === 200000, JSON.stringify(sp.json));
  check("sprays: vat, fee, reserve, platform and host sums come from the stored rows", t?.vatKobo === sum("vat") && t.feeKobo === sum("fee") && t.reserveKobo === sum("reserve") && t.platformKobo === sum("platform") && t.hostKobo === sum("host"), JSON.stringify(t));
  check("sprays: refundedKobo is the reversed amount", t?.refundedKobo === 70000, JSON.stringify(t));
  const byTier = Object.fromEntries((sp.json?.byTier ?? []).map((x: any) => [x.tier, x]));
  check("sprays: byTier splits note and bundle and sums to the total", byTier.note?.count === 2 && byTier.note.grossKobo === 100000 && byTier.bundle?.count === 1 && byTier.bundle.grossKobo === 100000, JSON.stringify(sp.json?.byTier));
  const byDay: any[] = sp.json?.byDay ?? [];
  check("sprays: byDay has today and two days ago (UTC) and sums to the total", byDay.find((d) => d.day === day(0))?.grossKobo === 150000 && byDay.find((d) => d.day === day(2))?.grossKobo === 50000 && byDay.reduce((a, d) => a + d.grossKobo, 0) === 200000, JSON.stringify(byDay));
  check("sprays: topRooms ordered by gross with the title", sp.json?.topRooms?.[0]?.roomId === live && sp.json.topRooms[0].title === "as live room" && sp.json.topRooms[0].grossKobo === 150000, JSON.stringify(sp.json?.topRooms));
  check("sprays: topHosts has the host with the username and total", sp.json?.topHosts?.[0]?.hostId === H && sp.json.topHosts[0].grossKobo === 200000 && sp.json.topHosts[0].count === 3 && sp.json.topHosts[0].username.startsWith("as_host"), JSON.stringify(sp.json?.topHosts));
  check("sprays: finance_manager and super_admin allowed, content_moderator 403", (await get(`/api/admin/rooms/sprays?${range}`, SA)).status === 200 && (await get(`/api/admin/rooms/sprays?${range}`, MOD)).status === 403);
  const emptyOld = await get(`/api/admin/rooms/sprays?from=2020-01-01&to=2020-01-31`, FIN);
  check("sprays: an empty range returns zeros and empty lists, not an error", emptyOld.status === 200 && emptyOld.json.totals.count === 0 && emptyOld.json.totals.grossKobo === 0 && emptyOld.json.byDay.length === 0 && emptyOld.json.topHosts.length === 0, JSON.stringify(emptyOld.json));
  check("sprays: an inverted range is 400 BAD_RANGE", (await get(`/api/admin/rooms/sprays?from=${day(0)}&to=${day(5)}`, FIN)).json?.code === "BAD_RANGE");
  const tooLong = await get(`/api/admin/rooms/sprays?from=2020-01-01&to=2021-06-01`, FIN);
  check("sprays: a range over 366 days is 400 BAD_RANGE", tooLong.status === 400 && tooLong.json?.code === "BAD_RANGE", JSON.stringify(tooLong.json));
  check("sprays: a junk date is 400 BAD_RANGE", (await get(`/api/admin/rooms/sprays?from=nope`, FIN)).json?.code === "BAD_RANGE");

  // ---- overview
  const ov = await get(`/api/admin/rooms/overview?${range}`, FIN);
  check("overview: rooms created, started, unique hosts, peak and tickets sold", ov.status === 200 && ov.json?.roomsCreated >= 4 && ov.json.roomsStarted === 3 && ov.json.uniqueHosts === 2 && ov.json.peakConcurrent === 12 && typeof ov.json.ticketsSold === "number", JSON.stringify(ov.json));
  const ovEmpty = await get(`/api/admin/rooms/overview?from=2020-01-01&to=2020-01-31`, FIN);
  check("overview: an empty range is zeros (peak 0), never null or an error", ovEmpty.status === 200 && ovEmpty.json.roomsCreated === 0 && ovEmpty.json.peakConcurrent === 0 && ovEmpty.json.uniqueHosts === 0, JSON.stringify(ovEmpty.json));
  check("overview: a moderator is 403", (await get(`/api/admin/rooms/overview?${range}`, MOD)).status === 403);
} finally {
  await q(`delete from spray_payments where room_id = any($1)`, [madeRooms]).catch(() => {});
  await q(`delete from room_host_freezes where host_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from rooms where id = any($1)`, [madeRooms]).catch((e) => console.log(`(cleanup rooms failed: ${e.message})`));
  await q(`delete from users where id = any($1)`, [madeUsers]).catch((e) => console.log(`(cleanup users failed: ${e.message})`));
  await q(`delete from admin_users where id = any($1)`, [madeAdmins]).catch(() => {});
  server.close(); await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
