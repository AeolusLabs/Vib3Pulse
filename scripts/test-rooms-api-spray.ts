// Spraying (phase 5, tasks 5.4 to 5.6): the spray endpoint, finalize, reversal, the sweep, limits, the saved card, the
// webhook (charge, refund, dispute) and clawbacks, against a MOCK split provider. Every item of revisions section D that
// belongs to the server has a case here (the effects engine and the Spray button are lanes D and C).
//   npm run test:rooms      (needs a scratch database whose name contains "test"; usernames use the prefix sp_)
// No real card, no real Paystack: the provider is replaced with setSplitProviderForTests; PAYSTACK_SECRET_KEY is a fake used
// only to sign webhooks; the spray flag is switched on IN THIS PROCESS ONLY through the roomFeatures test seam. The scratch DB
// can be remote (about 200 ms per query): every wait is on an event or a condition, never a short fixed sleep.
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
process.env.PAYSTACK_SECRET_KEY = "sk_test_spray_mock_only_not_a_real_key";
process.env.SESSION_SECRET ||= "spray-test-session-secret";
process.env.PAYMENT_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64"); // test-only key, this process only
delete process.env.APP_URL; // the callback then uses the test server's own origin
delete process.env.NEW_HOST_RECEIVE_CAP_KOBO;

// ---- every console line is captured, so the secrets checks can read what the server logged
const logged: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const { storage } = await import("../server/storage");
const { wsManager } = await import("../server/websocket");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { registerPaymentRoutes } = await import("../server/payment-routes");
const { roomHub } = await import("../server/rooms/RoomHub");
const { tuning, applyMod } = await import("../server/rooms/roomSocket");
const { roomFeatures } = await import("../server/rooms/features");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
const { setSplitProviderForTests } = await import("../server/payments/splitProvider");
const { setPaymentProviderForTests } = await import("../server/payments/index");
const { assertPaymentTokenKeyForBoot, encryptToken } = await import("../server/payments/tokenCrypto");
const { makeSprayReference, sprayReferenceSecret } = await import("../server/payments/sprayReference");
const { finalizeSpray, sprayClock, SPRAY_UNAVAILABLE } = await import("../server/rooms/spray");
const { sweepPendingSprays, stopSprayJob } = await import("../server/rooms/sprayJobs");
const { applyClawbacks } = await import("../server/rooms/clawbacks");
const { runSettlementPass } = await import("../server/rooms/settlement");
const ss = await import("../server/rooms/sprayStorage");
const { SPRAY_CATALOGUE, ticketBreakdown } = await import("../shared/money");
const { spraySplit } = await import("../shared/spray");

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

// ---------------------------------------------------------------- the mock split provider (scripted)
const SECRET_CODE = "AUTH_spraytest_secret_code_x9";
const SECRET_SIG = "SIG_spraytest_card_signature_x9";
type Tx = { state: "paid" | "failed" | "pending"; amountKobo: number; currency: string; metadata: Record<string, string>; authorization?: any; paidFlag?: boolean };
const mock = {
  txs: new Map<string, Tx>(),
  refunds: new Map<string, "in_progress" | "done">(),
  calls: { start: [] as any[], charge: [] as any[], verify: [] as string[], refund: [] as string[], refundState: [] as string[] },
  nextCharge: "success" as "success" | "declined" | "insufficient" | "network_charged" | "network_throw" | "action_required",
  verifyThrows: false,
  refundMode: "ok" as "ok" | "outage" | "refusal" | "pending",
  refundLookupThrows: false,
  async startFirstPayment(p: any) {
    this.calls.start.push(p);
    this.txs.set(p.reference, { state: "pending", amountKobo: p.amountKobo, currency: "NGN", metadata: p.metadata });
    return { url: `https://checkout.paystack.test/${p.reference}` };
  },
  async chargeSaved(p: any) {
    this.calls.charge.push({ ...p, authorizationCode: p.authorizationCode === SECRET_CODE ? "<the saved code>" : "<WRONG CODE>" });
    const mode = this.nextCharge;
    const set = (state: Tx["state"]) => this.txs.set(p.reference, { state, amountKobo: p.amountKobo, currency: "NGN", metadata: p.metadata });
    if (mode === "success") { set("paid"); return { status: "success", reference: p.reference }; }
    if (mode === "declined") { set("failed"); return { status: "failed", reference: p.reference, failure: "DECLINED" }; }
    if (mode === "insufficient") { set("failed"); return { status: "failed", reference: p.reference, failure: "INSUFFICIENT_FUNDS" }; }
    if (mode === "network_charged") { set("paid"); return { status: "failed", reference: p.reference, failure: "NETWORK" }; }
    if (mode === "network_throw") { throw new Error("Paystack unavailable: socket hang up"); }
    set("pending"); return { status: "action_required", reference: p.reference, authorizationUrl: `https://3ds.paystack.test/${p.reference}` };
  },
  async verify(ref: string) {
    this.calls.verify.push(ref);
    if (this.verifyThrows) throw new Error("Paystack unavailable: verify");
    const t = this.txs.get(ref);
    if (!t) return null;
    // Same contract as the real provider (fix round): paid = success, the currency and amount passed through as they are.
    return {
      paid: t.paidFlag ?? t.state === "paid", state: t.state, amountKobo: t.amountKobo, currency: t.currency,
      metadata: t.metadata, ...(t.authorization ? { authorization: t.authorization } : {}),
    };
  },
  async refund(ref: string) {
    this.calls.refund.push(ref);
    if (this.refundMode === "outage") throw new Error("Paystack unavailable: refund");
    if (this.refundMode === "refusal") throw new Error("Paystack error: Transaction has been fully reversed");
    if (this.refunds.has(ref)) return;
    this.refunds.set(ref, this.refundMode === "pending" ? "in_progress" : "done");
  },
  async refundState(ref: string) {
    this.calls.refundState.push(ref);
    if (this.refundLookupThrows) throw new Error("Paystack unavailable: refund lookup");
    return this.refunds.get(ref) ?? "none";
  },
  /** The payer finishes the checkout (or the bank approval). */
  pay(ref: string, o: { amountKobo?: number; currency?: string; reusable?: boolean; paidFlag?: boolean } = {}) {
    const t = this.txs.get(ref);
    if (!t) throw new Error(`mock: no checkout for ${ref}`);
    t.state = "paid";
    if (o.amountKobo !== undefined) t.amountKobo = o.amountKobo;
    if (o.currency !== undefined) t.currency = o.currency;
    if (o.paidFlag !== undefined) t.paidFlag = o.paidFlag;
    t.authorization = { authorizationCode: SECRET_CODE, last4: "4242", brand: "visa", bank: "TEST BANK", reusable: o.reusable !== false, signature: SECRET_SIG };
  },
  chargesFor(ref: string) { return this.calls.charge.filter((c) => c.reference === ref).length + this.calls.start.filter((c) => c.reference === ref).length; },
};
setSplitProviderForTests(mock as any);
// Room payouts in the settlement case: never a real transfer.
setPaymentProviderForTests({
  verifyTransfer: async () => null,
  createTransferRecipient: async () => ({ recipientCode: "RCP_spray_test" }),
  createTransfer: async () => ({ status: "success" }),
});

// ---------------------------------------------------------------- one server: REST + webhook + /ws
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) { const u = await storage.getUser(id); req.user = u ? userToSessionUser(u) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
registerPaymentRoutes(app);
const fakeStore = { get: (sid: string, cb: (e: any, s: any) => void) => cb(null, { passport: { user: sid } }) };
const server = http.createServer(app);
setVoiceServiceForTests(null);
wsManager.initialize(server, fakeStore);
stopSprayJob(); // the suite drives sweep passes by hand
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
const responses: string[] = [];
let ipSeq = 1;
async function rest(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json: any = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, headers: res.headers };
}
const spray = (as: string | null, roomId: string, body: Record<string, unknown>) => rest("POST", `/api/rooms/${roomId}/spray`, as, body);
async function webhook(event: string, data: unknown, sign: "valid" | "bad" = "valid") {
  const body = JSON.stringify({ event, data });
  const sig = crypto.createHmac("sha512", sign === "valid" ? process.env.PAYSTACK_SECRET_KEY! : "wrong").update(body).digest("hex");
  const res = await fetch(base + "/api/webhooks/paystack", { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sig }, body });
  responses.push(await res.text());
  return res.status;
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
async function joinRoom(id: string, roomId: string) {
  const c = await new Client(id).open(); conns.push(c);
  c.send({ type: "room:join", roomId });
  const s = await c.waitFor((m) => m.type === "room:state" || m.type === "room:error", 20_000);
  return { c, s };
}

