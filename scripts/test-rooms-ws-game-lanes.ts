// Rooms gaming: age lanes over a real WebSocket server with the REST routes on the same server (FakeVoice for LiveKit).
//   npm run test:rooms     Needs a scratch database whose name contains "test". Usernames use the prefix gw_.
// Review Focus 2: a teen and an adult joining the same game room land in different lanes; no chat line, member, count,
// spray notice or report excerpt of one lane ever reaches the other. Plus the owner decision of 2026-10-22: an invited,
// acknowledged adult may play (screen only) in the teen lane; an uninvited adult cannot enter at all.
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
delete process.env.ROOMS_GAMING;
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { wsManager } = await import("../server/websocket");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");
const { roomFeatures } = await import("../server/rooms/features");
const { tuning, applyDobCorrection } = await import("../server/rooms/roomSocket");
const { MINORS_LANE_WARNING } = await import("../shared/rooms");
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
const fake = new FakeVoice();
setVoiceServiceForTests(fake);
wsManager.initialize(server, fakeStore);
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const url = `ws://127.0.0.1:${port}/ws`;
let ipSeq = 1;
async function rest(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.33.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
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
  async open() { await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); }); await this.waitFor((m) => m.type === "connected"); return this; }
  send(o: object) { this.ws.send(JSON.stringify(o)); }
  drain() { this.base = this.msgs.length; }
  async waitFor(pred: (m: any) => boolean, ms = 10_000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.msgs.slice(this.base).find(pred); if (m) return m; await sleep(15); }
    return null;
  }
  async none(pred: (m: any) => boolean, ms = 800) { await sleep(ms); return !this.msgs.slice(this.base).some(pred); }
  close() { this.ws.close(); }
}
const conns: Client[] = [];
const connect = async (id: string) => { const c = await new Client(id).open(); conns.push(c); return c; };
const join = async (c: Client, roomId: string) => {
  c.drain(); c.send({ type: "room:join", roomId });
  return c.waitFor((m) => m.type === "room:state" || m.type === "room:error");
};
const until = async (f: () => Promise<boolean> | boolean, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(50); } return false; };
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const mk = async (name: string, dob: string | null) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`gw_${name}${stamp}@t.dev`, `gw_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };

tuning.join = { rate: 1000, burst: 1000 };
tuning.stage = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000;

try {
  roomFeatures.gaming = true;
  const A = await mk("adult_host", yearsAgo(30)), B = await mk("adult_b", yearsAgo(30)), C = await mk("adult_invited", yearsAgo(35));
  const T = await mk("teen_host", yearsAgo(16)), T2 = await mk("teen_two", yearsAgo(15)), N = await mk("nodob", null);
  const S = await mk("adult_stranger", yearsAgo(33));
  await mutual(A, T); await mutual(T, T2); await mutual(T, C);
  await mutual(T, B); // B: an adult friend of the teen host with no personal invite (can see the friends-only teen lane)

  const cr = await rest("POST", "/api/rooms", A, { title: "Lane test", kind: "party", visibility: "public", capacity: 20, gameFormat: 2, lanes: true });
  const P = cr.json.room.id as string, AL = cr.json.lane.id as string;
  const TL = (await rest("POST", `/api/rooms/${P}/lanes`, T, { lane: "teen" })).json.room.id as string;
  await rest("POST", `/api/rooms/${P}/start`, A); await rest("POST", `/api/rooms/${TL}/start`, T);
  for (const id of [AL, TL]) { await rs.setVoiceEnabled(id, true); await rs.setLiveVideo(id, true); } // before anyone joins (hub flags)

  const a = await connect(A), b = await connect(B), t = await connect(T), t2 = await connect(T2);
  const sa = await join(a, P), sb = await join(b, P), st = await join(t, P), st2 = await join(t2, P);
  check("routing: the adult host and an adult land in the adult lane", sa?.room?.id === AL && sb?.room?.id === AL, JSON.stringify([sa?.room?.id, sb?.room?.id]));
  check("routing: the teen host and a 15-year-old land in the teen lane", st?.room?.id === TL && st2?.room?.id === TL, JSON.stringify([st?.room?.id, st2?.room?.id]));
  check("routing: the game room itself never has anyone in it", roomHub.count(P) === 0);
  check("counts: each lane's room:state counts its own lane only", st2?.memberCount === 2 && (await until(() => roomHub.count(AL) === 2)), JSON.stringify(st2?.memberCount));
  check("members: the teen lane's member list has no adult-lane member", !(st2?.members as any[]).some((m) => m.userId === A || m.userId === B), JSON.stringify(st2?.members));
  check("lane room object: the lane is named for its own members", st2?.room?.ageLane === "teen" && st2.room.parentRoomId === P && sb?.room?.ageLane === "adult");

  const n = await connect(N);
  const sn = await join(n, P);
  check("no birthdate: AGE_UNKNOWN at the door (never a lane)", sn?.type === "room:error" && sn.code === "AGE_UNKNOWN", JSON.stringify(sn));
  const bt = await connect(B);
  const direct = await join(bt, TL);
  check("an uninvited adult cannot join the teen lane by id: MINORS_ROOM with the teen-lane warning", direct?.type === "room:error" && direct.code === "MINORS_ROOM" && direct.warning === MINORS_LANE_WARNING, JSON.stringify(direct));
  check("...and is still in the adult lane (refused before leaving it)", roomHub.roomOf(B) === AL);
  // An adult who cannot even see the teen lane (not a friend of its teen host, no invite) is told nothing about it: the
  // existing visibility rule answers first, exactly as for any friends-only minors' room (no confirmation a teen room exists).
  const sx = await connect(S);
  const stranger = await join(sx, TL);
  check("a stranger adult joining the friends-only teen lane by id gets NOT_FOUND (it does not exist for them)", stranger?.type === "room:error" && stranger.code === "NOT_FOUND" && !("warning" in stranger), JSON.stringify(stranger));
  const t3 = await connect(T2);
  const teenDirect = await join(t3, AL);
  check("a teen cannot join the adult lane by id (AGE_LIMIT)", teenDirect?.type === "room:error" && teenDirect.code === "AGE_LIMIT", JSON.stringify(teenDirect));

  // chat stays in its lane
  for (const c of [a, b, t, t2]) c.drain();
  t2.send({ type: "room:chat", text: "teen line only" });
  b.send({ type: "room:chat", text: "adult line only" });
  check("chat: the teen lane hears its own line", !!(await t.waitFor((m) => m.type === "room:chat" && m.text === "teen line only")));
  check("chat: the adult lane hears its own line", !!(await a.waitFor((m) => m.type === "room:chat" && m.text === "adult line only")));
  check("chat: nothing crosses lanes", await t.none((m) => m.type === "room:chat" && m.text === "adult line only") && await a.none((m) => m.type === "room:chat" && m.text === "teen line only"));

  // report excerpts: a teen's report carries only the teen lane's chat
  const rep = await rest("POST", `/api/rooms/${TL}/report`, T2, { reason: "test", type: "room" });
  const desc = (await q(`select description from content_reports where reporter_id = $1 order by created_at desc limit 1`, [T2]))[0]?.description ?? "";
  check("report excerpt: the teen lane's report has its own chat and never the adult lane's", rep.status === 200 && desc.includes("teen line only") && !desc.includes("adult line only"), JSON.stringify([rep, desc]));
  const crossRep = await rest("POST", `/api/rooms/${AL}/report`, T2, { reason: "test", type: "room" });
  check("report excerpt: a teen cannot file a report on the adult lane (404, no excerpt taken)", crossRep.status === 404, JSON.stringify(crossRep));

  // an invited, acknowledged adult may enter the teen lane and play (screen only); an uninvited one cannot enter at all
  await q(`insert into room_adult_invites (room_id, user_id, invited_by, acknowledged_at) values ($1,$2,$3, now())`, [TL, C, T]);
  const cc = await connect(C);
  const sc = await join(cc, TL);
  check("an invited, acknowledged adult joins the teen lane", sc?.type === "room:state" && sc.room?.id === TL, JSON.stringify(sc));
  fake.calls.length = 0;
  t.send({ type: "room:game", action: "accept", targetId: C, side: "A" });
  check("...and the teen host can put them in the game", await until(() => roomHub.gameOf(TL).teams.A.includes(C)));
  check("...with the screen only (no microphone)", await until(() => fake.calls.some((x) => x.op === "setPublishSources" && x.userId === C && JSON.stringify(x.sources) === JSON.stringify(["screen_share", "screen_share_audio"]))) && !fake.calls.some((x) => x.userId === C && x.op === "setCanPublish" && x.canPublish === true), JSON.stringify(fake.calls));

  // a whole-session leak scan: nothing a teen client received names the adult lane or an adult-lane-only person
  const teenSaw = JSON.stringify([...t.msgs, ...t2.msgs]);
  check("leak scan: no teen-lane message mentions the adult lane id or B", !teenSaw.includes(AL) && !teenSaw.includes(B));
  const adultSaw = JSON.stringify([...a.msgs, ...b.msgs]);
  check("leak scan: no adult-lane message mentions the teen lane id or the 15-year-old", !adultSaw.includes(TL) && !adultSaw.includes(T2));

  // an admin birthdate correction takes a live user out of a now-wrong lane
  await q(`update users set date_of_birth = $2 where id = $1`, [B, yearsAgo(16)]);
  b.drain();
  await applyDobCorrection(B).catch(() => {});
  check("birthdate corrected to 16: out of the adult lane (AGE_LIMIT)", await until(() => roomHub.roomOf(B) !== AL) && !!(await b.waitFor((m) => m.type === "room:error" && m.code === "AGE_LIMIT")));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.gaming = false;
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  setVoiceServiceForTests(undefined);
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
