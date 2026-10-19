// Paid rooms (phase 4): the door check and ticket capacity over a real WebSocket server, REST routes on the same server
// (same harness as test-rooms-ws-hostsettings.ts).   npm run test:rooms
// Needs a scratch database whose name contains "test". Usernames use the prefix tw_. Tickets are SQL rows (the checkout lane
// is not in this tree). paidRooms is flipped in THIS PROCESS ONLY through the roomFeatures test seam. The scratch DB can be
// remote (about 200 ms per query): every check waits on an event (10 to 20 s), never on a short fixed sleep.
import http from "node:http";
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";
import WebSocket from "ws";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { wsManager } = await import("../server/websocket");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomHub } = await import("../server/rooms/RoomHub");
const { tuning, testHooks, enforceTicketFor } = await import("../server/rooms/roomSocket");
const { roomFeatures } = await import("../server/rooms/features");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
const { ticketBreakdown } = await import("../shared/money");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.log(`(pool error ignored: ${e.message})`));
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- one server: REST (fake auth header) + /ws (session id in the cookie IS the user id)
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
const fakeStore = { get: (sid: string, cb: (e: any, s: any) => void) => cb(null, { passport: { user: sid } }) };
const server = http.createServer(app);
setVoiceServiceForTests(null); // never the real LiveKit
wsManager.initialize(server, fakeStore);
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const url = `ws://127.0.0.1:${port}/ws`;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.42.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

class Client {
  msgs: any[] = [];
  base = 0;
  ws: WebSocket;
  constructor(public id: string) {
    this.ws = new WebSocket(url, { headers: { cookie: `vibepulse.sid=s%3A${id}.sig` } });
    this.ws.on("message", (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  }
  async open() { await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); this.ws.once("close", () => rej(new Error("closed before open"))); }); await this.waitFor((m) => m.type === "connected"); return this; }
  send(o: object) { this.ws.send(JSON.stringify(o)); }
  drain() { this.base = this.msgs.length; }
  async waitFor(pred: (m: any) => boolean, ms = 15_000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.msgs.slice(this.base).find(pred);
      if (m) return m;
      await sleep(15);
    }
    return null;
  }
  all(pred: (m: any) => boolean) { return this.msgs.slice(this.base).filter(pred); }
  close() { this.ws.close(); }
}
const conns: Client[] = [];
const connect = async (id: string) => { const c = await new Client(id).open(); conns.push(c); return c; };
const join = async (c: Client, roomId: string, extra: object = {}) => {
  c.drain(); c.send({ type: "room:join", roomId, ...extra });
  return c.waitFor((m) => m.type === "room:state" || m.type === "room:error", 20_000);
};
const until = async (f: () => Promise<boolean> | boolean, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const created: string[] = [];
const mk = async (name: string, dob: string | null = yearsAgo(30), verified = true) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', $5, $6) returning id`,
    [`tw_${name}${stamp}@t.dev`, `tw_${name}${stamp}`, hash, dob, verified ? new Date() : null, verified ? "admin" : null]))[0].id as string;
  created.push(id);
  return id;
};
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
let refSeq = 0;
const PRICE = 500000;
const insertTicket = async (roomId: string, userId: string, status: "paid" | "refunded" = "paid") => {
  const b = ticketBreakdown(PRICE);
  return (await q(
    `insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, refunded_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,$10, case when $10 = 'refunded' then now() else null end) returning id`,
    [roomId, userId, b.price, b.vat, b.fee, b.reserve, b.platform, b.host, `tw-ref-${stamp}-${++refSeq}`, status]))[0].id as string;
};
const refund = (ticketId: string) => q(`update room_tickets set status = 'refunded', refunded_at = now(), refund_reason = 'buyer' where id = $1 and status = 'paid'`, [ticketId]);
/** A refusal is the bare code: nothing about the room or its price. */
const bareRefusal = (m: any, code: string) => !!m && m.type === "room:error" && m.code === code && Object.keys(m).sort().join(",") === "code,type";

