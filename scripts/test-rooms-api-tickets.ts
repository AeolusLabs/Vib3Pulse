// Paid rooms (phase 4) over REST against a scratch database:   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-tickets.ts
// Refuses to run unless the database name contains "test" (it creates users). Usernames use the prefix tk_.
// Tickets are inserted as SQL rows (the checkout lane is not in this tree). The paidRooms switch is flipped IN THIS PROCESS
// ONLY through the test seam (roomFeatures is "mutable only so tests can exercise the dormant code"); never in any env.
// The scratch DB can be remote (about 200 ms per query): nothing here waits on a fixed sleep.
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomFeatures } = await import("../server/rooms/features");
const { countPaidTickets, hasPaidTicket, hasVerifiedPayoutAccount } = await import("../server/rooms/ticketStorage");
const { ROOM_TICKETS_SCHEMA_SQL } = await import("../server/rooms/roomTicketsMigration");
const { ticketBreakdown } = await import("../shared/money");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.log(`(pool error ignored: ${e.message})`));
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) { const u = await storage.getUser(id); req.user = u ? userToSessionUser(u) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.41.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const created: string[] = [];
const mk = async (name: string, dob: string | null, verified: boolean) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', $5, $6) returning id`,
    [`tk_${name}${stamp}@t.dev`, `tk_${name}${stamp}`, hash, dob, verified ? new Date() : null, verified ? "admin" : null]))[0].id as string;
  created.push(id);
  return id;
};
const payout = (userId: string, enabled = true) => q(
  `insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack',$2,true,$3)`,
  [userId, `ACCT_tk_${userId.slice(0, 8)}`, enabled]);
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
let refSeq = 0;
/** A ticket row as the checkout lane would write it: amounts from ticketBreakdown of the stored price. */
const insertTicket = async (roomId: string, userId: string, priceKobo: number, status: "paid" | "refunded" = "paid") => {
  const b = ticketBreakdown(priceKobo);
  return (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, refunded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,$10, case when $10 = 'refunded' then now() else null end) returning id`,
    [roomId, userId, b.price, b.vat, b.fee, b.reserve, b.platform, b.host, `tk-ref-${stamp}-${++refSeq}`, status]))[0].id as string;
};
const pgCode = async (f: () => Promise<unknown>) => { try { await f(); return "ok"; } catch (e: any) { return e?.code ?? String(e); } };
const noPriceIn = (text: string, price: number) => !text.includes(String(price)) && !/ticketPriceKobo|ticketCapacity|refundBeforeStart|priceMinor|"ticket"/.test(text);

const PRICE = 500000; // 5,000 naira
const paid = { kind: "party", visibility: "public", ageLimit: "18+", ticketPriceKobo: PRICE, ticketCapacity: 20 };

try {
  roomFeatures.paidRooms = false;
  const H = await mk("host", yearsAgo(30), true); await payout(H);
  const HU = await mk("host_unverified", yearsAgo(30), false); await payout(HU);
  const HN = await mk("host_nopayout", yearsAgo(30), true);
  const HD = await mk("host_disabled", yearsAgo(30), true); await payout(HD, false);
  const E = await mk("eligible", yearsAgo(30), true);
  const U = await mk("unverified", yearsAgo(30), false);
  const T = await mk("teen", yearsAgo(16), true); // verified teen: still never a price
  const Y = await mk("nineteen", yearsAgo(19), true);
  const CO = await mk("cohost", yearsAgo(30), false);
  const MH = await mk("minors_host", yearsAgo(15), false);
  const MA = await mk("minors_adult", yearsAgo(30), true);
  const MT = await mk("minors_teen", yearsAgo(15), true);

  // ---- payout account lookup (real table)
  check("payout: verified Paystack row counts", await hasVerifiedPayoutAccount(H));
  check("payout: no row does not count", !(await hasVerifiedPayoutAccount(HN)));
  check("payout: payouts_enabled false does not count", !(await hasVerifiedPayoutAccount(HD)));

  // ---- flag OFF: no ticketed room can be made
  const offCreate = await rest("POST", "/api/rooms", H, { title: "tk off", ...paid });
  check("flag off: creating a ticketed room is refused 403 FEATURE_OFF", offCreate.status === 403 && offCreate.json?.code === "FEATURE_OFF", JSON.stringify(offCreate.json));
  check("flag off: no room was written", (await q(`select count(*)::int n from rooms where host_id = $1 and title = 'tk off'`, [H]))[0].n === 0);
  const offFree = await rest("POST", "/api/rooms", H, { title: "tk free while off", kind: "party", visibility: "public", ageLimit: "18+" });
  check("flag off: a free room is still created (201), host view says free", offFree.status === 201 && offFree.json.room.ticketPriceKobo === null && offFree.json.room.ticketCapacity === null && offFree.json.room.refundBeforeStart === true, JSON.stringify(offFree.json?.room));

  // ---- flag ON (this process only)
  roomFeatures.paidRooms = true;
  const bad = async (body: object) => rest("POST", "/api/rooms", H, { title: "tk bad", ...paid, ...body });
  let r = await bad({ ticketCapacity: undefined });
  check("validation: price without capacity 400 field ticketCapacity", r.status === 400 && r.json?.field === "ticketCapacity", JSON.stringify(r.json));
  r = await bad({ ticketCapacity: 151 });
  check("validation: capacity 151 refused 400", r.status === 400 && r.json?.field === "ticketCapacity", JSON.stringify(r.json));
  r = await bad({ ticketCapacity: 19 });
  check("validation: capacity 19 refused 400", r.status === 400 && r.json?.field === "ticketCapacity", JSON.stringify(r.json));
  r = await bad({ ticketPriceKobo: 99999 });
  check("validation: price below 1,000 naira refused 400", r.status === 400 && r.json?.field === "ticketPriceKobo", JSON.stringify(r.json));
  r = await bad({ ticketPriceKobo: 10000001 });
  check("validation: price above 100,000 naira refused 400", r.status === 400 && r.json?.field === "ticketPriceKobo", JSON.stringify(r.json));
  r = await bad({ ticketPriceKobo: "500000" });
  check("validation: price as a string refused 400", r.status === 400 && r.json?.field === "ticketPriceKobo", JSON.stringify(r.json));
  r = await bad({ ageLimit: "16+" });
  check("validation: a ticketed 16+ room refused 400 field ageLimit", r.status === 400 && r.json?.field === "ageLimit", JSON.stringify(r.json));
  r = await rest("POST", "/api/rooms", HU, { title: "tk hu", ...paid });
  check("host not ID-verified: 403 HOST_NOT_VERIFIED", r.status === 403 && r.json?.code === "HOST_NOT_VERIFIED", JSON.stringify(r.json));
  r = await rest("POST", "/api/rooms", HN, { title: "tk hn", ...paid });
  check("host without payout account: 403 NO_PAYOUT_ACCOUNT", r.status === 403 && r.json?.code === "NO_PAYOUT_ACCOUNT", JSON.stringify(r.json));
  r = await rest("POST", "/api/rooms", HD, { title: "tk hd", ...paid });
  check("host with payouts disabled: 403 NO_PAYOUT_ACCOUNT", r.status === 403 && r.json?.code === "NO_PAYOUT_ACCOUNT", JSON.stringify(r.json));
  r = await rest("POST", "/api/rooms", MH, { title: "tk teen host", ...paid, visibility: "friends" });
  check("teen host: a ticketed room is refused (403, never created)", r.status === 403, JSON.stringify(r.json));
  check("refused attempts wrote no room", (await q(`select count(*)::int n from rooms where title like 'tk h%' or title in ('tk bad', 'tk teen host')`))[0].n === 0);

  const cr = await rest("POST", "/api/rooms", H, { title: "tk paid", ...paid, refundBeforeStart: true, capacity: 30 });
  const R = cr.json?.room?.id as string;
  check("host creates a ticketed 18+ room: 201 with the host's ticket settings", cr.status === 201 && cr.json.room.ticketPriceKobo === PRICE && cr.json.room.ticketCapacity === 20 && cr.json.room.refundBeforeStart === true, JSON.stringify(cr.json?.room));
  const row = (await q(`select ticket_price_kobo, ticket_capacity, refund_before_start, capacity from rooms where id = $1`, [R]))[0];
  check("stored: price, ticket capacity, refund flag; free capacity column untouched", row?.ticket_price_kobo === PRICE && row.ticket_capacity === 20 && row.refund_before_start === true && row.capacity === 30, JSON.stringify(row));
  const cr21 = await rest("POST", "/api/rooms", H, { title: "tk paid 21", ...paid, ageLimit: "21+" });
  const R21 = cr21.json?.room?.id as string;
  check("host creates a ticketed 21+ room", cr21.status === 201, JSON.stringify(cr21.json));

  // ---- GET: the ticket block per viewer
  let g = await rest("GET", `/api/rooms/${R}`, H);
  check("host: ticket { required:false, priceKobo, held:false, soldOut:false }", g.status === 200 && JSON.stringify(g.json.ticket) === JSON.stringify({ required: false, priceKobo: PRICE, held: false, soldOut: false }), JSON.stringify(g.json?.ticket));
  check("host: the room object carries the ticket settings (hostRoom)", g.json?.room?.ticketPriceKobo === PRICE && g.json.room.ticketCapacity === 20, JSON.stringify(g.json?.room));
  g = await rest("GET", `/api/rooms/${R}`, E);
  check("eligible adult: ticket { required:true, priceKobo, held:false, soldOut:false }", g.status === 200 && JSON.stringify(g.json.ticket) === JSON.stringify({ required: true, priceKobo: PRICE, held: false, soldOut: false }), JSON.stringify(g.json?.ticket));
  check("eligible adult: the room object itself carries no ticket settings", !("ticketPriceKobo" in g.json.room) && !("ticketCapacity" in g.json.room) && !("refundBeforeStart" in g.json.room), JSON.stringify(g.json.room));
  g = await rest("GET", `/api/rooms/${R}`, U);
  check("unverified adult: 200, no ticket block, no price anywhere in the body", g.status === 200 && !("ticket" in g.json) && noPriceIn(g.text, PRICE), g.text.slice(0, 400));
  g = await rest("GET", `/api/rooms/${R}`, T);
  check("teen (even ID-verified): no ticket block, no price anywhere", g.status === 200 && !("ticket" in g.json) && noPriceIn(g.text, PRICE) && g.json.canJoin?.code === "AGE_LIMIT", g.text.slice(0, 400));
  g = await rest("GET", `/api/rooms/${R21}`, Y);
  check("verified 19-year-old on a 21+ room: no ticket block, no price", g.status === 200 && !("ticket" in g.json) && noPriceIn(g.text, PRICE), g.text.slice(0, 400));
  g = await rest("GET", `/api/rooms/${R21}`, E);
  check("eligible adult on the 21+ room: ticket block present", g.json?.ticket?.priceKobo === PRICE && g.json.ticket.required === true, JSON.stringify(g.json?.ticket));
  const freeId = offFree.json?.room?.id as string;
  g = await rest("GET", `/api/rooms/${freeId}`, E);
  check("eligible adult on a free 18+ room: ticket { required:false, priceKobo:0 }", JSON.stringify(g.json?.ticket) === JSON.stringify({ required: false, priceKobo: 0, held: false, soldOut: false }), JSON.stringify(g.json?.ticket));

  // co-host: needs no ticket
  await q(`insert into room_members (room_id, user_id, role) values ($1,$2,'cohost') on conflict (room_id, user_id) do update set role = 'cohost'`, [R, CO]);
  await q(`update users set age_verified_at = now(), age_verified_method = 'admin' where id = $1`, [CO]);
  g = await rest("GET", `/api/rooms/${R}`, CO);
  check("co-host (verified adult): ticket.required false", g.json?.ticket?.required === false && g.json.ticket.priceKobo === PRICE, JSON.stringify(g.json?.ticket));
  check("co-host: the room object carries no ticket settings (not the host)", !("ticketPriceKobo" in (g.json?.room ?? {})), JSON.stringify(g.json?.room));

  // ---- list: priceMinor only for eligible viewers
  const listFor = async (who: string) => (await rest("GET", "/api/rooms?scope=upcoming", who));
  let l = await listFor(E);
  let item = (l.json?.rooms ?? []).find((x: any) => x.id === R);
  check("list (eligible adult): priceMinor is the price; no other ticket keys", !!item && item.priceMinor === PRICE && !("ticketPriceKobo" in item) && !("ticketCapacity" in item), JSON.stringify(item));
  const freeItem = (l.json?.rooms ?? []).find((x: any) => x.id === freeId);
  check("list (eligible adult): a free room has no priceMinor key", !!freeItem && !("priceMinor" in freeItem), JSON.stringify(freeItem));
  for (const [who, label] of [[U, "unverified adult"], [T, "teen"]] as const) {
    l = await listFor(who);
    item = (l.json?.rooms ?? []).find((x: any) => x.id === R);
    check(`list (${label}): no priceMinor and no price anywhere for this room`, !item || (!("priceMinor" in item) && noPriceIn(JSON.stringify(item), PRICE)), JSON.stringify(item));
  }
  l = await listFor(Y);
  item = (l.json?.rooms ?? []).find((x: any) => x.id === R21);
  check("list (verified 19 on a 21+ room): no priceMinor", !item || !("priceMinor" in item), JSON.stringify(item));

  // ---- minors' room: the gate answers first; no price, ever
  await mutual(MH, MA); await mutual(MH, MT);
  const mr = await rest("POST", "/api/rooms", MH, { title: "tk minors", kind: "party", visibility: "friends", ageLimit: "all" });
  const MR = mr.json?.room?.id as string;
  check("setup: teen host's room is a minors' room", mr.status === 201 && mr.json.room.minorsRoom === true, JSON.stringify(mr.json?.room));
  // Worst case written straight to the row (the routes can never do this): a minors' room with a price.
  await q(`update rooms set ticket_price_kobo = $2, ticket_capacity = 20 where id = $1`, [MR, PRICE]);
  g = await rest("GET", `/api/rooms/${MR}`, MA);
  check("minors' room, adult friend without an invite: 403 minors body, exactly 4 keys, no ticket, no price",
    g.status === 403 && g.json?.code === "MINORS_ROOM" && Object.keys(g.json).sort().join(",") === "canJoin,code,message,warning" && noPriceIn(g.text, PRICE), g.text);
  g = await rest("GET", `/api/rooms/${MR}`, MT);
  check("minors' room, teen friend: 200, no ticket block, no price", g.status === 200 && !("ticket" in g.json) && noPriceIn(g.text, PRICE), g.text.slice(0, 400));
  l = await listFor(MA);
  check("list (adult friend): the minors' room is not listed at all", !(l.json?.rooms ?? []).some((x: any) => x.id === MR));
  l = await listFor(MT);
  item = (l.json?.rooms ?? []).find((x: any) => x.id === MR);
  check("list (teen friend): the minors' room has no priceMinor", !item || !("priceMinor" in item), JSON.stringify(item));
  await q(`update rooms set ticket_price_kobo = null, ticket_capacity = null where id = $1`, [MR]);

  // ---- tickets: storage helpers and DB constraints
  const t1 = await insertTicket(R, E, PRICE);
  check("helpers: E holds a paid ticket, count 1", (await hasPaidTicket(R, E)) && (await countPaidTickets(R)) === 1);
  g = await rest("GET", `/api/rooms/${R}`, E);
  check("eligible adult with a ticket: held true, still required (they need it to enter)", g.json?.ticket?.held === true && g.json.ticket.required === true, JSON.stringify(g.json?.ticket));
  check("DB: a second PAID ticket for the same room and person is refused (unique)", (await pgCode(() => insertTicket(R, E, PRICE))) === "23505");
  const dupRef = (await q(`select provider_ref from room_tickets where id = $1`, [t1]))[0].provider_ref;
  check("DB: a duplicate provider_ref is refused (unique)", (await pgCode(() => q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref) values ($1,$2,1,0,0,0,0,0,'paystack',$3)`, [R21, E, dupRef]))) === "23505");
  check("DB: status outside paid/refunded is refused (check)", (await pgCode(() => q(`update room_tickets set status = 'void' where id = $1`, [t1]))) === "23514");
  check("DB: ticket capacity 19 is refused (check)", (await pgCode(() => q(`update rooms set ticket_capacity = 19 where id = $1`, [R]))) === "23514");
  check("DB: a price without a capacity is refused (check)", (await pgCode(() => q(`update rooms set ticket_capacity = null where id = $1`, [R]))) === "23514");
  // refunded then bought again: allowed (the partial unique index covers paid rows only)
  const R2 = (await rest("POST", "/api/rooms", H, { title: "tk paid two", ...paid })).json?.room?.id as string;
  await insertTicket(R2, U, PRICE, "refunded");
  check("helpers: a refunded ticket is not a ticket (hasPaidTicket false, count 0)", !(await hasPaidTicket(R2, U)) && (await countPaidTickets(R2)) === 0);
  check("DB: a new paid ticket after a refund is allowed", (await pgCode(() => insertTicket(R2, U, PRICE))) === "ok");
  check("DB: room_payouts status check", (await pgCode(() => q(`insert into room_payouts (room_id, host_id, release_at, status) values ($1,$2, now(), 'sent')`, [R2, H]))) === "23514");
  await q(`insert into room_payouts (room_id, host_id, release_at) values ($1,$2, now() + interval '2 days')`, [R2, H]);
  check("DB: one payout row per room (unique room_id)", (await pgCode(() => q(`insert into room_payouts (room_id, host_id, release_at) values ($1,$2, now())`, [R2, H]))) === "23505");
  const pr = (await q(`select status, attempts, amount_kobo from room_payouts where room_id = $1`, [R2]))[0];
  check("DB: payout defaults held / 0 attempts / 0 kobo", pr?.status === "held" && pr.attempts === 0 && pr.amount_kobo === 0, JSON.stringify(pr));
  await q(`delete from room_payouts where room_id = $1`, [R2]); // payouts do not cascade: clear before cleanup

  // ---- PATCH after a sale
  const pricePatch = await rest("PATCH", `/api/rooms/${R}`, H, { ticketPriceKobo: 600000 });
  check("PATCH price after a ticket was sold: 409 TICKETS_SOLD", pricePatch.status === 409 && pricePatch.json?.code === "TICKETS_SOLD", JSON.stringify(pricePatch.json));
  check("price unchanged in the DB", (await q(`select ticket_price_kobo p from rooms where id = $1`, [R]))[0].p === PRICE);
  r = await rest("PATCH", `/api/rooms/${R}`, H, { ticketPriceKobo: null, ticketCapacity: null });
  check("PATCH to free after a sale: 409 TICKETS_SOLD", r.status === 409 && r.json?.code === "TICKETS_SOLD", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, H, { ageLimit: "21+" });
  check("PATCH age limit of a ticketed room after a sale: 409 TICKETS_SOLD", r.status === 409 && r.json?.code === "TICKETS_SOLD", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, H, { refundBeforeStart: false });
  check("PATCH taking back the refund promise after a sale: 409 TICKETS_SOLD", r.status === 409 && r.json?.code === "TICKETS_SOLD", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, H, { ticketPriceKobo: PRICE, title: "tk paid renamed" });
  check("PATCH with the same price plus a title: 200 (no change to the sale)", r.status === 200 && r.json.room.title === "tk paid renamed" && r.json.room.ticketPriceKobo === PRICE, JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, H, { ageLimit: "all" });
  check("PATCH a ticketed room to all ages: 400 field ageLimit", r.status === 400 && r.json?.field === "ageLimit", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, CO, { ticketPriceKobo: 100000 });
  check("co-host cannot change the price (403)", r.status === 403, JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${R}`, CO, { pinnedMessage: "Welcome" });
  check("co-host pinned-message PATCH: 200 and the reply has no ticket settings", r.status === 200 && !("ticketPriceKobo" in r.json.room) && noPriceIn(JSON.stringify(r.json.room), PRICE), JSON.stringify(r.json));

  // capacity: never below the tickets sold
  const RC = (await rest("POST", "/api/rooms", H, { title: "tk cap", ...paid, ticketCapacity: 25 })).json?.room?.id as string;
  const buyers = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at)
     select 'tk_b' || g || '_' || $1 || '@t.dev', 'tk_b' || g || '_' || $1, 'social', $2, true, true, $3, now() - interval '60 days', now()
     from generate_series(1, 21) g returning id`, [stamp, hash, yearsAgo(30)])).map((x: any) => x.id as string);
  created.push(...buyers);
  for (const b of buyers) await insertTicket(RC, b, PRICE);
  r = await rest("PATCH", `/api/rooms/${RC}`, H, { ticketCapacity: 20 });
  check("PATCH capacity 20 with 21 sold: 409 CAPACITY_BELOW_SOLD", r.status === 409 && r.json?.code === "CAPACITY_BELOW_SOLD", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${RC}`, H, { ticketCapacity: 151 });
  check("PATCH capacity 151: 400", r.status === 400 && r.json?.field === "ticketCapacity", JSON.stringify(r.json));
  g = await rest("GET", `/api/rooms/${RC}`, E);
  check("not sold out at 21 of 25", g.json?.ticket?.soldOut === false, JSON.stringify(g.json?.ticket));
  r = await rest("PATCH", `/api/rooms/${RC}`, H, { ticketCapacity: 21 });
  check("PATCH capacity down to exactly the tickets sold (21): 200", r.status === 200 && r.json.room.ticketCapacity === 21, JSON.stringify(r.json));
  g = await rest("GET", `/api/rooms/${RC}`, E);
  check("sold out at 21 of 21: soldOut true", g.json?.ticket?.soldOut === true, JSON.stringify(g.json?.ticket));
  r = await rest("PATCH", `/api/rooms/${RC}`, H, { ticketCapacity: 150 });
  check("PATCH capacity up to 150: 200", r.status === 200 && r.json.room.ticketCapacity === 150, JSON.stringify(r.json));

  // a free room can be made ticketed (by an allowed host), and back while nothing is sold
  r = await rest("PATCH", `/api/rooms/${freeId}`, H, { ticketPriceKobo: 200000, ticketCapacity: 40 });
  check("PATCH free -> ticketed by an allowed host: 200", r.status === 200 && r.json.room.ticketPriceKobo === 200000 && r.json.room.ticketCapacity === 40, JSON.stringify(r.json));
  roomFeatures.paidRooms = false;
  r = await rest("PATCH", `/api/rooms/${freeId}`, H, { ticketPriceKobo: 300000 });
  check("flag off: changing a price is refused 403 FEATURE_OFF", r.status === 403 && r.json?.code === "FEATURE_OFF", JSON.stringify(r.json));
  r = await rest("PATCH", `/api/rooms/${freeId}`, H, { ticketPriceKobo: null, ticketCapacity: null });
  check("flag off: making an unsold ticketed room free again is allowed (200)", r.status === 200 && r.json.room.ticketPriceKobo === null, JSON.stringify(r.json));
  roomFeatures.paidRooms = true;
  const HUroom = (await rest("POST", "/api/rooms", HU, { title: "tk hu free", kind: "party", visibility: "public", ageLimit: "18+" })).json?.room?.id as string;
  r = await rest("PATCH", `/api/rooms/${HUroom}`, HU, { ticketPriceKobo: 200000, ticketCapacity: 40 });
  check("PATCH free -> ticketed by an unverified host: 403 HOST_NOT_VERIFIED", r.status === 403 && r.json?.code === "HOST_NOT_VERIFIED", JSON.stringify(r.json));

  // ---- the ensureSchema SQL applies cleanly on top of the drizzle-pushed schema, twice, with no duplicate constraints
  check("ensureSchema SQL applies on the pushed schema", (await pgCode(() => pool.query(ROOM_TICKETS_SCHEMA_SQL))) === "ok");
  check("ensureSchema SQL is idempotent (second run)", (await pgCode(() => pool.query(ROOM_TICKETS_SCHEMA_SQL))) === "ok");
  const cons = await q(`select conname, count(*)::int n from pg_constraint where conrelid in ('rooms'::regclass, 'room_tickets'::regclass, 'room_payouts'::regclass) and contype in ('c','u') group by conname`);
  const names = new Map(cons.map((c: any) => [c.conname, c.n]));
  const want = ["rooms_ticket_price_kobo_check", "rooms_ticket_capacity_check", "rooms_ticket_both_check", "room_tickets_provider_ref_key", "room_tickets_status_check", "room_tickets_amounts_check", "room_payouts_room_id_key", "room_payouts_transfer_ref_key", "room_payouts_status_check", "room_payouts_amount_check"];
  check("every named constraint exists exactly once (drizzle names = SQL names)", want.every((n) => names.get(n) === 1), JSON.stringify(Object.fromEntries(names)));
  const idx = (await q(`select indexdef from pg_indexes where indexname = 'room_tickets_paid_uniq'`))[0]?.indexdef ?? "";
  check("partial unique index is UNIQUE on (room_id, user_id) WHERE status = 'paid'", /UNIQUE/.test(idx) && /\(room_id, user_id\)/.test(idx) && /status\)?\s*=\s*'paid'/.test(idx), idx);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.paidRooms = false;
  try {
    if (created.length) {
      await q(`delete from room_payouts where host_id = any($1::varchar[])`, [created]);
      await q(`delete from users where id = any($1::varchar[])`, [created]); // rooms, tickets, members, payout accounts cascade
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
