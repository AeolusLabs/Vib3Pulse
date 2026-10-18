// Minors' rooms over a real WebSocket server (same harness as test-rooms-ws.ts), with the REST routes on the same server.
//   npm run test:rooms     Needs a scratch database whose name contains "test". Usernames use the prefix mr_.
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
const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");
const { tuning } = await import("../server/rooms/roomSocket");
const { MINORS_ROOM_WARNING } = await import("../shared/rooms");
const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
wsManager.initialize(server, fakeStore);
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const url = `ws://127.0.0.1:${port}/ws`;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.13.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
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
  return c.waitFor((m) => m.type === "room:state" || m.type === "room:error");
};
const until = async (f: () => Promise<boolean> | boolean, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const mk = async (name: string, dob: string | null = yearsAgo(30)) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`mr_${name}${stamp}@t.dev`, `mr_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const isMinorsError = (m: any, code: string) => m?.type === "room:error" && m.code === code && m.warning === MINORS_ROOM_WARNING;

tuning.join = { rate: 1000, burst: 1000 };
tuning.stage = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000; // the host's socket may drop between blocks; the room must not end behind the tests

try {
  const T = await mk("teenhost", yearsAgo(15)), T2 = await mk("teen2", yearsAgo(16));
  const A = await mk("adultfriend"), B = await mk("invited"), B2 = await mk("racer"), C = await mk("linkholder"), N = await mk("nodob", null), D = await mk("blocked");
  for (const x of [A, B, B2, N, D, T2]) await mutual(T, x);
  await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [T, D]);

  // A real minors' room, created and started over REST by the teen host.
  const cr = await rest("POST", "/api/rooms", T, { title: "teen hangout", kind: "party", visibility: "friends" });
  const R = cr.json.room.id as string;
  check("setup: the teen host's room is a minors' room", cr.json.room.minorsRoom === true, JSON.stringify(cr.json));
  await rest("POST", `/api/rooms/${R}/start`, T);
  const th = await connect(T), t2 = await connect(T2);
  check("host joins", (await join(th, R))?.type === "room:state");
  const t2s = await join(t2, R);
  check("a teen friend joins normally", t2s?.type === "room:state" && t2s.room?.minorsRoom === true, JSON.stringify(t2s));

  // ---- refusals over the socket
  const a = await connect(A);
  const aj = await join(a, R);
  check("adult friend without an invite: room:error MINORS_ROOM with the warning", isMinorsError(aj, "MINORS_ROOM"), JSON.stringify(aj));
  check("...and is not in the room", !roomHub.get(R, A));
  check("...the refusal says nothing about the room", !JSON.stringify(aj).includes("teen hangout") && !JSON.stringify(aj).includes(T));
  const aj2 = await join(a, R, { ack: true, acknowledged: true, minorsRoom: false });
  check("client-sent ack / minorsRoom fields are ignored", isMinorsError(aj2, "MINORS_ROOM"), JSON.stringify(aj2));

  const n = await connect(N);
  const nj = await join(n, R);
  check("unknown age: AGE_UNKNOWN (no warning)", nj?.type === "room:error" && nj.code === "AGE_UNKNOWN" && nj.warning === undefined, JSON.stringify(nj));
  const d = await connect(D);
  const dj = await join(d, R);
  check("blocked adult: NOT_FOUND, no warning (same as a room that does not exist)", dj?.type === "room:error" && dj.code === "NOT_FOUND" && dj.warning === undefined, JSON.stringify(dj));

  // invite-only minors' room joined with its link by an adult
  const ri = await rest("POST", "/api/rooms", T2, { title: "teen invite room", kind: "party", visibility: "invite" });
  const RI = ri.json.room.id as string;
  const tok = new URL(`http://x${ri.json.inviteLink}`).searchParams.get("token")!;
  await rest("POST", `/api/rooms/${RI}/start`, T2);
  const c = await connect(C);
  const cj = await join(c, RI, { inviteToken: tok });
  check("invite link alone over the socket: adult refused MINORS_ROOM with the warning", isMinorsError(cj, "MINORS_ROOM"), JSON.stringify(cj));

  // ---- invited, not acknowledged; then acknowledged
  const b = await connect(B);
  await rest("POST", `/api/rooms/${R}/adult-invites/${B}`, T);
  const bj = await join(b, R);
  check("invited but not acknowledged: room:error MINORS_ROOM_ACK with the warning", isMinorsError(bj, "MINORS_ROOM_ACK"), JSON.stringify(bj));
  const bj2 = await join(b, R, { ack: true });
  check("...a client-sent ack does not count", isMinorsError(bj2, "MINORS_ROOM_ACK"), JSON.stringify(bj2));
  await rest("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B);
  const bj3 = await join(b, R);
  check("invited and acknowledged: admitted (room:state)", bj3?.type === "room:state", JSON.stringify(bj3));
  check("the teen sees them join", !!(await t2.waitFor((m) => m.type === "room:joined" && m.member?.userId === B)));
  check("the invite is personal: the adult friend is still refused", isMinorsError(await join(a, R), "MINORS_ROOM"));

  // ---- revoke while inside ejects with a notice
  b.drain(); t2.drain();
  const rv = await rest("DELETE", `/api/rooms/${R}/adult-invites/${B}`, T);
  check("host revokes over REST", rv.status === 200 && rv.json?.revoked === true, JSON.stringify(rv));
  check("the adult is told, with the warning", isMinorsError(await b.waitFor((m) => m.type === "room:error"), "MINORS_ROOM"));
  check("the room sees them leave", !!(await t2.waitFor((m) => m.type === "room:left" && m.userId === B)));
  check("they are out of the room", !roomHub.get(R, B));
  check("they cannot rejoin", isMinorsError(await join(b, R), "MINORS_ROOM"));
  b.drain();
  b.send({ type: "room:chat", text: "still here?" });
  check("...and their socket can no longer talk to the room", !!(await b.waitFor((m) => m.type === "room:notice" && m.code === "NOT_IN_ROOM")));

  // ---- race: join and revoke at the same moment; the adult must never end up inside
  const b2 = await connect(B2);
  let inThenOut = 0, refused = 0, bad = 0;
  // The revoke is fired at different points of the join (several database round trips long), so some rounds land before the
  // first check, some between the first check and the fresh re-read, and some after the hub insert.
  const delays = [0, 250, 500, 900, 1400];
  for (let i = 0; i < delays.length; i++) {
    const inv = await rest("POST", `/api/rooms/${R}/adult-invites/${B2}`, T);
    const ak = await rest("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B2);
    if (inv.status !== 200 || ak.status !== 200) { bad++; console.log("race setup failed", inv.status, ak.status); continue; }
    b2.drain();
    b2.send({ type: "room:join", roomId: R });          // back to back: the join is in flight
    const revoke = sleep(delays[i]).then(() => rest("DELETE", `/api/rooms/${R}/adult-invites/${B2}`, T)); // ...while the revoke lands
    const first = await b2.waitFor((m) => m.type === "room:state" || m.type === "room:error");
    await revoke;
    const out = await until(() => !roomHub.get(R, B2), 15_000);
    if (!out) { bad++; continue; }
    if (first?.type === "room:state") {
      // got in on a stale read: must have been taken out by the revoke, with the warning
      if (await b2.waitFor((m) => isMinorsError(m, "MINORS_ROOM"), 15_000)) inThenOut++; else bad++;
    } else if (isMinorsError(first, "MINORS_ROOM")) refused++;
    else bad++;
    await sleep(0);
    if (roomHub.get(R, B2)) bad++; // no late insert after the revoke settled
  }
  check(`join + revoke race (${delays.length} rounds): never left inside (refused ${refused}, in then out ${inThenOut})`, bad === 0 && refused + inThenOut === delays.length, `bad=${bad}`);
  await sleep(1500);
  check("...and still not inside a moment later", !roomHub.get(R, B2));

  // ---- deterministic race: the revoke lands while the join is held between its first check and the fresh re-read.
  // B2 sits in another room with voice on; joining R first leaves that room, which calls LiveKit. That call is held open.
  class GatedVoice extends FakeVoice {
    gate: Promise<void> | null = null; held = false; heldRoom = ""; heldUser = "";
    async removeParticipant(roomId: string, userId: string) {
      await super.removeParticipant(roomId, userId);
      if (this.gate && roomId === this.heldRoom && userId === (this.heldUser || B2)) { this.held = true; await this.gate; }
    }
  }
  const gv = new GatedVoice();
  setVoiceServiceForTests(gv);
  const YH = await mk("yhost");
  const Y = await rs.createRoom(YH, { title: "elsewhere", kind: "party", visibility: "public", ageLimit: "all" } as any);
  await rs.setStatus(Y.id, "live"); await rs.setVoiceEnabled(Y.id, true);
  const yh = await connect(YH);
  await join(yh, Y.id);
  check("held race setup: the adult is in another room", (await join(b2, Y.id))?.type === "room:state");
  await rest("POST", `/api/rooms/${R}/adult-invites/${B2}`, T);
  await rest("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B2);
  let release!: () => void;
  gv.gate = new Promise<void>((r) => { release = r; }); gv.heldRoom = Y.id;
  b2.drain();
  b2.send({ type: "room:join", roomId: R });
  check("held race: the join passed its first check and is held mid-way", await until(() => gv.held));
  let revokeDone = false;
  const heldRevoke = rest("DELETE", `/api/rooms/${R}/adult-invites/${B2}`, T).then((r) => { revokeDone = true; return r; });
  check("held race: the revoke is committed while the join is held", await until(async () => (await q(`select revoked_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B2]))[0]?.revoked_at != null));
  await sleep(600);
  check("held race: the revoke waits for the in-flight join before it answers", !revokeDone);
  release();
  const heldFirst = await b2.waitFor((m) => (m.type === "room:state" && m.room?.id === R) || m.type === "room:error");
  check("held race: the fresh re-read refuses the join (MINORS_ROOM with the warning), never a room:state", isMinorsError(heldFirst, "MINORS_ROOM"), JSON.stringify(heldFirst));
  check("held race: the revoke then answers", (await heldRevoke).status === 200);
  check("held race: the adult is not in the minors' room", !roomHub.get(R, B2));
  gv.gate = null;

  // ---- held race 2: a teen's birthdate is corrected to an adult while their join is held; the fresh re-read uses the new age
  const { correctDateOfBirth } = await import("../server/services/dobCorrection");
  const admin = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A','super_admin') returning id`,
    [`mr_adm${stamp}`, `mr_adm${stamp}@t.dev`, hash]))[0].id as string;
  const TG = await mk("teen_fixed", yearsAgo(16));
  await mutual(T, TG);
  const tg = await connect(TG);
  check("held race 2 setup: the teen is in another room", (await join(tg, Y.id))?.type === "room:state");
  let release2!: () => void;
  gv.held = false; gv.heldUser = TG; gv.gate = new Promise<void>((r) => { release2 = r; });
  tg.drain();
  tg.send({ type: "room:join", roomId: R });
  check("held race 2: the teen's join passed its first check and is held", await until(() => gv.held));
  const fixing = correctDateOfBirth({ adminId: admin, userId: TG, dateOfBirth: yearsAgo(30), reason: "test correction" });
  check("held race 2: the correction is saved while the join is held", await until(async () => (await q(`select date_of_birth from users where id=$1`, [TG]))[0]?.date_of_birth === yearsAgo(30)));
  release2();
  const tgFirst = await tg.waitFor((m) => (m.type === "room:state" && m.room?.id === R) || m.type === "room:error");
  check("held race 2: refused at the fresh re-read with the new age (MINORS_ROOM + warning), never a room:state", isMinorsError(tgFirst, "MINORS_ROOM"), JSON.stringify(tgFirst));
  check("held race 2: the correction finishes and they are not in the minors' room", (await fixing).ok && !roomHub.get(R, TG));
  gv.gate = null; gv.heldUser = "";

  // ---- teen stage rule unchanged: an invited adult still takes teen speakers off the stage
  const fake = new FakeVoice();
  setVoiceServiceForTests(fake);
  const TH = await mk("st_teenhost", yearsAgo(16)), S1 = await mk("st_t1", yearsAgo(15)), AD = await mk("st_adult");
  await mutual(TH, S1); await mutual(TH, AD);
  const sr = await rest("POST", "/api/rooms", TH, { title: "teen stage", kind: "party", visibility: "friends" });
  const SR = sr.json.room.id as string;
  await rest("POST", `/api/rooms/${SR}/start`, TH);
  await rs.setVoiceEnabled(SR, true);
  const lastStage = (cl: Client) => [...cl.msgs].reverse().find((m) => m.type === "room:stage" && !m.invitedYou);
  const stageNow = async (cl: Client, pred: (s: any) => boolean) => { await until(() => { const s = lastStage(cl); return !!s && pred(s); }); const s = lastStage(cl); return !!s && pred(s); };
  const sth = await connect(TH), s1 = await connect(S1), ad = await connect(AD);
  await join(sth, SR); await join(s1, SR);
  const hostTok = await rest("POST", `/api/rooms/${SR}/voice-token`, TH);
  check("all-teen minors' room: the teen host's voice token can publish", hostTok.status === 200 && hostTok.json?.canPublish === true, JSON.stringify(hostTok));
  const logOf = (op: string, roomId: string, userId?: string, canPublish?: boolean) =>
    fake.calls.filter((c) => c.op === op && c.roomId === roomId && (userId === undefined || c.userId === userId) && (canPublish === undefined || c.canPublish === canPublish));
  s1.send({ type: "room:stage", action: "raise" });
  check("all-teen minors' room: a teen can raise a hand", await stageNow(sth, (s) => s.hands.includes(S1)));
  sth.send({ type: "room:stage", action: "accept", targetId: S1 });
  check("...and the teen host gives them the mic", await stageNow(sth, (s) => s.stage.includes(S1)));
  await rest("POST", `/api/rooms/${SR}/adult-invites/${AD}`, TH);
  await rest("POST", `/api/rooms/${SR}/adult-invites/acknowledge`, AD);
  check("an invited, acknowledged adult joins", (await join(ad, SR))?.type === "room:state");
  check("...and the teen speaker comes off the stage (existing rule, unchanged)", await stageNow(sth, (s) => s.stage.length === 0));
  check("...and the teen HOST's own mic permission is revoked while the adult is there (existing rule; host keeps the role)", await until(() => logOf("setCanPublish", SR, TH, false).length >= 1) && roomHub.get(SR, TH)?.role === "host");
  s1.drain();
  s1.send({ type: "room:stage", action: "raise" });
  check("...a teen cannot raise a hand while the adult is there (NOT_ELIGIBLE)", !!(await s1.waitFor((m) => m.type === "room:notice" && m.code === "NOT_ELIGIBLE")));
  sth.drain(); s1.drain();
  await rest("DELETE", `/api/rooms/${SR}/adult-invites/${AD}`, TH);
  check("revoking the adult takes them out of the stage room too", await until(() => !roomHub.get(SR, AD)));
  check("...and LiveKit is told to drop them at once", logOf("remove", SR, AD).length >= 1);
  check("...the teen host's mic permission comes back", await until(() => logOf("setCanPublish", SR, TH, true).length >= 1));
  // A token minted before the revoke lives up to 60 s: if they reconnect to LiveKit with it, the sweep removes anyone not in the room.
  const { sweepVoice } = await import("../server/rooms/stage");
  const removesBefore = logOf("remove", SR, AD).length;
  fake.participants = [{ identity: TH, canPublish: true }, { identity: S1, canPublish: false }, { identity: AD, canPublish: false }];
  await sweepVoice(SR);
  check("voice sweep: a revoked adult back in LiveKit on an old token is removed", logOf("remove", SR, AD).length > removesBefore);
  check("...and nobody who is in the room is removed", logOf("remove", SR, TH).length === 0 && logOf("remove", SR, S1).length === 0);
  fake.participants = [];
  s1.send({ type: "room:stage", action: "raise" });
  check("...and teens can raise a hand again once the adult is gone", await stageNow(sth, (s) => s.hands.includes(S1)));
  setVoiceServiceForTests(undefined);

  // ---- nothing a teen received in this file carried the warning
  check("the warning was never sent to a teen", ![t2, s1, sth, th].some((cl) => cl.msgs.some((m) => m.warning !== undefined || JSON.stringify(m).includes("legal action"))));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const cl of conns) try { cl.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