// ---------------------------------------------------------------- data
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const hash = await bcrypt.hash("Passw0rd!spray", 4);
const stamp = Date.now();
const created: string[] = [];
const madeRooms: string[] = [];
let seq = 0;
const mk = async (name: string, o: { dob?: string | null; verified?: boolean; payout?: boolean; newAccount?: boolean } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, case when $7 then now() else now() - interval '60 days' end, $5, $6) returning id`,
    [`sp_${name}${stamp}@t.dev`, `sp_${name}${stamp}`, hash, o.dob === undefined ? yearsAgo(30) : o.dob,
      o.verified === false ? null : new Date(), o.verified === false ? null : "admin", o.newAccount === true],
  ))[0].id as string;
  created.push(id);
  if (o.payout) await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled) values ($1,'paystack',$2,true,true)`, [id, `ACCT_sp_${++seq}`]);
  return id;
};
const emailOf = async (id: string) => (await q(`select email from users where id = $1`, [id]))[0].email as string;
const sprayRows = (payerId: string) => q(`select * from spray_payments where payer_id = $1 order by created_at`, [payerId]);
const rowById = async (id: string) => (await q(`select * from spray_payments where id = $1`, [id]))[0];
const ledger = (ref: string, type: string) => q(`select * from payment_transactions where provider_payment_id = $1 and type = $2`, [ref, type]);
const spentIn = async (roomId: string, userId: string) => Number((await q(`select spent_kobo from room_spend where room_id = $1 and user_id = $2`, [roomId, userId]))[0]?.spent_kobo ?? 0);
/** Seeds a saved reusable card for this payer (as a first payment with saveCard would). */
const seedCard = (userId: string) => ss.saveMethod({ userId, provider: "paystack", authEnc: encryptToken(SECRET_CODE), last4: "4242", brand: "visa", bank: null, reusable: true, signature: `${SECRET_SIG}_${userId}` });
async function mkRoom(hostId: string, ageLimit = "18+") {
  const cr = await rest("POST", "/api/rooms", hostId, { title: `sp room ${++seq}`, kind: "party", visibility: "public", ageLimit });
  const id = cr.json?.room?.id as string;
  madeRooms.push(id);
  await rest("POST", `/api/rooms/${id}/start`, hostId);
  return id;
}
const isGeneric403 = (r: { status: number; json: any }) =>
  r.status === 403 && JSON.stringify(r.json) === JSON.stringify(SPRAY_UNAVAILABLE);
// Fix round helpers. Every reversal of a taken payment now writes clawbacks (owner ruling C1), and anyone owing an open
// clawback cannot receive sprays: after checking them, a case settles them so the shared host/guest stay sprayable.
const clawbacksOf = (sprayId: string) => q(`select * from host_clawbacks where spray_id = $1 order by amount_kobo`, [sprayId]);
const settleClawbacks = (sprayId: string) => q(`update host_clawbacks set status = 'recovered', recovered_kobo = amount_kobo, recovered_at = now() where spray_id = $1 and status = 'open'`, [sprayId]);
/** The sweep backs off rows it checked; a test that drives passes by hand makes the row due again. */
const due = (sprayId: string) => q(`update spray_payments set next_check_at = null where id = $1`, [sprayId]);
const realNow = sprayClock.now;
/** Moves the spray clock past the 60 s delivery deadline (restored with clockBack). */
const clockAhead = (ms = 2 * 60_000) => { sprayClock.now = () => Date.now() + ms; };
const clockBack = () => { sprayClock.now = realNow; };
const issues = (ref: string, reason: string) => q(`select * from payment_issues where provider_payment_id = $1 and reason = $2`, [ref, reason]);

tuning.join = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000;

