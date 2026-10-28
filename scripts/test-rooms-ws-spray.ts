// Spraying (phase 5, task 5.4): what the ROOM sees, over a real WebSocket server with the REST routes on the same server
// (same harness as test-rooms-ws-tickets.ts), against a MOCK split provider.   npm run test:rooms
// Needs a scratch database whose name contains "test". Usernames use the prefix sw_. The spray flag is switched on in THIS
// PROCESS ONLY (roomFeatures test seam). Every check waits on an event, never on a short fixed sleep.
//  - room:spray reaches everyone in the room, carries exactly { type, id, tier, v3c, fromId, toId, at }, fromId is the
//    payer's user id as members appear in room:state, never a reference, an amount in kobo or card data;
//  - the receipt chat line is made by the server, once;
//  - a broadcast failure never undoes a delivered spray; a ledger failure rolls the delivery back (no broadcast) and the
//    sweep delivers it once later;
//  - a reversal is told to the payer only;
//  - a double tap gives one room:spray.
import http from "node:http";
import crypto from "node:crypto";
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
process.env.SESSION_SECRET ||= "spray-ws-test-session-secret";
process.env.PAYMENT_TOKEN_KEY = Buffer.alloc(32, 9).toString("base64"); // test-only key, this process only
delete process.env.APP_URL;

const { storage } = await import("../server/storage");
const { wsManager } = await import("../server/websocket");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomHub } = await import("../server/rooms/RoomHub");
const { tuning } = await import("../server/rooms/roomSocket");
const { roomFeatures } = await import("../server/rooms/features");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
const { setSplitProviderForTests } = await import("../server/payments/splitProvider");
const { encryptToken } = await import("../server/payments/tokenCrypto");
const { finalizeSpray, sprayClock, sprayTestHooks } = await import("../server/rooms/spray");
const { sweepPendingSprays, stopSprayJob } = await import("../server/rooms/sprayJobs");
const ss = await import("../server/rooms/sprayStorage");
const { SPRAY_CATALOGUE } = await import("../shared/money");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (e) => console.log(`(pool error ignored: ${e.message})`));
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean> | boolean, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };
const key = () => crypto.randomUUID();

// ---- mock split provider (scripted, minimal)
type Tx = { state: "paid" | "failed" | "pending"; amountKobo: number; metadata: Record<string, string> };
const mock = {
  txs: new Map<string, Tx>(),
  refunds: new Set<string>(),
  charges: 0,
  async startFirstPayment(p: any) { this.txs.set(p.reference, { state: "pending", amountKobo: p.amountKobo, metadata: p.metadata }); return { url: `https://checkout.paystack.test/${p.reference}` }; },
  async chargeSaved(p: any) { this.charges++; this.txs.set(p.reference, { state: "paid", amountKobo: p.amountKobo, metadata: p.metadata }); return { status: "success", reference: p.reference }; },
  async verify(ref: string) { const t = this.txs.get(ref); return t ? { paid: t.state === "paid", state: t.state, amountKobo: t.amountKobo, currency: "NGN", metadata: t.metadata } : null; },
  async refund(ref: string) { this.refunds.add(ref); },
  async refundState(ref: string, _fullKobo?: number) { return this.refunds.has(ref) ? "done" : "none"; },
  pay(ref: string) { const t = this.txs.get(ref); if (t) t.state = "paid"; },
};
setSplitProviderForTests(mock as any);

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
setVoiceServiceForTests(null);
wsManager.initialize(server, fakeStore);
stopSprayJob();
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.78.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

