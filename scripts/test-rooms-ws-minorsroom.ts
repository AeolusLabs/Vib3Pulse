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
const { tuning, expectHost } = await import("../server/rooms/roomSocket");
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
setVoiceServiceForTests(null); // never the real LiveKit, even at this server's boot (rehydrate + boot voice sweep)
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
  await mutual(NH, NA); await mutual(NH, NT);
  const NR = await rs.createRoom(NH, { title: "normal first", kind: "party", visibility: "friends", ageLimit: "all" } as any);
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

  // ---- N1: a correction refreshes the live age at once (no rejoin): a normal-room adult speaker corrected to 16
  const H6 = await mk("n1_normhost"), A6 = await mk("n1_normadult"), A7 = await mk("n1_normadult2");
  for (const x of [A6, A7]) await mutual(H6, x);
  const R6 = await rs.createRoom(H6, { title: "n1 normal 2", kind: "party", visibility: "friends", ageLimit: "all" } as any);
  await rs.setStatus(R6.id, "live"); await rs.setVoiceEnabled(R6.id, true);
  const h6 = await connect(H6), a6 = await connect(A6), a7 = await connect(A7);
  await join(h6, R6.id); await join(a6, R6.id); await join(a7, R6.id);
  h6.send({ type: "room:stage", action: "accept", targetId: A6 });
  h6.send({ type: "room:stage", action: "accept", targetId: A7 });
  check("N1 normal setup: two adults on stage", await stageNow(h6, (s) => s.stage.includes(A6) && s.stage.includes(A7)));
  const beforeN1n = fake.calls.length;
  await correctDateOfBirth({ adminId: fixAdmin, userId: A6, dateOfBirth: yearsAgo(45), reason: "test correction" });
  check("N1 normal room: adult corrected to another adult age keeps the stage, no permission change, room not flagged",
    roomHub.stageOf(R6.id).stage.includes(A6) && canPublishNow(R6.id, A6) && !fake.calls.slice(beforeN1n).some((c) => c.op === "setCanPublish" && c.canPublish === false) && (await rs.getRoom(R6.id))!.minorsRoom === false);
  await correctDateOfBirth({ adminId: fixAdmin, userId: A7, dateOfBirth: yearsAgo(16), reason: "test correction" });
  check("N1 normal room: a speaker corrected to 16 with adults present comes off the stage at once (live age refreshed)", await stageNow(h6, (s) => !s.stage.includes(A7)) && !canPublishNow(R6.id, A7) && roomHub.get(R6.id, A7)?.age === 16);

  // ---- (a) a teen host corrected to an adult loses every minors' room: live ended, scheduled cancelled, normal rooms kept
  const H3 = await mk("n1_host", yearsAgo(16)), G3 = await mk("n1_teen", yearsAgo(15)), G4 = await mk("n1_teen2", yearsAgo(14));
  for (const x of [G3, G4]) await mutual(H3, x);
  const m3 = await rest("POST", "/api/rooms", H3, { title: "n1 room", kind: "party", visibility: "friends" });
  const MR3 = m3.json.room.id as string;
  const ms3 = await rest("POST", "/api/rooms", H3, { title: "n1 later", kind: "party", visibility: "invite", scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
  const MS3 = ms3.json.room.id as string;
  const NN3 = (await rs.createRoom(H3, { title: "n1 normal", kind: "party", visibility: "friends", ageLimit: "all" } as any)).id; // a room that is not a minors' room
  check("(a) setup: two minors' rooms and one normal room", m3.json.room.minorsRoom === true && ms3.json.room.minorsRoom === true && !(await rs.getRoom(NN3))!.minorsRoom);
  await rest("POST", `/api/rooms/${MR3}/start`, H3);
  await rs.setVoiceEnabled(MR3, true); await rs.setLiveVideo(MR3, true);
  const h3 = await connect(H3), g3 = await connect(G3), g4 = await connect(G4);
  await join(h3, MR3); await join(g3, MR3); await join(g4, MR3);
  await rest("POST", `/api/rooms/${MR3}/voice-token`, H3);
  h3.send({ type: "room:stage", action: "accept", targetId: G3 });
  h3.send({ type: "room:stage", action: "accept", targetId: G4 });
  check("(a) setup: two teens on stage", await stageNow(h3, (s) => s.stage.includes(G3) && s.stage.includes(G4)));
  h3.send({ type: "room:live", action: "grant", targetId: H3 });
  check("(a) setup: the teen host holds the mic and the live screen", await liveNow(h3, (l) => l.holder === H3) && canPublishNow(MR3, H3) && canCameraNow(MR3, H3));
  // a teen guest on stage corrected to an adult: taken out (no invite); the room carries on
  await correctDateOfBirth({ adminId: fixAdmin, userId: G4, dateOfBirth: yearsAgo(30), reason: "test correction" });
  check("a teen speaker corrected to an adult is taken out of the minors' room", !roomHub.get(MR3, G4) && !roomHub.stageOf(MR3).stage.includes(G4) && (await rs.getRoom(MR3))!.status === "live");
  g3.drain();
  await correctDateOfBirth({ adminId: fixAdmin, userId: H3, dateOfBirth: yearsAgo(25), reason: "test correction" });
  check("(a) host corrected to 25: the live minors' room is ended", (await rs.getRoom(MR3))!.status === "ended" && roomHub.count(MR3) === 0);
  check("...the guests are told in plain words, then that the room ended", !!(await g3.waitFor((m) => m.type === "room:notice" && m.code === "HOST_REVIEW" && /account is being reviewed/.test(m.message))) && !!(await g3.waitFor((m) => m.type === "room:ended")));
  check("...the scheduled minors' room is cancelled", (await rs.getRoom(MS3))!.status === "ended");
  check("...their normal room is untouched", (await rs.getRoom(NN3))!.status === "scheduled");
  const restart = await rest("POST", `/api/rooms/${MS3}/start`, H3);
  check("...and the cancelled room cannot be started", restart.status === 409, JSON.stringify(restart));
  await correctDateOfBirth({ adminId: fixAdmin, userId: H3, dateOfBirth: yearsAgo(25), reason: "test correction again" });
  check("...a repeat correction is a no-op (idempotent)", (await rs.getRoom(NN3))!.status === "scheduled" && (await rs.getRoom(MR3))!.status === "ended");

  // ---- adult-posing host of a normal room corrected to a teen: the room becomes a minors' room and they keep speaking
  const H5 = await mk("n1_adulthost"), G5 = await mk("n1_teen5", yearsAgo(15));
  await mutual(H5, G5);
  const R5 = await rs.createRoom(H5, { title: "n1 normal", kind: "party", visibility: "friends", ageLimit: "all" } as any);
  const R5pub = await rs.createRoom(H5, { title: "n1 public", kind: "party", visibility: "public", ageLimit: "all", scheduledFor: new Date(Date.now() + 3600e3).toISOString() } as any);
  const R5adult = await rs.createRoom(H5, { title: "n1 18+", kind: "party", visibility: "friends", ageLimit: "18+", scheduledFor: new Date(Date.now() + 3600e3).toISOString() } as any);
  await rs.setStatus(R5.id, "live"); await rs.setVoiceEnabled(R5.id, true);
  const h5 = await connect(H5), g5 = await connect(G5);
  await join(h5, R5.id); await join(g5, R5.id);
  await rest("POST", `/api/rooms/${R5.id}/voice-token`, H5);
  check("N1 reverse setup: the adult host of a normal room can publish", canPublishNow(R5.id, H5));
  await correctDateOfBirth({ adminId: fixAdmin, userId: H5, dateOfBirth: yearsAgo(15), reason: "test correction" });
  check("N1 reverse: host corrected to 15: the room is a minors' room and the host (now a teen) still speaks", (await rs.getRoom(R5.id))!.minorsRoom === true && canPublishNow(R5.id, H5));
  check("...rooms a 15-year-old could not host are cancelled (a public room, an 18+ room)", (await rs.getRoom(R5pub.id))!.status === "ended" && (await rs.getRoom(R5adult.id))!.status === "ended");
  g5.send({ type: "room:stage", action: "raise" });
  check("...and the teen guest may now raise a hand", await stageNow(h5, (s) => s.hands.includes(G5)));

  // ---- N2: a join held between its fresh read and the hub insert while the (empty) room becomes a minors' room
  const H7 = await mk("n2_host"), X7 = await mk("n2_adult");
  await mutual(H7, X7);
  const R7 = await rs.createRoom(H7, { title: "n2 room", kind: "party", visibility: "friends", ageLimit: "all" } as any);
  await rs.setStatus(R7.id, "live"); expectHost(R7.id); // nobody in it
  const x7 = await connect(X7);
  const realGetUser = storage.getUser.bind(storage);
  let calls7 = 0, held7 = false, release7!: () => void;
  const gate7 = new Promise<void>((r) => { release7 = r; });
  (storage as any).getUser = async (id: string) => {
    if (id === X7 && ++calls7 === 2) { held7 = true; await gate7; } // the 2nd read of X7 in a join is the fresh re-read
    return realGetUser(id);
  };
  try {
    x7.drain();
    x7.send({ type: "room:join", roomId: R7.id });
    check("N2: the join is held at its fresh re-read", await until(() => held7));
    await sleep(1000); // the fresh room read was issued together with the held user read: let it return (minors_room false)
    await correctDateOfBirth({ adminId: fixAdmin, userId: H7, dateOfBirth: yearsAgo(15), reason: "test correction" });
    check("N2: the empty room is now a minors' room in the database", (await rs.getRoom(R7.id))!.minorsRoom === true);
    release7();
    const x7First = await x7.waitFor((m) => (m.type === "room:state" && m.room?.id === R7.id) || m.type === "room:error");
    check("N2: the adult is refused before the hub insert (MINORS_ROOM + warning), never a room:state", isMinorsError(x7First, "MINORS_ROOM"), JSON.stringify(x7First));
    check("N2: and is not in the room", !roomHub.get(R7.id, X7));
  } finally {
    (storage as any).getUser = realGetUser;
    release7();
  }

  // ---- leftover race: as N2, but a teen joins and leaves the empty room while the adult's join is held
  const H8 = await mk("n3_host"), X8 = await mk("n3_adult"), T8 = await mk("n3_teen", yearsAgo(15));
  await mutual(H8, X8); await mutual(H8, T8);
  const R8 = await rs.createRoom(H8, { title: "n3 room", kind: "party", visibility: "friends", ageLimit: "all" } as any);
  await rs.setStatus(R8.id, "live"); expectHost(R8.id);
  const x8 = await connect(X8), t8 = await connect(T8);
  let calls8 = 0, held8 = false, release8!: () => void;
  const gate8 = new Promise<void>((r) => { release8 = r; });
  (storage as any).getUser = async (id: string) => {
    if (id === X8 && ++calls8 === 2) { held8 = true; await gate8; }
    return realGetUser(id);
  };
  try {
    x8.drain();
    x8.send({ type: "room:join", roomId: R8.id });
    check("leftover race: the adult's join is held at its fresh re-read", await until(() => held8));
    await sleep(1000);
    await correctDateOfBirth({ adminId: fixAdmin, userId: H8, dateOfBirth: yearsAgo(15), reason: "test correction" });
    check("leftover race: a teen joins the now minors' room", (await join(t8, R8.id))?.type === "room:state");
    t8.send({ type: "room:leave" });
    check("...and leaves, emptying it", await until(() => roomHub.count(R8.id) === 0));
    release8();
    const x8First = await x8.waitFor((m) => (m.type === "room:state" && m.room?.id === R8.id) || m.type === "room:error");
    check("leftover race: the adult is still refused (MINORS_ROOM + warning)", isMinorsError(x8First, "MINORS_ROOM"), JSON.stringify(x8First));
    check("leftover race: and is not in the room", !roomHub.get(R8.id, X8));
  } finally {
    (storage as any).getUser = realGetUser;
    release8();
  }

  // ---- one step of a birthdate correction throws: the later steps and the other rooms still run; running it again finishes the job
  const HC = await mk("iso_host"), XA = await mk("iso_adult_a"), XB = await mk("iso_adult_b");
  await mutual(HC, XA); await mutual(HC, XB);
  const mkLive = async (title: string) => { const r = await rs.createRoom(HC, { title, kind: "party", visibility: "friends", ageLimit: "all" } as any); await rs.setStatus(r.id, "live"); expectHost(r.id); return r.id as string; };
  const mkLive2 = async (host: string, title: string) => { const r = await rs.createRoom(host, { title, kind: "party", visibility: "friends", ageLimit: "all" } as any); await rs.setStatus(r.id, "live"); expectHost(r.id); return r.id as string; };
  const RA = await mkLive("iso room a"), RB = await mkLive("iso room b");
  const RPub = (await rs.createRoom(HC, { title: "iso public", kind: "party", visibility: "public", ageLimit: "all", scheduledFor: new Date(Date.now() + 3600e3).toISOString() } as any)).id as string;
  const hc = await connect(HC), xa = await connect(XA), xb = await connect(XB);
  check("isolation setup: the adult guests are in two different live rooms", (await join(hc, RA))?.type === "room:state" && (await join(xa, RA))?.type === "room:state" && (await join(xb, RB))?.type === "room:state");
  (storage as any).getUser = async (id: string) => { if (id === XA) throw new Error("injected failure"); return realGetUser(id); };
  let isoRes: any;
  try { isoRes = await correctDateOfBirth({ adminId: fixAdmin, userId: HC, dateOfBirth: yearsAgo(15), reason: "test correction" }); }
  finally { (storage as any).getUser = realGetUser; }
  check("a throwing step is reported: the birthdate is saved and roomsFailed is set with the failed room id", isoRes?.ok === true && isoRes.roomsFailed === true && (isoRes.failedRoomIds ?? []).includes(RA) && !(isoRes.failedRoomIds ?? []).includes(RB), JSON.stringify(isoRes));
  check("...both rooms were still flagged as minors' rooms", (await rs.getRoom(RA))!.minorsRoom === true && (await rs.getRoom(RB))!.minorsRoom === true);
  check("...the adult in the OTHER room is still evicted", !roomHub.get(RB, XB));
  check("...the later step still ran: the public room a 15-year-old cannot host is cancelled", (await rs.getRoom(RPub))!.status === "ended");
  check("...the guest whose check threw is taken out (fail closed; they can rejoin through the gated join), with a plain notice and no warning", !roomHub.get(RA, XA) && xa.msgs.some((m) => m.type === "room:notice" && m.code === "REVIEW") && !xa.msgs.some((m) => m.warning !== undefined || m.code === "MINORS_ROOM"));
  const isoAgain = await correctDateOfBirth({ adminId: fixAdmin, userId: HC, dateOfBirth: yearsAgo(15), reason: "test correction again" });
  check("running the correction again succeeds without roomsFailed", isoAgain?.ok === true && !isoAgain.roomsFailed, JSON.stringify(isoAgain));
  check("...and the rooms are otherwise unchanged", !roomHub.get(RA, XA) && !roomHub.get(RB, XB) && (await rs.getRoom(RA))!.status === "live" && (await rs.getRoom(RB))!.status === "live" && (await rs.getRoom(RPub))!.status === "ended");
  await correctDateOfBirth({ adminId: fixAdmin, userId: HC, dateOfBirth: yearsAgo(15), reason: "test correction a third time" });
  check("...a third run changes nothing (idempotent)", !roomHub.get(RA, XA) && (await rs.getRoom(RA))!.minorsRoom === true && (await rs.getRoom(RPub))!.status === "ended");

  // ---- Round 6: a public room with an adult inside is ended with the NEUTRAL notice before anything can flag it; the adult never sees the under-18s warning
  const HP = await mk("neutral_host"), XP = await mk("neutral_adult");
  const RP = (await rs.createRoom(HP, { title: "neutral public", kind: "party", visibility: "public", ageLimit: "all" } as any)).id as string;
  await rs.setStatus(RP, "live"); expectHost(RP);
  const hp = await connect(HP), xp = await connect(XP);
  check("neutral order setup: the adult host and an adult guest are in a live public room", (await join(hp, RP))?.type === "room:state" && (await join(xp, RP))?.type === "room:state");
  xp.drain();
  await correctDateOfBirth({ adminId: fixAdmin, userId: HP, dateOfBirth: yearsAgo(15), reason: "test correction" });
  check("neutral order: the room is ended", (await rs.getRoom(RP))!.status === "ended");
  check("neutral order: the adult got the plain HOST_REVIEW notice", xp.msgs.some((m) => m.type === "room:notice" && m.code === "HOST_REVIEW"));
  check("neutral order: the adult NEVER received the under-18s warning or a MINORS_ROOM error", !xp.msgs.some((m) => m.warning !== undefined || m.code === "MINORS_ROOM" || JSON.stringify(m).includes("legal action")), JSON.stringify(xp.msgs.slice(-5)));
  check("neutral order: the ended room was never flagged as a minors' room", (await rs.getRoom(RP))!.minorsRoom === false);

  // ---- Round 6: the flag step throws: the host's live room is still closed (neutral), nobody is left in a room that should be a minors' room
  const { db: dbF } = await import("../server/storage");
  const HF = await mk("flagfail_host"), XF = await mk("flagfail_adult");
  await mutual(HF, XF);
  const RF = await mkLive2(HF, "flag fail room");
  const hf = await connect(HF), xf = await connect(XF);
  check("flag failure setup: host and an adult guest are in a live friends room", (await join(hf, RF))?.type === "room:state" && (await join(xf, RF))?.type === "room:state");
  xf.drain();
  const realUpdate = dbF.update.bind(dbF);
  (dbF as any).update = (t: any) => { // only the write that sets minorsRoom fails
    const b = realUpdate(t); const realSet = b.set.bind(b);
    (b as any).set = (v: any) => { if (v && "minorsRoom" in v) throw new Error("injected flag failure"); return realSet(v); };
    return b;
  };
  let flagRes: any;
  try { flagRes = await correctDateOfBirth({ adminId: fixAdmin, userId: HF, dateOfBirth: yearsAgo(15), reason: "test correction" }); }
  finally { (dbF as any).update = realUpdate; }
  check("flag step failure is reported (roomsFailed)", flagRes?.ok === true && flagRes.roomsFailed === true, JSON.stringify(flagRes));
  check("...and fails closed: the host's live room is ended", (await rs.getRoom(RF))!.status === "ended" && !roomHub.get(RF, XF));
  check("...the adult got the neutral notice, never the warning", xf.msgs.some((m) => m.type === "room:notice" && m.code === "HOST_REVIEW") && !xf.msgs.some((m) => m.warning !== undefined || m.code === "MINORS_ROOM"));
  const flagAgain = await correctDateOfBirth({ adminId: fixAdmin, userId: HF, dateOfBirth: yearsAgo(15), reason: "test correction again" });
  check("...a re-run works (nothing left to do)", flagAgain?.ok === true && !flagAgain.roomsFailed, JSON.stringify(flagAgain));

  // ---- Round 7: the host-age invariant at the door. The correction job failed to flag / list, and the host was not in the hub.
  const { rooms: roomsTable } = await import("../shared/schema");
  // (1) host corrected to a teen while disconnected, the flag step fails: nothing flags the live room. On reconnect it is flagged and uninvited adults leave.
  const HD = await mk("inv_host"), XD = await mk("inv_adult"), GD = await mk("inv_teen", yearsAgo(15));
  await mutual(HD, XD); await mutual(HD, GD);
  const RD = await mkLive2(HD, "invariant room");
  const xd = await connect(XD), gd = await connect(GD);
  check("invariant (1) setup: an adult and a teen guest are in the live room, the host is disconnected", (await join(xd, RD))?.type === "room:state" && (await join(gd, RD))?.type === "room:state");
  xd.drain();
  const realUpdate2 = dbF.update.bind(dbF);
  (dbF as any).update = (t: any) => {
    const b = realUpdate2(t); const realSet = b.set.bind(b);
    (b as any).set = (v: any) => { if (v && "minorsRoom" in v) throw new Error("injected flag failure"); return realSet(v); };
    return b;
  };
  let invRes: any;
  try { invRes = await correctDateOfBirth({ adminId: fixAdmin, userId: HD, dateOfBirth: yearsAgo(15), reason: "test correction" }); }
  finally { (dbF as any).update = realUpdate2; }
  check("invariant (1): the correction reports the failure and the live room is left unflagged with the adult inside", invRes?.roomsFailed === true && (await rs.getRoom(RD))!.minorsRoom === false && !!roomHub.get(RD, XD), JSON.stringify(invRes));
  const hd = await connect(HD);
  const hdj = await join(hd, RD);
  check("invariant (1): the host reconnects: allowed in, the room is now flagged in the database and in the hub", hdj?.type === "room:state" && (await rs.getRoom(RD))!.minorsRoom === true && roomHub.isMinorsRoom(RD), JSON.stringify(hdj));
  check("invariant (1): the uninvited adult is evicted with the warning (the room truly is a teen host's); the teen stays", !roomHub.get(RD, XD) && xd.msgs.some((m) => isMinorsError(m, "MINORS_ROOM")) && !!roomHub.get(RD, GD));
  const xd2 = await connect(XD);
  check("invariant (1): a new adult cannot join the now-flagged room (MINORS_ROOM + warning)", isMinorsError(await join(xd2, RD), "MINORS_ROOM"));

  // (2) host corrected to an adult while disconnected, the list step fails: the minors' room stays open. On reconnect it ends, neutrally.
  const HT = await mk("inv2_host", yearsAgo(15)), GT = await mk("inv2_teen", yearsAgo(15));
  await mutual(HT, GT);
  const crT = await rest("POST", "/api/rooms", HT, { title: "inv2 room", kind: "party", visibility: "friends" });
  const RT = crT.json.room.id as string;
  await rest("POST", `/api/rooms/${RT}/start`, HT);
  const gt = await connect(GT);
  check("invariant (2) setup: a flagged live minors' room with a teen guest and a disconnected teen host", crT.json.room.minorsRoom === true && (await join(gt, RT))?.type === "room:state");
  gt.drain();
  const realSelect = dbF.select.bind(dbF);
  let listArmed = true;
  (dbF as any).select = (...a: any[]) => { // the first read of the rooms table (the host's room list) fails once
    const b = (realSelect as any)(...a); const realFrom = b.from.bind(b);
    (b as any).from = (t: any) => { if (listArmed && t === roomsTable) { listArmed = false; throw new Error("injected list failure"); } return realFrom(t); };
    return b;
  };
  let listRes: any;
  try { listRes = await correctDateOfBirth({ adminId: fixAdmin, userId: HT, dateOfBirth: yearsAgo(30), reason: "test correction" }); }
  finally { (dbF as any).select = realSelect; }
  check("invariant (2): the correction reports the failure and the minors' room is still live with an adult host", listRes?.roomsFailed === true && (await rs.getRoom(RT))!.status === "live", JSON.stringify(listRes));
  const ht = await connect(HT);
  const htj = await join(ht, RT);
  check("invariant (2): the adult host is refused on reconnect (ROOM_ENDED) and the room is ended", htj?.type === "room:error" && htj.code === "ROOM_ENDED" && (await rs.getRoom(RT))!.status === "ended", JSON.stringify(htj));
  check("invariant (2): the guest got the neutral notice and the room end, never the warning", gt.msgs.some((m) => m.type === "room:notice" && m.code === "HOST_REVIEW") && gt.msgs.some((m) => m.type === "room:ended") && !gt.msgs.some((m) => m.warning !== undefined || m.code === "MINORS_ROOM"), JSON.stringify(gt.msgs.slice(-4)));

  // ---- restart gap: at boot, LiveKit participants in a live minors' room who are not teens are removed
  const { sweepMinorsVoiceAtBoot } = await import("../server/rooms/roomSocket");
  const bootRoom = (await rs.getRoom(SR))!;
  const throwingRoom = { ...bootRoom, id: "boot-throws" } as any;
  fake.participants = [{ identity: TH, canPublish: true }, { identity: S1, canPublish: true }, { identity: A6, canPublish: true }, { identity: X7, canPublish: false }];
  const origList = fake.listParticipants.bind(fake), origRemove = fake.removeParticipant.bind(fake);
  fake.listParticipants = async (roomId: string) => { if (roomId === "boot-throws") throw new Error("fake outage"); return origList(roomId); };
  fake.removeParticipant = async (roomId: string, userId: string) => { if (userId === A6) throw new Error("fake outage"); return origRemove(roomId, userId); };
  const beforeBoot = fake.calls.length;
  await sweepMinorsVoiceAtBoot([throwingRoom, bootRoom, (await rs.getRoom(R6.id))!]);
  const bootRemoved = fake.calls.slice(beforeBoot).filter((c) => c.op === "remove").map((c) => `${c.roomId === SR ? "minors" : "normal"}:${c.userId}`);
  check("boot sweep: a room that throws and a participant that throws do not stop the rest (the other adult is removed)",
    bootRemoved.includes(`minors:${X7}`), JSON.stringify(bootRemoved));
  check("boot sweep: teens kept, normal rooms untouched", !bootRemoved.includes(`minors:${TH}`) && !bootRemoved.includes(`minors:${S1}`) && !bootRemoved.some((x) => x.startsWith("normal:")), JSON.stringify(bootRemoved));
  fake.listParticipants = origList; fake.removeParticipant = origRemove;
  fake.participants = [];
  setVoiceServiceForTests(null);

  // ---- nothing a teen received in this file carried the warning
  check("the warning was never sent to a teen", ![t2, s1, s2, sth, th, nt, g3, g5, t8].some((cl) => cl.msgs.some((m) => m.warning !== undefined || JSON.stringify(m).includes("legal action"))));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const cl of conns) try { cl.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
