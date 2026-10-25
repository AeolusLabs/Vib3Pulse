// Live spray state and admin spray controls: the host switch reaches every member live (room:settings sprayOn), the admin pause,
// host freeze and per-room block do too, a host can never undo an admin block, and an in-flight spray still delivers.
// Same harness as test-rooms-api-sprayoptin.ts (REST + WS + admin routes on one server, MOCK split provider). Needs a scratch
// database whose name contains "test". Usernames use the prefix sl_. The spray flag is switched on in THIS PROCESS ONLY.
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
process.env.SESSION_SECRET ||= "spray-live-test-session-secret";
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
const { finalizeSpray, sprayGate } = await import("../server/rooms/spray");
const { registerRoomsAdminRoutes } = await import("../server/rooms/adminRoutes");
const { sprayEffectiveFor, sprayToggleCooldown } = await import("../server/rooms/sprayState");
const { setControl, freezeHost, unfreezeHost } = await import("../server/rooms/roomControls");
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
app.use("/api/admin", (req: any, _res, next) => { const id = req.header("x-test-admin"); req.session = { adminId: id || undefined, destroy: (cb?: () => void) => cb?.() }; next(); });
registerRoomRoutes(app);
registerRoomsAdminRoutes(app);
const fakeStore = { get: (sid: string, cb: (e: any, s: any) => void) => cb(null, { passport: { user: sid } }) };
const server = http.createServer(app);
setVoiceServiceForTests(null);
wsManager.initialize(server, fakeStore);
stopSprayJob();
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown, adminId?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.79.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as, ...(adminId ? { "x-test-admin": adminId } : {}) },
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
    [`sl_${name}${stamp}@t.dev`, `sl_${name}${stamp}`, hash, yearsAgo(o.age ?? 30)]))[0].id as string;
  created.push(id);
  if (o.payout) await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`, [id, `ACCT_so_${++seq}`]);
  if (o.card) await ss.saveMethod({ userId: id, provider: "paystack", authEnc: encryptToken("AUTH_so_secret"), last4: "4242", brand: "visa", bank: null, reusable: true, signature: `SIG_so_${id}` });
  return id;
};
const sprayRows = (payerId: string) => q(`select * from spray_payments where payer_id = $1 order by created_at`, [payerId]);
const spray = (as: string, roomId: string, b: object) => rest("POST", `/api/rooms/${roomId}/spray`, as, b);


tuning.join = { rate: 1000, burst: 1000 };
stopSprayJob();

const madeAdmins: string[] = [], madeRooms: string[] = [];
const mkAdmin = async (role: string) => {
  const id = (await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`,
    [`sl_admin_${role}${stamp}@t.dev`, `sl_admin_${role}${stamp}`, hash, `sl ${role}`, role]))[0].id as string;
  madeAdmins.push(id); return id;
};
const admin = (method: string, path: string, as: string, body?: unknown) => rest(method, path, "", body, as);
const audits = async (action: string, targetId: string) => q(`select * from admin_activity_logs where action = $1 and target_id = $2`, [action, targetId]);
const mkRoom = (hostId: string, extra: Record<string, unknown> = {}) =>
  rest("POST", "/api/rooms", hostId, { title: `sl room ${++seq}`, kind: "party", visibility: "public", ageLimit: "18+", ...extra });
const fresh = (o: Parameters<typeof mk>[1] = {}) => mk(`u${++seq}`, o);
const settingsMsg = (m: any) => m.type === "room:settings";
const settingsSince = (c: Client, since: number) => c.msgs.slice(since).filter(settingsMsg);
/** Every client gets a room:settings with this sprayOn after its mark. */
const waitSpray = async (cs: Client[], on: boolean, since: number[]) =>
  (await Promise.all(cs.map((c, i) => c.waitFor((m) => settingsMsg(m) && m.sprayOn === on && c.msgs.indexOf(m) >= since[i], 8000)))).every((m) => !!m);
