// Rooms gaming: team spray (POST /api/rooms/:id/spray/team), over a real WebSocket server with the REST routes on the same
// server, against a MOCK split provider.   npm run test:rooms   (database name must contain "test"; usernames prefix gt_)
// Owner order (2026-10-22): the deductions come off the WHOLE charge, the pool is split equally into the players' subaccounts.
// A charge that went through is delivered even when the room/player is gone (the PSP, not us, returns money that did not arrive).
// Every check waits on an event, never on a short fixed sleep. Nothing here is a real charge.
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
process.env.SESSION_SECRET ||= "teamspray-ws-test-session-secret";
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
const { finalizeSpray, SPRAY_UNAVAILABLE } = await import("../server/rooms/spray");
const { stopSprayJob, sweepPendingSprays } = await import("../server/rooms/sprayJobs");
const ss = await import("../server/rooms/sprayStorage");
const rs = await import("../server/rooms/roomStorage");
const { newGame } = await import("../shared/gameScreen");
const { teamSprayBreakdown } = await import("../shared/money");

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

// ---- mock split provider (scripted, minimal); keeps the split it was asked for so the test can read the cuts
type Tx = { state: "paid" | "failed" | "pending"; amountKobo: number; metadata: Record<string, string>; split: { shares: { subaccountCode: string; amountKobo: number }[]; team?: true } };
const mock = {
  txs: new Map<string, Tx>(),
  refunds: new Set<string>(),
  charges: 0,
  firstPayments: 0,
  async startFirstPayment(p: any) { this.firstPayments++; this.txs.set(p.reference, { state: "pending", amountKobo: p.amountKobo, metadata: p.metadata, split: p.split }); return { url: `https://checkout.paystack.test/${p.reference}` }; },
  async chargeSaved(p: any) { this.charges++; this.txs.set(p.reference, { state: "paid", amountKobo: p.amountKobo, metadata: p.metadata, split: p.split }); return { status: "success", reference: p.reference }; },
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
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.79.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json, raw: JSON.stringify(json) };
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
const hash = await bcrypt.hash("Passw0rd!teamspray", 4);
const stamp = Date.now();
const created: string[] = [];
const codeOf = new Map<string, string>(); // user id -> subaccount code (test only)
let seq = 0;
const mk = async (name: string, o: { payout?: boolean; card?: boolean } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', now(), 'admin') returning id`,
    [`gt_${name}${stamp}@t.dev`, `gt_${name}${stamp}`, hash, yearsAgo(30)]))[0].id as string;
  created.push(id);
  if (o.payout) {
    const code = `ACCT_gt_${stamp}_${++seq}`;
    codeOf.set(id, code);
    await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`, [id, code]);
  }
  if (o.card) await ss.saveMethod({ userId: id, provider: "paystack", authEnc: encryptToken("AUTH_gt_secret"), last4: "4242", brand: "visa", bank: null, reusable: true, signature: `SIG_gt_${id}` });
  return id;
};
const batchesOf = (payerId: string) => q(`select * from spray_batches where payer_id = $1 order by created_at`, [payerId]);
const sharesOf = (batchId: string) => q(`select * from spray_payments where batch_id = $1 order by idempotency_key`, [batchId]);
const ledger = (ref: string, type: string) => q(`select 1 from payment_transactions where provider_payment_id like $1 and type = $2`, [`${ref}%`, type]);
const team = (payer: string, roomId: string, b: object) => rest("POST", `/api/rooms/${roomId}/spray/team`, payer, b);
const isGeneric403 = (r: { status: number; json: any }) => r.status === 403 && JSON.stringify(r.json) === JSON.stringify(SPRAY_UNAVAILABLE);

tuning.join = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000;
const savedSpray = roomFeatures.spray, savedGaming = roomFeatures.gaming;

try {
  roomFeatures.spray = true;
  roomFeatures.gaming = true;
  const H = await mk("host", { payout: true });
  const A1 = await mk("a1", { payout: true }), A2 = await mk("a2", { payout: true });
  const A3 = await mk("a3"); // no payout account
  const B1 = await mk("b1", { payout: true }), B2 = await mk("b2", { payout: true }), B3 = await mk("b3", { payout: true }), B4 = await mk("b4", { payout: true });
  const P = await mk("payer", { card: true });       // charges the saved card at once
  const P2 = await mk("payer2");                      // no card: the bank page, then pay
  const P3 = await mk("payer3", { card: true }), P4 = await mk("payer4"), P5 = await mk("payer5", { card: true }), P6 = await mk("payer6");
  const cr = await rest("POST", "/api/rooms", H, { title: "gt room", kind: "party", visibility: "public", ageLimit: "18+", sprayEnabled: true });
  const R = cr.json?.room?.id as string;
  check("setup: room started", (await rest("POST", `/api/rooms/${R}/start`, H)).status === 200);
  const everyone = [H, A1, A2, A3, B1, B2, B3, B4, P, P2, P3, P4, P5, P6];
  const joined = new Map<string, Awaited<ReturnType<typeof join>>>();
  for (const id of everyone) joined.set(id, await join(id, R));
  check("setup: everyone in", everyone.every((id) => joined.get(id)?.s?.type === "room:state"));
  // Payer-owned limits are checked FIRST (no oracle), so the payers that spray a 10,000 naira bag need a higher room limit than the 2,000 naira default.
  for (const id of [P3, P4]) await ss.setRoomLimit(R, id, 5_000_000);
  roomHub.setVoiceOn(R, true);
  roomHub.setLiveVideoOn(R, true);
  roomHub.setGameOn(R, true, { dropMs: 120_000, ageLane: null });
  const setTeams = (a: string[], b: string[], fa: string | null, fb: string | null) => {
    const g = newGame(4); g.teams.A = a; g.teams.B = b; g.featured.A = fa; g.featured.B = fb; roomHub.setGame(R, g);
  };
  const hostClient = joined.get(H)!.c, a1c = joined.get(A1)!.c, a2c = joined.get(A2)!.c, watcher = joined.get(P5)!.c;
  const reset = () => joined.forEach((j) => { j.c.msgs = []; });

  // ---- flag off: not a route at all
  setTeams([A1, A2], [B1], A1, B1);
  roomFeatures.gaming = false;
  const off = await team(P, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  roomFeatures.gaming = true;
  check("flag off (ROOMS_GAMING): 404, no batch, no charge", off.status === 404 && (await batchesOf(P)).length === 0 && mock.charges === 0, off.raw);

  // ---- bad requests are the single spray's 400; bad side / tier never reach the engine
  const bad = await team(P, R, { tier: "bundle", side: "C", idempotencyKey: key() });
  const bad2 = await team(P, R, { tier: "gold", side: "A", idempotencyKey: key() });
  const bad3 = await team(P, R, { tier: "bundle", side: "A", idempotencyKey: "x" });
  check("bad side / tier / key: 400 BAD_REQUEST", [bad, bad2, bad3].every((r) => r.status === 400 && r.json?.code === "BAD_REQUEST"), [bad.raw, bad2.raw, bad3.raw].join(" "));

  // ---- spray opt-in: the host's room switch gates a team spray like a single one
  await q(`update rooms set spray_enabled = false where id = $1`, [R]);
  const optOff = await team(P, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  await q(`update rooms set spray_enabled = true where id = $1`, [R]);
  check("team spray refused when off: the generic 403, no batch, no charge", optOff.status === 403 && (await batchesOf(P)).length === 0 && mock.charges === 0, optOff.raw);

  // ---- the happy path: Team A of 2 (A1 featured), the 1,000 naira bundle, saved card -> charged and delivered at once
  reset();
  const k1 = key();
  const r1 = await team(P, R, { tier: "bundle", side: "A", idempotencyKey: k1 });
  check("team spray: 200 delivered", r1.status === 200 && r1.json?.status === "delivered", r1.raw);
  check("response shape: exactly status, batchId, tier, amountKobo, shares[{userId, amountKobo}]",
    JSON.stringify(Object.keys(r1.json ?? {}).sort()) === JSON.stringify(["amountKobo", "batchId", "shares", "status", "tier"])
    && r1.json.tier === "bundle" && r1.json.amountKobo === 100_000
    && r1.json.shares.every((s: any) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["amountKobo", "userId"])), r1.raw);
  check("shares shown to the payer are the equal GROSS split, summing to the charge", r1.json?.shares?.length === 2
    && r1.json.shares.map((s: any) => s.userId).sort().join() === [A1, A2].sort().join()
    && r1.json.shares.every((s: any) => s.amountKobo === 50_000), r1.raw);
  check("nothing secret in the answer: no subaccount, reference or card data", !/ACCT_|SIG_|AUTH_|reference|providerRef|last4/i.test(r1.raw), r1.raw);
  const b1 = (await batchesOf(P))[0];
  const rows1 = await sharesOf(b1.id);
  check("one charge: one batch, delivered, two share rows (delivered)", (await batchesOf(P)).length === 1 && b1.status === "delivered" && rows1.length === 2 && rows1.every((r: any) => r.status === "delivered"), JSON.stringify(b1));
  check("the worked numbers: VAT 6,977, fee 1,500, reserve 2,500 on the batch", b1.vat_kobo === 6977 && b1.fee_kobo === 1500 && b1.reserve_kobo === 2500 && b1.amount_kobo === 100_000, JSON.stringify(b1));
  const sum = (col: string) => rows1.reduce((a: number, r: any) => a + Number(r[col] ?? 0), 0);
  check("rows: each row's parts sum to its amount; rows sum to the charge", rows1.every((r: any) =>
    Number(r.vat_kobo) + Number(r.fee_kobo) + Number(r.reserve_kobo) + Number(r.platform_kobo) + Number(r.host_kobo) + Number(r.guest_kobo ?? 0) === Number(r.amount_kobo)) && sum("amount_kobo") === 100_000);
  check("rows: platform 22,256, host 13,353, VAT 6,977, fee 1,500, reserve 2,500; each player's cut 26,707 (pool 53,414 / 2)",
    sum("platform_kobo") === 22_256 && sum("host_kobo") === 13_353 && sum("vat_kobo") === 6_977 && sum("fee_kobo") === 1_500 && sum("reserve_kobo") === 2_500
    && rows1.every((r: any) => Number(r.guest_kobo) === 26_707), JSON.stringify(rows1.map((r: any) => [r.platform_kobo, r.host_kobo, r.guest_kobo])));
  check("rows hold a DERIVED unique key and reference and the subaccount snapshot; the share reference is not the charge's",
    new Set(rows1.map((r: any) => r.idempotency_key)).size === 2 && new Set(rows1.map((r: any) => r.provider_ref)).size === 2
    && rows1.every((r: any) => r.provider_ref !== b1.provider_ref && r.recipient_subaccount === codeOf.get(r.recipient_id)));
  const tx1 = mock.txs.get(b1.provider_ref)!;
  const byCode = new Map(tx1.split.shares.map((s) => [s.subaccountCode, s.amountKobo]));
  check("ONE provider transaction, a team split of 3 entries: each player 26,707, the host 13,353", mock.charges === 1 && tx1.split.team === true && tx1.split.shares.length === 3
    && byCode.get(codeOf.get(A1)!) === 26_707 && byCode.get(codeOf.get(A2)!) === 26_707 && byCode.get(codeOf.get(H)!) === 13_353, JSON.stringify(tx1.split));
  check("the split sums to charge - VAT - fee - reserve - platform (the rest stays with the platform)",
    tx1.split.shares.reduce((a, s) => a + s.amountKobo, 0) === 100_000 - 6_977 - 1_500 - 2_500 - 22_256);
  check("ledger: one spray row per share", (await ledger(b1.provider_ref, "spray")).length === 2);
  // WS: one room:spray per share (toId = the player) and ONE system line
  const ev = await Promise.all([A1, A2].map((id) => watcher.waitFor((m) => m.type === "room:spray" && m.toId === id)));
  check("WS: one room:spray per player, toId = the player, fromId = the payer, v3c = their gross share", ev.every(Boolean)
    && ev.every((e: any) => e.fromId === P && e.tier === "bundle" && e.v3c === 50_000 && JSON.stringify(Object.keys(e).sort()) === JSON.stringify(["at", "fromId", "id", "tier", "toId", "type", "v3c"])));
  const line = await watcher.waitFor((m) => m.type === "room:chat" && m.system === "spray");
  await sleep(300);
  check("WS: exactly one system line 'sprayed team A' and two room:spray in all", /team A/.test(line?.text ?? "") && watcher.all((m) => m.type === "room:chat" && m.system === "spray").length === 1
    && watcher.all((m) => m.type === "room:spray").length === 2);
  check("the helper and the stored rows agree (same numbers as teamSprayBreakdown)", (() => {
    const bd = teamSprayBreakdown("bundle", [{ userId: A1, isHost: false }, { userId: A2, isHost: false }], A1);
    return bd.shares.every((s) => Number(rows1.find((r: any) => r.recipient_id === s.userId)?.guest_kobo) === s.recipient);
  })());
  // the payer's own status read
  const st = await rest("GET", `/api/rooms/${R}/spray/team/${b1.id}`, P);
  check("GET status (payer): delivered with the same shares", st.status === 200 && st.json?.status === "delivered" && st.json?.shares?.length === 2 && !/ACCT_/.test(st.raw), st.raw);
  check("GET status: another user gets the same 404 as a batch that does not exist", (await rest("GET", `/api/rooms/${R}/spray/team/${b1.id}`, P3)).status === 404
    && (await rest("GET", `/api/rooms/${R}/spray/team/${crypto.randomUUID()}`, P)).status === 404);

  // ---- idempotent replay: the first result, no second charge
  const charges = mock.charges;
  const rep = await team(P, R, { tier: "bundle", side: "A", idempotencyKey: k1 });
  check("replay (same key): same answer, same batch, NO second charge", rep.status === 200 && rep.json?.status === "delivered" && rep.json?.batchId === r1.json.batchId
    && mock.charges === charges && (await batchesOf(P)).length === 1, rep.raw);
  const mism = await team(P, R, { tier: "bag", side: "A", idempotencyKey: k1 });
  check("same key, other tier: 409 IDEMPOTENCY_MISMATCH", mism.status === 409 && mism.json?.code === "IDEMPOTENCY_MISMATCH", mism.raw);
  const mism2 = await team(P, R, { tier: "bundle", side: "B", idempotencyKey: k1 });
  check("same key, other side: 409 IDEMPOTENCY_MISMATCH", mism2.status === 409 && mism2.json?.code === "IDEMPOTENCY_MISMATCH", mism2.raw);

  // ---- no oracle: every eligibility failure is the SAME generic 403
  const onTeam = await team(A1, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  check("payer on the sprayed team: the generic 403 SPRAY_UNAVAILABLE", isGeneric403(onTeam), onTeam.raw);
  setTeams([A1, A2, A3], [B1], A1, B1); // A3 has no payable account
  const noSub = await team(P3, R, { tier: "bag", side: "A", idempotencyKey: key() });
  check("a player without a payable subaccount: the generic 403, nothing charged, nothing reserved", isGeneric403(noSub) && (await batchesOf(P3)).length === 0, noSub.raw);
  check("...and its body is byte-identical to the payer-on-team refusal (no oracle)", noSub.raw === onTeam.raw);
  const tooSmall = await team(P3, R, { tier: "bundle", side: "A", idempotencyKey: key() }); // 3 players need 1,500 naira
  check("below 500 naira x players: the generic 403", isGeneric403(tooSmall), tooSmall.raw);
  setTeams([A1, A2], [], A1, null);
  const emptyB = await team(P3, R, { tier: "bundle", side: "B", idempotencyKey: key() });
  check("an empty side: the generic 403", isGeneric403(emptyB), emptyB.raw);
  roomFeatures.spray = false;
  const sprayOff = await team(P3, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  roomFeatures.spray = true;
  check("spray switched off: the generic 403", isGeneric403(sprayOff), sprayOff.raw);
  check("none of those refusals charged anyone or reserved room spend", mock.charges === charges && (await batchesOf(P3)).length === 0
    && Number((await q(`select coalesce(sum(spent_kobo),0)::int n from room_spend where room_id = $1 and user_id = $2`, [R, P3]))[0].n) === 0);

  // ---- a team of 4, the remainder kobo: featured first, then team order (bag = 1,000,000 naira-kobo; a bag always goes through the bank page)
  setTeams([B1, B2, B3, B4], [A1], B3, A1); // side A = B1..B4 (featured B3)
  const r4 = await team(P4, R, { tier: "bag", side: "A", idempotencyKey: key() });
  check("team of 4: the 10,000 naira tier is never a silent saved-card charge -> action_required with 4 gross shares", r4.status === 200 && r4.json?.status === "action_required" && r4.json.shares.length === 4
    && r4.json.shares.reduce((a: number, s: any) => a + s.amountKobo, 0) === 1_000_000, r4.raw);
  const b4 = (await batchesOf(P4))[0];
  mock.pay(b4.provider_ref);
  check("team of 4: paid -> delivered", (await finalizeSpray(b4.provider_ref)) === "delivered");
  const rows4 = await sharesOf(b4.id);
  const bd4 = teamSprayBreakdown("bag", [B1, B2, B3, B4].map((u) => ({ userId: u, isHost: false })), B3);
  check("team of 4: each stored cut equals the helper's (equal, remainder to the featured B3 first), cuts differ by at most 1 kobo",
    bd4.shares.every((s) => Number(rows4.find((r: any) => r.recipient_id === s.userId)?.guest_kobo) === s.recipient)
    && Math.max(...rows4.map((r: any) => Number(r.guest_kobo))) - Math.min(...rows4.map((r: any) => Number(r.guest_kobo))) <= 1);
  const all4 = rows4.reduce((a: number, r: any) => a + Number(r.vat_kobo) + Number(r.fee_kobo) + Number(r.reserve_kobo) + Number(r.platform_kobo) + Number(r.host_kobo) + Number(r.guest_kobo), 0);
  check("team of 4: platform + host + VAT + fee + reserve + all four cuts = the charge to the kobo", all4 === 1_000_000);
  const tx4 = mock.txs.get(b4.provider_ref)!;
  check("team of 4: a 5-entry split (four players and the host), the fee's flat part taken once (fee 25,000 on the batch)",
    tx4.split.shares.length === 5 && b4.fee_kobo === 25_000, String(tx4.split.shares.length));

  // ---- 3DS / bank page: action_required, then the player LEAVES, then it is paid: delivered all the same (owner rule)
  setTeams([A1, A2], [B1], A1, B1);
  reset();
  const firstBefore = mock.firstPayments;
  const r2 = await team(P2, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  check("no saved card: 200 action_required with the bank page and the gross shares", r2.status === 200 && r2.json?.status === "action_required"
    && /^https:\/\//.test(r2.json?.authorizationUrl ?? "") && r2.json.shares.length === 2, r2.raw);
  const b2 = (await batchesOf(P2))[0];
  check("pending: batch and both shares 'pending', the room spend reserved once", b2.status === "pending" && (await sharesOf(b2.id)).every((r: any) => r.status === "pending")
    && Number((await q(`select spent_kobo from room_spend where room_id = $1 and user_id = $2`, [R, P2]))[0]?.spent_kobo) === 100_000);
  const replayPending = await team(P2, R, { tier: "bundle", side: "A", idempotencyKey: (b2.idempotency_key as string) });
  check("replay while pending: the same bank page again, no second checkout", replayPending.json?.status === "action_required" && replayPending.json?.authorizationUrl === r2.json.authorizationUrl && mock.firstPayments === firstBefore + 1, replayPending.raw);
  check("a second team spray while one is in flight is a 429", (await team(P2, R, { tier: "bundle", side: "A", idempotencyKey: key() })).status === 429);
  a2c.send({ type: "room:leave" });
  check("setup: player A2 left after the spray started", await until(() => !roomHub.get(R, A2)));
  mock.pay(b2.provider_ref);
  reset();
  const out2 = await finalizeSpray(b2.provider_ref);
  check("paid after a player left: DELIVERED (the split is fixed at init), never reversed or refunded", out2 === "delivered" && !mock.refunds.has(b2.provider_ref)
    && (await batchesOf(P2))[0].status === "delivered" && (await sharesOf(b2.id)).every((r: any) => r.status === "delivered"));
  check("the departed player keeps their share (a row with their cut), no clawbacks", (await sharesOf(b2.id)).some((r: any) => r.recipient_id === A2 && Number(r.guest_kobo) === 26_707)
    && (await q(`select 1 from host_clawbacks where spray_id = any($1::uuid[])`, [(await sharesOf(b2.id)).map((r: any) => r.id)])).length === 0);
  check("webhook replay of the same payment is a no-op", (await finalizeSpray(b2.provider_ref)) === "already" && (await ledger(b2.provider_ref, "spray")).length === 2);

  // ---- the room ends before the payment lands: delivered all the same, no animation, no refund (owner rule)
  // (A2 is gone, so the split is over the players still here: team A is now just A1.)
  const r5 = await team(P6, R, { tier: "bundle", side: "A", idempotencyKey: key() });
  check("team of 1 left: the 1,000 naira tier is allowed (500 x 1), bank page", r5.status === 200 && r5.json?.status === "action_required" && r5.json.shares.length === 1 && r5.json.shares[0].userId === A1, r5.raw);
  const b5 = (await batchesOf(P6))[0];
  const rows5 = await sharesOf(b5.id);
  check("team of 1: the whole pool is that player's cut", rows5.length === 1 && Number(rows5[0].amount_kobo) === 100_000 && Number(rows5[0].guest_kobo) === 53_414);
  await rs.setStatus(R, "ended");
  mock.pay(b5.provider_ref);
  watcher.msgs = [];
  const out5 = await finalizeSpray(b5.provider_ref);
  check("room ended before delivery: delivered, ledger written, NOT refunded", out5 === "delivered" && !mock.refunds.has(b5.provider_ref)
    && (await ledger(b5.provider_ref, "spray")).length === 1 && (await batchesOf(P6))[0].status === "delivered");
  await sleep(300);
  check("room ended: no animation broadcast (nobody to see it)", !watcher.all((m) => m.type === "room:spray").length);
  await sweepPendingSprays(Date.now()); // the sweep drives batches without error and leaves delivered ones alone
  check("the sweep runs over batches and changes nothing that is delivered", (await batchesOf(P))[0].status === "delivered");
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = savedSpray; roomFeatures.gaming = savedGaming;
  setSplitProviderForTests(null);
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    if (created.length) {
      const ids = created;
      await q(`delete from payment_transactions where buyer_user_id = any($1::varchar[])`, [ids]).catch(() => {});
      await q(`delete from host_clawbacks where host_id = any($1::varchar[])`, [ids]).catch(() => {});
      await q(`delete from spray_payments where payer_id = any($1::varchar[])`, [ids]).catch(() => {});
      await q(`delete from spray_batches where payer_id = any($1::varchar[])`, [ids]).catch(() => {});
    }
  } catch { /* best effort */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