try {
  roomFeatures.spray = true;

  // ---- people: a payable host, payable stage guest, payable co-host, and the rest
  const H = await mk("host", { payout: true });
  const G = await mk("guest_stage", { payout: true });
  const CO = await mk("cohost", { payout: true });
  const NOPAY = await mk("stage_nopayout");
  const UNVSTAGE = await mk("stage_unverified", { verified: false, payout: true });
  const PLAIN = await mk("plain_guest", { payout: true }); // in the room, never on stage
  const R = await mkRoom(H);
  check("setup: room live", (await q(`select status from rooms where id = $1`, [R]))[0]?.status === "live");
  const h = await joinRoom(H, R);
  check("setup: host in", h.s?.type === "room:state");
  await q(`insert into room_members (room_id, user_id, role) values ($1,$2,'cohost') on conflict (room_id, user_id) do update set role = 'cohost'`, [R, CO]);
  for (const id of [G, CO, NOPAY, UNVSTAGE, PLAIN]) await joinRoom(id, R);
  roomHub.setStage(R, { stage: [G, NOPAY, UNVSTAGE], hands: [], invited: [] });

  /** A verified adult payer, in the room, with a saved card unless told otherwise. */
  const payer = async (name: string, o: { card?: boolean; join?: boolean } = {}) => {
    const id = await mk(name);
    if (o.card !== false) await seedCard(id);
    const j = o.join === false ? null : await joinRoom(id, R);
    return { id, c: j?.c ?? null };
  };

  // =============================================================== D: who may spray (generic 403, no row, no provider call)
  const P = await payer("p_main");
  const callsBefore = () => mock.calls.charge.length + mock.calls.start.length;
  async function refused(name: string, as: string | null, roomId: string, body: Record<string, unknown>, expectStatus: 401 | 403 = 403) {
    const before = callsBefore();
    const rowsBefore = as ? (await sprayRows(as)).length : 0;
    const r = await spray(as, roomId, body);
    const ok = expectStatus === 401 ? r.status === 401 : isGeneric403(r);
    check(`${name}: ${expectStatus === 401 ? "401" : "generic 403 SPRAY_UNAVAILABLE"}`, ok, `${r.status} ${JSON.stringify(r.json)}`);
    check(`${name}: no row and no provider call`, callsBefore() === before && (as ? (await sprayRows(as)).length === rowsBefore : true));
  }
  const body = (targetId: string, tier = "note") => ({ tier, targetId, idempotencyKey: key() });

  await refused("signed out", null, R, body(H), 401);
  roomFeatures.spray = false;
  await refused("flag off", P.id, R, body(H));
  roomFeatures.spray = true;
  const TEEN = await mk("teen", { dob: yearsAgo(16) });
  await seedCard(TEEN);
  const teenJoin = await joinRoom(TEEN, R);
  check("setup: a teen cannot even join an 18+ room", teenJoin.s?.type === "room:error");
  await refused("teen payer", TEEN, R, body(H));
  const UNV = await mk("unverified_adult", { verified: false });
  await seedCard(UNV);
  await joinRoom(UNV, R);
  await refused("unverified adult payer (in the room)", UNV, R, body(H));
  const OUT = await payer("outside", { join: false });
  await refused("verified adult outside the room", OUT.id, R, body(H));
  const BAN = await payer("banned");
  await applyMod(R, "ban", BAN.id);
  await refused("banned payer", BAN.id, R, body(H));
  const KICK = await payer("kicked");
  await applyMod(R, "kick", KICK.id);
  await refused("kicked payer", KICK.id, R, body(H));
  await refused("non-stage target (a guest in the room)", P.id, R, body(PLAIN));
  await refused("teen as target (not in the room, not payable)", P.id, R, body(TEEN));
  await refused("unverified adult on stage as target", P.id, R, body(UNVSTAGE));
  await refused("stage target without a payout account", P.id, R, body(NOPAY));
  await refused("self (payer targets themselves)", P.id, R, body(P.id));
  await refused("self (host sprays the host)", H, R, body(H));
  const BLK = await payer("blocker");
  await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [G, BLK.id]);
  await refused("blocked pair (the recipient blocked the payer)", BLK.id, R, body(G));
  // Fix round (R1 M2): on a stage spray the host takes a cut, so a block between the payer and the HOST refuses it too.
  const HBLK = await payer("hostblocked");
  await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [H, HBLK.id]);
  await refused("the host blocked the payer (spraying a stage guest)", HBLK.id, R, body(G));
  await refused("unknown target id", P.id, R, body("00000000-0000-4000-8000-000000000000"));
  // A free all-ages room is never a money room.
  const H2 = await mk("host_allages", { payout: true });
  const RA = await mkRoom(H2, "all");
  await joinRoom(H2, RA);
  const PA = await payer("p_allages", { join: false });
  await joinRoom(PA.id, RA);
  await refused("all-ages room", PA.id, RA, body(H2));
  // Shapes: 400 for a malformed body, never a charge.
  for (const [n, b] of [
    ["unknown tier", { tier: "n20", targetId: H, idempotencyKey: key() }],
    ["upper-case key", { tier: "note", targetId: H, idempotencyKey: key().toUpperCase() }],
    ["not a uuid v4 key", { tier: "note", targetId: H, idempotencyKey: "11111111-1111-1111-1111-111111111111" }],
    ["client amount is not a field we read (still validated as a tier)", { tier: 50000, targetId: H, idempotencyKey: key() }],
    ["saveCard not a boolean", { tier: "note", targetId: H, idempotencyKey: key(), saveCard: "yes" }],
  ] as const) {
    const r = await spray(P.id, R, b as any);
    check(`bad body (${n}): 400 BAD_REQUEST`, r.status === 400 && r.json?.code === "BAD_REQUEST", `${r.status} ${JSON.stringify(r.json)}`);
  }

  // =============================================================== happy path (saved card, note to the host)
  const k1 = key();
  const happy = await spray(P.id, R, { tier: "note", targetId: H, idempotencyKey: k1, amountKobo: 1, currency: "USD", payerId: H, reference: "x" });
  check("happy: 200 delivered", happy.status === 200 && happy.json?.status === "delivered" && typeof happy.json?.sprayId === "string", JSON.stringify(happy.json));
  const hrow = await rowById(happy.json.sprayId);
  check("happy: client amount/currency/payer/reference ignored: stored price is the catalogue price", Number(hrow.amount_kobo) === SPRAY_CATALOGUE.note.kobo && hrow.payer_id === P.id && hrow.provider_ref !== "x");
  const sp = spraySplit("note", "host");
  check("happy: split from the catalogue (host share, no guest)", Number(hrow.host_kobo) === sp.hostKobo && hrow.guest_kobo === null && Number(hrow.platform_kobo) === sp.breakdown.platform);
  check("happy: charged once with the saved card, split to the host's subaccount only", mock.calls.charge.filter((c) => c.reference === hrow.provider_ref).length === 1
    && mock.calls.charge.find((c) => c.reference === hrow.provider_ref)?.authorizationCode === "<the saved code>"
    && mock.calls.charge.find((c) => c.reference === hrow.provider_ref)?.split.shares.length === 1
    && typeof mock.calls.charge.find((c) => c.reference === hrow.provider_ref)?.callbackUrl === "string");
  check("happy: exactly one spray ledger row", (await ledger(hrow.provider_ref, "spray")).length === 1);
  check("happy: room spend reserved", (await spentIn(R, P.id)) === SPRAY_CATALOGUE.note.kobo);
  check("happy: the reference is a spray reference bound by MAC", /^vib3rs_[0-9a-f]{24}_[0-9a-f]{32}$/.test(hrow.provider_ref));
  check("happy: response carries no reference, amount or card", !JSON.stringify(happy.json).includes(hrow.provider_ref) && !("amountKobo" in happy.json));
  const st = await rest("GET", `/api/rooms/${R}/spray/${hrow.id}`, P.id);
  check("status: payer sees delivered", st.status === 200 && st.json?.status === "delivered", JSON.stringify(st.json));
  check("status: another user gets 404", (await rest("GET", `/api/rooms/${R}/spray/${hrow.id}`, H)).status === 404);
  check("status: wrong room gets 404", (await rest("GET", `/api/rooms/${RA}/spray/${hrow.id}`, P.id)).status === 404);

  // ---- replays
  const rep = await spray(P.id, R, { tier: "note", targetId: H, idempotencyKey: k1 });
  check("replay same key: same sprayId, still one charge", rep.status === 200 && rep.json?.sprayId === hrow.id && rep.json?.status === "delivered" && mock.chargesFor(hrow.provider_ref) === 1);
  const repT = await spray(P.id, R, { tier: "bundle", targetId: H, idempotencyKey: k1 });
  check("replay with a different tier: 409 IDEMPOTENCY_MISMATCH", repT.status === 409 && repT.json?.code === "IDEMPOTENCY_MISMATCH");
  const repG = await spray(P.id, R, { tier: "note", targetId: G, idempotencyKey: k1 });
  check("replay with a different target: 409 IDEMPOTENCY_MISMATCH, no charge", repG.status === 409 && (await sprayRows(P.id)).length === 1);
  // Keys are per payer: another payer may use the same key string.
  const P2 = await payer("p_samekey");
  const other = await spray(P2.id, R, { tier: "note", targetId: H, idempotencyKey: k1 });
  check("another payer with the same key gets their own spray", other.status === 200 && other.json?.sprayId !== hrow.id, JSON.stringify(other.json));

  // ---- parallel double tap (same key, 6 at once): one charge, one delivery, one ledger row
  const PD = await payer("p_doubletap");
  const kd = key();
  const taps = await Promise.all(Array.from({ length: 6 }, () => spray(PD.id, R, { tier: "note", targetId: G, idempotencyKey: kd })));
  const ids = new Set(taps.filter((t) => t.status === 200).map((t) => t.json?.sprayId));
  const drows = await sprayRows(PD.id);
  check("double tap: one row", drows.length === 1, `${drows.length}`);
  check("double tap: every 200 names the same spray", ids.size === 1 && taps.every((t) => t.status === 200 || t.status === 429), JSON.stringify(taps.map((t) => t.status)));
  check("double tap: one charge, one delivery, one ledger row", mock.chargesFor(drows[0].provider_ref) === 1 && drows[0].status === "delivered" && (await ledger(drows[0].provider_ref, "spray")).length === 1);
  const gsp = spraySplit("note", "stage");
  check("stage guest spray: host cut and guest share stored, two shares sent", Number(drows[0].host_kobo) === gsp.hostKobo && Number(drows[0].guest_kobo) === gsp.guestKobo
    && mock.calls.charge.find((c) => c.reference === drows[0].provider_ref)?.split.shares.length === 2);

  // ---- co-host target (on stage implicitly)
  const PC = await payer("p_cohost");
  check("co-host is a valid target", (await spray(PC.id, R, body(CO))).json?.status === "delivered");

  // =============================================================== declined, insufficient, network
  const PX = await payer("p_declined");
  mock.nextCharge = "declined";
  const dec = await spray(PX.id, R, body(H));
  check("declined: 402 PAYMENT_DECLINED reason DECLINED", dec.status === 402 && dec.json?.code === "PAYMENT_DECLINED" && dec.json?.reason === "DECLINED", JSON.stringify(dec.json));
  const decRow = (await sprayRows(PX.id))[0];
  check("declined: row failed, spend released, no ledger", decRow?.status === "failed" && (await spentIn(R, PX.id)) === 0 && (await ledger(decRow.provider_ref, "spray")).length === 0);
  check("declined: no broadcast", !h.c.all((m) => m.type === "room:spray" && m.id === decRow.id).length);
  mock.nextCharge = "insufficient";
  const ins = await spray(PX.id, R, body(G));
  check("insufficient funds: 402 reason INSUFFICIENT_FUNDS", ins.status === 402 && ins.json?.reason === "INSUFFICIENT_FUNDS");
  const PN = await payer("p_network");
  mock.nextCharge = "network_charged";
  const net = await spray(PN.id, R, body(H));
  check("network answer lost but the charge went through: verified and delivered", net.status === 200 && net.json?.status === "delivered", JSON.stringify(net.json));
  const PN2 = await payer("p_network2");
  mock.nextCharge = "network_throw";
  mock.verifyThrows = true;
  const net2 = await spray(PN2.id, R, body(H));
  const n2row = (await sprayRows(PN2.id))[0];
  check("network unknown and verify down: 200 pending, row pending, spend still reserved", net2.status === 200 && net2.json?.status === "pending" && n2row?.status === "pending" && (await spentIn(R, PN2.id)) === SPRAY_CATALOGUE.note.kobo, JSON.stringify(net2.json));
  mock.verifyThrows = false;
  mock.nextCharge = "success";

  // =============================================================== first payment (no card), saveCard, 3D Secure
  const PF = await payer("p_first", { card: false });
  const kf1 = key();
  const f1 = await spray(PF.id, R, { tier: "note", targetId: H, idempotencyKey: kf1, saveCard: true });
  const f1row = (await sprayRows(PF.id))[0];
  check("no saved card: action_required with an authorization URL", f1.status === 200 && f1.json?.status === "action_required" && typeof f1.json?.authorizationUrl === "string", JSON.stringify(f1.json));
  // Client M7: a replay of the same key while the bank page is still open hands the same link back (one charge only).
  const f1again = await spray(PF.id, R, { tier: "note", targetId: H, idempotencyKey: kf1, saveCard: true });
  check("M7: replay while waiting for the bank answers action_required with the same link, no second checkout",
    f1again.status === 200 && f1again.json?.status === "action_required" && f1again.json?.authorizationUrl === f1.json?.authorizationUrl
    && f1again.json?.sprayId === f1row.id && mock.calls.start.filter((s) => s.reference === f1row.provider_ref).length === 1, JSON.stringify(f1again.json));
  check("first payment: callback is /rooms/:id?spray=<sprayId> on our origin", mock.calls.start.find((s) => s.reference === f1row.provider_ref)?.callbackUrl === `${base}/rooms/${R}?spray=${f1row.id}`);
  check("first payment: row pending, no charge of a saved card", f1row.status === "pending" && !mock.calls.charge.some((c) => c.reference === f1row.provider_ref));
  mock.pay(f1row.provider_ref);
  check("webhook charge.success: 200", (await webhook("charge.success", { reference: f1row.provider_ref, metadata: { type: "spray" } })) === 200);
  check("after the webhook: delivered", (await rowById(f1row.id)).status === "delivered");
  const saved = await ss.getSavedMethod(PF.id);
  check("saveCard true + reusable: the card is saved, encrypted (never the plain code)", !!saved && saved.authEnc.startsWith("v1:") && !saved.authEnc.includes(SECRET_CODE));
  const me = await rest("GET", "/api/users/me/spray", PF.id);
  check("GET /api/users/me/spray: last4 and brand only", me.status === 200 && JSON.stringify(Object.keys(me.json.method).sort()) === JSON.stringify(["brand", "last4"]) && me.json.method.last4 === "4242", JSON.stringify(me.json));
  const PF2 = await payer("p_first_nosave", { card: false });
  await spray(PF2.id, R, body(H));
  const f2row = (await sprayRows(PF2.id))[0];
  mock.pay(f2row.provider_ref);
  await webhook("charge.success", { reference: f2row.provider_ref });
  check("no saveCard: delivered but no card stored", (await rowById(f2row.id)).status === "delivered" && !(await ss.getSavedMethod(PF2.id)));
  const PF3 = await payer("p_first_notreusable", { card: false });
  await spray(PF3.id, R, { tier: "note", targetId: H, idempotencyKey: key(), saveCard: true });
  const f3row = (await sprayRows(PF3.id))[0];
  mock.pay(f3row.provider_ref, { reusable: false });
  await webhook("charge.success", { reference: f3row.provider_ref });
  check("saveCard true but the card is not reusable: not stored", !(await ss.getSavedMethod(PF3.id)));
  // Delete the card, then spray: action_required.
  const del = await rest("DELETE", "/api/users/me/spray/method", PF.id);
  check("DELETE method: 200 and the card is gone (auth_enc wiped)", del.status === 200 && !(await ss.getSavedMethod(PF.id))
    && (await q(`select auth_enc, deleted_at from user_payment_methods where user_id = $1`, [PF.id])).every((r: any) => r.auth_enc === "" && r.deleted_at));
  const afterDel = await spray(PF.id, R, body(G));
  check("after deleting the card: action_required", afterDel.json?.status === "action_required", JSON.stringify(afterDel.json));
  // 3D Secure: bag never charges the saved card silently.
  const P3 = await payer("p_bag");
  check("setup: room limit raised to 1,000,000 (verified)", (await rest("PUT", `/api/rooms/${R}/spray/limit`, P3.id, { kobo: 1000000 })).json?.limitKobo === 1000000);
  const bag = await spray(P3.id, R, body(H, "bag"));
  const bagRow = (await sprayRows(P3.id))[0];
  check("bag with a saved card: action_required (bank approval), chargeSaved never called", bag.json?.status === "action_required" && !mock.calls.charge.some((c) => c.reference === bagRow.provider_ref) && mock.calls.start.some((s) => s.reference === bagRow.provider_ref), JSON.stringify(bag.json));

  // =============================================================== webhook racing client poll racing the sweep
  const PR = await payer("p_race", { card: false });
  await spray(PR.id, R, body(G, "bundle"));
  const rrow = (await sprayRows(PR.id))[0];
  mock.pay(rrow.provider_ref);
  h.c.msgs = [];
  await Promise.all([
    webhook("charge.success", { reference: rrow.provider_ref }),
    webhook("charge.success", { reference: rrow.provider_ref }),
    rest("GET", `/api/rooms/${R}/spray/${rrow.id}`, PR.id),
    sweepPendingSprays(sprayClock.now() + 11 * 60_000),
    finalizeSpray(rrow.provider_ref),
  ]);
  check("race: delivered exactly once", (await rowById(rrow.id)).status === "delivered" && (await ledger(rrow.provider_ref, "spray")).length === 1);
  await h.c.waitFor((m) => m.type === "room:spray" && m.id === rrow.id, 5000);
  await sleep(300);
  check("race: one room:spray broadcast", h.c.all((m) => m.type === "room:spray" && m.id === rrow.id).length === 1);

  // =============================================================== references and payloads that must never become a spray
  const forged = makeSprayReference(R, P.id, "rain", H, sprayReferenceSecret());
  mock.txs.set(forged, { state: "paid", amountKobo: 10000000, currency: "NGN", metadata: { type: "spray" } });
  check("forged (well-formed, no row) reference: webhook 200", (await webhook("charge.success", { reference: forged })) === 200);
  check("forged reference: no row was created", (await q(`select 1 from spray_payments where provider_ref = $1`, [forged])).length === 0);
  check("junk reference with metadata type spray (string metadata): 200, nothing", (await webhook("charge.success", { reference: "made_up_ref_123", metadata: JSON.stringify({ type: "spray", roomId: R, payerId: P.id }) })) === 200);
  check("bad signature: 400", (await webhook("charge.success", { reference: rrow.provider_ref }, "bad")) === 400);
  // Fix round (R1 I4, owner ruling): a stored row is trusted by itself, so rotating the reference secret can never strand a
  // paid spray. (The MAC only gates references we have no row for: see the forged case above.)
  const PT = await payer("p_rotate", { card: false });
  await spray(PT.id, R, body(H));
  const trow = (await sprayRows(PT.id))[0];
  process.env.SPRAY_REF_SECRET = "rotated-after-an-incident";
  try {
    mock.pay(trow.provider_ref);
    await webhook("charge.success", { reference: trow.provider_ref });
    check("secret rotated between checkout and payment: still delivered once", (await rowById(trow.id)).status === "delivered" && (await ledger(trow.provider_ref, "spray")).length === 1);
  } finally { delete process.env.SPRAY_REF_SECRET; }
  // String metadata on a real spray reference: routed by the reference, processed normally.
  const PS = await payer("p_strmeta", { card: false });
  await spray(PS.id, R, body(H));
  const srow = (await sprayRows(PS.id))[0];
  mock.pay(srow.provider_ref);
  await webhook("charge.success", { reference: srow.provider_ref, metadata: JSON.stringify({ type: "spray" }) });
  check("string metadata on a spray reference: delivered", (await rowById(srow.id)).status === "delivered");
  // Wrong amount.
  const PW = await payer("p_amount", { card: false });
  await spray(PW.id, R, body(H));
  const wrow = (await sprayRows(PW.id))[0];
  mock.pay(wrow.provider_ref, { amountKobo: SPRAY_CATALOGUE.note.kobo - 1 });
  await webhook("charge.success", { reference: wrow.provider_ref });
  const wnow = await rowById(wrow.id);
  check("wrong amount: never delivered, refunded in full, reversed AMOUNT_MISMATCH", wnow.status === "reversed" && wnow.reason === "AMOUNT_MISMATCH" && mock.calls.refund.includes(wrow.provider_ref) && (await ledger(wrow.provider_ref, "spray")).length === 0, JSON.stringify(wnow));
  const wclaw = await clawbacksOf(wrow.id);
  check("C1: a reversal of a taken payment writes the host's clawback (origin reversal, the stored host share)",
    wclaw.length === 1 && wclaw[0].beneficiary_id === H && Number(wclaw[0].amount_kobo) === Number(wrow.host_kobo) && wclaw[0].origin === "reversal" && wclaw[0].status === "open", JSON.stringify(wclaw));
  // r4 N5 (owner decision): a small reversal debt alone does not bar receiving (default threshold 10,000 naira)...
  const PDEBT = await payer("p_debt");
  check("N5: one small reversal debt does not bar the host (under the threshold)", (await spray(PDEBT.id, R, body(H))).json?.status === "delivered");
  // ...but owing more than the threshold does (threshold set to 0 here, so this one debt is over it).
  const PDEBT2 = await payer("p_debt2");
  process.env.CLAWBACK_BLOCK_THRESHOLD_KOBO = "0";
  try { await refused("I2/N5: the host owes more than the threshold, so nobody can start a spray to them", PDEBT2.id, R, body(H)); }
  finally { delete process.env.CLAWBACK_BLOCK_THRESHOLD_KOBO; }
  // r4 N4: a debt that appears AFTER a spray started never reverses it at delivery (the split already happened).
  const PN4 = await payer("p_debt_late", { card: false });
  await spray(PN4.id, R, body(H));
  const n4 = (await sprayRows(PN4.id))[0];
  await q(`insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo, origin) values ($1,$1,$2,1000,'dispute')`, [H, n4.id]);
  mock.pay(n4.provider_ref);
  await webhook("charge.success", { reference: n4.provider_ref });
  check("N4: a paid spray is delivered even though the host now owes a chargeback clawback", (await rowById(n4.id)).status === "delivered" && !mock.calls.refund.includes(n4.provider_ref));
  await settleClawbacks(n4.id);
  await settleClawbacks(wrow.id);
  // Wrong currency, reported paid (defensive) and reported as the provider does (not paid, pending).
  const PCUR = await payer("p_currency", { card: false });
  await spray(PCUR.id, R, body(H));
  const crow = (await sprayRows(PCUR.id))[0];
  mock.pay(crow.provider_ref, { currency: "USD", paidFlag: true });
  await webhook("charge.success", { reference: crow.provider_ref });
  check("wrong currency (reported paid): reversed, never delivered", (await rowById(crow.id)).status === "reversed");
  await settleClawbacks(crow.id);
  // Fix round (R2 I2 / ruling 4): the provider reports a wrong-currency success as paid with its currency, so it is refunded
  // in full; it is never marked failed and kept (not by the webhook, not by the sweep's expiry).
  const PCUR2 = await payer("p_currency2", { card: false });
  await spray(PCUR2.id, R, body(H));
  const c2row = (await sprayRows(PCUR2.id))[0];
  mock.pay(c2row.provider_ref, { currency: "USD" });
  await q(`update spray_payments set created_at = now() - interval '11 minutes' where id = $1`, [c2row.id]); // the sweep would expire it
  await sweepPendingSprays(sprayClock.now());
  const c2now = await rowById(c2row.id);
  check("wrong currency: refunded in full (AMOUNT_MISMATCH), never failed, never delivered", c2now.status === "reversed" && c2now.reason === "AMOUNT_MISMATCH" && mock.calls.refund.includes(c2row.provider_ref), JSON.stringify(c2now));
  await settleClawbacks(c2row.id);

  // =============================================================== recipient leaves between payment and finalize
  const GL = await mk("guest_leaves", { payout: true });
  const gl = await joinRoom(GL, R);
  roomHub.setStage(R, { stage: [G, NOPAY, UNVSTAGE, GL], hands: [], invited: [] });
  const PL = await payer("p_left", { card: false });
  await spray(PL.id, R, body(GL));
  const lrow = (await sprayRows(PL.id))[0];
  gl.c.send({ type: "room:leave" });
  check("setup: the recipient left", await until(() => !roomHub.get(R, GL)));
  mock.pay(lrow.provider_ref);
  h.c.msgs = [];
  await webhook("charge.success", { reference: lrow.provider_ref });
  // Fix round (ruling 6): a recipient this process's hub does not see is waited for until the 60 s deadline (a deploy
  // overlap looks exactly like this), so the spray stays paid; then the sweep reverses it.
  check("recipient not seen: still paid before the deadline (not reversed yet)", (await rowById(lrow.id)).status === "paid" && mock.calls.refund.filter((r) => r === lrow.provider_ref).length === 0);
  clockAhead();
  try { await due(lrow.id); await sweepPendingSprays(sprayClock.now()); } finally { clockBack(); }
  const lnow = await rowById(lrow.id);
  check("recipient left: reversed RECIPIENT_LEFT", lnow.status === "reversed" && lnow.reason === "RECIPIENT_LEFT", JSON.stringify(lnow));
  check("recipient left: one refund call, spend released, refund ledger once, no spray ledger",
    mock.calls.refund.filter((r) => r === lrow.provider_ref).length === 1 && (await spentIn(R, PL.id)) === 0
    && (await ledger(lrow.provider_ref, "spray_refund")).length === 1 && (await ledger(lrow.provider_ref, "spray")).length === 0);
  check("recipient left: no room:spray", !h.c.all((m) => m.type === "room:spray" && m.id === lrow.id).length);
  check("recipient left: the payer is told (chat line to the payer only)", !!(await PL.c!.waitFor((m) => m.type === "room:chat" && m.system === "spray_reversed" && /refunded in full/.test(m.text), 5000))
    && !h.c.all((m) => m.system === "spray_reversed").length);
  check("recipient left: a spray_reversed notification", (await q(`select 1 from notifications where user_id = $1 and type = 'spray_reversed'`, [PL.id])).length === 1);
  check("recipient left: status poll says reversed with the reason", (await rest("GET", `/api/rooms/${R}/spray/${lrow.id}`, PL.id)).json?.reason === "RECIPIENT_LEFT");
  const lclaw = await clawbacksOf(lrow.id);
  check("C1: a stage spray reversal writes the host's cut AND the guest's share as clawbacks", lclaw.length === 2
    && lclaw.some((c: any) => c.beneficiary_id === H && Number(c.amount_kobo) === Number(lrow.host_kobo))
    && lclaw.some((c: any) => c.beneficiary_id === GL && Number(c.amount_kobo) === Number(lrow.guest_kobo))
    && lclaw.every((c: any) => c.origin === "reversal"), JSON.stringify(lclaw));
  await settleClawbacks(lrow.id);

  // =============================================================== server restart between payment and finalize (the sweep)
  const PRS = await payer("p_restart", { card: false });
  await spray(PRS.id, R, body(H));
  const rsrow = (await sprayRows(PRS.id))[0];
  mock.pay(rsrow.provider_ref);
  await q(`update spray_payments set status = 'paid', paid_at = now() where id = $1`, [rsrow.id]); // finalize died after "paid"
  await sweepPendingSprays(sprayClock.now());
  check("restart: the sweep delivers a paid spray once", (await rowById(rsrow.id)).status === "delivered" && (await ledger(rsrow.provider_ref, "spray")).length === 1);
  const PRS2 = await payer("p_restart_late", { card: false });
  await spray(PRS2.id, R, body(H));
  const rs2 = (await sprayRows(PRS2.id))[0];
  mock.pay(rs2.provider_ref);
  await q(`update spray_payments set status = 'paid', paid_at = now() - interval '2 minutes' where id = $1`, [rs2.id]);
  await sweepPendingSprays(sprayClock.now());
  check("restart: a paid spray past the 60 s deadline is reversed (TIMEOUT)", (await rowById(rs2.id)).status === "reversed" && (await rowById(rs2.id)).reason === "TIMEOUT");
  check("restart: the TIMEOUT reversal wrote its clawback too", (await clawbacksOf(rs2.id)).length === 1);
  await settleClawbacks(rs2.id);
  // Unpaid and stale: failed, spend released. Then the payment lands late: refunded, never delivered, spend not given twice.
  const PU = await payer("p_unpaid", { card: false });
  await spray(PU.id, R, body(H));
  const urow = (await sprayRows(PU.id))[0];
  await q(`update spray_payments set created_at = now() - interval '11 minutes' where id = $1`, [urow.id]);
  await sweepPendingSprays(sprayClock.now());
  check("stale unpaid: failed (TIMEOUT) and the spend released", (await rowById(urow.id)).status === "failed" && (await spentIn(R, PU.id)) === 0);
  mock.pay(urow.provider_ref);
  await webhook("charge.success", { reference: urow.provider_ref });
  const late = await rowById(urow.id);
  check("late payment after failed: refunded (reversed LATE_PAYMENT), never delivered", late.status === "reversed" && late.reason === "LATE_PAYMENT" && mock.calls.refund.includes(urow.provider_ref));
  check("late payment: spend not released twice", (await spentIn(R, PU.id)) === 0);
  await settleClawbacks(urow.id);
  // Fix round (R1 I5 / ruling 10): a late payment with NO webhook is still found: the sweep re-checks failed rows.
  const PU2 = await payer("p_unpaid_nohook", { card: false });
  await spray(PU2.id, R, body(H));
  const u2 = (await sprayRows(PU2.id))[0];
  await q(`update spray_payments set created_at = now() - interval '11 minutes' where id = $1`, [u2.id]);
  await sweepPendingSprays(sprayClock.now());
  check("setup: expired to failed", (await rowById(u2.id)).status === "failed");
  mock.pay(u2.provider_ref); // no webhook ever arrives
  await due(u2.id);
  await sweepPendingSprays(sprayClock.now());
  const u2now = await rowById(u2.id);
  check("late payment without a webhook: the sweep refunds it (LATE_PAYMENT)", u2now.status === "reversed" && u2now.reason === "LATE_PAYMENT" && mock.calls.refund.includes(u2.provider_ref), JSON.stringify(u2now));
  check("the sweep recorded its checks (attempts, backoff)", Number(u2now.check_attempts) >= 2 && !!u2now.last_checked_at);
  await settleClawbacks(u2.id);

  // =============================================================== refund fails: stays reversing, retried, never silently reversed
  const GF = await mk("guest_refundfail", { payout: true });
  const gf = await joinRoom(GF, R);
  roomHub.setStage(R, { stage: [G, NOPAY, UNVSTAGE, GF], hands: [], invited: [] });
  const PRF = await payer("p_refundfail", { card: false });
  await spray(PRF.id, R, body(GF));
  const rfrow = (await sprayRows(PRF.id))[0];
  gf.c.send({ type: "room:leave" });
  await until(() => !roomHub.get(R, GF));
  mock.pay(rfrow.provider_ref);
  mock.refundMode = "outage";
  await webhook("charge.success", { reference: rfrow.provider_ref });
  clockAhead(); // past the delivery deadline: the absent recipient now means a reversal
  try { await due(rfrow.id); await sweepPendingSprays(sprayClock.now()); } finally { clockBack(); }
  check("refund outage: stays reversing", (await rowById(rfrow.id)).status === "reversing");
  await due(rfrow.id);
  await sweepPendingSprays(sprayClock.now());
  check("refund outage: the sweep retried, still reversing (never silently reversed)", (await rowById(rfrow.id)).status === "reversing" && mock.calls.refund.filter((r) => r === rfrow.provider_ref).length >= 2);
  // The sweep backs off a row it could not finish: not due again at once.
  const refundCalls = mock.calls.refund.filter((r) => r === rfrow.provider_ref).length;
  await sweepPendingSprays(sprayClock.now());
  check("I3: a row in backoff is not retried on the very next pass", mock.calls.refund.filter((r) => r === rfrow.provider_ref).length === refundCalls);
  mock.refundMode = "refusal";
  await due(rfrow.id);
  await sweepPendingSprays(sprayClock.now());
  check("refund refused: still reversing, a refund_failed issue for a person", (await rowById(rfrow.id)).status === "reversing"
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and reason = 'refund_failed' and resolved_at is null`, [rfrow.provider_ref])).length === 1);
  mock.refundLookupThrows = true; mock.refundMode = "ok";
  const refundsBefore = mock.calls.refund.length;
  await due(rfrow.id);
  await sweepPendingSprays(sprayClock.now());
  check("refund lookup down: nothing sent (fail closed)", mock.calls.refund.length === refundsBefore && (await rowById(rfrow.id)).status === "reversing");
  mock.refundLookupThrows = false;
  await due(rfrow.id);
  await sweepPendingSprays(sprayClock.now());
  check("provider back: reversed, issues resolved, one refund ledger row", (await rowById(rfrow.id)).status === "reversed"
    && (await ledger(rfrow.provider_ref, "spray_refund")).length === 1
    && (await q(`select 1 from payment_issues where provider_payment_id = $1 and resolved_at is null`, [rfrow.provider_ref])).length === 0);
  await settleClawbacks(rfrow.id);

  // =============================================================== chargeback after delivery: clawbacks, idempotent
  const dref = drows[0].provider_ref; // the double-tap spray to the stage guest G (delivered)
  check("dispute: 200", (await webhook("charge.dispute.create", { id: 1, transaction: { reference: dref, amount: 1 } })) === 200);
  const disp = await q(`select * from spray_payments where provider_ref = $1`, [dref]);
  const claws = await q(`select * from host_clawbacks where spray_id = $1 order by amount_kobo`, [disp[0].id]);
  check("dispute: spray disputed, chargeback ledger once", disp[0].status === "disputed" && (await ledger(dref, "chargeback")).length === 1);
  check("dispute: clawbacks equal the stored host and guest shares (payload amounts ignored)", claws.length === 2
    && claws.some((c: any) => c.beneficiary_id === H && Number(c.amount_kobo) === gsp.hostKobo && c.status === "open")
    && claws.some((c: any) => c.beneficiary_id === G && Number(c.amount_kobo) === gsp.guestKobo && c.status === "open"), JSON.stringify(claws));
  await webhook("charge.dispute.create", { transaction: { reference: dref } });
  await webhook("charge.dispute.remind", { transaction: { reference: dref } });
  check("dispute again: no-op (same rows, one ledger row)", (await q(`select 1 from host_clawbacks where spray_id = $1`, [disp[0].id])).length === 2 && (await ledger(dref, "chargeback")).length === 1);
  check("I1: every dispute opens ONE 'dispute' issue for a person to answer in Paystack", (await issues(dref, "dispute")).filter((i: any) => !i.resolved_at).length === 1);
  check("dispute clawbacks are origin dispute", claws.every((c: any) => c.origin === "dispute"));
  const lclawBefore = (await clawbacksOf(lrow.id)).length;
  check("dispute on a reversed spray: no new clawback (the reversal's stay), still reversed, an issue says contest with the refund",
    (await webhook("charge.dispute.create", { transaction: { reference: lrow.provider_ref } })) === 200
    && (await clawbacksOf(lrow.id)).length === lclawBefore && (await rowById(lrow.id)).status === "reversed"
    && (await issues(lrow.provider_ref, "dispute")).some((i: any) => /AFTER_REFUND/.test(i.error_message ?? "")));
  // r4 N1: the payer then WINS that chargeback: they were paid back twice; a person is told.
  check("N1: payer wins a dispute on a refunded spray: a LOST_AFTER_REFUND issue (never silent)",
    (await webhook("charge.dispute.resolve", { transaction: { reference: lrow.provider_ref }, resolution: "merchant-accepted" })) === 200
    && (await issues(lrow.provider_ref, "dispute_resolved")).some((i: any) => /LOST_AFTER_REFUND/.test(i.error_message ?? "") && !i.resolved_at)
    && (await issues(lrow.provider_ref, "dispute")).every((i: any) => !!i.resolved_at));
  // r4 N2: the merchant wins on a refunded spray: never "refund the payer by hand" (they were refunded already).
  await webhook("charge.dispute.create", { transaction: { reference: wrow.provider_ref } });
  check("N2: merchant wins a dispute on a refunded spray: no refund-by-hand issue, no money action",
    (await webhook("charge.dispute.resolve", { transaction: { reference: wrow.provider_ref }, resolution: "declined" })) === 200
    && !(await issues(wrow.provider_ref, "dispute_resolved")).some((i: any) => /UNDELIVERED|REPAY/.test(i.error_message ?? ""))
    && (await rowById(wrow.id)).status === "reversed");
  check("dispute: status poll for the payer says DISPUTED", (await rest("GET", `/api/rooms/${R}/spray/${disp[0].id}`, PD.id)).json?.reason === "DISPUTED");
  // ---- settlement deducts open clawbacks (host H owes gsp.hostKobo)
  const PRICE = 500000;
  const TB = ticketBreakdown(PRICE);
  const mkPaidRoom = async (hostId: string) => {
    const id = (await q(
      `insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for, started_at, ended_at, ticket_price_kobo, ticket_capacity, refund_before_start, minors_room, moderation_status)
       values ($1, $2, 'party', 'public', '18+', 'ended', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', $3, 50, true, false, 'approved') returning id`,
      [hostId, `sp paid ${++seq}`, PRICE]))[0].id as string;
    madeRooms.push(id);
    const buyer = await mk(`buyer${seq}`);
    await q(`insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'paystack',$9,'paid')`, [id, buyer, TB.price, TB.vat, TB.fee, TB.reserve, TB.platform, TB.host, `sp_tref_${stamp}_${seq}`]);
    await q(`insert into room_payouts (room_id, host_id, amount_kobo, status, release_at) values ($1,$2,$3,'held', now() - interval '1 hour')`, [id, hostId, TB.host]);
    return id;
  };
  const PRm = await mkPaidRoom(H);
  await runSettlementPass(new Date());
  const pay1 = (await q(`select * from room_payouts where room_id = $1`, [PRm]))[0];
  check("settlement: pays max(0, amount - open clawbacks)", Number(pay1.amount_kobo) === TB.host - gsp.hostKobo, JSON.stringify(pay1));
  check("settlement: the host's clawback is recovered, the guest's stays open (the guest owes it)", (await q(`select status from host_clawbacks where spray_id = $1 and beneficiary_id = $2`, [disp[0].id, H]))[0]?.status === "recovered"
    && (await q(`select status from host_clawbacks where spray_id = $1 and beneficiary_id = $2`, [disp[0].id, G]))[0]?.status === "open");
  // I7: the dispute is resolved in the platform's favour ("declined"): the open dispute clawback (the guest's) is settled;
  // the host's share was already taken from a payout, so a person must repay it (a dispute_resolved issue).
  check("dispute resolved: 200", (await webhook("charge.dispute.resolve", { transaction: { reference: dref }, resolution: "declined" })) === 200);
  check("dispute won: the guest's open dispute clawback is settled (recovered in full)", (await q(`select status, recovered_kobo, amount_kobo from host_clawbacks where spray_id = $1 and beneficiary_id = $2`, [disp[0].id, G]))
    .every((c: any) => c.status === "recovered" && Number(c.recovered_kobo) === Number(c.amount_kobo)));
  check("dispute won: the dispute issue is closed and a person is asked to repay what a payout already took",
    (await issues(dref, "dispute")).every((i: any) => !!i.resolved_at) && (await issues(dref, "dispute_resolved")).some((i: any) => /REPAY/.test(i.error_message ?? "")));
  // I1: a dispute on a spray that was never delivered (H and G owe nothing now): disputed (delivery blocked for good),
  // clawbacks (the split went at charge time), an issue. A later charge.success never delivers it, and it is never refunded
  // again as a late payment.
  const PDP = await payer("p_dispute_pending", { card: false });
  const dpStart = await spray(PDP.id, R, body(H));
  const dprow = (await sprayRows(PDP.id))[0];
  check("setup: an undelivered spray waiting for the bank page", dpStart.json?.status === "action_required" && dprow?.status === "pending", JSON.stringify(dpStart.json));
  check("setup: the room spend is reserved", (await spentIn(R, PDP.id)) === SPRAY_CATALOGUE.note.kobo);
  check("undelivered dispute: 200", (await webhook("charge.dispute.create", { transaction: { reference: dprow.provider_ref } })) === 200);
  check("r4 m3: the disputed spray gives the payer's room spend back (it will never be delivered)", (await spentIn(R, PDP.id)) === 0);
  check("undelivered dispute: disputed, host clawback opened, issue opened", (await rowById(dprow.id)).status === "disputed"
    && (await clawbacksOf(dprow.id)).length === 1 && (await issues(dprow.provider_ref, "dispute")).some((i: any) => /UNDELIVERED/.test(i.error_message ?? "")));
  mock.pay(dprow.provider_ref);
  await webhook("charge.success", { reference: dprow.provider_ref });
  check("undelivered dispute: a later payment never delivers it", (await rowById(dprow.id)).status === "disputed" && (await ledger(dprow.provider_ref, "spray")).length === 0
    && !mock.calls.refund.includes(dprow.provider_ref));
  check("undelivered dispute won: a person is asked to refund the payer, clawbacks stay open",
    (await webhook("charge.dispute.resolve", { transaction: { reference: dprow.provider_ref }, resolution: "declined" })) === 200
    && (await issues(dprow.provider_ref, "dispute_resolved")).some((i: any) => /UNDELIVERED/.test(i.error_message ?? ""))
    && (await clawbacksOf(dprow.id)).every((c: any) => c.status === "open"));
  await settleClawbacks(dprow.id);
  // r4 N3: the dispute clawbacks were ALL recovered by payouts before the dispute was won: the host is still repaid
  // (a REPAY issue), and a repeated resolve event changes nothing (the chargeback ledger row flips once).
  const dref2 = hrow.provider_ref; // the happy-path note to H (delivered)
  await webhook("charge.dispute.create", { transaction: { reference: dref2 } });
  await q(`update host_clawbacks set status = 'recovered', recovered_kobo = amount_kobo, recovered_at = now() where spray_id = $1 and origin = 'dispute'`, [hrow.id]); // a payout took it
  check("N3: setup: disputed, its dispute clawback fully recovered", (await rowById(hrow.id)).status === "disputed" && (await clawbacksOf(hrow.id)).every((c: any) => c.status === "recovered"));
  await webhook("charge.dispute.resolve", { transaction: { reference: dref2 }, resolution: "declined" });
  check("N3: dispute won after a payout recovered everything: a REPAY issue for the full amount taken",
    (await issues(dref2, "dispute_resolved")).some((i: any) => /REPAY/.test(i.error_message ?? "") && (i.error_message ?? "").includes(String(hrow.host_kobo))));
  check("N3: the chargeback ledger row flipped once to chargeback_won", (await ledger(dref2, "chargeback"))[0]?.status === "chargeback_won");
  const issuesBefore = (await issues(dref2, "dispute_resolved")).length;
  await q(`update payment_issues set resolved_at = now() where provider_payment_id = $1 and reason = 'dispute_resolved'`, [dref2]); // a person handled it
  await webhook("charge.dispute.resolve", { transaction: { reference: dref2 }, resolution: "declined" });
  check("N3: a repeated resolve event changes nothing (no new issue)", (await issues(dref2, "dispute_resolved")).length === issuesBefore);
  // r5 I2: a second dispute cycle that ends the OTHER way is never swallowed as "already", and its dispute issue stays open.
  await webhook("charge.dispute.create", { transaction: { reference: dref2 } }); // pre-arbitration: a new dispute issue
  const clawsBeforeI2 = JSON.stringify(await clawbacksOf(hrow.id));
  await webhook("charge.dispute.resolve", { transaction: { reference: dref2 }, resolution: "merchant-accepted" });
  check("r5 I2: an outcome that differs from the ledger opens an OUTCOME_CHANGED issue",
    (await issues(dref2, "dispute_resolved")).some((i: any) => !i.resolved_at && /OUTCOME_CHANGED/.test(i.error_message ?? "")));
  check("r5 I2: nothing acted, so the new dispute issue stays open and the clawbacks are unchanged",
    (await issues(dref2, "dispute")).some((i: any) => !i.resolved_at) && JSON.stringify(await clawbacksOf(hrow.id)) === clawsBeforeI2
    && (await ledger(dref2, "chargeback"))[0]?.status === "chargeback_won");
  // r5 I3: an unknown resolution word first, then "declined": the REPAY issue (with the amount) still lands.
  const orow = await rowById(other.json.sprayId);
  await webhook("charge.dispute.create", { transaction: { reference: orow.provider_ref } });
  await q(`update host_clawbacks set recovered_kobo = 100 where spray_id = $1 and origin = 'dispute'`, [orow.id]); // a payout took 100 kobo
  await webhook("charge.dispute.resolve", { transaction: { reference: orow.provider_ref }, resolution: "under-review-new-word" });
  check("r5 I3 setup: unknown word: an UNKNOWN issue, the dispute issue stays open, nothing flipped",
    (await issues(orow.provider_ref, "dispute_resolved")).some((i: any) => !i.resolved_at && /UNKNOWN/.test(i.error_message ?? ""))
    && (await issues(orow.provider_ref, "dispute")).some((i: any) => !i.resolved_at) && (await ledger(orow.provider_ref, "chargeback"))[0]?.status === "disputed");
  await webhook("charge.dispute.resolve", { transaction: { reference: orow.provider_ref }, resolution: "declined" });
  const oIssues = await issues(orow.provider_ref, "dispute_resolved");
  check("r5 I3: the REPAY issue for 100 kobo is open; the superseded UNKNOWN issue is closed",
    oIssues.some((i: any) => !i.resolved_at && /REPAY/.test(i.error_message ?? "") && /\b100 kobo\b/.test(i.error_message ?? ""))
    && oIssues.filter((i: any) => /UNKNOWN/.test(i.error_message ?? "")).every((i: any) => !!i.resolved_at), JSON.stringify(oIssues));
  check("r5 I3: the dispute clawbacks are settled and the dispute issue closed", (await clawbacksOf(orow.id)).filter((c: any) => c.origin === "dispute").every((c: any) => c.status === "recovered")
    && (await issues(orow.provider_ref, "dispute")).every((i: any) => !!i.resolved_at));
  check("r5 I3: the amount owed back is also in the log line", logged.some((l) => l.includes(`outcome=needs_person`) && l.includes("owed_back_kobo=100")));
  // r5 m2: a refunded spray whose LOST_AFTER_REFUND issue a person already closed: a redelivered event adds nothing.
  await q(`update payment_issues set resolved_at = now() where provider_payment_id = $1 and reason = 'dispute_resolved'`, [lrow.provider_ref]);
  const lostBefore = (await issues(lrow.provider_ref, "dispute_resolved")).length;
  await webhook("charge.dispute.resolve", { transaction: { reference: lrow.provider_ref }, resolution: "merchant-accepted" });
  check("r5 m2: no duplicate LOST_AFTER_REFUND issue", (await issues(lrow.provider_ref, "dispute_resolved")).length === lostBefore);
  // A clawback bigger than the payout: closed at 0, nothing sent.
  const H3 = await mk("host_bigclaw", { payout: true });
  await q(`insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo) values ($1,$1,$2,$3)`, [H3, hrow.id, TB.host]);
  const PRm3 = await mkPaidRoom(H3);
  await runSettlementPass(new Date());
  const pay3 = (await q(`select * from room_payouts where room_id = $1`, [PRm3]))[0];
  check("settlement: a payout fully used by clawbacks is closed at 0 (CLAWED_BACK), never sent", pay3.status === "paid" && Number(pay3.amount_kobo) === 0 && pay3.last_error === "CLAWED_BACK", JSON.stringify(pay3));
  // applyClawbacks directly: a row larger than what is left stays open.
  const H4 = await mk("host_partial");
  await q(`insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo) values ($1,$1,$2,100)`, [H4, hrow.id]);
  await q(`insert into host_clawbacks (host_id, beneficiary_id, spray_id, amount_kobo) values ($1,$1,$2,500)`, [H4, rrow.id]);
  const ap = await applyClawbacks(H4, 300);
  check("applyClawbacks: oldest first, the 100 in full and 200 of the 500 (partial recovery), the 500 stays open",
    ap.appliedKobo === 300 && ap.remainingOpen === 1 && ap.recoveredIds.length === 1 && ap.partialIds.length === 1, JSON.stringify(ap));
  check("partial recovery is recorded (recovered_kobo 200, still open)", (await q(`select status, recovered_kobo from host_clawbacks where beneficiary_id = $1 and amount_kobo = 500`, [H4]))
    .every((c: any) => c.status === "open" && Number(c.recovered_kobo) === 200));
  const ap2 = await applyClawbacks(H4, 1000);
  check("the next payout takes only what is still owed (300), then it is recovered", ap2.appliedKobo === 300 && ap2.remainingOpen === 0);

  // =============================================================== limits (task 5.5)
  const PLIM = await payer("p_limits");
  const g0 = await rest("GET", "/api/users/me/spray", PLIM.id);
  check("GET me/spray: defaults", g0.status === 200 && g0.json.dailyLimitKobo === 2000000 && g0.json.dailySpentKobo === 0 && g0.json.verified === true, JSON.stringify(g0.json));
  check("GET me/spray for a teen: generic 403 (teens never see money controls)", isGeneric403(await rest("GET", "/api/users/me/spray", TEEN)));
  check("unverified adult cannot raise the daily limit above the default: 403 ID_REQUIRED", (await rest("PUT", "/api/users/me/spray/daily-limit", UNV, { kobo: 2000001 })).json?.code === "ID_REQUIRED");
  check("unverified adult may set it at the default", (await rest("PUT", "/api/users/me/spray/daily-limit", UNV, { kobo: 2000000 })).status === 200);
  check("verified: up to 10,000,000", (await rest("PUT", "/api/users/me/spray/daily-limit", PLIM.id, { kobo: 10000000 })).json?.dailyLimitKobo === 10000000);
  check("never above 10,000,000: 400", (await rest("PUT", "/api/users/me/spray/daily-limit", PLIM.id, { kobo: 10000001 })).status === 400);
  check("room limit not an option: 400", (await rest("PUT", `/api/rooms/${R}/spray/limit`, PLIM.id, { kobo: 123456 })).status === 400);
  check("room limit 100,000 naira unverified: 403 ID_REQUIRED", (await rest("PUT", `/api/rooms/${R}/spray/limit`, UNV, { kobo: 10000000 })).json?.code === "ID_REQUIRED");
  check("room limit for a teen: generic 403", isGeneric403(await rest("PUT", `/api/rooms/${R}/spray/limit`, TEEN, { kobo: 50000 })));
  const rl = await rest("PUT", `/api/rooms/${R}/spray/limit`, PLIM.id, { kobo: 100000 });
  check("room limit set: { limitKobo, spentKobo }", rl.json?.limitKobo === 100000 && rl.json?.spentKobo === 0, JSON.stringify(rl.json));
  check("room limit boundary: equal to the limit is allowed", (await spray(PLIM.id, R, body(H, "bundle"))).json?.status === "delivered");
  const over = await spray(PLIM.id, R, body(G));
  check("room limit boundary: one more note is 409 ROOM_LIMIT, no charge", over.status === 409 && over.json?.code === "ROOM_LIMIT" && (await sprayRows(PLIM.id)).length === 1);
  // Fix round (R1 M1 / ruling 5): the payer's own limits are answered BEFORE anything about the target, so the answer is
  // the same whoever they name: a plain guest, someone without a payout account, an unknown id. No oracle.
  for (const [n, t] of [["a plain guest", PLAIN], ["a stage person without a payout account", NOPAY], ["an unknown id", "00000000-0000-4000-8000-000000000000"]] as const) {
    const r = await spray(PLIM.id, R, body(t));
    check(`M1: at their own room limit, spraying ${n} is the same 409 ROOM_LIMIT`, r.status === 409 && r.json?.code === "ROOM_LIMIT", `${r.status} ${JSON.stringify(r.json)}`);
  }
  // Daily total across rooms.
  const PDAY = await payer("p_daily");
  await rest("PUT", "/api/users/me/spray/daily-limit", PDAY.id, { kobo: 100000 });
  check("daily: first bundle fits", (await spray(PDAY.id, R, body(H, "bundle"))).json?.status === "delivered");
  const H5 = await mk("host_daily", { payout: true });
  const R5 = await mkRoom(H5);
  await joinRoom(H5, R5);
  await joinRoom(PDAY.id, R5); // leaves R, joins R5
  const dd = await spray(PDAY.id, R5, body(H5));
  check("daily total across rooms: 409 DAILY_LIMIT", dd.status === 409 && dd.json?.code === "DAILY_LIMIT", JSON.stringify(dd.json));
  // Two tabs and two devices racing the room limit: never over.
  const PRL = await payer("p_racelimit");
  await rest("PUT", `/api/rooms/${R}/spray/limit`, PRL.id, { kobo: 100000 });
  const racers = await Promise.all([H, G, CO, H, G, CO].map((t) => spray(PRL.id, R, body(t, "bundle"))));
  const delivered = (await sprayRows(PRL.id)).filter((r: any) => r.status === "delivered").length;
  check("limit race: at most one bundle delivered against a 100,000 limit, spent never over", delivered === 1 && (await spentIn(R, PRL.id)) <= 100000, `${delivered} ${JSON.stringify(racers.map((r) => r.status))}`);
  // Daily race across two rooms.
  const PDR = await payer("p_racedaily");
  await rest("PUT", "/api/users/me/spray/daily-limit", PDR.id, { kobo: 100000 });
  await Promise.all([spray(PDR.id, R, body(H, "bundle")), spray(PDR.id, R, body(G, "bundle")), spray(PDR.id, R, body(CO, "bundle"))]);
  check("daily race: the rolling 24 h total never passes the limit", Number((await q(`select coalesce(sum(amount_kobo),0) as n from spray_payments where payer_id = $1 and status in ('created','pending','paid','delivered','reversing','disputed')`, [PDR.id]))[0].n) <= 100000);
  // Velocity: 10 a minute per payer, 3 a minute per recipient, Retry-After.
  const PV = await payer("p_velocity");
  const vrow = await sprayRows(P.id);
  for (let i = 0; i < 10; i++) {
    await q(`insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, guest_kobo, provider, provider_ref, status, reason)
             select $1, request_hash, room_id, host_id, $2, recipient_id, tier, v3c, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, guest_kobo, provider, $3, 'failed', 'DECLINED' from spray_payments where id = $4`,
      [key(), PV.id, `vib3rs_${crypto.randomBytes(12).toString("hex")}_${crypto.randomBytes(16).toString("hex")}`, vrow[0].id]);
  }
  const vel = await spray(PV.id, R, body(G));
  check("velocity: 11th in a minute is 429 RATE_LIMITED with Retry-After", vel.status === 429 && vel.json?.code === "RATE_LIMITED" && !!vel.headers.get("retry-after"), `${vel.status} ${JSON.stringify(vel.json)}`);
  // One in flight per (payer, recipient): a pending bank approval blocks a second spray to the same person for 10 s.
  const PIF = await payer("p_inflight", { card: false });
  await spray(PIF.id, R, body(H));
  const inflight = await spray(PIF.id, R, body(H));
  check("one in flight per payer and recipient: 429 with Retry-After", inflight.status === 429 && !!inflight.headers.get("retry-after"));

  // =============================================================== new host receive cap
  const HN = await mk("host_new", { payout: true });
  const RN = await mkRoom(HN);
  await q(`update users set created_at = now() where id = $1`, [HN]); // a brand new host
  await joinRoom(HN, RN);
  const PNH = await payer("p_newhost", { join: false });
  await joinRoom(PNH.id, RN);
  process.env.NEW_HOST_RECEIVE_CAP_KOBO = "100000";
  check("new host cap: up to the cap is fine", (await spray(PNH.id, RN, body(HN, "bundle"))).json?.status === "delivered");
  await refused("new host cap: over it at start", PNH.id, RN, body(HN));
  // Fix round (R1 C2): the cap applies to the RECIPIENT too. A brand new account on the stage of an established host's room.
  const GN = await mk("guest_new", { payout: true, newAccount: true });
  await joinRoom(GN, R);
  roomHub.setStage(R, { stage: [G, NOPAY, UNVSTAGE, GN], hands: [], invited: [] });
  const PGN = await payer("p_newguest");
  process.env.NEW_HOST_RECEIVE_CAP_KOBO = "50000";
  check("C2: a new stage guest can receive up to the cap", (await spray(PGN.id, R, body(GN))).json?.status === "delivered");
  await refused("C2: a new stage guest over the cap at start (the host is established)", PGN.id, R, body(GN));
  check("C2: the established host is not capped", (await spray(PGN.id, R, body(H))).json?.status === "delivered");
  delete process.env.NEW_HOST_RECEIVE_CAP_KOBO;

  // =============================================================== the room's spray block (GET /api/rooms/:id)
  const PB = await payer("p_block");
  const gb = await rest("GET", `/api/rooms/${R}`, PB.id);
  check("spray block for an eligible payer in the room", gb.json?.spray?.enabled === true && typeof gb.json.spray.roomLimitKobo === "number", JSON.stringify(gb.json?.spray));
  check("spray block targets: host, payable stage guest and co-host; never the unverified, unpayable or plain guest",
    [H, G, CO].every((t) => gb.json?.spray?.targets.includes(t)) && ![UNVSTAGE, NOPAY, PLAIN, PB.id].some((t) => gb.json?.spray?.targets.includes(t)), JSON.stringify(gb.json?.spray?.targets));
  check("spray block absent for an unverified adult (never enabled: false)", !("spray" in ((await rest("GET", `/api/rooms/${R}`, UNV)).json ?? {})));
  check("spray block absent for someone outside the room", !("spray" in ((await rest("GET", `/api/rooms/${R}`, OUT.id)).json ?? {})));
  roomFeatures.spray = false;
  check("spray block absent with the flag off", !("spray" in ((await rest("GET", `/api/rooms/${R}`, PB.id)).json ?? {})));
  roomFeatures.spray = true;

  // =============================================================== secrets: never in a response or a log
  const emails = await Promise.all([P.id, PF.id, PL.id].map(emailOf));
  const allOut = responses.join("\n");
  const allLog = logged.join("\n");
  check("the authorization code never appears in any response", !allOut.includes(SECRET_CODE));
  check("the card signature never appears in any response", !allOut.includes(SECRET_SIG));
  check("the authorization code never appears in any log line", !allLog.includes(SECRET_CODE));
  check("the card signature never appears in any log line", !allLog.includes(SECRET_SIG));
  check("payer emails never logged", emails.every((e) => !allLog.includes(e)));
  check("no auth_enc ciphertext in any response", !/"authEnc"|"auth_enc"|v1:[A-Za-z0-9_-]{30,}/.test(allOut));
  check("redaction strips authorization keys from a body that forgets", (() => {
    let sent: any = null;
    const res: any = { json: (b: any) => { sent = b; return res; } };
    redactSensitiveFields({} as any, res, () => {});
    res.json({ a: { authorizationCode: "x", authorization_code: "x", authEnc: "x", auth_enc: "x", signature: "x", last4: "4242", authorization: { authorizationCode: "x" } } });
    return sent && !("authorizationCode" in sent.a) && !("authEnc" in sent.a) && !("signature" in sent.a) && !("authorization" in sent.a) && sent.a.last4 === "4242";
  })());

  // =============================================================== boot: production with the flag off and no key still boots
  let threw = false;
  try { assertPaymentTokenKeyForBoot(false, { NODE_ENV: "production" } as any); } catch { threw = true; }
  check("production boot with the flag off and no PAYMENT_TOKEN_KEY: no throw", !threw);
  threw = false;
  try { assertPaymentTokenKeyForBoot(true, { NODE_ENV: "production" } as any); } catch { threw = true; }
  check("production boot with the flag ON and no key: refuses", threw);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = false;
  setSplitProviderForTests(null);
  setPaymentProviderForTests(null);
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    if (created.length) {
      // Money records are RESTRICT: children first.
      await q(`delete from host_clawbacks where host_id = any($1::varchar[]) or beneficiary_id = any($1::varchar[])`, [created]);
      await q(`delete from payment_transactions where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from payment_issues where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from spray_payments where payer_id = any($1::varchar[]) or host_id = any($1::varchar[])`, [created]);
      await q(`delete from payment_transactions where type = 'room_payout' and organizer_id = any($1::varchar[])`, [created]);
      await q(`delete from room_payouts where host_id = any($1::varchar[])`, [created]);
      await q(`delete from room_tickets where room_id = any($1::varchar[])`, [madeRooms]);
      await q(`delete from users where id = any($1::varchar[])`, [created]);
    }
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
