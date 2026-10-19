// Host settings (pinned message, slow mode, room lock) over a real WebSocket server with the REST routes on the same server
// (same harness as test-rooms-ws-minorsroom.ts).   npm run test:rooms
// Needs a scratch database whose name contains "test". Usernames use the prefix hs_. The scratch DB can be remote (about
// 200 ms per query): every check waits on an event (10 to 20 s), never on a short fixed sleep.
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
const { tuning, testHooks, roomSocketInternals } = await import("../server/rooms/roomSocket");
const { MINORS_ROOM_WARNING } = await import("../shared/rooms");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");

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
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.31.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
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
  /** Nothing matching arrives while we wait for a later marker message (an event, not a fixed sleep). */
  async noneBefore(pred: (m: any) => boolean, marker: (m: any) => boolean, ms = 15_000) {
    const got = await this.waitFor(marker, ms);
    return !!got && !this.msgs.slice(this.base).some(pred);
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
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`hs_${name}${stamp}@t.dev`, `hs_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const memberRow = (roomId: string, userId: string) => rs.getMember(roomId, userId);
const settingsMsg = (m: any) => m.type === "room:settings";
const chatOf = (c: Client, text: string) => c.waitFor((m) => m.type === "room:chat" && m.text === text);

tuning.join = { rate: 1000, burst: 1000 };
tuning.chat = { rate: 1000, burst: 1000 }; // the ordinary limiter must not be what refuses a line here: slow mode must
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000; // a host who leaves must not end the room behind the tests

try {
  // A kick that has run out must never leave the person inside the lock's rejoin window.
  check("tuning: kickMs is never shorter than lockRejoinMs", tuning.kickMs >= tuning.lockRejoinMs, `${tuning.kickMs} < ${tuning.lockRejoinMs}`);
  const H = await mk("host"), CO = await mk("cohost"), A = await mk("a"), B = await mk("b"), C = await mk("c"), D = await mk("newcomer");

  // ---- create with settings (REST) and the validator on the way in
  const bad7 = await rest("POST", "/api/rooms", H, { title: "hs bad", kind: "party", visibility: "public", slowModeSec: 7 });
  check("create: slowModeSec 7 refused 400 field slowModeSec", bad7.status === 400 && bad7.json?.field === "slowModeSec", JSON.stringify(bad7));
  const bad5 = await rest("POST", "/api/rooms", H, { title: "hs bad", kind: "party", visibility: "public", slowModeSec: "5" });
  check('create: slowModeSec "5" (string) refused 400', bad5.status === 400 && bad5.json?.field === "slowModeSec", JSON.stringify(bad5));
  const cr = await rest("POST", "/api/rooms", H, { title: "hs room", kind: "party", visibility: "public", slowModeSec: 5, pinnedMessage: "<b>Welcome</b>", locked: true });
  const R = cr.json?.room?.id as string;
  check("create: 201 with slowModeSec 5 and the pinned message as plain text", cr.status === 201 && cr.json.room.slowModeSec === 5 && cr.json.room.pinnedMessage === "Welcome", JSON.stringify(cr.json));
  check("create: locked is not settable at creation (stays false)", cr.json?.room?.locked === false, JSON.stringify(cr.json?.room));
  await rest("POST", `/api/rooms/${R}/start`, H);

  const h = await connect(H), co = await connect(CO), a1 = await connect(A), a2 = await connect(A), b = await connect(B);
  const hs = await join(h, R);
  check("room:state.room carries the settings (pinnedMessage, slowModeSec, locked)", hs?.type === "room:state" && hs.room.pinnedMessage === "Welcome" && hs.room.slowModeSec === 5 && hs.room.locked === false, JSON.stringify(hs?.room));
  for (const x of [co, a1, a2, b]) await join(x, R);
  check("setup: A is in the room with two tabs", !!roomHub.get(R, A) && a2.all((m) => m.type === "room:state").length === 1);
  await until(async () => !!(await memberRow(R, CO)));
  const role = await rest("PUT", `/api/rooms/${R}/members/${CO}/role`, H, { role: "cohost" });
  check("setup: CO made co-host", role.status === 200 && roomHub.get(R, CO)?.role === "cohost", JSON.stringify(role));

  // ---- pinned message exposure: viewers yes, lists no
  const g = await rest("GET", `/api/rooms/${R}`, A);
  check("GET /api/rooms/:id shows the pinned message to a viewer", g.status === 200 && g.json.room.pinnedMessage === "Welcome", JSON.stringify(g.json?.room));
  const list = await rest("GET", "/api/rooms?scope=live", A);
  const inList = (list.json?.rooms ?? []).find((r: any) => r.id === R);
  check("GET /api/rooms (list) never carries the pinned message, still shows slowModeSec/locked", !!inList && !("pinnedMessage" in inList) && inList.slowModeSec === 5 && inList.locked === false, JSON.stringify(inList));

  // ---- slow mode: two tabs of the same person share one clock
  b.drain(); a1.drain(); a2.drain();
  a1.send({ type: "room:chat", text: "s1" });
  check("slow mode: the first line goes out", !!(await chatOf(b, "s1")));
  a2.send({ type: "room:chat", text: "s2" });
  const sm = await a2.waitFor((m) => m.type === "room:notice" && m.code === "SLOW_MODE");
  check("slow mode: the second line from ANOTHER tab of the same user gets SLOW_MODE", !!sm, JSON.stringify(a2.all(() => true)));
  check("slow mode: retryMs is between 1 and 5000", typeof sm?.retryMs === "number" && sm.retryMs >= 1 && sm.retryMs <= 5000, JSON.stringify(sm));
  // B sends a marker after A's refused line: once B sees the marker, A's line would have arrived before it.
  b.send({ type: "room:chat", text: "marker1" });
  check("slow mode: the refused line was not broadcast", await a1.noneBefore((m) => m.type === "room:chat" && m.text === "s2", (m) => m.type === "room:chat" && m.text === "marker1"));
  check("slow mode: a different person (B) is not held by A's clock", !!(await chatOf(a1, "marker1")));

  h.drain(); b.drain();
  h.send({ type: "room:chat", text: "h1" }); h.send({ type: "room:chat", text: "h2" }); h.send({ type: "room:chat", text: "h3" });
  check("host is exempt: three quick lines all go out", !!(await chatOf(b, "h1")) && !!(await chatOf(b, "h2")) && !!(await chatOf(b, "h3")));
  check("host is exempt: no SLOW_MODE notice", !h.all((m) => m.code === "SLOW_MODE").length);
  co.drain();
  co.send({ type: "room:chat", text: "c1" }); co.send({ type: "room:chat", text: "c2" });
  check("co-host is exempt: both lines go out", !!(await chatOf(b, "c1")) && !!(await chatOf(b, "c2")));
  check("co-host is exempt: no SLOW_MODE notice", !co.all((m) => m.code === "SLOW_MODE").length);

  // After the wait the server named, A may talk again (waiting out the server's own number is the event here).
  await sleep((sm?.retryMs ?? 5000) + 300);
  b.drain();
  a2.send({ type: "room:chat", text: "s3" });
  check("slow mode: after retryMs the person may chat again", !!(await chatOf(b, "s3")));

  // ---- settings change: broadcast to everyone (both tabs), stored as plain text cut to 200
  for (const x of [h, co, a1, a2, b]) x.drain();
  const longHtml = `<i>Be kind</i> <script>alert(1)</script>${"x".repeat(300)}`;
  const p1 = await rest("PATCH", `/api/rooms/${R}`, H, { pinnedMessage: longHtml, slowModeSec: 15 });
  const expected = `Be kind ${"x".repeat(300)}`.slice(0, 200);
  check("PATCH (host): 200, pinned plain and cut to 200, slowModeSec 15", p1.status === 200 && p1.json.room.pinnedMessage === expected && p1.json.room.slowModeSec === 15, JSON.stringify(p1.json?.room));
  const stored = (await q(`select pinned_message, slow_mode_sec, locked from rooms where id = $1`, [R]))[0];
  check("stored pinned_message is plain text (no < or >), 200 characters", stored?.pinned_message === expected && stored.pinned_message.length === 200 && !/[<>]/.test(stored.pinned_message), JSON.stringify(stored));
  let everyone = true;
  for (const x of [h, co, a1, a2, b]) {
    const m = await x.waitFor(settingsMsg);
    if (!(m && m.pinnedMessage === expected && m.slowModeSec === 15 && m.locked === false)) { everyone = false; console.log(`  missing/wrong room:settings for ${x.id.slice(0, 6)}: ${JSON.stringify(m)}`); }
  }
  check("room:settings reaches everyone, every tab, with all three fields", everyone);
  const c = await connect(C);
  const cs = await join(c, R);
  check("a later joiner's room:state has the new settings", cs?.type === "room:state" && cs.room.pinnedMessage === expected && cs.room.slowModeSec === 15 && cs.room.locked === false, JSON.stringify(cs?.room));

  // ---- validation on PATCH
  check("PATCH slowModeSec 7: 400", (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: 7 })).json?.field === "slowModeSec");
  check('PATCH slowModeSec "5": 400', (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: "5" })).json?.field === "slowModeSec");
  check('PATCH locked "yes": 400', (await rest("PATCH", `/api/rooms/${R}`, H, { locked: "yes" })).json?.field === "locked");
  check("PATCH pinnedMessage over 2000 characters: 400", (await rest("PATCH", `/api/rooms/${R}`, H, { pinnedMessage: "y".repeat(2001) })).json?.field === "pinnedMessage");

  // ---- co-host: pinned message only
  b.drain();
  const cp = await rest("PATCH", `/api/rooms/${R}`, CO, { pinnedMessage: "from the cohost" });
  check("co-host may set the pinned message (200)", cp.status === 200 && cp.json.room.pinnedMessage === "from the cohost", JSON.stringify(cp));
  const bm = await b.waitFor((m) => settingsMsg(m) && m.pinnedMessage === "from the cohost");
  check("...and the room hears it (slow mode unchanged)", !!bm && bm.slowModeSec === 15);
  check("co-host may NOT change slow mode (403)", (await rest("PATCH", `/api/rooms/${R}`, CO, { slowModeSec: 0 })).status === 403);
  check("co-host may NOT lock the room (403)", (await rest("PATCH", `/api/rooms/${R}`, CO, { locked: true })).status === 403);
  check("co-host may NOT mix pinned with another field (403)", (await rest("PATCH", `/api/rooms/${R}`, CO, { pinnedMessage: "x", locked: true })).status === 403);
  check("co-host may NOT rename the room (403)", (await rest("PATCH", `/api/rooms/${R}`, CO, { title: "mine" })).status === 403);
  check("a guest may not set the pinned message (403)", (await rest("PATCH", `/api/rooms/${R}`, A, { pinnedMessage: "x" })).status === 403);
  const st = (await q(`select slow_mode_sec, locked, title, pinned_message from rooms where id = $1`, [R]))[0];
  check("nothing the co-host was refused was stored (slow mode, lock, title, and the pinned part of the mixed body)",
    st?.slow_mode_sec === 15 && st.locked === false && st.title === "hs room" && st.pinned_message === "from the cohost", JSON.stringify(st));
  check("host clears the pinned message with null", (await rest("PATCH", `/api/rooms/${R}`, H, { pinnedMessage: null })).json?.room?.pinnedMessage === null);

  // ---- lock
  for (const x of [h, co, a1, b, c]) x.drain();
  const lk = await rest("PATCH", `/api/rooms/${R}`, H, { locked: true });
  check("host locks the room (200, locked true)", lk.status === 200 && lk.json.room.locked === true, JSON.stringify(lk.json?.room));
  check("everyone hears room:settings locked true", !!(await b.waitFor((m) => settingsMsg(m) && m.locked === true)) && !!(await co.waitFor((m) => settingsMsg(m) && m.locked === true)));
  const d = await connect(D);
  const dj = await join(d, R);
  check("lock: a NEW joiner is refused ROOM_LOCKED", dj?.type === "room:error" && dj.code === "ROOM_LOCKED", JSON.stringify(dj));
  check("lock: ...and is not in the room", !roomHub.get(R, D));
  const c2 = await connect(C);
  // With the rejoin window at 0, C's member row gives no pass: only the "already in the hub" rule can admit this tab.
  tuning.lockRejoinMs = 0;
  const c2j = await join(c2, R);
  tuning.lockRejoinMs = 120_000;
  check("lock: a member already inside opens a second tab (admitted by the hub rule alone, rejoin window 0)", c2j?.type === "room:state", JSON.stringify(c2j));

  // Reconnect after a dropped connection (within the rejoin window): close every socket of A, then come back.
  a1.close(); a2.close();
  await until(() => roomHub.roomOf(A) === null);
  const a3 = await connect(A);
  const a3s = await join(a3, R);
  check("lock: an existing member reconnecting after a drop is admitted", a3s?.type === "room:state" && a3s.room.locked === true, JSON.stringify(a3s));

  // Host, co-host and window: with the rejoin window at 0, only the role rules can let people back in.
  tuning.lockRejoinMs = 0;
  h.send({ type: "room:leave" });
  await until(async () => roomHub.get(R, H) === undefined && (await memberRow(R, H))?.leftAt != null);
  check("lock: the host coming back is admitted (window 0: the host rule itself)", (await join(h, R))?.type === "room:state");
  co.send({ type: "room:leave" });
  await until(async () => roomHub.get(R, CO) === undefined && (await memberRow(R, CO))?.leftAt != null);
  check("lock: a co-host coming back is admitted (window 0: the co-host rule itself)", (await join(co, R))?.type === "room:state");
  b.send({ type: "room:leave" });
  await until(async () => roomHub.get(R, B) === undefined && (await memberRow(R, B))?.leftAt != null);
  const bj = await join(b, R);
  check("lock: a guest who left, outside the rejoin window, is refused ROOM_LOCKED", bj?.type === "room:error" && bj.code === "ROOM_LOCKED", JSON.stringify(bj));
  tuning.lockRejoinMs = 120_000;
  check("lock: the same guest inside the rejoin window is admitted", (await join(b, R))?.type === "room:state");

  const ul = await rest("PATCH", `/api/rooms/${R}`, H, { locked: false });
  check("host unlocks", ul.status === 200 && ul.json.room.locked === false);
  check("after unlocking the newcomer gets in", (await join(d, R))?.type === "room:state");

  // ---- a lock refusal must not pull the joiner out of the room they are in (pre-check before leaving room X)
  const HY = await mk("hosty");
  const ry = await rest("POST", "/api/rooms", HY, { title: "hs other room", kind: "party", visibility: "public" });
  const RY = ry.json?.room?.id as string;
  await rest("POST", `/api/rooms/${RY}/start`, HY);
  const hy = await connect(HY);
  await join(hy, RY);
  check("setup: room Y is locked", (await rest("PATCH", `/api/rooms/${RY}`, HY, { locked: true })).json?.room?.locked === true);
  h.drain();
  const by = await join(b, RY);
  check("lock: a member of room X tapping locked room Y is refused ROOM_LOCKED", by?.type === "room:error" && by.code === "ROOM_LOCKED", JSON.stringify(by));
  check("lock: ...and stays in room X (hub), never entering Y", roomHub.roomOf(B) === R && !!roomHub.get(R, B) && !roomHub.get(RY, B));
  check("lock: ...their member row in X still says present (left_at null)", (await memberRow(R, B))?.leftAt == null);
  b.drain();
  h.send({ type: "room:chat", text: "still-here" });
  check("lock: ...they still get room X's chat on the same socket", !!(await chatOf(b, "still-here")));
  check("lock: ...and room X never heard them leave", !h.all((m) => m.type === "room:left" && m.userId === B).length);

  // ---- invite-only room: a valid link still opens a locked room
  const H2 = await mk("host2"), E = await mk("linkholder"), F = await mk("nolink");
  const ri = await rest("POST", "/api/rooms", H2, { title: "hs invite room", kind: "party", visibility: "invite" });
  const RI = ri.json?.room?.id as string;
  const tok = new URL(`http://x${ri.json?.inviteLink}`).searchParams.get("token")!;
  await rest("POST", `/api/rooms/${RI}/start`, H2);
  const h2 = await connect(H2);
  await join(h2, RI);
  check("invite room locked", (await rest("PATCH", `/api/rooms/${RI}`, H2, { locked: true })).json?.room?.locked === true);
  const e = await connect(E), f = await connect(F);
  // Every joiner of an invite-only room holds the link, so the link cannot be a way past the lock.
  const ej = await join(e, RI, { inviteToken: tok });
  check("lock: a newcomer holding a valid invite token is refused ROOM_LOCKED in a locked invite-only room", ej?.type === "room:error" && ej.code === "ROOM_LOCKED", JSON.stringify(ej));
  check("lock: ...and is not in the room", !roomHub.get(RI, E));
  const fj = await join(f, RI, { inviteToken: "0".repeat(48) });
  check("lock: a wrong token is still NOT_FOUND (not visible), never ROOM_LOCKED", fj?.type === "room:error" && fj.code === "NOT_FOUND", JSON.stringify(fj));
  check("the invite room's host unlocks", (await rest("PATCH", `/api/rooms/${RI}`, H2, { locked: false })).json?.room?.locked === false);
  check("after unlocking, the token holder gets in", (await join(e, RI, { inviteToken: tok }))?.type === "room:state");

  // ---- lock turned on during a join (held between the first checks and the fresh re-read)
  const J = await mk("racer");
  const j = await connect(J);
  let heldJ = false, releaseJ!: () => void;
  const gateJ = new Promise<void>((r) => { releaseJ = r; });
  // Held right AFTER the join's fresh re-read has come back (its room row says unlocked): no timing guess involved.
  testHooks.afterFreshRead = async (_roomId: string, userId: string) => { if (userId === J) { heldJ = true; await gateJ; } };
  try {
    j.drain();
    j.send({ type: "room:join", roomId: R });
    check("race: the join is held right after its fresh re-read", await until(() => heldJ));
    const lk2 = await rest("PATCH", `/api/rooms/${R}`, H, { locked: true });
    check("race: the room is locked while the join is held", lk2.json?.room?.locked === true);
    releaseJ();
    const jr = await j.waitFor((m) => m.type === "room:state" || m.type === "room:error");
    check("race: the held joiner is refused ROOM_LOCKED (live copy wins over the older row read)", jr?.type === "room:error" && jr.code === "ROOM_LOCKED", JSON.stringify(jr));
    check("race: ...and is not in the room", !roomHub.get(R, J));
  } finally {
    testHooks.afterFreshRead = undefined;
    releaseJ();
  }
  await rest("PATCH", `/api/rooms/${R}`, H, { locked: false });

  // ---- settings changed during a join: the joiner's room:state has the new values
  const K = await mk("racer2");
  const k = await connect(K);
  let heldK = false, releaseK!: () => void;
  const gateK = new Promise<void>((r) => { releaseK = r; });
  testHooks.afterFreshRead = async (_roomId: string, userId: string) => { if (userId === K) { heldK = true; await gateK; } };
  try {
    k.drain();
    k.send({ type: "room:join", roomId: R });
    check("race 2: the join is held right after its fresh re-read (its row has the old settings)", await until(() => heldK));
    await rest("PATCH", `/api/rooms/${R}`, H, { pinnedMessage: "mid-join", slowModeSec: 30 });
    releaseK();
    const ks = await k.waitFor((m) => m.type === "room:state" || m.type === "room:error");
    check("race 2: the joiner's room:state has the settings changed during its join", ks?.type === "room:state" && ks.room.pinnedMessage === "mid-join" && ks.room.slowModeSec === 30, JSON.stringify(ks?.room));
  } finally {
    testHooks.afterFreshRead = undefined;
    releaseK();
  }

  // ---- a kicked co-host goes back to guest: no pinned edits, and the rejoin window never undoes a kick
  const CO2 = await mk("cohost2");
  const co2 = await connect(CO2);
  await join(co2, R);
  await until(async () => !!(await memberRow(R, CO2)));
  check("setup: CO2 made co-host", (await rest("PUT", `/api/rooms/${R}/members/${CO2}/role`, H, { role: "cohost" })).status === 200 && roomHub.get(R, CO2)?.role === "cohost");
  co2.drain();
  h.send({ type: "room:mod", action: "kick", targetId: CO2 });
  check("kick: the co-host hears the kick", !!(await co2.waitFor((m) => m.type === "room:mod" && m.action === "kick" && m.targetId === CO2)));
  check("kick: the co-host is out and their stored role is guest", await until(async () => !roomHub.get(R, CO2) && (await memberRow(R, CO2))?.role === "guest"));
  const kp = await rest("PATCH", `/api/rooms/${R}`, CO2, { pinnedMessage: "kicked edit" });
  check("kick: the kicked co-host may NOT set the pinned message (403), nothing stored",
    kp.status === 403 && (await q(`select pinned_message from rooms where id = $1`, [R]))[0]?.pinned_message === "mid-join", JSON.stringify(kp));
  check("lock on for the kick checks", (await rest("PATCH", `/api/rooms/${R}`, H, { locked: true })).json?.room?.locked === true);
  const kj = await join(co2, R);
  check("kick: back inside the rejoin window, still refused KICKED (the window never undoes a kick)", kj?.type === "room:error" && kj.code === "KICKED", JSON.stringify(kj));
  check("kick: ...and not in the room", !roomHub.get(R, CO2));

  // A short kick (still >= the window, here 0) so its end can be reached in the test: afterwards no co-host pass remains.
  check("unlock to let CO3 in", (await rest("PATCH", `/api/rooms/${R}`, H, { locked: false })).json?.room?.locked === false);
  const CO3 = await mk("cohost3");
  const co3 = await connect(CO3);
  await join(co3, R);
  await until(async () => !!(await memberRow(R, CO3)));
  check("setup: CO3 made co-host", (await rest("PUT", `/api/rooms/${R}/members/${CO3}/role`, H, { role: "cohost" })).status === 200 && roomHub.get(R, CO3)?.role === "cohost");
  const savedKickMs = tuning.kickMs;
  tuning.kickMs = 2000; tuning.lockRejoinMs = 0;
  try {
    h.send({ type: "room:mod", action: "kick", targetId: CO3 });
    check("short kick: CO3 is out and their stored role is guest", await until(async () => !roomHub.get(R, CO3) && (await memberRow(R, CO3))?.role === "guest"));
    const kickSetBy = Date.now(); // the kick was recorded before the role reset we just saw
    check("lock on again", (await rest("PATCH", `/api/rooms/${R}`, H, { locked: true })).json?.room?.locked === true);
    await until(() => Date.now() > kickSetBy + 2300, 10_000); // the server's own kick length running out is the event here
    const k3 = await join(co3, R);
    check("after the kick runs out, the former co-host has no co-host pass: the locked room refuses ROOM_LOCKED", k3?.type === "room:error" && k3.code === "ROOM_LOCKED", JSON.stringify(k3));
  } finally {
    tuning.kickMs = savedKickMs; tuning.lockRejoinMs = 120_000;
  }
  // A member row made for someone who never joined (ban, then unban, before they arrive) gives no pass through the lock.
  const Q = await mk("neverjoined");
  check("ban before arrival", (await rest("POST", `/api/rooms/${R}/members/${Q}/ban`, H)).status === 200);
  check("unban before arrival", (await rest("POST", `/api/rooms/${R}/members/${Q}/unban`, H)).status === 200);
  const qrow = await memberRow(R, Q);
  check("the never-joined row carries 1970 as joined_at and left_at", !!qrow && new Date(qrow.joinedAt).getTime() === 0 && qrow.leftAt != null && new Date(qrow.leftAt).getTime() === 0, JSON.stringify(qrow));
  const q1 = await connect(Q);
  const qj = await join(q1, R); // R is still locked here
  check("lock: the never-joined (unbanned) person is refused ROOM_LOCKED, not let in by a fresh left_at", qj?.type === "room:error" && qj.code === "ROOM_LOCKED", JSON.stringify(qj));
  check("unlock after the kick checks", (await rest("PATCH", `/api/rooms/${R}`, H, { locked: false })).json?.room?.locked === false);

  // ---- slow mode details: replies, the rate token, a change mid-window
  check("slow mode 5 for these checks", (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: 5 })).json?.room?.slowModeSec === 5);
  const G = await mk("slowpoke");
  tuning.chat = { rate: 0.0001, burst: 2 }; // G's buckets are built at G's first join with these numbers: two lines, no refill
  const g = await connect(G);
  const gj = await join(g, R);
  tuning.chat = { rate: 1000, burst: 1000 };
  check("setup: G is in the room (two chat tokens)", gj?.type === "room:state", JSON.stringify(gj));
  b.drain(); g.drain();
  b.send({ type: "room:chat", text: "quote-me" });
  check("setup: B's line reaches G", !!(await chatOf(g, "quote-me")));
  g.send({ type: "room:chat", text: "g1" });
  check("G's first line goes out (token 1 of 2)", !!(await chatOf(b, "g1")));
  g.drain();
  g.send({ type: "room:chat", text: "g2", replyTo: { userId: B, text: "quote-me" } });
  const gs = await g.waitFor((m) => m.type === "room:notice" && m.code === "SLOW_MODE");
  check("slow mode: a reply inside the window is refused SLOW_MODE like any line", !!gs, JSON.stringify(g.all(() => true)));
  h.send({ type: "room:chat", text: "marker-g2" }); // the host is exempt: a marker that always goes out
  check("slow mode: the refused reply was not broadcast", await b.noneBefore((m) => m.type === "room:chat" && m.text === "g2", (m) => m.type === "room:chat" && m.text === "marker-g2"));
  g.drain();
  g.send({ type: "room:chat", text: "g3" });
  const gs2 = await g.waitFor((m) => m.type === "room:notice" && m.code === "SLOW_MODE");
  check("slow mode: a second line in the window is SLOW_MODE again, not RATE_LIMITED", !!gs2 && !g.all((m) => m.code === "RATE_LIMITED").length, JSON.stringify(g.all(() => true)));
  await sleep((gs2?.retryMs ?? 5000) + 300); // the server's own number running out is the event here
  b.drain(); g.drain();
  g.send({ type: "room:chat", text: "g4", replyTo: { userId: B, text: "quote-me" } });
  const g4 = await chatOf(b, "g4");
  check("rate limit: the two slow-mode refusals used no token (G's second and last token sends this line)", !!g4 && !g.all((m) => m.code === "RATE_LIMITED").length, JSON.stringify(g.all(() => true)));
  check("slow mode: after the wait a reply goes out, quoting from the server's record", g4?.replyTo?.userId === B && g4.replyTo.text === "quote-me", JSON.stringify(g4));

  check("slow mode 30", (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: 30 })).json?.room?.slowModeSec === 30);
  await a3.waitFor((m) => settingsMsg(m) && m.slowModeSec === 30);
  b.drain(); a3.drain();
  a3.send({ type: "room:chat", text: "m1" });
  const m1 = await chatOf(b, "m1");
  const m1Seen = Date.now(); // the server recorded m1 before this moment
  check("A's first line under slow mode 30 goes out", !!m1);
  a3.send({ type: "room:chat", text: "m2" });
  const sm30 = await a3.waitFor((m) => m.type === "room:notice" && m.code === "SLOW_MODE");
  check("slow mode 30: A's next line is held for more than 5 s", !!sm30 && sm30.retryMs > 5000, JSON.stringify(sm30));
  check("host shortens slow mode to 5 mid-window", (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: 5 })).json?.room?.slowModeSec === 5);
  await a3.waitFor((m) => settingsMsg(m) && m.slowModeSec === 5);
  await until(() => Date.now() > m1Seen + 5300, 10_000);
  a3.drain(); b.drain();
  a3.send({ type: "room:chat", text: "m3" });
  check("slow mode change mid-window: 5 s after the last line A may talk again (the 30 s wait is gone)", !!(await chatOf(b, "m3")) && !a3.all((m) => m.code === "SLOW_MODE").length);
  check("host turns slow mode off", (await rest("PATCH", `/api/rooms/${R}`, H, { slowModeSec: 0 })).json?.room?.slowModeSec === 0);
  await a3.waitFor((m) => settingsMsg(m) && m.slowModeSec === 0);
  a3.drain(); b.drain();
  a3.send({ type: "room:chat", text: "m4" }); a3.send({ type: "room:chat", text: "m5" });
  check("slow mode off mid-window: two quick lines both go out", !!(await chatOf(b, "m4")) && !!(await chatOf(b, "m5")) && !a3.all((m) => m.code === "SLOW_MODE").length);

  // ---- lock and a minors' room: the minors' gate is unchanged and comes first; an invited adult still gets in
  const T = await mk("teenhost", yearsAgo(15)), T2 = await mk("teen2", yearsAgo(16)), T3 = await mk("teen3", yearsAgo(14));
  const AI = await mk("invitedadult"), AF = await mk("adultfriend"), AN = await mk("notacked");
  for (const x of [T2, T3, AI, AF, AN]) await mutual(T, x);
  const mrc = await rest("POST", "/api/rooms", T, { title: "hs teen room", kind: "party", visibility: "friends" });
  const MR = mrc.json?.room?.id as string;
  check("setup: the teen host's room is a minors' room", mrc.json?.room?.minorsRoom === true, JSON.stringify(mrc.json));
  await rest("POST", `/api/rooms/${MR}/start`, T);
  const th = await connect(T), t2 = await connect(T2);
  await join(th, MR); await join(t2, MR);
  await rest("POST", `/api/rooms/${MR}/adult-invites/${AI}`, T);
  await rest("POST", `/api/rooms/${MR}/adult-invites/acknowledge`, AI);
  await rest("POST", `/api/rooms/${MR}/adult-invites/${AN}`, T);
  check("minors' room: the teen host locks it", (await rest("PATCH", `/api/rooms/${MR}`, T, { locked: true })).json?.room?.locked === true);
  const t3 = await connect(T3);
  const t3j = await join(t3, MR);
  check("minors' room locked: a new teen is refused ROOM_LOCKED", t3j?.type === "room:error" && t3j.code === "ROOM_LOCKED", JSON.stringify(t3j));
  const ai = await connect(AI);
  const aij = await join(ai, MR);
  check("minors' room locked: an adult with an acknowledged personal invite is admitted", aij?.type === "room:state", JSON.stringify(aij));
  const af = await connect(AF);
  const afj = await join(af, MR);
  check("minors' room locked: an adult friend without an invite still gets MINORS_ROOM with the warning (not ROOM_LOCKED)", afj?.type === "room:error" && afj.code === "MINORS_ROOM" && afj.warning === MINORS_ROOM_WARNING, JSON.stringify(afj));
  const an = await connect(AN);
  const anj = await join(an, MR);
  check("minors' room locked: invited but not acknowledged still gets MINORS_ROOM_ACK (not ROOM_LOCKED)", anj?.type === "room:error" && anj.code === "MINORS_ROOM_ACK" && anj.warning === MINORS_ROOM_WARNING, JSON.stringify(anj));
  await rest("PATCH", `/api/rooms/${MR}`, T, { pinnedMessage: "teen pin" });
  const den = await rest("GET", `/api/rooms/${MR}`, AF);
  check("minors' room denial body unchanged: exactly code, message, warning, canJoin (no pinned message, no settings)",
    den.status === 403 && JSON.stringify(Object.keys(den.json ?? {}).sort()) === JSON.stringify(["canJoin", "code", "message", "warning"]) && !JSON.stringify(den.json).includes("teen pin"), JSON.stringify(den));
  const afList = await rest("GET", "/api/rooms?scope=friends", AF);
  check("minors' room never listed for the adult friend", !(afList.json?.rooms ?? []).some((r: any) => r.id === MR));

  // ---- memory: the slow-mode clock goes when a room empties; it and the live settings go when the room ends
  const HE = await mk("hostempty"), GE = await mk("guestempty");
  const re = await rest("POST", "/api/rooms", HE, { title: "hs empty room", kind: "party", visibility: "public", slowModeSec: 5 });
  const RE = re.json?.room?.id as string;
  await rest("POST", `/api/rooms/${RE}/start`, HE);
  const he = await connect(HE), ge = await connect(GE);
  await join(he, RE); await join(ge, RE);
  he.drain();
  ge.send({ type: "room:chat", text: "e1" });
  check("setup: a guest line in a slow-mode room (its clock has an entry, its settings are live)", !!(await chatOf(he, "e1")) && roomSocketInternals.hasSlowClock(RE) && roomSocketInternals.hasSettings(RE));
  ge.send({ type: "room:leave" }); he.send({ type: "room:leave" });
  check("empty room: nobody left in the hub", await until(() => roomHub.count(RE) === 0));
  check("empty room: the slow-mode clock is dropped", !roomSocketInternals.hasSlowClock(RE));
  check("empty room: the live settings stay while the room is still live (a rejoin reads them)", roomSocketInternals.hasSettings(RE));
  check("empty room ends", (await rest("POST", `/api/rooms/${RE}/end`, HE)).status === 200);
  check("ended empty room: live settings and slow-mode clock both gone", !roomSocketInternals.hasSettings(RE) && !roomSocketInternals.hasSlowClock(RE));

  check("before the end, R has live settings and a slow-mode clock", roomSocketInternals.hasSettings(R) && roomSocketInternals.hasSlowClock(R));
  const end = await rest("POST", `/api/rooms/${R}/end`, H);
  check("room ends", end.status === 200);
  check("after the end nobody is in the hub for it", roomHub.count(R) === 0);
  check("after the end R's live settings and slow-mode clock are gone", !roomSocketInternals.hasSettings(R) && !roomSocketInternals.hasSlowClock(R));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
