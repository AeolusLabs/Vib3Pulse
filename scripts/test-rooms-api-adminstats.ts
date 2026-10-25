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
const stats = await import("../server/rooms/adminStats");

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

// A ticket row as the issuing code writes it (500,000 kobo price, stored split that adds up). daysAgo moves created_at (and refunded_at).
const TICKET = { amount: 500000, vat: 34884, fee: 17500, reserve: 5000, platform: 66392, host: 376224 };
const ticket = async (roomId: string, userId: string, status: "paid" | "refunded", daysAgo: number, refundReason: string | null = null) => {
  await q(`insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, created_at, refund_reason, refunded_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,$10, now() - ($11::int * interval '1 day'), $12, case when $10 = 'refunded' then now() - ($11::int * interval '1 day') end)`,
    [roomId, userId, TICKET.amount, TICKET.vat, TICKET.fee, TICKET.reserve, TICKET.platform, TICKET.host, `vib3rt_as${stamp}${++seq}`, status, daysAgo, refundReason]);
};

try {
  const SA = await mkAdmin("super_admin"), FIN = await mkAdmin("finance_manager"), MOD = await mkAdmin("content_moderator"), SUP = await mkAdmin("user_support");
  const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const range = `from=${day(30)}&to=${day(0)}`;
  // Other suites share this database, so everything below is a before/after difference or looks up its own ids.
  const before = (await get(`/api/admin/rooms/sprays?${range}`, FIN)).json;
  const ovBefore = (await get(`/api/admin/rooms/overview?${range}`, FIN)).json;
  const tkBefore = (await get(`/api/admin/rooms/tickets?${range}`, FIN)).json;
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
  await spray(live, H, P1, "note", 50000, "delivered", 35); // previous period (before day(30))
  await spray(live, H, P2, "note", 70000, "reversed", 0);
  await spray(live, H, P1, "note", 50000, "pending", 0);

  // tickets: 4 paid in range (2 in the live room today, 1 in the ended room 2 days ago, 1 in the frozen host's live room today),
  // 1 refunded and 1 auto-refused charge today (excluded everywhere), 1 paid 35 days ago (previous period)
  const [B1, B2, B3, B4] = [await mk("b1"), await mk("b2"), await mk("b3"), await mk("b4")];
  await ticket(live, B1, "paid", 0); await ticket(live, B2, "paid", 0); await ticket(ended, B1, "paid", 2); await ticket(live2, B4, "paid", 0);
  await ticket(live, B3, "refunded", 0);
  await ticket(live, B4, "refunded", 0, "auto_sold_out");
  await ticket(ended, B2, "paid", 35);

  // ---- ticket sales
  const tk = await get(`/api/admin/rooms/tickets?${range}`, FIN);
  const tt = tk.json?.totals;
  const td = (k: string) => (tt?.[k] ?? 0) - (tkBefore.totals[k] ?? 0);
  check("tickets: totals count only paid tickets in the range", tk.status === 200 && td("count") === 4 && td("grossKobo") === 4 * TICKET.amount, JSON.stringify(tk.json));
  check("tickets: vat, fee, reserve, platform and host sums come from the stored rows", td("vatKobo") === 4 * TICKET.vat && td("feeKobo") === 4 * TICKET.fee && td("reserveKobo") === 4 * TICKET.reserve
    && td("platformKobo") === 4 * TICKET.platform && td("hostKobo") === 4 * TICKET.host, JSON.stringify(tt));
  check("tickets: the parts add up to the gross", td("vatKobo") + td("feeKobo") + td("reserveKobo") + td("platformKobo") + td("hostKobo") === td("grossKobo"));
  check("tickets: one refunded ticket counted, the auto-refused charge is nowhere", td("refundedCount") === 1 && td("refundedKobo") === TICKET.amount, JSON.stringify(tt));
  check("tickets: uniqueBuyers counts distinct paying people (B1, B2, B4)", tk.json?.uniqueBuyers - tkBefore.uniqueBuyers === 3, JSON.stringify([tkBefore.uniqueBuyers, tk.json?.uniqueBuyers]));
  const tp = tk.json?.previous, tpb = tkBefore.previous;
  check("tickets: previous is the same-length window before the range (count, gross, buyers, refunded)", tp && tp.count - tpb.count === 1 && tp.grossKobo - tpb.grossKobo === TICKET.amount && tp.uniqueBuyers - tpb.uniqueBuyers === 1 && typeof tp.refundedKobo === "number", JSON.stringify([tpb, tp]));
  const tday = (j: any, k: string) => (j.byDay ?? []).find((x: any) => x.day === k) ?? { count: 0, grossKobo: 0 };
  check("tickets: byDay buckets by UTC day", tday(tk.json, day(0)).count - tday(tkBefore, day(0)).count === 3 && tday(tk.json, day(2)).count - tday(tkBefore, day(2)).count === 1
    && tday(tk.json, day(0)).grossKobo - tday(tkBefore, day(0)).grossKobo === 3 * TICKET.amount, JSON.stringify(tk.json?.byDay));
  const ticketRoom = (tk.json?.topRooms ?? []).find((r: any) => r.roomId === live);
  check("tickets: topRooms lists the room with its title and ticket total", ticketRoom?.title === "as live room" && ticketRoom.count === 2 && ticketRoom.grossKobo === 2 * TICKET.amount, JSON.stringify(tk.json?.topRooms));
  const th1 = (tk.json?.topHosts ?? []).find((h: any) => h.hostId === H), th2 = (tk.json?.topHosts ?? []).find((h: any) => h.hostId === H2);
  check("tickets: topHosts lists both hosts with usernames and totals, ordered by gross", th1?.count === 3 && th1.grossKobo === 3 * TICKET.amount && th1.username.startsWith("as_host") && th2?.count === 1
    && (tk.json.topHosts as any[]).every((h, i, a) => i === 0 || a[i - 1].grossKobo >= h.grossKobo), JSON.stringify(tk.json?.topHosts));
  const tkEmpty = await get(`/api/admin/rooms/tickets?from=2020-01-01&to=2020-01-31`, FIN);
  const refundOnly = await get(`/api/admin/rooms/tickets?${range}`, FIN);
  check("tickets: refunded tickets never count as sales (the refunded one adds no gross, count or buyer)", td("count") === 4 && refundOnly.json.uniqueBuyers - tkBefore.uniqueBuyers === 3);
  check("tickets: an empty range is zeros and empty lists", tkEmpty.status === 200 && tkEmpty.json.totals.count === 0 && tkEmpty.json.totals.refundedCount === 0 && tkEmpty.json.uniqueBuyers === 0 && tkEmpty.json.byDay.length === 0 && tkEmpty.json.topHosts.length === 0, JSON.stringify(tkEmpty.json));
  check("tickets: an inverted range and a junk date are 400 BAD_RANGE", (await get(`/api/admin/rooms/tickets?from=${day(0)}&to=${day(5)}`, FIN)).json?.code === "BAD_RANGE" && (await get(`/api/admin/rooms/tickets?from=nope`, FIN)).json?.code === "BAD_RANGE");
  check("tickets: a range over 366 days is 400 BAD_RANGE", (await get(`/api/admin/rooms/tickets?from=2020-01-01&to=2021-06-01`, FIN)).status === 400);
  check("tickets: super_admin allowed, content_moderator and user_support 403, signed out 401", (await get(`/api/admin/rooms/tickets?${range}`, SA)).status === 200 && (await get(`/api/admin/rooms/tickets?${range}`, MOD)).status === 403
    && (await get(`/api/admin/rooms/tickets?${range}`, SUP)).status === 403 && (await get(`/api/admin/rooms/tickets?${range}`, null)).status === 401);

  // ---- live rooms
  const lv = await get("/api/admin/rooms/live", MOD);
  const rows: any[] = lv.json?.rooms ?? [];
  check("live rooms: a moderator sees the two live rooms and no scheduled or ended one", lv.status === 200 && rows.some((r) => r.id === live) && rows.some((r) => r.id === live2) && !rows.some((r) => r.id === ended), JSON.stringify(lv.json));
  const lrow = rows.find((r) => r.id === live);
  check("live rooms: title, host username, age limit, member count, ticketed and hostFrozen are present", lrow?.title === "as live room" && lrow.hostUsername.startsWith("as_host") && lrow.ageLimit === "18+" && typeof lrow.members === "number" && lrow.ticketed === true && lrow.hostFrozen === false, JSON.stringify(lrow));
  check("live rooms: a frozen host's room is flagged", rows.find((r) => r.id === live2)?.hostFrozen === true);
  check("live rooms: super_admin and finance_manager allowed, user_support 403, signed out 401", (await get("/api/admin/rooms/live", SA)).status === 200 && (await get("/api/admin/rooms/live", FIN)).status === 200 && (await get("/api/admin/rooms/live", SUP)).status === 403 && (await get("/api/admin/rooms/live", null)).status === 401);

  // ---- spray breakdown
  const sp = await get(`/api/admin/rooms/sprays?${range}`, FIN);
  const t = sp.json?.totals;
  const sum = (k: "vat" | "fee" | "reserve" | "platform" | "host") => s1[k] + s2[k] + s3[k];
  const d = (k: string) => (t?.[k] ?? 0) - (before.totals[k] ?? 0);
  check("sprays: totals count only delivered rows", sp.status === 200 && d("count") === 3 && d("grossKobo") === 200000, JSON.stringify(sp.json));
  check("sprays: vat, fee, reserve, platform and host sums come from the stored rows", d("vatKobo") === sum("vat") && d("feeKobo") === sum("fee") && d("reserveKobo") === sum("reserve") && d("platformKobo") === sum("platform") && d("hostKobo") === sum("host"), JSON.stringify(t));
  check("sprays: refundedKobo is the reversed amount", d("refundedKobo") === 70000, JSON.stringify(t));
  check("sprays: guestKobo is a number (stage guests' share), part of the split", typeof t?.guestKobo === "number" && d("guestKobo") === 0, JSON.stringify(t));
  check("sprays: uniquePayers counts distinct paying people in the range", sp.json?.uniquePayers - before.uniquePayers === 2, JSON.stringify([before.uniquePayers, sp.json?.uniquePayers]));
  const pv = sp.json?.previous, pvb = before.previous;
  check("sprays: previous is the same-length window just before the range (count, gross, payers, refunded)", pv && pv.count - pvb.count === 1 && pv.grossKobo - pvb.grossKobo === 50000 && pv.uniquePayers - pvb.uniquePayers === 1 && typeof pv.refundedKobo === "number", JSON.stringify([pvb, pv]));
  const tierOf = (j: any, k: string) => (j.byTier ?? []).find((x: any) => x.tier === k) ?? { count: 0, grossKobo: 0 };
  check("sprays: byTier splits note and bundle and sums to the total", tierOf(sp.json, "note").count - tierOf(before, "note").count === 2 && tierOf(sp.json, "note").grossKobo - tierOf(before, "note").grossKobo === 100000
    && tierOf(sp.json, "bundle").count - tierOf(before, "bundle").count === 1 && tierOf(sp.json, "bundle").grossKobo - tierOf(before, "bundle").grossKobo === 100000, JSON.stringify(sp.json?.byTier));
  const dayOf = (j: any, k: string) => (j.byDay ?? []).find((x: any) => x.day === k)?.grossKobo ?? 0;
  check("sprays: byDay has today and two days ago (UTC) and sums to the total", dayOf(sp.json, day(0)) - dayOf(before, day(0)) === 150000 && dayOf(sp.json, day(2)) - dayOf(before, day(2)) === 50000
    && (sp.json.byDay as any[]).reduce((a, x) => a + x.grossKobo, 0) - (before.byDay as any[]).reduce((a, x) => a + x.grossKobo, 0) === 200000, JSON.stringify(sp.json?.byDay));
  const tr = (sp.json?.topRooms ?? []).find((r: any) => r.roomId === live);
  check("sprays: topRooms lists the room with its title and total", tr?.title === "as live room" && tr.grossKobo === 150000 && tr.count === 2, JSON.stringify(sp.json?.topRooms));
  const th = (sp.json?.topHosts ?? []).find((h: any) => h.hostId === H);
  check("sprays: topHosts lists the host with the username and total, and the list is ordered by gross", th?.grossKobo === 200000 && th.count === 3 && th.username.startsWith("as_host")
    && (sp.json.topHosts as any[]).every((h, i, a) => i === 0 || a[i - 1].grossKobo >= h.grossKobo), JSON.stringify(sp.json?.topHosts));
  check("sprays: finance_manager and super_admin allowed, content_moderator 403", (await get(`/api/admin/rooms/sprays?${range}`, SA)).status === 200 && (await get(`/api/admin/rooms/sprays?${range}`, MOD)).status === 403);
  const emptyOld = await get(`/api/admin/rooms/sprays?from=2020-01-01&to=2020-01-31`, FIN);
  check("sprays: an empty range returns zeros and empty lists, not an error", emptyOld.status === 200 && emptyOld.json.totals.count === 0 && emptyOld.json.totals.grossKobo === 0 && emptyOld.json.byDay.length === 0 && emptyOld.json.topHosts.length === 0, JSON.stringify(emptyOld.json));
  check("sprays: an inverted range is 400 BAD_RANGE", (await get(`/api/admin/rooms/sprays?from=${day(0)}&to=${day(5)}`, FIN)).json?.code === "BAD_RANGE");
  const tooLong = await get(`/api/admin/rooms/sprays?from=2020-01-01&to=2021-06-01`, FIN);
  check("sprays: a range over 366 days is 400 BAD_RANGE", tooLong.status === 400 && tooLong.json?.code === "BAD_RANGE", JSON.stringify(tooLong.json));
  check("sprays: a junk date is 400 BAD_RANGE", (await get(`/api/admin/rooms/sprays?from=nope`, FIN)).json?.code === "BAD_RANGE");

  // ---- many dashboards at once must never starve the database pool (one Money tab load used to ask for about 30 connections)
  stats.resetAdminQueryPeak();
  const burst = await Promise.all(Array.from({ length: 4 }, () => [
    get(`/api/admin/rooms/sprays?${range}`, FIN), get(`/api/admin/rooms/overview?${range}`, FIN), get(`/api/admin/rooms/tickets?${range}`, FIN),
  ]).flat());
  check("a burst of 12 simultaneous dashboard requests all answer 200", burst.length === 12 && burst.every((r) => r.status === 200), JSON.stringify(burst.map((r) => r.status)));
  const peak = stats.adminQueryPeak();
  check("the statistics queries never held more than 4 database connections at once, whatever the burst", peak > 0 && peak <= 4, String(peak));

  // ---- overview
  const ov = await get(`/api/admin/rooms/overview?${range}`, FIN);
  check("overview: rooms created, started, unique hosts, peak and tickets sold", ov.status === 200 && ov.json.roomsCreated - ovBefore.roomsCreated === 4 && ov.json.roomsStarted - ovBefore.roomsStarted === 3 && ov.json.uniqueHosts - ovBefore.uniqueHosts === 2 && ov.json.peakConcurrent >= 12 && typeof ov.json.ticketsSold === "number", JSON.stringify([ovBefore, ov.json]));
  const ovEmpty = await get(`/api/admin/rooms/overview?from=2020-01-01&to=2020-01-31`, FIN);
  const odayOf = (j: any, k: string) => (j.byDay ?? []).find((x: any) => x.day === k) ?? { roomsStarted: 0, peakConcurrent: 0, ticketsSold: 0 };
  check("overview: byDay has rooms started per day and the day's peak attendance (UTC)", odayOf(ov.json, day(0)).roomsStarted - odayOf(ovBefore, day(0)).roomsStarted === 2 && odayOf(ov.json, day(2)).roomsStarted - odayOf(ovBefore, day(2)).roomsStarted === 1 && odayOf(ov.json, day(2)).peakConcurrent >= 12, JSON.stringify(ov.json.byDay));
  check("overview: previous has roomsStarted, uniqueHosts and ticketsSold for the window before", ov.json.previous && ["roomsStarted", "uniqueHosts", "ticketsSold"].every((k) => typeof ov.json.previous[k] === "number"), JSON.stringify(ov.json.previous));
  check("overview: an empty range is zeros (peak 0), never null or an error", ovEmpty.status === 200 && ovEmpty.json.roomsCreated === 0 && ovEmpty.json.peakConcurrent === 0 && ovEmpty.json.uniqueHosts === 0, JSON.stringify(ovEmpty.json));
  check("overview: a moderator is 403", (await get(`/api/admin/rooms/overview?${range}`, MOD)).status === 403);
} finally {
  await q(`delete from room_tickets where room_id = any($1)`, [madeRooms]).catch(() => {});
  await q(`delete from spray_payments where room_id = any($1)`, [madeRooms]).catch(() => {});
  await q(`delete from room_host_freezes where host_id = any($1)`, [madeUsers]).catch(() => {});
  await q(`delete from rooms where id = any($1)`, [madeRooms]).catch((e) => console.log(`(cleanup rooms failed: ${e.message})`));
  await q(`delete from users where id = any($1)`, [madeUsers]).catch((e) => console.log(`(cleanup users failed: ${e.message})`));
  await q(`delete from admin_users where id = any($1)`, [madeAdmins]).catch(() => {});
  server.close(); await pool.end();
}
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