tuning.join = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000; // a host who leaves must not end the room behind the tests

try {
  roomFeatures.paidRooms = true;
  const H = await mk("host");
  await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack','ACCT_tw',true,true)`, [H]);
  const H2 = await mk("freehost");
  const CO = await mk("cohost"), HOLD = await mk("holder"), NON = await mk("nonholder"), REF = await mk("refunded");
  const HOLD2 = await mk("holder2"), HOLD3 = await mk("holder3"), UNV = await mk("unverified", yearsAgo(30), false);

  // ---- rooms: one ticketed 18+ (capacity 20), one free room for "stays where they are"
  const cr = await rest("POST", "/api/rooms", H, { title: "tw paid", kind: "party", visibility: "public", ageLimit: "18+", ticketPriceKobo: PRICE, ticketCapacity: 20 });
  const R = cr.json?.room?.id as string;
  check("setup: ticketed room created", cr.status === 201 && !!R, JSON.stringify(cr.json));
  check("setup: ticketed room started", (await rest("POST", `/api/rooms/${R}/start`, H)).status === 200);
  const fr = await rest("POST", "/api/rooms", H2, { title: "tw free", kind: "party", visibility: "public", ageLimit: "18+" });
  const F = fr.json?.room?.id as string;
  check("setup: free room started", (await rest("POST", `/api/rooms/${F}/start`, H2)).status === 200);

  // ---- host admitted without a ticket; room:state carries no price
  const h = await connect(H);
  const hs = await join(h, R);
  check("host admitted without a ticket", hs?.type === "room:state" && hs.you?.role === "host", JSON.stringify(hs));
  check("room:state.room never carries the price or ticket settings", !!hs?.room && !("ticketPriceKobo" in hs.room) && !("ticketCapacity" in hs.room) && !JSON.stringify(hs).includes(String(PRICE)), JSON.stringify(hs?.room));
  const hf = await connect(H2);
  await join(hf, F);

  // ---- non-holder: refused TICKET_REQUIRED (bare code), and stays in the room they were in
  const non = await connect(NON);
  const nf = await join(non, F);
  check("setup: non-holder is in the free room", nf?.type === "room:state" && roomHub.roomOf(NON) === F, JSON.stringify(nf));
  const nr = await join(non, R);
  check("non-holder refused TICKET_REQUIRED (bare code, no price)", bareRefusal(nr, "TICKET_REQUIRED"), JSON.stringify(nr));
  check("non-holder refused: still in the free room (the pre-check ran before leaving it)", roomHub.roomOf(NON) === F && !roomHub.get(R, NON));
  const unv = await connect(UNV);
  check("unverified adult without a ticket: TICKET_REQUIRED, bare code", bareRefusal(await join(unv, R), "TICKET_REQUIRED"));

  // ---- holder admitted
  await insertTicket(R, HOLD);
  const hold = await connect(HOLD);
  const ho = await join(hold, R);
  check("ticket holder admitted", ho?.type === "room:state" && roomHub.get(R, HOLD)?.role === "guest", JSON.stringify(ho));
  const hold2tab = await connect(HOLD);
  check("ticket holder's second tab admitted", (await join(hold2tab, R))?.type === "room:state");

  // ---- co-host admitted without a ticket (member row role cohost)
  await q(`insert into room_members (room_id, user_id, role) values ($1,$2,'cohost') on conflict (room_id, user_id) do update set role = 'cohost'`, [R, CO]);
  const co = await connect(CO);
  const cs = await join(co, R);
  check("co-host admitted without a ticket", cs?.type === "room:state" && roomHub.get(R, CO)?.role === "cohost", JSON.stringify(cs));

  // ---- refunded ticket refused
  await insertTicket(R, REF, "refunded");
  const ref = await connect(REF);
  check("refunded ticket refused TICKET_REQUIRED", bareRefusal(await join(ref, R), "TICKET_REQUIRED"));
  check("refunded: not in the room", !roomHub.get(R, REF));

  // ---- refunded while inside: enforceTicketFor removes them (bare code), the room sees room:left, rejoin refused
  const t2 = await insertTicket(R, HOLD2);
  const hold2 = await connect(HOLD2);
  check("setup: holder 2 admitted", (await join(hold2, R))?.type === "room:state");
  h.drain(); hold2.drain();
  await refund(t2);
  check("enforceTicketFor removes a guest whose ticket was refunded", (await enforceTicketFor(R, HOLD2)) === true);
  check("the refunded guest is told TICKET_REQUIRED (bare code)", bareRefusal(await hold2.waitFor((m) => m.type === "room:error"), "TICKET_REQUIRED"));
  check("the room sees room:left for them", !!(await h.waitFor((m) => m.type === "room:left" && m.userId === HOLD2)));
  check("refunded guest is out of the hub", !roomHub.get(R, HOLD2));
  check("refunded guest's rejoin is refused TICKET_REQUIRED", bareRefusal(await join(hold2, R), "TICKET_REQUIRED"));
  check("enforceTicketFor never removes the host or a co-host", (await enforceTicketFor(R, H)) === false && (await enforceTicketFor(R, CO)) === false && !!roomHub.get(R, H) && !!roomHub.get(R, CO));
  check("enforceTicketFor leaves a holder with a paid ticket", (await enforceTicketFor(R, HOLD)) === false && !!roomHub.get(R, HOLD));

  // ---- refund during the join window: the join is held right after its fresh reads (ticket still paid), the refund lands,
  // the refund lane calls enforceTicketFor, which waits for the join to finish and then removes them. Never left inside.
  const t3 = await insertTicket(R, HOLD3);
  let held3 = false, release3!: () => void;
  const gate3 = new Promise<void>((r) => { release3 = r; });
  testHooks.afterFreshRead = async (_roomId: string, userId: string) => { if (userId === HOLD3) { held3 = true; await gate3; } };
  try {
    const hold3 = await connect(HOLD3);
    hold3.drain(); hold3.send({ type: "room:join", roomId: R });
    check("held: the join of holder 3 is held after its fresh reads", await until(() => held3));
    await refund(t3);
    let enforced: boolean | null = null;
    const enforcing = enforceTicketFor(R, HOLD3).then((x) => { enforced = x; });
    // enforceTicketFor must wait for the join in flight: release the join only once enforce has started waiting.
    release3();
    await enforcing;
    check("held: enforceTicketFor ran after the join finished and removed holder 3", enforced === true, String(enforced));
    check("held: holder 3 is not left inside the room", !roomHub.get(R, HOLD3));
    check("held: holder 3 got TICKET_REQUIRED", !!(await hold3.waitFor((m) => m.type === "room:error" && m.code === "TICKET_REQUIRED")));
  } finally {
    testHooks.afterFreshRead = undefined;
    release3();
  }

  // ---- capacity: ticketCapacity counts guests only (host and co-host take no seat)
  const buyers = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at)
     select 'tw_b' || g || '_' || $1 || '@t.dev', 'tw_b' || g || '_' || $1, 'social', $2, true, true, $3, now() - interval '60 days', now()
     from generate_series(1, 20) g returning id`, [stamp, hash, yearsAgo(30)])).map((x: any) => x.id as string);
  created.push(...buyers);
  for (const b of buyers) await insertTicket(R, b);
  const guestsIn = () => roomHub.members(R).filter((m) => m.role === "guest").length;
  const fill: Client[] = [];
  let admittedAll = true;
  for (const b of buyers.slice(0, 19)) { // HOLD is the 1st guest: 19 more make 20
    const c = await connect(b); fill.push(c);
    const s = await join(c, R);
    if (s?.type !== "room:state") { admittedAll = false; console.log(`  not admitted: ${JSON.stringify(s)}`); }
  }
  check("19 more holders admitted: 20 guests = ticket capacity", admittedAll && guestsIn() === 20, `${guestsIn()} guests`);
  check("host and co-host are in the room on top of the 20 seats", roomHub.count(R) === 22 && !!roomHub.get(R, H) && !!roomHub.get(R, CO), `${roomHub.count(R)}`);
  const last = await connect(buyers[19]);
  const full = await join(last, R);
  check("the 21st holder is refused ROOM_FULL (sold out at the door)", bareRefusal(full, "ROOM_FULL"), JSON.stringify(full));
  fill[0].send({ type: "room:leave" });
  check("a guest leaves", await until(() => guestsIn() === 19));
  const after = await join(last, R);
  check("then the waiting holder gets in", after?.type === "room:state" && guestsIn() === 20, JSON.stringify(after));

  // ---- minors' gate still first: an adult without an invite gets the minors' warning, never TICKET_REQUIRED
  const MH = await mk("minors_host", yearsAgo(15), false), MA = await mk("minors_adult"), MT = await mk("minors_teen", yearsAgo(15), true);
  await mutual(MH, MA); await mutual(MH, MT);
  const mr = await rest("POST", "/api/rooms", MH, { title: "tw minors", kind: "party", visibility: "friends", ageLimit: "all" });
  const MR = mr.json?.room?.id as string;
  check("setup: minors' room", mr.status === 201 && mr.json.room.minorsRoom === true, JSON.stringify(mr.json?.room));
  check("setup: minors' room started", (await rest("POST", `/api/rooms/${MR}/start`, MH)).status === 200);
  const mh = await connect(MH);
  check("setup: teen host in", (await join(mh, MR))?.type === "room:state");
  // Worst case written straight to the row (no route can do this): a minors' room with a price.
  await q(`update rooms set ticket_price_kobo = $2, ticket_capacity = 20 where id = $1`, [MR, PRICE]);
  const ma = await connect(MA);
  const mae = await join(ma, MR);
  check("minors' room: an uninvited adult gets MINORS_ROOM with the warning, not TICKET_REQUIRED", mae?.type === "room:error" && mae.code === "MINORS_ROOM" && typeof mae.warning === "string", JSON.stringify(mae));
  check("minors' room: the refusal carries no price", !JSON.stringify(mae).includes(String(PRICE)));
  const mt = await connect(MT);
  const mte = await join(mt, MR);
  check("minors' room: a teen without a ticket is refused by the ticket check AFTER the minors' gate (bare code, no price)", bareRefusal(mte, "TICKET_REQUIRED"), JSON.stringify(mte));
  await q(`update rooms set ticket_price_kobo = null, ticket_capacity = null where id = $1`, [MR]);
  check("minors' room made free again: the teen gets in", (await join(mt, MR))?.type === "room:state");

  // ---- the lock still answers before the ticket check (order: minors' gate, age, lock, ticket)
  const lockR = await rest("PATCH", `/api/rooms/${R}`, H, { locked: true });
  check("setup: ticketed room locked", lockR.status === 200 && lockR.json.room.locked === true, JSON.stringify(lockR.json));
  const nonLocked = await join(non, R);
  check("locked ticketed room: a non-holder gets ROOM_LOCKED (the lock comes before the ticket check)", bareRefusal(nonLocked, "ROOM_LOCKED"), JSON.stringify(nonLocked));
  await rest("PATCH", `/api/rooms/${R}`, H, { locked: false });

  // ---- a teen never reaches the ticket check of an 18+ room (age limit first)
  const TEEN = await mk("teen", yearsAgo(16), true);
  const teen = await connect(TEEN);
  const te = await join(teen, R);
  check("teen on an 18+ ticketed room: AGE_LIMIT, never TICKET_REQUIRED", bareRefusal(te, "AGE_LIMIT"), JSON.stringify(te));

  check("ticketed room ends", (await rest("POST", `/api/rooms/${R}/end`, H)).status === 200);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.paidRooms = false;
  testHooks.afterFreshRead = undefined;
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    if (created.length) {
      await q(`delete from room_payouts where host_id = any($1::varchar[])`, [created]);
      await q(`delete from users where id = any($1::varchar[])`, [created]);
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
