// Spray opt-in (rooms.spray_enabled): create and PATCH rules per failing check, the gate on new sprays only, and what each viewer sees.
// Same harness as test-rooms-ws-spray.ts (REST + WS on one server, MOCK split provider). Needs a scratch database whose name
// contains "test". Usernames use the prefix so_. The spray flag is switched on in THIS PROCESS ONLY (roomFeatures test seam).
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
process.env.SESSION_SECRET ||= "spray-optin-test-session-secret";
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
const { finalizeSpray } = await import("../server/rooms/spray");
const { stopSprayJob } = await import("../server/rooms/sprayJobs");
const ss = await import("../server/rooms/sprayStorage");
const lanes = await import("../server/rooms/gameLanes");
const { canEnableSpray } = await import("../shared/roomRules");

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
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.79.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
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
const hash = await bcrypt.hash("Passw0rd!sprayoptin", 4);
const stamp = Date.now();
const created: string[] = [];
let seq = 0;
const mk = async (name: string, o: { payout?: boolean; card?: boolean; age?: number; verified?: boolean } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', ${o.verified === false ? "null" : "now()"}, ${o.verified === false ? "null" : "'admin'"}) returning id`,
    [`so_${name}${stamp}@t.dev`, `so_${name}${stamp}`, hash, yearsAgo(o.age ?? 30)]))[0].id as string;
  created.push(id);
  if (o.payout) await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`, [id, `ACCT_so_${++seq}`]);
  if (o.card) await ss.saveMethod({ userId: id, provider: "paystack", authEnc: encryptToken("AUTH_so_secret"), last4: "4242", brand: "visa", bank: null, reusable: true, signature: `SIG_so_${id}` });
  return id;
};
const sprayRows = (payerId: string) => q(`select * from spray_payments where payer_id = $1 order by created_at`, [payerId]);
const spray = (as: string, roomId: string, b: object) => rest("POST", `/api/rooms/${roomId}/spray`, as, b);


tuning.join = { rate: 1000, burst: 1000 };
stopSprayJob();

const mkRoom = (hostId: string, extra: Record<string, unknown> = {}) =>
  rest("POST", "/api/rooms", hostId, { title: `so room ${++seq}`, kind: "party", visibility: "public", ageLimit: "18+", ...extra });
const col = async (id: string) => (await q(`select spray_enabled from rooms where id = $1`, [id]))[0]?.spray_enabled;

try {
  roomFeatures.spray = true;
  const H = await mk("host", { payout: true });
  const P = await mk("payer", { card: true });
  const P2 = await mk("payer2");
  const NOPAY = await mk("nopay");
  const UNVER = await mk("unver", { verified: false, payout: true });
  const TEEN = await mk("teen", { age: 15, verified: false });

  // ---- create
  const ok = await mkRoom(H, { sprayEnabled: true });
  check("create with sprayEnabled by an eligible host stores true", ok.json?.room?.sprayEnabled === true && (await col(ok.json?.room?.id)) === true, JSON.stringify(ok.json));
  const def = await mkRoom(H);
  check("default for a room created without the field is false", def.json?.room?.sprayEnabled === false && (await col(def.json?.room?.id)) === false, JSON.stringify(def.json));
  const explicitOff = await mkRoom(H, { sprayEnabled: false });
  check("sprayEnabled: false stores false", (await col(explicitOff.json?.room?.id)) === false);

  roomFeatures.spray = false;
  const rFlag = await mkRoom(H, { sprayEnabled: true });
  roomFeatures.spray = true;
  const rTeen = await mkRoom(TEEN, { sprayEnabled: true, ageLimit: "all", visibility: "friends" });
  const rUnver = await mkRoom(UNVER, { sprayEnabled: true });
  const rNoPay = await mkRoom(NOPAY, { sprayEnabled: true });
  const rAge = await mkRoom(H, { sprayEnabled: true, ageLimit: "13+" });
  const refused = [rFlag, rTeen, rUnver, rNoPay, rAge];
  const codes = refused.map((r) => `${r.status}:${r.json?.code}`);
  check("create refused with code per failing rule (flag off, teen host, unverified, no payout, 13+ room)",
    codes.join() === ["403:FEATURE_OFF", "403:HOST_NOT_ADULT", "403:HOST_NOT_VERIFIED", "403:NO_PAYOUT_ACCOUNT", "403:ROOM_NOT_ADULT"].join()
    && refused.every((r) => typeof r.json?.message === "string"), codes.join());
  check("a refused create made no room", (await q(`select 1 from rooms where host_id = any($1::varchar[])`, [[TEEN, UNVER, NOPAY]])).length === 0);
  // the pure rule, including the minors' room case and the fail-closed default
  const adultHost = { age: 30, idVerified: true, hasPayoutAccount: true };
  const rule = (h: typeof adultHost, room: { ageLimit: string; minorsRoom?: boolean }, f?: { spray: boolean }) => { const r = canEnableSpray(h, room, f); return r.ok ? "ok" : r.code; };
  const on1 = { spray: true };
  check("canEnableSpray: order, minors room, fail-closed default", rule(adultHost, { ageLimit: "18+" }) === "FEATURE_OFF"
    && rule({ ...adultHost, age: null }, { ageLimit: "18+" }, on1) === "HOST_NOT_ADULT"
    && rule({ ...adultHost, age: 17, idVerified: false }, { ageLimit: "13+" }, on1) === "HOST_NOT_ADULT"
    && rule({ ...adultHost, idVerified: false, hasPayoutAccount: false }, { ageLimit: "13+" }, on1) === "HOST_NOT_VERIFIED"
    && rule({ ...adultHost, hasPayoutAccount: false }, { ageLimit: "13+" }, on1) === "NO_PAYOUT_ACCOUNT"
    && rule(adultHost, { ageLimit: "21+", minorsRoom: true }, on1) === "ROOM_NOT_ADULT"
    && rule(adultHost, { ageLimit: "13+" }, on1) === "ROOM_NOT_ADULT"
    && rule(adultHost, { ageLimit: "21+" }, on1) === "ok");
  const bad = await Promise.all([mkRoom(H, { sprayEnabled: "yes" }), mkRoom(H, { sprayEnabled: 1 }), mkRoom(H, { sprayEnabled: null })]);
  check("unknown or non-boolean sprayEnabled is a 400 on field sprayEnabled", bad.every((r) => r.status === 400 && r.json?.field === "sprayEnabled"), bad.map((r) => `${r.status}:${r.json?.field}`).join());

  // ---- PATCH toggles while live; the gate reads the row, so the room follows at once
  const R = (await mkRoom(H)).json.room.id as string;
  check("setup: room started", (await rest("POST", `/api/rooms/${R}/start`, H)).status === 200);
  const h = await join(H, R), p = await join(P, R), p2 = await join(P2, R);
  check("setup: everyone in", [h, p, p2].every((x) => x.s?.type === "room:state"));
  const spray = (as: string, b: object = {}) => rest("POST", `/api/rooms/${R}/spray`, as, { tier: "note", targetId: H, idempotencyKey: key(), ...b });
  const blockOf = async (as: string) => (await rest("GET", `/api/rooms/${R}`, as)).json?.spray;
  check("off by default: no spray block for a payer and a new spray is refused (generic 403)", (await blockOf(P)) == null && (await spray(P)).status === 403 && (await sprayRows(P)).length === 0);
  const guestKeysOff = Object.keys((await rest("GET", `/api/rooms/${R}`, P)).json?.room ?? {});

  const on = await rest("PATCH", `/api/rooms/${R}`, H, { sprayEnabled: true });
  check("PATCH on: stored, returned to the host", on.status === 200 && on.json?.room?.sprayEnabled === true && (await col(R)) === true, JSON.stringify(on.json));
  const blkOn = await blockOf(P);
  check("PATCH on while live: the payer's room now carries the spray block", !!blkOn && blkOn.targets.includes(H));
  const guestOn = (await rest("GET", `/api/rooms/${R}`, P)).json?.room;
  check("sprayEnabled never rides on a room object for a guest (same keys on and off)", !("sprayEnabled" in guestOn) && JSON.stringify(Object.keys(guestOn)) === JSON.stringify(guestKeysOff));
  check("the host's own view carries sprayEnabled", (await rest("GET", `/api/rooms/${R}`, H)).json?.room?.sprayEnabled === true);
  const sprayed = await spray(P);
  check("a spray starts and delivers once on", sprayed.json?.status === "delivered", JSON.stringify(sprayed.json));

  // ---- in flight: a spray already started (bank page) still delivers after the host turns spray off
  const pending = await spray(P2);
  const prow = (await sprayRows(P2))[0];
  check("setup: a pending spray from a payer with no saved card", !!prow && prow.status !== "delivered", JSON.stringify(pending.json));
  mock.pay(prow.provider_ref);
  const off = await rest("PATCH", `/api/rooms/${R}`, H, { sprayEnabled: false });
  check("PATCH off while live: stored false", off.status === 200 && off.json?.room?.sprayEnabled === false && (await col(R)) === false, JSON.stringify(off.json));
  check("PATCH off: no spray block, a new spray is refused", (await blockOf(P)) == null && (await spray(P)).status === 403);
  const out = await finalizeSpray(prow.provider_ref);
  check("in-flight spray still delivers after the host turns it off", out === "delivered" && (await sprayRows(P2))[0].status === "delivered", String(out));

  // ---- sprayBlockFor needs spray_enabled even with every other rule met
  await q(`update rooms set spray_enabled = false where id = $1`, [R]);
  const blk0 = await blockOf(P);
  await q(`update rooms set spray_enabled = true where id = $1`, [R]);
  const blk1 = await blockOf(P);
  check("sprayBlockFor is null when spray_enabled is false even with every other rule met", blk0 == null && !!blk1);

  // ---- PATCH rules
  const bp = await rest("PATCH", `/api/rooms/${R}`, H, { sprayEnabled: "no" });
  check("PATCH non-boolean sprayEnabled: 400 on field sprayEnabled", bp.status === 400 && bp.json?.field === "sprayEnabled", JSON.stringify(bp.json));
  const S = (await mkRoom(NOPAY)).json.room.id as string;
  const pn = await rest("PATCH", `/api/rooms/${S}`, NOPAY, { sprayEnabled: true });
  check("PATCH on by a host with no payout account: 403 NO_PAYOUT_ACCOUNT, still false", pn.status === 403 && pn.json?.code === "NO_PAYOUT_ACCOUNT" && (await col(S)) === false, JSON.stringify(pn.json));
  const pc = await rest("PATCH", `/api/rooms/${S}`, NOPAY, { sprayEnabled: false });
  check("PATCH off needs no host checks", pc.status === 200 && pc.json?.room?.sprayEnabled === false, JSON.stringify(pc.json));
  const A = (await mkRoom(H)).json.room.id as string;
  const pa = await rest("PATCH", `/api/rooms/${A}`, H, { sprayEnabled: true, ageLimit: "13+" });
  check("PATCH on together with a 13+ age limit: 403 ROOM_NOT_ADULT", pa.status === 403 && pa.json?.code === "ROOM_NOT_ADULT", JSON.stringify(pa.json));
  const other = await rest("PATCH", `/api/rooms/${R}`, P, { sprayEnabled: false });
  check("only the host can change it", other.status === 403 && (await col(R)) === true);

  // ---- game-room lanes: the lane runs the game, so the opt-in must land on the creator's adult lane
  roomFeatures.gaming = true;
  const gameBody = { title: "so game", kind: "party", visibility: "public", ageLimit: "18+", capacity: 20, gameFormat: 2, lanes: true };
  const gc = await rest("POST", "/api/rooms", H, { ...gameBody, sprayEnabled: true });
  const adultLane = gc.json?.lane?.id as string | undefined;
  check("adult creator: the adult lane inherits sprayEnabled true", gc.status === 201 && !!adultLane && (await col(adultLane)) === true, JSON.stringify(gc.json));
  const gcOff = await rest("POST", "/api/rooms", H, gameBody);
  check("adult creator without the switch: lane stays false", !!gcOff.json?.lane?.id && (await col(gcOff.json.lane.id)) === false);
  const teenUser = await storage.getUser(TEEN);
  const tl = await lanes.createGameRoomWithLane(teenUser!, { title: "so teen game", kind: "party", visibility: "public", ageLimit: "all", capacity: 20, gameFormat: 2, sprayEnabled: true } as any);
  check("a teen lane never inherits spray, even if the input asks", tl.lane.ageLane === "teen" && (await col(tl.lane.id)) === false);
  const fl = await lanes.openLane(tl.parent, (await storage.getUser(H))!, "adult", "public", true);
  check("a lane opened later by a friend keeps spray off", fl.ageLane === "adult" && (await col(fl.id)) === false);
  if (adultLane) {
    check("setup: inheriting adult lane started", (await rest("POST", `/api/rooms/${adultLane}/start`, H)).status === 200);
    await join(H, adultLane); await join(P, adultLane);
    const ls = await rest("POST", `/api/rooms/${adultLane}/spray`, P, { tier: "note", targetId: H, idempotencyKey: key() });
    check("a spray in the inheriting adult lane passes the gate", ls.status !== 403 && ls.json?.status === "delivered", JSON.stringify(ls.json));
  }
  roomFeatures.gaming = false;

  // ---- config: the caller's own readiness
  const cfgH = await rest("GET", "/api/rooms/config", H);
  const cfgN = await rest("GET", "/api/rooms/config", NOPAY);
  const cfgT = await rest("GET", "/api/rooms/config", TEEN);
  check("config: hostMoneyReadiness for the caller, exactly { adult, idVerified, payoutAccount }",
    JSON.stringify(cfgH.json?.hostMoneyReadiness) === JSON.stringify({ adult: true, idVerified: true, payoutAccount: true })
    && JSON.stringify(cfgN.json?.hostMoneyReadiness) === JSON.stringify({ adult: true, idVerified: true, payoutAccount: false })
    && JSON.stringify(cfgT.json?.hostMoneyReadiness) === JSON.stringify({ adult: false, idVerified: false, payoutAccount: false }), JSON.stringify([cfgH.json, cfgN.json]));
  check("config: features.spray unchanged, no hostSprayReadiness", cfgH.json?.features?.spray === true && !("hostSprayReadiness" in cfgH.json));
  const prevPaid = roomFeatures.paidRooms;
  roomFeatures.spray = false; roomFeatures.paidRooms = false;
  const cfgOff = await rest("GET", "/api/rooms/config", H);
  roomFeatures.spray = true; roomFeatures.paidRooms = prevPaid;
  check("config: hostMoneyReadiness absent only when both paid rooms and spray are off", !("hostMoneyReadiness" in cfgOff.json));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = false; roomFeatures.gaming = false;
  setSplitProviderForTests(null);
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    if (created.length) {
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