/** A started room with the host and these guests, all connected (a person can be in one room only). */
async function mkLive(hostId: string, guests: string[], sprayEnabled: boolean) {
  const r = await mkRoom(hostId, sprayEnabled ? { sprayEnabled: true } : {});
  const id = r.json?.room?.id as string;
  madeRooms.push(id);
  await rest("POST", `/api/rooms/${id}/start`, hostId);
  const host = (await join(hostId, id)).c;
  const gs: Client[] = [];
  for (const g of guests) gs.push((await join(g, id)).c);
  return { id, host, gs, all: [host, ...gs] };
}
const marks = (cs: Client[]) => cs.map((c) => c.msgs.length);
const BLOCK_FIELDS = ["sprayAdminBlocked", "sprayBlockReason", "sprayBlockedBy", "sprayBlockedAt"];
const liveOnSql = `select count(*)::int n from rooms r where status = 'live' and spray_enabled and not spray_admin_blocked
                   and not exists (select 1 from room_host_freezes f where f.host_id = r.host_id)
                   and not exists (select 1 from rooms c where c.parent_room_id = r.id)
                   and not exists (select 1 from rooms p where p.id = r.parent_room_id and p.spray_admin_blocked)`;

try {
  roomFeatures.spray = true;
  const SA = await mkAdmin("super_admin"), FIN = await mkAdmin("finance_manager");
  const H = await mk("host", { payout: true }), H2 = await mk("host2", { payout: true }), H3 = await mk("host3", { payout: true });

  // ---- effective state, reason by reason (first failing wins)
  {
    const room = (o: Record<string, unknown> = {}) => ({ hostId: H, sprayEnabled: true, sprayAdminBlocked: false, ageLimit: "18+", minorsRoom: false, parentRoomId: null, ...o }) as any;
    const why = async (r: any) => { const e = await sprayEffectiveFor(r); return `${e.on}:${e.reason}`; };
    const seen: string[] = [];
    roomFeatures.spray = false;
    await setControl({ key: "sprays_paused", on: true, adminId: SA, reason: "state test" });
    await freezeHost({ hostId: H, adminId: SA, reason: "state test" });
    seen.push(await why(room({ sprayEnabled: false, sprayAdminBlocked: true }))); // everything wrong: the flag wins
    roomFeatures.spray = true;
    seen.push(await why(room({ sprayEnabled: false, sprayAdminBlocked: true }))); // then the pause
    await setControl({ key: "sprays_paused", on: false, adminId: SA, reason: "state test" });
    seen.push(await why(room({ sprayEnabled: false, sprayAdminBlocked: true }))); // then the host switch
    seen.push(await why(room({ sprayAdminBlocked: true })));                      // then the admin block (before the freeze)
    seen.push(await why(room()));                                                 // then the freeze
    await unfreezeHost({ hostId: H, adminId: SA });
    seen.push(await why(room()));
    check("effective state: each reason in order", seen.join() === ["false:FEATURE_OFF", "false:PAUSED", "false:HOST_OFF", "false:ADMIN_BLOCKED", "false:HOST_FROZEN", "true:null"].join(), seen.join());
  }

  // ---- late joiner, host toggle, cooldown
  const A = await mkLive(H, [await fresh(), await fresh()], true);
  const lj = await join(await fresh(), A.id);
  check("late joiner room:state carries sprayOn", lj.s?.room?.sprayOn === true && lj.s?.room?.sprayBlockedByAdmin === false, JSON.stringify(lj.s?.room));
  const off = await mkLive(H3, [], false);
  check("late joiner in a room with the host switch off: sprayOn false", (await join(await fresh(), off.id)).s?.room?.sprayOn === false);

  const all = [...A.all, lj.c];
  let m = marks(all);
  const t1 = await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: false });
  check("host toggle live broadcasts to every member", t1.status === 200 && await waitSpray(all, false, m), JSON.stringify(t1.json));
  const t2 = await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: true });
  check("ON within 3 s of ON/OFF returns 429 SPRAY_TOGGLE_COOLDOWN with retryMs", t2.status === 429 && t2.json?.code === "SPRAY_TOGGLE_COOLDOWN" && t2.json?.retryMs > 0 && t2.json?.retryMs <= 3000
    && (await q(`select spray_enabled from rooms where id = $1`, [A.id]))[0].spray_enabled === false, JSON.stringify(t2.json));
  sprayToggleCooldown.clear(A.id);
  m = marks(all);
  const t3 = await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: true });
  check("after the cooldown the toggle works and broadcasts true", t3.status === 200 && await waitSpray(all, true, m), JSON.stringify(t3.json));
  m = marks(all);
  const t4 = await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: false });
  check("OFF within 3 s of ON is allowed", t4.status === 200 && await waitSpray(all, false, m), JSON.stringify(t4.json));
  const t5 = await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: true });
  check("ON right after that OFF is still 429 (window restarted by the OFF)", t5.status === 429 && t5.json?.code === "SPRAY_TOGGLE_COOLDOWN", JSON.stringify(t5.json));
  sprayToggleCooldown.clear(A.id);
  await rest("PATCH", `/api/rooms/${A.id}`, H, { sprayEnabled: true });
  sprayToggleCooldown.clear(A.id);
  {
    // Room "off" (host switch off, never toggled): a PATCH that fails after the spray block (409 NOT_SCHEDULED) must not start the window.
    const failed1 = await rest("PATCH", `/api/rooms/${off.id}`, H3, { sprayEnabled: true, ticketPriceKobo: 100000, ticketCapacity: 20 });
    const okAfter = await rest("PATCH", `/api/rooms/${off.id}`, H3, { sprayEnabled: true });
    check("a failed PATCH does not start the window", failed1.status === 409 && okAfter.status === 200 && okAfter.json?.room?.sprayEnabled === true, `${failed1.status} ${okAfter.status} ${JSON.stringify(okAfter.json)}`);
  }

  // ---- flag off: no spray keys at all
  {
    roomFeatures.spray = false;
    const pin = await rest("PATCH", `/api/rooms/${A.id}`, H, { pinnedMessage: "hello" });
    const msg = await lj.c.waitFor((x) => settingsMsg(x) && x.pinnedMessage === "hello", 8000);
    check("flag off: room:settings has no spray keys (byte-identical)", pin.status === 200 && !!msg
      && JSON.stringify(Object.keys(msg)) === JSON.stringify(["type", "pinnedMessage", "slowModeSec", "locked"]), JSON.stringify(msg));
    const lj2 = await join(await fresh(), A.id);
    check("flag off: room:state carries no spray keys", !("sprayOn" in (lj2.s?.room ?? {})) && !("sprayBlockedByAdmin" in (lj2.s?.room ?? {})), JSON.stringify(lj2.s?.room));
    roomFeatures.spray = true;
  }

  // ---- admin pause / resume (room B: host switch on; room C: host switch off)
  const B = await mkLive(H2, [await fresh()], true);
  const C = await mkLive(await mk("host4", { payout: true }), [], false);
  const everyone = [...A.all, lj.c, ...B.all, ...C.all];
  m = marks(everyone);
  const pz = await admin("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "incident review" });
  check("admin pause broadcasts sprayOn false to every live room", pz.status === 200 && pz.json?.changed === true && await waitSpray(everyone, false, m), JSON.stringify(pz.json));
  m = marks(everyone);
  const rs = await admin("POST", "/api/admin/rooms/controls/sprays_paused", SA, { on: false, reason: "all clear" });
  check("resume broadcasts true only where host switch on", rs.status === 200 && await waitSpray([...A.all, lj.c, ...B.all], true, m.slice(0, A.all.length + 1 + B.all.length))
    && (await C.host.waitFor((x) => settingsMsg(x) && C.host.msgs.indexOf(x) >= m[everyone.length - 1], 8000))?.sprayOn === false, JSON.stringify(rs.json));

  // ---- host freeze / unfreeze reaches that host's rooms only
  const mA = marks(A.all), mB = marks(B.all);
  const fz = await admin("POST", `/api/admin/rooms/hosts/${H}/freeze`, FIN, { reason: "chargeback pattern" });
  const frozenOk = fz.status === 200 && await waitSpray(A.all, false, mA);
  const unfrozenB = settingsSince(B.host, mB[0]).every((x) => x.sprayOn !== false);
  const mA2 = marks(A.all);
  const uf = await admin("POST", `/api/admin/rooms/hosts/${H}/unfreeze`, SA, { reason: "cleared up" });
  check("host freeze/unfreeze broadcasts to that host's rooms", frozenOk && unfrozenB && uf.status === 200 && await waitSpray(A.all, true, mA2), JSON.stringify([fz.json, uf.json]));

  // ---- admin per-room block (room K: host H4's, payer with a card and one without)
  const H4 = await mk("host5", { payout: true }), PC = await fresh({ card: true }), PN = await fresh();
  const K = await mkLive(H4, [PC, PN], true);
  m = marks(K.all);
  const bl = await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { on: true, reason: "reported scam" });
  const got = await K.gs[0].waitFor((x) => settingsMsg(x) && x.sprayOn === false && x.sprayBlockedByAdmin === true && K.gs[0].msgs.indexOf(x) >= m[1], 8000);
  check("admin block: broadcast carries sprayOn false and sprayBlockedByAdmin true", bl.status === 200 && bl.json?.changed === true && !!got, JSON.stringify(bl.json));
  const gate = await sprayGate(K.id, PC, H4, "start");
  // The room has spraying ON, so a host PATCH "on" now would be a no-op (200). The refusal matters once the host has turned it off:
  // first off (always allowed), then "on" again must be refused while the admin block stands.
  sprayToggleCooldown.clear(K.id);
  const hostOff = await rest("PATCH", `/api/rooms/${K.id}`, H4, { sprayEnabled: false });
  sprayToggleCooldown.clear(K.id);
  const host403 = await rest("PATCH", `/api/rooms/${K.id}`, H4, { sprayEnabled: true });
  sprayToggleCooldown.clear(K.id);
  const sneaky = await rest("PATCH", `/api/rooms/${K.id}`, H4, { sprayAdminBlocked: false, sprayBlockReason: "x" });
  const hostView = (await rest("GET", `/api/rooms/${K.id}`, H4)).json?.room;
  const row = (await q(`select spray_admin_blocked, spray_block_reason, spray_blocked_by from rooms where id = $1`, [K.id]))[0];
  check("admin block: gate refuses start, host PATCH on => 403 SPRAY_ADMIN_BLOCKED, host cannot clear it",
    !gate.ok && host403.status === 403 && host403.json?.code === "SPRAY_ADMIN_BLOCKED" && host403.json?.message === "Spray is turned off by the platform for this room."
    && hostOff.status === 200 && sneaky.status === 200 && row.spray_admin_blocked === true && row.spray_block_reason === "reported scam" && row.spray_blocked_by === FIN
    && hostView?.sprayAdminBlocked === true && !("sprayBlockReason" in hostView) && !JSON.stringify(hostView).includes("reported scam") && !("sprayBlockedBy" in hostView), `${host403.status} ${JSON.stringify(row)}`);
  const unF = await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { on: false, reason: "mistake found" });
  check("unblock super_admin only (finance gets 403)", unF.status === 403 && unF.json?.code === "SUPER_ADMIN_ONLY"
    && (await q(`select spray_admin_blocked from rooms where id = $1`, [K.id]))[0].spray_admin_blocked === true, JSON.stringify(unF.json));
  const rep = await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { on: true, reason: "reported scam" });
  m = marks(K.all);
  const unSA = await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, SA, { on: false, reason: "mistake found" });
  const unRep = await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, SA, { on: false, reason: "mistake found" });
  const after = (await q(`select spray_admin_blocked, spray_blocked_by, spray_blocked_at from rooms where id = $1`, [K.id]))[0];
  check("block/unblock audited once, repeat is changed:false",
    rep.json?.changed === false && unSA.json?.changed === true && unRep.json?.changed === false
    && (await audits("room_spray.block", K.id)).length === 1 && (await audits("room_spray.unblock", K.id)).length === 1
    && after.spray_admin_blocked === false && after.spray_blocked_by === null && after.spray_blocked_at === null, JSON.stringify([rep.json, unSA.json, unRep.json]));
  const unMsg = await K.gs[0].waitFor((x) => settingsMsg(x) && x.sprayBlockedByAdmin === false && K.gs[0].msgs.indexOf(x) >= m[1], 8000);
  check("unblock broadcasts, and the host's own switch (off) still decides sprayOn", !!unMsg && unMsg.sprayOn === false);
  const bad = await Promise.all([
    admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { on: true }),
    admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { reason: "no flag here" }),
    admin("POST", `/api/admin/rooms/not-a-uuid/spray-block`, FIN, { on: true, reason: "no such room" }),
  ]);
  check("block: reason and boolean required, bad id 404", bad[0].json?.code === "REASON_REQUIRED" && bad[1].status === 400 && bad[2].status === 404);

  // ---- in-flight spray still delivers after a block and a pause
  sprayToggleCooldown.clear(K.id);
  await rest("PATCH", `/api/rooms/${K.id}`, H4, { sprayEnabled: true });
  const pend = await rest("POST", `/api/rooms/${K.id}/spray`, PN, { tier: "note", targetId: H4, idempotencyKey: key() });
  const prow = (await q(`select * from spray_payments where payer_id = $1 order by created_at`, [PN]))[0];
  mock.pay(prow?.provider_ref);
  await admin("POST", `/api/admin/rooms/${K.id}/spray-block`, FIN, { on: true, reason: "block mid payment" });
  await admin("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "pause mid payment" });
  const fin = await finalizeSpray(prow?.provider_ref);
  check("in-flight spray still delivers after block/pause", !!prow && prow.status !== "delivered" && fin === "delivered"
    && (await q(`select status from spray_payments where id = $1`, [prow.id]))[0].status === "delivered", `${pend.status} ${fin}`);

  // ---- spray-status
  const st = await admin("GET", "/api/admin/rooms/spray-status", FIN);
  check("spray-status counts", st.status === 200 && st.json?.platformFlag === true && st.json?.paused === true
    && st.json?.frozenHosts === (await q(`select count(*)::int n from room_host_freezes`))[0].n && st.json?.liveRoomsSprayOn === 0
    && st.json?.blockedRooms?.some((b: any) => b.roomId === K.id && b.reason === "block mid payment" && b.byAdminId === FIN && typeof b.at === "string" && typeof b.title === "string"), JSON.stringify(st.json));
  await admin("POST", "/api/admin/rooms/controls/sprays_paused", SA, { on: false, reason: "end of test" });
  const st2 = await admin("GET", "/api/admin/rooms/spray-status", FIN);
  const live2 = (await q(liveOnSql))[0].n;
  check("spray-status liveRoomsSprayOn follows the pause", st2.json?.paused === false && st2.json?.liveRoomsSprayOn === live2 && live2 >= 1, JSON.stringify(st2.json));

  // ---- guests never see the block fields (room K is still blocked, with a reason)
  const guestGet = await rest("GET", `/api/rooms/${K.id}`, PC);
  const guestList = await rest("GET", "/api/rooms", PC);
  const stateMsg = (await join(await fresh(), K.id)).s;
  const dump = JSON.stringify([guestGet.json, guestList.json, stateMsg]);
  check("guest bodies never carry the four block fields", guestGet.status === 200 && BLOCK_FIELDS.every((f) => !dump.includes(`"${f}":`)) && !dump.includes("block mid payment"), BLOCK_FIELDS.filter((f) => dump.includes(`"${f}":`)).join());

  // ---- final fix wave
  {
    const HH = await fresh({ payout: true });
    const mkRow = async (host: string, o: { parent?: string | null; lane?: string | null; age?: string; minors?: boolean } = {}) => {
      const id = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, started_at, spray_enabled, parent_room_id, age_lane, minors_room, created_at)
        values ($1,$2,'party','public',$3,'live', now(), true, $4, $5, $6, now()) returning id`, [host, `sl final ${++seq}`, o.age ?? "18+", o.parent ?? null, o.lane ?? null, o.minors === true]))[0].id as string;
      madeRooms.push(id); return id;
    };
    const parent = await mkRow(HH), lane1 = await mkRow(HH, { parent, lane: "adult" });
    const blk = await admin("POST", `/api/admin/rooms/${parent}/spray-block`, FIN, { on: true, reason: "fraud suspected" });
    const kids = await q(`select id, spray_admin_blocked, spray_block_reason, spray_blocked_by from rooms where id = any($1::varchar[])`, [[parent, lane1]]);
    const au = await audits("room_spray.block", parent);
    const lane1Row = (await q(`select * from rooms where id = $1`, [lane1]))[0];
    const lane1Eff = await sprayEffectiveFor({ hostId: HH, sprayEnabled: true, sprayAdminBlocked: lane1Row.spray_admin_blocked, ageLimit: "18+", minorsRoom: false, parentRoomId: parent } as any);
    check("block on a game parent blocks its lanes (derived: only the parent row is written)", blk.status === 200 && blk.json?.changed === true && [parent, lane1].every((i) => blk.json?.roomIds?.includes(i))
      && kids.find((k: any) => k.id === parent)?.spray_admin_blocked === true && kids.find((k: any) => k.id === lane1)?.spray_admin_blocked === false
      && lane1Eff.on === false && lane1Eff.reason === "ADMIN_BLOCKED" && !(await sprayGate(lane1, await fresh(), HH, "start")).ok
      && au.length === 1 && au[0].details.includes(lane1), JSON.stringify([blk.json, kids]));
    // a lane blocked only via its parent reads as admin-blocked to its host
    const laneHostView = await rest("GET", `/api/rooms/${lane1}`, HH);
    check("a lane blocked via its parent shows sprayBlockedByAdmin true to its host", laneHostView.status === 200 && laneHostView.json?.room?.sprayAdminBlocked === true && !JSON.stringify(laneHostView.json).includes("fraud suspected"), JSON.stringify(laneHostView.json?.room));
    // unblocking the lane directly while the parent is blocked
    await admin("POST", `/api/admin/rooms/${lane1}/spray-block`, FIN, { on: true, reason: "lane own reason" });
    const unLane = await admin("POST", `/api/admin/rooms/${lane1}/spray-block`, SA, { on: false, reason: "lane cleared" });
    check("unblock lane while parent blocked => stillBlockedByParent true", unLane.status === 200 && unLane.json?.changed === true && unLane.json?.stillBlockedByParent === true
      && (await q(`select spray_admin_blocked from rooms where id = $1`, [lane1]))[0].spray_admin_blocked === false, JSON.stringify(unLane.json));
    const lane2 = await mkRow(HH, { parent, lane: "adult" });
    const row2 = (await q(`select spray_admin_blocked from rooms where id = $1`, [lane2]))[0];
    const eff = await sprayEffectiveFor({ hostId: HH, sprayEnabled: true, sprayAdminBlocked: false, ageLimit: "18+", minorsRoom: false, parentRoomId: parent } as any);
    const g2 = await sprayGate(lane2, await fresh(), HH, "start");
    check("a lane opened after the block cannot spray", row2.spray_admin_blocked === false && eff.on === false && eff.reason === "ADMIN_BLOCKED" && !g2.ok);
    const stB = await admin("GET", "/api/admin/rooms/spray-status", FIN);
    check("live count not doubled (lane parents and lanes of a blocked parent are not counted)", stB.json?.liveRoomsSprayOn === (await q(liveOnSql))[0].n, JSON.stringify(stB.json?.liveRoomsSprayOn));
    const un = await admin("POST", `/api/admin/rooms/${parent}/spray-block`, SA, { on: false, reason: "cleared" });
    const after = await q(`select spray_admin_blocked, spray_block_reason, spray_blocked_by, spray_blocked_at from rooms where id = any($1::varchar[])`, [[parent, lane1]]);
    const laneAfter = await sprayEffectiveFor({ hostId: HH, sprayEnabled: true, sprayAdminBlocked: false, ageLimit: "18+", minorsRoom: false, parentRoomId: parent } as any);
    check("unblock clears the lanes (they have no block of their own, so unblocking the parent frees them)", un.status === 200 && un.json?.roomIds?.length >= 2 && un.json?.stillBlockedByParent === false
      && after.every((k: any) => k.spray_admin_blocked === false && k.spray_block_reason === null && k.spray_blocked_by === null && k.spray_blocked_at === null) && laneAfter.on === true);
    // a lane an admin blocked separately stays blocked when its parent is blocked and then unblocked
    const laneS = await mkRow(HH, { parent, lane: "adult" });
    await admin("POST", `/api/admin/rooms/${laneS}/spray-block`, FIN, { on: true, reason: "separate lane reason" });
    await admin("POST", `/api/admin/rooms/${parent}/spray-block`, FIN, { on: true, reason: "parent again" });
    await admin("POST", `/api/admin/rooms/${parent}/spray-block`, SA, { on: false, reason: "parent cleared" });
    const sep = (await q(`select spray_admin_blocked, spray_block_reason from rooms where id = $1`, [laneS]))[0];
    check("unblocking the parent does not clear a separately blocked lane", sep.spray_admin_blocked === true && sep.spray_block_reason === "separate lane reason", JSON.stringify(sep));
    const stC = await admin("GET", "/api/admin/rooms/spray-status", FIN);
    check("live count counts the lane, not its game room", stC.json?.liveRoomsSprayOn === (await q(liveOnSql))[0].n);

    const ne = await sprayEffectiveFor({ hostId: HH, sprayEnabled: true, sprayAdminBlocked: false, ageLimit: "all", minorsRoom: false, parentRoomId: null } as any);
    const nm = await sprayEffectiveFor({ hostId: HH, sprayEnabled: true, sprayAdminBlocked: false, ageLimit: "18+", minorsRoom: true, parentRoomId: null } as any);
    check("sprayOn is never true in a room that is not money eligible (ROOM_NOT_ELIGIBLE)", ne.reason === "ROOM_NOT_ELIGIBLE" && nm.reason === "ROOM_NOT_ELIGIBLE" && !ne.on && !nm.on);

    // the host never learns the admin's reason
    const HR = await fresh({ payout: true });
    const R = await mkRoom(HR);
    madeRooms.push(R.json.room.id);
    await admin("POST", `/api/admin/rooms/${R.json.room.id}/spray-block`, FIN, { on: true, reason: "fraud suspected: internal note" });
    const hv = await rest("GET", `/api/rooms/${R.json.room.id}`, HR);
    const hp = await rest("PATCH", `/api/rooms/${R.json.room.id}`, HR, { title: "renamed" });
    check("block reason never reaches the host", hv.status === 200 && hv.json.room.sprayAdminBlocked === true && !JSON.stringify([hv.json, hp.json]).includes("fraud suspected") && !("sprayBlockReason" in hv.json.room));
    await admin("POST", `/api/admin/rooms/${R.json.room.id}/spray-block`, SA, { on: false, reason: "done" });

    // flag off: nothing new reaches a client
    const HO = await fresh({ payout: true }), GO = await fresh();
    const lv = await mkLive(HO, [GO], true);
    roomFeatures.spray = false;
    const mk0 = marks(lv.all);
    await admin("POST", "/api/admin/rooms/controls/sprays_paused", FIN, { on: true, reason: "flag off test" });
    await admin("POST", "/api/admin/rooms/controls/sprays_paused", SA, { on: false, reason: "flag off test" });
    await admin("POST", `/api/admin/rooms/hosts/${HO}/freeze`, FIN, { reason: "flag off test" });
    await admin("POST", `/api/admin/rooms/hosts/${HO}/unfreeze`, SA, { reason: "flag off test" });
    await admin("POST", `/api/admin/rooms/${lv.id}/spray-block`, FIN, { on: true, reason: "flag off test" });
    await admin("POST", `/api/admin/rooms/${lv.id}/spray-block`, SA, { on: false, reason: "flag off test" });
    await rest("PATCH", `/api/rooms/${lv.id}`, HO, { sprayEnabled: false });
    await sleep(800);
    const frames = lv.all.flatMap((c, i) => c.msgs.slice(mk0[i]).filter((m) => m.type === "room:settings"));
    check("flag off: no room:settings frame on pause/freeze/block/PATCH", frames.length === 0, JSON.stringify(frames.slice(0, 2)));
    const offView = (await rest("GET", `/api/rooms/${lv.id}`, HO)).json?.room ?? {};
    check("flag off: hostRoom key set unchanged", !("sprayAdminBlocked" in offView) && !("sprayBlockReason" in offView) && !("sprayBlockedBy" in offView) && !("sprayBlockedAt" in offView), Object.keys(offView).join());
    roomFeatures.spray = true;
  }
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = false;
  setSplitProviderForTests(null);
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  try {
    await q(`delete from room_controls where key = 'sprays_paused'`);
    await q(`delete from room_host_freezes where host_id = any($1::varchar[])`, [created]);
    if (madeAdmins.length) await q(`delete from admin_activity_logs where admin_id = any($1::varchar[])`, [madeAdmins]);
    if (created.length) {
      await q(`delete from host_clawbacks where host_id = any($1::varchar[]) or beneficiary_id = any($1::varchar[])`, [created]);
      await q(`delete from payment_transactions where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from payment_issues where provider_payment_id in (select provider_ref from spray_payments where payer_id = any($1::varchar[]))`, [created]);
      await q(`delete from spray_payments where payer_id = any($1::varchar[])`, [created]);
      if (madeRooms.length) await q(`update rooms set parent_room_id = null where id = any($1::varchar[])`, [madeRooms]).catch(() => {});
      await q(`delete from users where id = any($1::varchar[])`, [created]);
    }
    if (madeAdmins.length) await q(`delete from admin_users where id = any($1::varchar[])`, [madeAdmins]);
  } catch (e: any) { console.log(`(cleanup failed: ${e.message})`); }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
