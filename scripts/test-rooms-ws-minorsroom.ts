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

  // ---- minors' room stage rule: teens keep the mic and camera whoever is present; adults listen and chat only
  const fake = new FakeVoice();
  setVoiceServiceForTests(fake);
  const { canPublishNow, canCameraNow, sweepVoice } = await import("../server/rooms/stage");
  const TH = await mk("st_teenhost", yearsAgo(16)), S1 = await mk("st_t1", yearsAgo(15)), S2 = await mk("st_t2", yearsAgo(14)), AD = await mk("st_adult");
  for (const x of [S1, S2, AD]) await mutual(TH, x);
  const sr = await rest("POST", "/api/rooms", TH, { title: "teen stage", kind: "party", visibility: "friends" });
  const SR = sr.json.room.id as string;
  await rest("POST", `/api/rooms/${SR}/start`, TH);
  await rs.setVoiceEnabled(SR, true); await rs.setLiveVideo(SR, true);
  const lastStage = (cl: Client) => [...cl.msgs].reverse().find((m) => m.type === "room:stage" && !m.invitedYou);
  const stageNow = async (cl: Client, pred: (s: any) => boolean) => { await until(() => { const s = lastStage(cl); return !!s && pred(s); }); const s = lastStage(cl); return !!s && pred(s); };
  const lastLive = (cl: Client) => [...cl.msgs].reverse().find((m) => m.type === "room:live");
  const liveNow = async (cl: Client, pred: (l: any) => boolean) => { await until(() => { const l = lastLive(cl); return !!l && pred(l); }); const l = lastLive(cl); return !!l && pred(l); };
  const noticeOf = (cl: Client, code: string) => cl.waitFor((m) => m.type === "room:notice" && m.code === code);
  const logOf = (op: string, roomId: string, userId?: string, canPublish?: boolean) =>
    fake.calls.filter((c) => c.op === op && c.roomId === roomId && (userId === undefined || c.userId === userId) && (canPublish === undefined || c.canPublish === canPublish));
  const revokedPublish = (from: number, except?: string) => fake.calls.slice(from).filter((c) => c.op === "setCanPublish" && c.canPublish === false && c.userId !== except);
  const sth = await connect(TH), s1 = await connect(S1), s2 = await connect(S2), ad = await connect(AD);
  await join(sth, SR); await join(s1, SR); await join(s2, SR);
  const hostTok = await rest("POST", `/api/rooms/${SR}/voice-token`, TH);
  check("minors' room: the teen host's voice token can publish", hostTok.status === 200 && hostTok.json?.canPublish === true, JSON.stringify(hostTok));
  s1.send({ type: "room:stage", action: "raise" });
  check("minors' room: a teen raises a hand", await stageNow(sth, (s) => s.hands.includes(S1)));
  sth.send({ type: "room:stage", action: "accept", targetId: S1 });
  sth.send({ type: "room:stage", action: "accept", targetId: S2 });
  check("...and the teen host gives two teens the mic", await stageNow(sth, (s) => s.stage.includes(S1) && s.stage.includes(S2)));
  s1.drain();
  s1.send({ type: "room:live", action: "ask" });
  check("...a teen on stage asks for the live screen", await liveNow(sth, (l) => l.asks.includes(S1)));
  sth.send({ type: "room:live", action: "grant", targetId: S1 });
  check("...and the host gives it to them (camera)", await liveNow(sth, (l) => l.holder === S1) && canCameraNow(SR, S1));

  await rest("POST", `/api/rooms/${SR}/adult-invites/${AD}`, TH);
  await rest("POST", `/api/rooms/${SR}/adult-invites/acknowledge`, AD);
  const callsBefore = fake.calls.length;
  check("an invited, acknowledged adult joins", (await join(ad, SR))?.type === "room:state"); // the join's reconcile runs before room:state
  check("...the teen speakers stay on the stage", roomHub.stageOf(SR).stage.includes(S1) && roomHub.stageOf(SR).stage.includes(S2));
  check("...the teen host keeps the mic and no teen's publish permission is revoked", canPublishNow(SR, TH) && canPublishNow(SR, S1) && canPublishNow(SR, S2) && revokedPublish(callsBefore, AD).length === 0, JSON.stringify(fake.calls.slice(callsBefore)));
  check("...the teen keeps the live screen and camera", roomHub.liveOf(SR).holder === S1 && canCameraNow(SR, S1));
  const hostTok2 = await rest("POST", `/api/rooms/${SR}/voice-token`, TH);
  check("...a fresh token for the teen host can still publish", hostTok2.json?.canPublish === true, JSON.stringify(hostTok2.json));
  const adTok = await rest("POST", `/api/rooms/${SR}/voice-token`, AD);
  check("the adult's voice token is listen only (canPublish false)", adTok.status === 200 && adTok.json?.canPublish === false, JSON.stringify(adTok.json));
  ad.drain();
  ad.send({ type: "room:stage", action: "raise" });
  check("the adult cannot raise a hand (NOT_ELIGIBLE)", !!(await noticeOf(ad, "NOT_ELIGIBLE")));
  sth.drain();
  sth.send({ type: "room:stage", action: "accept", targetId: AD });
  check("the host cannot give the adult the mic (NOT_ELIGIBLE)", !!(await noticeOf(sth, "NOT_ELIGIBLE")));
  sth.drain();
  sth.send({ type: "room:stage", action: "invite", targetId: AD });
  check("...nor invite them to the stage (NOT_ELIGIBLE)", !!(await noticeOf(sth, "NOT_ELIGIBLE")));
  ad.drain();
  ad.send({ type: "room:live", action: "ask" });
  check("the adult cannot ask for the live screen", !!(await ad.waitFor((m) => m.type === "room:notice" && (m.code === "NOT_ON_STAGE" || m.code === "TEEN_RULE"))));
  s1.drain();
  ad.send({ type: "room:chat", text: "hello from the adult" });
  check("the adult can still chat", !!(await s1.waitFor((m) => m.type === "room:chat" && m.userId === AD)));

  // An adult co-host would be an implicit speaker elsewhere: in a minors' room their publish permission is off.
  const adMember = roomHub.get(SR, AD);
  if (adMember) adMember.role = "cohost";
  check("an adult co-host in a minors' room cannot publish", !!adMember && !canPublishNow(SR, AD));
  if (adMember) adMember.role = "guest";

  const callsBeforeRevoke = fake.calls.length;
  await rest("DELETE", `/api/rooms/${SR}/adult-invites/${AD}`, TH);
  check("revoking the adult takes them out", await until(() => !roomHub.get(SR, AD)));
  check("...LiveKit is told to drop them at once", logOf("remove", SR, AD).length >= 1);
  check("...and nothing changes for the teens (stage, screen, publish)", roomHub.stageOf(SR).stage.includes(S1) && roomHub.stageOf(SR).stage.includes(S2) && roomHub.liveOf(SR).holder === S1 && canPublishNow(SR, TH)
    && revokedPublish(callsBeforeRevoke).length === 0, JSON.stringify(fake.calls.slice(callsBeforeRevoke)));
  // A token minted before the revoke lives up to 60 s: if they reconnect to LiveKit with it, the sweep removes anyone not in the room.
  const removesBefore = logOf("remove", SR, AD).length;
  fake.participants = [{ identity: TH, canPublish: true }, { identity: S1, canPublish: true }, { identity: AD, canPublish: false }];
  await sweepVoice(SR);
  check("voice sweep: a revoked adult back in LiveKit on an old token is removed", logOf("remove", SR, AD).length > removesBefore);
  check("...and nobody who is in the room is removed", logOf("remove", SR, TH).length === 0 && logOf("remove", SR, S1).length === 0);
  fake.participants = [];

  // An adult who simply leaves: nothing changes for teens either.
  const AD2 = await mk("st_adult2"); await mutual(TH, AD2);
  await rest("POST", `/api/rooms/${SR}/adult-invites/${AD2}`, TH);
  await rest("POST", `/api/rooms/${SR}/adult-invites/acknowledge`, AD2);
  const ad2 = await connect(AD2);
  check("a second invited adult joins", (await join(ad2, SR))?.type === "room:state");
  const callsBeforeLeave = fake.calls.length;
  ad2.send({ type: "room:leave" });
  check("...and leaves", await until(() => !roomHub.get(SR, AD2)));
  check("...teens unchanged after the adult leaves", roomHub.stageOf(SR).stage.length === 2 && roomHub.liveOf(SR).holder === S1 && revokedPublish(callsBeforeLeave).length === 0);

  // ---- an adult already on the stage when a room becomes a minors' room (host corrected to a teen) is taken off it
  const NH = await mk("st_normhost"), NA = await mk("st_normadult"), NT = await mk("st_normteen", yearsAgo(15));
  const NR = await rs.createRoom(NH, { title: "normal first", kind: "party", visibility: "public", ageLimit: "all" } as any);
  await rs.setStatus(NR.id, "live"); await rs.setVoiceEnabled(NR.id, true);
  const nh = await connect(NH), na = await connect(NA), nt = await connect(NT);
  await join(nh, NR.id); await join(na, NR.id); await join(nt, NR.id);
  nh.send({ type: "room:stage", action: "accept", targetId: NA });
  check("normal room (unchanged rule): the host gives an adult the mic", await stageNow(nh, (s) => s.stage.includes(NA)));
  nt.drain();
  nt.send({ type: "room:stage", action: "raise" });
  check("normal room (unchanged rule): a teen cannot raise a hand with adults present", !!(await noticeOf(nt, "NOT_ELIGIBLE")));
  // An adult holding an acknowledged invite stays in the room after the switch. Such a row cannot be made through the API
  // for a room that is not yet a minors' room, so it is written directly.
  await q(`insert into room_adult_invites (room_id, user_id, invited_by, acknowledged_at, first_acknowledged_at) values ($1,$2,$3, now(), now())`, [NR.id, NA, NH]);
  const fixAdmin = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A','super_admin') returning id`,
    [`mr_adm2${stamp}`, `mr_adm2${stamp}@t.dev`, hash]))[0].id as string;
  await correctDateOfBirth({ adminId: fixAdmin, userId: NH, dateOfBirth: yearsAgo(15), reason: "test correction" });
  check("host corrected to a teen: the room becomes a minors' room", (await rs.getRoom(NR.id))!.minorsRoom === true);
  check("...the invited adult stays in the room but is taken off the stage", !!roomHub.get(NR.id, NA) && await stageNow(nh, (s) => !s.stage.includes(NA)));
  check("...and loses publish permission", !canPublishNow(NR.id, NA));
  nt.drain();
  nt.send({ type: "room:stage", action: "raise" });
  check("...while the teen can now raise a hand with the adult present", await stageNow(nh, (s) => s.hands.includes(NT)));
  setVoiceServiceForTests(undefined);

  // ---- nothing a teen received in this file carried the warning
  check("the warning was never sent to a teen", ![t2, s1, s2, sth, th, nt].some((cl) => cl.msgs.some((m) => m.warning !== undefined || JSON.stringify(m).includes("legal action"))));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const cl of conns) try { cl.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