class Client {
  msgs: any[] = [];
  ws: WebSocket;
  constructor(public id: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `vibepulse.sid=s%3A${id}.sig` } });
    this.ws.on("message", (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  }
  async open() { await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); }); await this.waitFor((m) => m.type === "connected"); return this; }
  send(o: object) { this.ws.send(JSON.stringify(o)); }
  async waitFor(pred: (m: any) => boolean, ms = 15_000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.msgs.find(pred); if (m) return m; await sleep(15); }
    return null;
  }
  all(pred: (m: any) => boolean) { return this.msgs.filter(pred); }
  close() { this.ws.close(); }
}
const conns: Client[] = [];
async function join(id: string, roomId: string) {
  const c = await new Client(id).open(); conns.push(c);
  c.send({ type: "room:join", roomId });
  const s = await c.waitFor((m) => m.type === "room:state" || m.type === "room:error", 20_000);
  return { c, s };
}

const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const hash = await bcrypt.hash("Passw0rd!sprayws", 4);
const stamp = Date.now();
const created: string[] = [];
let seq = 0;
const mk = async (name: string, o: { payout?: boolean; card?: boolean } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', now(), 'admin') returning id`,
    [`sw_${name}${stamp}@t.dev`, `sw_${name}${stamp}`, hash, yearsAgo(30)]))[0].id as string;
  created.push(id);
  if (o.payout) await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`, [id, `ACCT_sw_${++seq}`]);
  if (o.card) await ss.saveMethod({ userId: id, provider: "paystack", authEnc: encryptToken("AUTH_sw_secret"), last4: "4242", brand: "visa", bank: null, reusable: true, signature: `SIG_sw_${id}` });
  return id;
};
const sprayRows = (payerId: string) => q(`select * from spray_payments where payer_id = $1 order by created_at`, [payerId]);
const spray = (as: string, roomId: string, b: object) => rest("POST", `/api/rooms/${roomId}/spray`, as, b);

tuning.join = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000;

try {
  roomFeatures.spray = true;
  const H = await mk("host", { payout: true });
  const G = await mk("stage", { payout: true });
  const BY = await mk("bystander");
  const P = await mk("payer", { card: true });
  const cr = await rest("POST", "/api/rooms", H, { title: "sw room", kind: "party", visibility: "public", ageLimit: "18+", sprayEnabled: true });
  const R = cr.json?.room?.id as string;
  check("setup: room started", (await rest("POST", `/api/rooms/${R}/start`, H)).status === 200);
  const h = await join(H, R), g = await join(G, R), by = await join(BY, R), p = await join(P, R);
  check("setup: everyone in", [h, g, by, p].every((x) => x.s?.type === "room:state"));
  roomHub.setStage(R, { stage: [G], hands: [], invited: [] });
  const all = [h.c, g.c, by.c, p.c];
  const reset = () => all.forEach((c) => { c.msgs = []; });

  // ---- room:spray reaches everyone, exact shape, ids as in room:state
  reset();
  const r1 = await spray(P, R, { tier: "bundle", targetId: G, idempotencyKey: key() });
  check("spray delivered", r1.json?.status === "delivered", JSON.stringify(r1.json));
  const got = await Promise.all(all.map((c) => c.waitFor((m) => m.type === "room:spray" && m.id === r1.json.sprayId)));
  check("room:spray reaches everyone (host, recipient, bystander, payer)", got.every(Boolean));
  const ev = got[2];
  check("room:spray has exactly { type, id, tier, v3c, fromId, toId, at }", !!ev && JSON.stringify(Object.keys(ev).sort()) === JSON.stringify(["at", "fromId", "id", "tier", "toId", "type", "v3c"]), JSON.stringify(ev));
  // room:state lists members by userId (memberPayload): the event's ids are those same values.
  check("room:spray fromId is the payer's user id, toId the recipient's (as in room:state)", ev?.fromId === P && ev?.toId === G
    && (p.s.members as any[]).some((m) => m.userId === P || m.userId === H));
  check("room:spray tier and V3C from the catalogue", ev?.tier === "bundle" && ev?.v3c === SPRAY_CATALOGUE.bundle.v3c && typeof ev?.at === "number");
  const ref = (await sprayRows(P))[0].provider_ref;
  check("room:spray never carries the reference, a kobo amount or card data", !JSON.stringify(ev).includes(ref) && !/kobo|last4|authorization|signature/i.test(JSON.stringify(ev)));
  const receipts = await Promise.all(all.map((c) => c.waitFor((m) => m.type === "room:chat" && m.system === "spray")));
  check("the receipt chat line is made by the server and reaches everyone", receipts.every(Boolean) && receipts[0].userId === P && typeof receipts[0].text === "string" && !/₦|cash/i.test(receipts[0].text));
  await sleep(300);
  check("one receipt line and one room:spray per spray", by.c.all((m) => m.type === "room:chat" && m.system === "spray").length === 1 && by.c.all((m) => m.type === "room:spray").length === 1);
  // Fix round (R1 M5 / ruling 7): the receipt is a system line, kept OUT of the chat ring report excerpts are cut from.
  check("the receipt is a system line and is not in the server's chat ring", receipts[0].system === "spray" && !roomHub.recentChat(R).some((l) => l.userId === P && l.text === receipts[0].text));

  // ---- the breakdown shown before paying: exactly what the real spray stored (same split, same saved rates)
  const rowQ = (await sprayRows(P))[0];
  const qs = await rest("GET", `/api/rooms/${R}/spray/quote?tier=bundle&target=${G}`, P);
  const qGuest = qs.json?.parts?.find((x: any) => x.kind === "recipient"), qHost = qs.json?.parts?.find((x: any) => x.kind === "host");
  check("quote for a stage guest: their share and the host's share are what the spray stored", qs.status === 200 && qGuest?.kobo === Number(rowQ.guest_kobo) && qHost?.kobo === Number(rowQ.host_kobo) && qGuest?.userId === G && qHost?.userId === H, JSON.stringify(qs.json));
  check("quote: the parts and the service charge add up to the price, and names come with it", qs.json?.priceKobo === SPRAY_CATALOGUE.bundle.kobo && qs.json.parts.reduce((a: number, x: any) => a + x.kobo, 0) + qs.json.serviceKobo === qs.json.priceKobo && qs.json.parts.every((x: any) => typeof x.name === "string" && x.name.length > 0));
  const qh = await rest("GET", `/api/rooms/${R}/spray/quote?tier=note&target=${H}`, BY);
  check("quote for the host: only the host's share, plus the service charge", qh.status === 200 && qh.json?.parts?.length === 1 && qh.json.parts[0].userId === H && qh.json.parts[0].kobo + qh.json.serviceKobo === SPRAY_CATALOGUE.note.kobo, JSON.stringify(qh.json));
  check("quote leaks no rate or account detail", !/rate|percent|subaccount|account|vat|fee|reserve|platform/i.test(JSON.stringify(qs.json)), JSON.stringify(qs.json));
  check("quote: not in the room, a bad tier or someone not in the room is a plain 404",
    (await rest("GET", `/api/rooms/${R}/spray/quote?tier=bundle&target=${G}`, (await mk("quoteout")))).status === 404
    && (await rest("GET", `/api/rooms/${R}/spray/quote?tier=zzz&target=${G}`, P)).status === 404
    && (await rest("GET", `/api/rooms/${R}/spray/quote?tier=bundle&target=${(await mk("quoteabsent"))}`, P)).status === 404);

  // ---- the spray board (top three) and the recipient's own total
  const boards = await Promise.all(all.map((c) => c.waitFor((m) => m.type === "room:spray_board")));
  check("room:spray_board reaches everyone with the top sprayers by V3C", boards.every(Boolean) && boards[2].top?.length === 1 && boards[2].top[0].id === P && boards[2].top[0].v3c === SPRAY_CATALOGUE.bundle.v3c, JSON.stringify(boards[2]));
  const rec = await g.c.waitFor((m) => m.type === "room:spray_received");
  check("the recipient gets what they receive after fees (their own share in kobo, and the same amount in V3C), never the sprayed amount", !!rec && rec.kobo > 0 && rec.kobo < SPRAY_CATALOGUE.bundle.kobo && rec.v3c === rec.kobo && rec.roomId === R, JSON.stringify(rec));
  await sleep(300);
  check("nobody else gets a room:spray_received", [h, by, p].every((x) => x.c.all((m) => m.type === "room:spray_received").length === 0));
  const gb1 = await rest("GET", `/api/rooms/${R}/spray/board`, BY);
  check("GET board for a member: the top three and their own total (nothing for someone not sprayed)", gb1.status === 200 && gb1.json?.top?.length === 1 && gb1.json?.mine?.kobo === 0 && gb1.json?.mine?.v3c === 0, JSON.stringify(gb1.json));
  const gb2 = await rest("GET", `/api/rooms/${R}/spray/board`, G);
  check("GET board for the recipient: their total matches what the socket sent", gb2.json?.mine?.kobo === rec?.kobo && gb2.json?.mine?.v3c === rec?.v3c, JSON.stringify(gb2.json));
  const OUT = await mk("outsider");
  check("GET board for someone not in the room: 404", (await rest("GET", `/api/rooms/${R}/spray/board`, OUT)).status === 404);

  // ---- anonymous spray: the room never sees who; the row (admins) still does
  const PA = await mk("payer_anon", { card: true });
  await join(PA, R);
  reset();
  const ra = await spray(PA, R, { tier: "note", targetId: H, idempotencyKey: key(), anonymous: true });
  check("anonymous spray delivered", ra.json?.status === "delivered", JSON.stringify(ra.json));
  const aev = await by.c.waitFor((m) => m.type === "room:spray" && m.id === ra.json.sprayId);
  check("room:spray fromId is the anonymous sentinel, never the payer's id", aev?.fromId === "anonymous" && !JSON.stringify(aev).includes(PA), JSON.stringify(aev));
  const arc = await by.c.waitFor((m) => m.type === "room:chat" && m.system === "spray");
  check("the receipt line comes from the anonymous sentinel", arc?.userId === "anonymous");
  const abd = await by.c.waitFor((m) => m.type === "room:spray_board");
  check("the board names them Anonymous, with no id of theirs", abd?.top?.some((r: any) => r.id === "anonymous" && r.name === "Anonymous") && !JSON.stringify(abd).includes(PA), JSON.stringify(abd));
  await sleep(300);
  check("nothing the room received names the anonymous payer", !JSON.stringify(by.c.msgs).includes(PA));
  const rowA = (await sprayRows(PA))[0];
  check("the row still records who paid, and that they chose anonymous", rowA?.payer_id === PA && rowA?.anonymous === true);
  check("a non-boolean anonymous is a plain 400", (await spray(PA, R, { tier: "note", targetId: H, idempotencyKey: key(), anonymous: "yes" })).status === 400);

  // ---- double tap: one room:spray
  reset();
  const kd = key();
  await Promise.all(Array.from({ length: 4 }, () => spray(P, R, { tier: "note", targetId: H, idempotencyKey: kd })));
  await by.c.waitFor((m) => m.type === "room:spray");
  await sleep(500);
  check("double tap: one room:spray", by.c.all((m) => m.type === "room:spray").length === 1, `${by.c.all((m) => m.type === "room:spray").length}`);

  // ---- a broadcast failure never undoes a delivered spray
  const P2 = await mk("payer2", { card: true });
  await join(P2, R);
  sprayTestHooks.failBroadcast = () => true;
  const r2 = await spray(P2, R, { tier: "note", targetId: H, idempotencyKey: key() });
  sprayTestHooks.failBroadcast = undefined;
  const row2 = (await sprayRows(P2))[0];
  check("broadcast failure: still delivered with its ledger row", r2.json?.status === "delivered" && row2.status === "delivered"
    && (await q(`select 1 from payment_transactions where type = 'spray' and provider_payment_id = $1`, [row2.provider_ref])).length === 1);

  // ---- a ledger failure rolls the delivery back: no broadcast; the sweep delivers it once later
  const P3 = await mk("payer3", { card: true });
  await join(P3, R);
  reset();
  sprayTestHooks.failDeliveryLedger = () => true;
  const r3 = await spray(P3, R, { tier: "note", targetId: H, idempotencyKey: key() });
  sprayTestHooks.failDeliveryLedger = undefined;
  const row3 = (await sprayRows(P3))[0];
  check("ledger failure: not delivered (still paid), no ledger row", row3.status === "paid" && r3.json?.status === "pending"
    && (await q(`select 1 from payment_transactions where provider_payment_id = $1`, [row3.provider_ref])).length === 0, `${row3.status} ${JSON.stringify(r3.json)}`);
  await sleep(300);
  check("ledger failure: no room:spray went out", !by.c.all((m) => m.type === "room:spray" && m.id === row3.id).length);
  await sweepPendingSprays(sprayClock.now());
  check("the sweep then delivers it once", (await sprayRows(P3))[0].status === "delivered" && !!(await by.c.waitFor((m) => m.type === "room:spray" && m.id === row3.id)));
  await sleep(300);
  check("the sweep delivered it once", by.c.all((m) => m.type === "room:spray" && m.id === row3.id).length === 1);

  // ---- rain: bank approval, then finalize; V3C 10,000,000
  const PR = await mk("payer_rain", { card: true });
  const pr = await join(PR, R);
  reset();
  const rr = await spray(PR, R, { tier: "rain", targetId: H, idempotencyKey: key() });
  check("rain: action_required (never a silent saved-card charge)", rr.json?.status === "action_required", JSON.stringify(rr.json));
  const rain = (await sprayRows(PR))[0];
  mock.pay(rain.provider_ref);
  check("rain: finalized", (await finalizeSpray(rain.provider_ref)) === "delivered");
  const rev = await by.c.waitFor((m) => m.type === "room:spray" && m.id === rain.id);
  check("rain: room:spray tier rain, v3c 10,000,000", rev?.tier === "rain" && rev?.v3c === 10000000);

  // ---- owner rule 2026-10-22: a charge that went through is delivered even if the recipient left (no refund, no animation)
  const PL = await mk("payer_left", { card: false });
  const pl = await join(PL, R);
  reset();
  await spray(PL, R, { tier: "note", targetId: G, idempotencyKey: key() });
  const lrow = (await sprayRows(PL))[0];
  g.c.send({ type: "room:leave" });
  check("setup: recipient left", await until(() => !roomHub.get(R, G)));
  mock.pay(lrow.provider_ref);
  // Fix round (ruling 6): a recipient this process does not see is waited for until the 60 s delivery deadline.
  check("before the deadline: finalize waits (pending), nothing refunded", (await finalizeSpray(lrow.provider_ref)) === "pending" && !mock.refunds.has(lrow.provider_ref));
  const realNow = sprayClock.now;
  sprayClock.now = () => Date.now() + 2 * 60_000;
  let out: string;
  try { out = await finalizeSpray(lrow.provider_ref); } finally { sprayClock.now = realNow; }
  check("finalize delivers once past the deadline (never refunds a taken payment)", out === "delivered" && !mock.refunds.has(lrow.provider_ref), out);
  await sleep(300);
  check("no refund line to the payer, nobody else sees one, and the room is still told once (the delivery check decides the money, not the show)",
    [h.c, by.c, pr.c, pl.c].every((c) => !c.all((m) => m.system === "spray_reversed").length)
    && by.c.all((m) => m.type === "room:spray" && m.id === lrow.id).length === 1);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = false;
  sprayTestHooks.failBroadcast = undefined;
  sprayTestHooks.failDeliveryLedger = undefined;
  setSplitProviderForTests(null);
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    if (created.length) {
      // Reversals write clawbacks now (RESTRICT on spray_payments): children first.
      await q(`delete from host_clawbacks where host_id = any($1::varchar[]) or beneficiary_id = any($1::varchar[])`, [created]);
      await q(`delete from payment_transactions where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from payment_issues where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from spray_payments where payer_id = any($1::varchar[])`, [created]);
      await q(`delete from users where id = any($1::varchar[])`, [created]);
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
