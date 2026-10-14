// Rooms WebSocket checks: real `ws` clients against an in-process server using the production cookie auth path
// (vibepulse.sid -> session store lookup) with a fake session store.   npm run test:rooms
import http from "node:http";
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
const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");
const { roomFeatures } = await import("../server/rooms/features");
roomFeatures.linkScreens = true; // dormant in production (default off), still tested; one block below pins the default
const { tuning, rehydrateLiveRooms, expectHost } = await import("../server/rooms/roomSocket");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- server: session id in the cookie IS the user id; the fake store maps it back, like the real lookup does ----
const fakeStore = { get: (sid: string, cb: (e: any, s: any) => void) => cb(null, { passport: { user: sid } }) };
const server = http.createServer();
wsManager.initialize(server, fakeStore);
await new Promise<void>((r) => server.listen(0, r));
const url = `ws://127.0.0.1:${(server.address() as any).port}/ws`;

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
  async waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.msgs.slice(this.base).find(pred);
      if (m) return m;
      await sleep(15);
    }
    if (process.env.WS_DEBUG) console.log("TIMEOUT", this.id.slice(0, 4), JSON.stringify(this.msgs.slice(this.base).map((m) => m.type + (m.code ? ":" + m.code : "") + (m.userId ? "@" + String(m.userId).slice(0, 4) : ""))).slice(0, 400));
    return null;
  }
  async none(pred: (m: any) => boolean, ms = 350) { await sleep(ms); return !this.msgs.slice(this.base).some(pred); }
  all(pred: (m: any) => boolean) { return this.msgs.slice(this.base).filter(pred); }
  close() { this.ws.close(); }
}
const conns: Client[] = [];
const connect = async (id: string) => { const c = await new Client(id).open(); conns.push(c); return c; };
const join = async (c: Client, roomId: string, extra: object = {}) => {
  c.drain(); c.send({ type: "room:join", roomId, ...extra });
  return c.waitFor((m) => m.type === "room:state" || m.type === "room:error");
};
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const mk = async (name: string, dob: string | null = yearsAgo(30)) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const liveRoom = async (host: string, over: Record<string, unknown> = {}) => {
  const r = await rs.createRoom(host, { title: "R", kind: "party", visibility: "public", ageLimit: "all", ...over } as any);
  await rs.setStatus(r.id, "live");
  return r;
};

tuning.join = { rate: 1000, burst: 1000 }; // lifted for the many joins below; one test lowers it
tuning.sweepMs = 0; // the periodic LiveKit sweep must not run behind the tests; they call sweepVoice directly
tuning.graceMs = 2500; // the scratch DB can be remote: a join is several round trips, so keep the grace well above one
const until = async (f: () => Promise<boolean>, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };

try {
  const H = await mk("w_host"), G1 = await mk("w_g1"), G2 = await mk("w_g2"), G3 = await mk("w_g3");
  const TEEN = await mk("w_teen", yearsAgo(16)), NODOB = await mk("w_nodob", null), BLK = await mk("w_blk");
  await mutual(G1, G2);
  await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [H, BLK]);

  const R = await liveRoom(H);
  const h = await connect(H), g1 = await connect(G1), g2 = await connect(G2), g3 = await connect(G3);

  // ---------------- join / presence
  const hs = await join(h, R.id);
  check("host joins: room:state with role host", hs?.type === "room:state" && hs.you?.role === "host" && hs.room?.id === R.id && !("inviteTokenHash" in hs.room), JSON.stringify(hs));
  const s1 = await join(g1, R.id);
  check("guest joins: state lists members, memberCount, you.role guest", s1?.type === "room:state" && s1.you?.role === "guest" && s1.memberCount === 2 && s1.members.some((m: any) => m.userId === H) && s1.members.some((m: any) => m.userId === G1), JSON.stringify(s1)?.slice(0, 300));
  check("member payload is public-safe (no email/passwordHash/dob)", !/passwordHash|email|dateOfBirth/.test(JSON.stringify(s1)));
  check("others get room:joined", !!(await h.waitFor((m) => m.type === "room:joined" && m.member?.userId === G1)));
  await join(g2, R.id);
  g1.drain(); h.drain();
  g2.send({ type: "room:leave" });
  check("leave: others get room:left", !!(await h.waitFor((m) => m.type === "room:left" && m.userId === G2)) && !!(await g1.waitFor((m) => m.type === "room:left" && m.userId === G2)));
  check("leave: DB left_at set, hub forgets user", (await rs.getMember(R.id, G2))?.leftAt != null && roomHub.roomOf(G2) === null);
  const rj = await join(g2, R.id);
  check("rejoin after leave works", rj?.type === "room:state");

  // ---------------- chat / react / rate limit / mute
  h.drain(); g1.drain();
  g1.send({ type: "room:chat", text: "hello <b>room</b>" });
  const c1 = await h.waitFor((m) => m.type === "room:chat");
  check("chat fans out to the room incl. sender, sanitized", c1?.userId === G1 && !/<b>/.test(c1.text) && /hello/.test(c1.text) && !!(await g1.waitFor((m) => m.type === "room:chat")), JSON.stringify(c1));
  g1.send({ type: "room:react", emoji: "🔥" });
  check("reaction fans out", (await h.waitFor((m) => m.type === "room:react"))?.emoji === "🔥");
  g1.send({ type: "room:react", emoji: "💩" });
  check("reaction outside the fixed set is dropped", await h.none((m) => m.type === "room:react" && m.emoji === "💩"));
  g1.send({ type: "room:chat", text: "   " }); g1.send({ type: "room:chat", text: "x".repeat(301) });
  check("empty / 301-char chat dropped", await h.none((m) => m.type === "room:chat" && (m.text === "" || m.text.length > 300)));

  await sleep(1200); h.drain();
  for (let i = 0; i < 12; i++) g1.send({ type: "room:chat", text: `spam ${i}` });
  await sleep(500);
  const got = h.all((m) => m.type === "room:chat" && /^spam/.test(m.text)).length;
  check("chat rate limit (1/s burst 5) drops the excess", got >= 5 && got <= 7, `got ${got} of 12`);
  check("rate-limited sender gets a notice", !!(await g1.waitFor((m) => m.type === "room:notice" && m.code === "RATE_LIMITED")));

  h.drain(); g2.drain();
  h.send({ type: "room:mod", action: "mute", targetId: G2 });
  check("mute: target and room are told", !!(await g2.waitFor((m) => m.type === "room:mod" && m.action === "mute" && m.targetId === G2)));
  g2.send({ type: "room:chat", text: "muted talk" });
  check("muted user's chat is dropped (and they are told)", await h.none((m) => m.type === "room:chat" && m.userId === G2) && !!(await g2.waitFor((m) => m.type === "room:notice" && m.code === "MUTED")));
  check("mute persisted", (await rs.getMember(R.id, G2))?.muted === true);
  g3.drain(); await join(g3, R.id);
  g1.send({ type: "room:mod", action: "mute", targetId: G3 });
  check("guest cannot moderate", !!(await g1.waitFor((m) => m.type === "room:notice" && m.code === "FORBIDDEN")) && (await rs.getMember(R.id, G3))?.muted !== true);
  g2.drain(); h.send({ type: "room:mod", action: "unmute", targetId: G2 });
  await g2.waitFor((m) => m.type === "room:mod" && m.action === "unmute"); h.drain();
  g2.send({ type: "room:chat", text: "back again" });
  check("unmute restores chat", !!(await h.waitFor((m) => m.type === "room:chat" && m.userId === G2)));

  // ---------------- screen
  h.drain(); g1.drain();
  h.send({ type: "room:screen", screen: "https://youtu.be/dQw4w9WgXcQ" });
  const sc = await g1.waitFor((m) => m.type === "room:screen");
  check("host sets screen: guests receive the resolved embed", sc?.screen?.embedUrl === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", JSON.stringify(sc));
  check("screen persisted", (await rs.getRoom(R.id))?.screen?.provider === "youtube");
  g1.drain(); g1.send({ type: "room:screen", screen: "https://vimeo.com/76979871" });
  check("guest cannot change the screen", !!(await g1.waitFor((m) => m.type === "room:notice" && m.code === "FORBIDDEN")) && (await rs.getRoom(R.id))?.screen?.provider === "youtube");
  h.drain(); h.send({ type: "room:screen", screen: "javascript:alert(1)" });
  check("hostile screen rejected", !!(await h.waitFor((m) => m.type === "room:notice" && m.code === "INVALID_SCREEN")) && (await rs.getRoom(R.id))?.screen?.provider === "youtube");

  // ---------------- interactions (server re-checks everything)
  await sleep(2100);
  g1.drain(); g2.drain(); g3.drain(); h.drain();
  g1.send({ type: "room:interact", targetId: G2, kind: "wave" });
  check("wave between mutual adults: whole room sees it", !!(await g2.waitFor((m) => m.type === "room:interact" && m.fromId === G1 && m.kind === "wave")) && !!(await h.waitFor((m) => m.type === "room:interact" && m.kind === "wave")));
  await sleep(2100); g2.drain(); h.drain();
  g1.send({ type: "room:interact", targetId: G2, kind: "reaction", emoji: "❤️" });
  check("private reaction: only the target gets it", !!(await g2.waitFor((m) => m.type === "room:interact" && m.kind === "reaction")) && await h.none((m) => m.type === "room:interact"));
  g1.drain(); g1.send({ type: "room:interact", targetId: G2, kind: "reaction", emoji: "🔥" });
  check("interaction rate limit (1 per 2s per target)", !!(await g1.waitFor((m) => m.type === "room:notice" && m.code === "RATE_LIMITED")));
  g3.drain(); g3.send({ type: "room:interact", targetId: G1, kind: "wave" });
  check("non-mutual with default privacy: PRIVACY", (await g3.waitFor((m) => m.type === "room:notice"))?.code === "PRIVACY");
  await q(`update users set room_privacy=$2 where id=$1`, [G2, JSON.stringify({ v: 1, interactions: "none", appearInLists: true, allowInvites: true })]);
  await sleep(2100); g1.drain(); g1.send({ type: "room:interact", targetId: G2, kind: "wave" });
  check("target set to nobody takes effect immediately (no rejoin): PRIVACY", (await g1.waitFor((m) => m.type === "room:notice"))?.code === "PRIVACY");
  await q(`update users set room_privacy=$2 where id=$1`, [G2, JSON.stringify({ v: 1, interactions: "everyone", appearInLists: true, allowInvites: true })]);
  await q(`update users set room_privacy=$2 where id = any($1)`, [[TEEN, G1], JSON.stringify({ v: 1, interactions: "everyone", appearInLists: true, allowInvites: true })]);
  const gt = await connect(TEEN); await join(gt, R.id);
  g1.drain(); await sleep(2100); g1.send({ type: "room:interact", targetId: TEEN, kind: "wave" });
  check("adult -> teen: refused as PRIVACY (the age band is never revealed), even with privacy everyone", (await g1.waitFor((m) => m.type === "room:notice"))?.code === "PRIVACY");
  gt.drain(); gt.send({ type: "room:interact", targetId: G1, kind: "wave" });
  check("teen -> adult: refused as PRIVACY", (await gt.waitFor((m) => m.type === "room:notice"))?.code === "PRIVACY");
  g1.drain(); await sleep(2100); g1.send({ type: "room:interact", targetId: G2, kind: "reaction", emoji: "💩" });
  check("interaction with a reaction outside the set is dropped", await g2.none((m) => m.type === "room:interact" && m.emoji === "💩"));
  g1.drain(); g1.send({ type: "room:interact", targetId: "00000000-0000-0000-0000-000000000000", kind: "wave" });
  check("interaction with someone not in the room: TARGET_GONE", (await g1.waitFor((m) => m.type === "room:notice"))?.code === "TARGET_GONE");
  const R2 = await liveRoom(G1, { noDirectInteractions: true, title: "no direct" });
  const g2b = await connect(G3); // G3 joins G1's room along with G2
  const g2c = g2; await join(g1, R2.id); await join(g2c, R2.id);
  await until(async () => roomHub.roomOf(G1) === R2.id && roomHub.roomOf(G2) === R2.id); await sleep(2100); g1.drain(); g1.send({ type: "room:interact", targetId: G2, kind: "wave" });
  check("room flag noDirectInteractions: ROOM_NO_DIRECT", (await g1.waitFor((m) => m.type === "room:notice"))?.code === "ROOM_NO_DIRECT");
  check("one room at a time: joining R2 left R (host told)", !!(await h.waitFor((m) => m.type === "room:left" && m.userId === G1)) && roomHub.roomOf(G1) === R2.id);
  g2b.close(); await join(g1, R.id); await join(g2, R.id);

  // ---------------- refused joins (bouncer, bans, blocks) incl. reconnect
  const adultsOnly = await liveRoom(H, { ageLimit: "18+", title: "18+" });
  const t2 = await connect(TEEN);
  check("under-age join refused: AGE_LIMIT", (await join(t2, adultsOnly.id))?.code === "AGE_LIMIT");
  t2.close(); const t3 = await connect(TEEN);
  check("under-age refused again after reconnect", (await join(t3, adultsOnly.id))?.code === "AGE_LIMIT");
  const nd = await connect(NODOB);
  check("unknown age refused: AGE_UNKNOWN", (await join(nd, R.id))?.code === "AGE_UNKNOWN");
  const bl = await connect(BLK);
  check("blocked by host refused as NOT_FOUND (a block is never revealed)", (await join(bl, R.id))?.code === "NOT_FOUND");
  await rs.setMemberFlag(R.id, G3, { banned: true });
  const g3b = await connect(G3);
  check("banned user refused: BANNED", (await join(g3b, R.id))?.code === "BANNED");
  g3b.close(); const g3c = await connect(G3);
  check("banned user refused again after reconnect", (await join(g3c, R.id))?.code === "BANNED");
  const priv = await liveRoom(H, { visibility: "friends", title: "friends only" });
  check("friends room join by non-mutual: NOT_FOUND", (await join(g1, priv.id))?.code === "NOT_FOUND");
  await join(g1, R.id);
  const crypto = await import("node:crypto");
  const tok = "secret-invite-token-0123456789abcdef0123456789";
  const invRoom = await liveRoom(H, { visibility: "invite", title: "invite", inviteTokenHash: crypto.createHash("sha256").update(tok).digest("hex") });
  check("invite room without token: NOT_FOUND, wrong token NOT_FOUND", (await join(g1, invRoom.id))?.code === "NOT_FOUND" && (await join(g1, invRoom.id, { inviteToken: "nope" }))?.code === "NOT_FOUND");
  check("invite room with token: joins", (await join(g1, invRoom.id, { inviteToken: tok }))?.type === "room:state");
  await join(g1, R.id);
  const ended = await rs.createRoom(H, { title: "E", kind: "party", visibility: "public", ageLimit: "all" } as any);
  check("scheduled room: ROOM_NOT_LIVE", (await join(g1, ended.id))?.code === "ROOM_NOT_LIVE");
  await rs.setStatus(ended.id, "ended");
  check("ended room: ROOM_ENDED", (await join(g1, ended.id))?.code === "ROOM_ENDED");
  check("unknown room: NOT_FOUND", (await join(g1, "00000000-0000-0000-0000-000000000000"))?.code === "NOT_FOUND");
  await join(g1, R.id);
  g1.drain(); g1.send({ type: "room:leave" }); await until(async () => roomHub.roomOf(G1) === null); g1.drain(); g1.send({ type: "room:chat", text: "ghost" });
  check("chat when not in a room: NOT_IN_ROOM notice", (await g1.waitFor((m) => m.type === "room:notice"))?.code === "NOT_IN_ROOM");
  await join(g1, R.id);

  // ---------------- capacity, member cap, multi-tab
  const HS = await mk("w_hs");
  const small = await liveRoom(HS, { capacity: 2, title: "tiny" });
  const hs2 = await connect(HS);
  check("capacity 2: host + one guest in", (await join(hs2, small.id))?.type === "room:state" && (await join(g1, small.id))?.type === "room:state");
  check("capacity 2: third refused ROOM_FULL", (await join(g2, small.id))?.code === "ROOM_FULL");
  await join(g1, R.id); hs2.close();
  const big = await liveRoom(H, { capacity: 100, title: "big" });
  for (let i = 0; i < 45; i++) roomHub.join(big.id, { userId: `fake-${i}`, role: "guest", muted: false, joinedAt: i, send: () => {} });
  const bs = await join(g2, big.id);
  check("member list capped at 40 with memberCount", bs?.members?.length <= 40 && bs.memberCount === 46, `${bs?.members?.length} ${bs?.memberCount}`);
  await join(g2, R.id);

  const g1tab2 = await connect(G1);
  g1tab2.drain(); g1tab2.send({ type: "room:join", roomId: R.id }); await g1tab2.waitFor((m) => m.type === "room:state");
  check("two tabs, one user: counted once", roomHub.members(R.id).filter((m) => m.userId === G1).length === 1);
  h.drain(); g1tab2.close();
  check("closing one tab keeps the user present (other tab still joined)", await h.none((m) => m.type === "room:left" && m.userId === G1, 400));
  g1.close();
  check("closing the last tab removes the user and tells the room", !!(await h.waitFor((m) => m.type === "room:left" && m.userId === G1)));

  // ---------------- kick / ban
  const g1n = await connect(G1); await join(g1n, R.id);
  g1n.drain(); h.drain();
  h.send({ type: "room:mod", action: "kick", targetId: G1 });
  check("kick: target is told, room sees them leave, membership closed at once", !!(await g1n.waitFor((m) => m.type === "room:mod" && m.action === "kick")) && !!(await h.waitFor((m) => m.type === "room:left" && m.userId === G1)) && roomHub.roomOf(G1) === null);
  g1n.send({ type: "room:chat", text: "still here?" });
  check("kicked user cannot chat any more", await h.none((m) => m.type === "room:chat" && m.userId === G1));
  check("kick keeps the person out for a while: rejoin refused KICKED", (await join(g1n, R.id))?.code === "KICKED");
  h.send({ type: "room:mod", action: "ban", targetId: G1 }); await until(async () => (await rs.isBanned(R.id, G1)) === true);
  check("ban persists and outranks the kick: BANNED", (await rs.isBanned(R.id, G1)) === true && (await join(g1n, R.id))?.code === "BANNED");
  h.drain(); h.send({ type: "room:mod", action: "kick", targetId: H });
  check("host cannot kick themselves", !!(await h.waitFor((m) => m.type === "room:notice" && m.code === "FORBIDDEN")));

  // ---------------- host disconnect / reconnect / end
  const R3 = await liveRoom(G2, { title: "G2 hosts" });
  await rs.setMemberFlag(R.id, G3, { banned: false });
  await join(g2, R3.id);
  const watcher = await connect(G3); await join(watcher, R3.id);
  watcher.drain();
  g2.close();
  const host2b = await connect(G2);
  await join(host2b, R3.id);
  await sleep(tuning.graceMs + 500);
  check("host reconnect within grace cancels the end", (await rs.getRoom(R3.id))?.status === "live" && roomHub.get(R3.id, G2)?.role === "host");
  watcher.drain();
  host2b.close();
  check("host gone past grace: room ended, guests told", !!(await watcher.waitFor((m) => m.type === "room:ended", tuning.graceMs + 5000)) && await until(async () => (await rs.getRoom(R3.id))?.status === "ended"));
  check("ended room leaves no ghost members", roomHub.count(R3.id) === 0 && roomHub.roomOf(G3) === null);

  // ---------------- co-hosts, bans surviving a hub reset
  const H6 = await mk("w_h6"), CO1 = await mk("w_co1"), CO2 = await mk("w_co2"), GU = await mk("w_gu"), GU2 = await mk("w_gu2");
  const R6 = await liveRoom(H6, { title: "mod matrix" });
  await rs.upsertMember(R6.id, CO1, "cohost"); await rs.upsertMember(R6.id, CO2, "cohost");
  const c6h = await connect(H6), c6a = await connect(CO1), c6b = await connect(CO2), c6g = await connect(GU), c6g2 = await connect(GU2);
  const cs = await join(c6a, R6.id);
  check("a stored co-host joins as cohost", cs?.you?.role === "cohost", JSON.stringify(cs?.you));
  await join(c6h, R6.id); await join(c6b, R6.id); await join(c6g, R6.id); await join(c6g2, R6.id);
  const notice = async (c: Client, code: string) => !!(await c.waitFor((m) => m.type === "room:notice" && m.code === code));
  c6a.drain(); c6a.send({ type: "room:mod", action: "ban", targetId: H6 });
  check("co-host cannot ban the host", await notice(c6a, "FORBIDDEN") && (await rs.isBanned(R6.id, H6)) === false);
  c6a.drain(); c6a.send({ type: "room:mod", action: "kick", targetId: CO2 });
  check("co-host cannot kick another co-host", await notice(c6a, "FORBIDDEN") && roomHub.get(R6.id, CO2) !== undefined);
  c6g.drain(); c6g.send({ type: "room:mod", action: "kick", targetId: GU2 });
  check("guest cannot kick", await notice(c6g, "FORBIDDEN") && roomHub.get(R6.id, GU2) !== undefined);
  c6g2.drain(); c6a.send({ type: "room:mod", action: "mute", targetId: GU2 });
  check("co-host can mute a guest", !!(await c6g2.waitFor((m) => m.type === "room:mod" && m.action === "mute")) && (await rs.getMember(R6.id, GU2))?.muted === true);
  c6b.drain(); c6h.send({ type: "room:mod", action: "mute", targetId: CO2 });
  check("host can mute a co-host", !!(await c6b.waitFor((m) => m.type === "room:mod" && m.action === "mute")));
  c6g.drain(); c6a.send({ type: "room:mod", action: "ban", targetId: GU });
  check("co-host can ban a guest", !!(await c6g.waitFor((m) => m.type === "room:mod" && m.action === "ban")) && await until(async () => (await rs.isBanned(R6.id, GU)) === true));
  roomHub.end(R6.id); // hub reset: all in-memory presence is gone, only the database remembers
  c6g.close(); const c6g3 = await connect(GU);
  check("ban survives a hub reset and a reconnect", (await join(c6g3, R6.id))?.code === "BANNED");

  // ---------------- races and abuse (review findings)
  // capacity: N simultaneous joins to a room with 3 seats must seat exactly 3
  const HC = await mk("w_hc"); const capRoom = await liveRoom(HC, { capacity: 3, title: "3 seats" });
  const racers: Client[] = [];
  for (let i = 0; i < 6; i++) racers.push(await connect(await mk(`w_race${i}`)));
  racers.forEach((c) => { c.drain(); c.send({ type: "room:join", roomId: capRoom.id }); });
  await until(async () => racers.filter((c) => c.msgs.some((m) => m.type === "room:state" || m.code === "ROOM_FULL")).length === 6);
  check("capacity race: 6 simultaneous joins, 3 seats -> exactly 3 in", roomHub.count(capRoom.id) === 3 && racers.filter((c) => c.msgs.some((m) => m.type === "room:state")).length === 3, `${roomHub.count(capRoom.id)}`);

  // a socket that dies while its join is in flight must not leave a ghost
  const ghostU = await mk("w_ghost"); const ghostRoom = await liveRoom(await mk("w_gh_host"), { title: "ghost test" });
  const gc = await connect(ghostU); gc.send({ type: "room:join", roomId: ghostRoom.id }); gc.close();
  await sleep(2500);
  check("socket closed mid-join leaves no ghost member", roomHub.get(ghostRoom.id, ghostU) === undefined && roomHub.roomOf(ghostU) === null);
  const ghostHost = await mk("w_gh2"); const ghostRoom2 = await liveRoom(ghostHost, { title: "ghost host" });
  expectHost(ghostRoom2.id);
  const ghc = await connect(ghostHost); ghc.send({ type: "room:join", roomId: ghostRoom2.id }); ghc.close();
  check("host whose socket died mid-join: room ends after the grace (no zombie)", await until(async () => (await rs.getRoom(ghostRoom2.id))?.status === "ended", tuning.graceMs + 6000));
  const lonelyHost = await mk("w_lonely"); const lonely = await liveRoom(lonelyHost, { title: "host never comes" });
  expectHost(lonely.id);
  check("a room started over REST whose host never connects ends after the grace", await until(async () => (await rs.getRoom(lonely.id))?.status === "ended", tuning.graceMs + 6000));

  // one user, two rooms at once -> ends up in exactly one
  const twoU = await mk("w_two"); const ra = await liveRoom(await mk("w_ra"), { title: "A" }); const rb = await liveRoom(await mk("w_rb"), { title: "B" });
  const tabA = await connect(twoU), tabB = await connect(twoU);
  tabA.send({ type: "room:join", roomId: ra.id }); tabB.send({ type: "room:join", roomId: rb.id });
  await sleep(3000);
  const inA = roomHub.get(ra.id, twoU) !== undefined, inB = roomHub.get(rb.id, twoU) !== undefined;
  check("concurrent joins to two rooms: in exactly one, and the hub agrees", inA !== inB && roomHub.roomOf(twoU) === (inA ? ra.id : rb.id));

  // join is rate limited; chat limits survive leave + rejoin
  tuning.join = { rate: 0.01, burst: 3 }; // negligible refill: a join takes about a second here, so a realistic rate would never run dry
  const spamU = await mk("w_spam"); const spamHost = await mk("w_sph"); const spamRoom = await liveRoom(spamHost, { title: "spam" });
  const spc = await connect(spamU); spc.drain();
  for (let i = 0; i < 6; i++) spc.send({ type: "room:join", roomId: spamRoom.id });
  await until(async () => spc.all((m) => m.type === "room:state" || m.type === "room:notice").length >= 6, 15000);
  check("room:join is rate limited (burst 3)", spc.all((m) => m.type === "room:notice" && m.code === "RATE_LIMITED").length >= 2);
  tuning.join = { rate: 1000, burst: 1000 };
  const sp2 = await connect(await mk("w_sp2")); await join(sp2, spamRoom.id); const w2 = await connect(spamHost); await join(w2, spamRoom.id);
  w2.drain();
  for (let i = 0; i < 8; i++) sp2.send({ type: "room:chat", text: `a${i}` });
  await sleep(600);
  sp2.send({ type: "room:leave" }); await sleep(400); await join(sp2, spamRoom.id); w2.drain();
  for (let i = 0; i < 5; i++) sp2.send({ type: "room:chat", text: `b${i}` });
  await sleep(600);
  check("leaving and rejoining does not refill the chat bucket", w2.all((m) => m.type === "room:chat" && /^b/.test(m.text)).length <= 1, `${w2.all((m) => m.type === "room:chat" && /^b/.test(m.text)).length}`);

  // ---------------- leave during an in-flight join; deleted accounts get no socket
  const lvU = await mk("w_leave"); const lvHost = await mk("w_lvh"); const lvRoom = await liveRoom(lvHost, { title: "leave race" });
  const lvc = await connect(lvU); lvc.send({ type: "room:join", roomId: lvRoom.id }); lvc.send({ type: "room:leave" });
  await sleep(3000);
  check("room:leave sent right after room:join leaves no ghost", roomHub.get(lvRoom.id, lvU) === undefined && roomHub.roomOf(lvU) === null);
  const delU = await mk("w_deleted"); await q(`update users set deleted_at = now() where id=$1`, [delU]);
  const closed = await new Promise<number | null>((resolve) => { const w = new WebSocket(url, { headers: { cookie: `vibepulse.sid=s%3A${delU}.sig` } }); w.on("close", (c) => resolve(c)); w.on("error", () => resolve(null)); setTimeout(() => resolve(-1), 5000); });
  check("a deleted account's socket is closed (4001)", closed === 4001, String(closed));

  // ---------------- Part 3a: stage (who may speak) + LiveKit revocation, with a fake LiveKit
  {
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const { shutdownVoice } = await import("../server/rooms/stage");
    const { endRoom, enforceAgeLimit } = await import("../server/rooms/roomSocket");
    const fake = new FakeVoice();
    setVoiceServiceForTests(fake);
    tuning.stage = { rate: 1000, burst: 1000 };
    const logOf = (op: string, roomId: string, userId?: string, canPublish?: boolean) =>
      fake.calls.filter((c) => c.op === op && c.roomId === roomId && (userId === undefined || c.userId === userId) && (canPublish === undefined || c.canPublish === canPublish));
    const lastStage = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:stage" && !m.invitedYou);
    const notice = async (c: Client, code: string) => !!(await c.waitFor((m) => m.type === "room:notice" && m.code === code));
    const stageNow = async (c: Client, pred: (s: any) => boolean) => { await until(async () => { const s = lastStage(c); return !!s && pred(s); }); const s = lastStage(c); return !!s && pred(s); };
    const send = (c: Client, action: string, targetId?: string) => { c.drain(); c.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }); };

    const HV = await mk("sg_host"), CO = await mk("sg_co");
    const GS = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mk(`sg_g${i}`)));
    const VR = await liveRoom(HV, { title: "voice stage" });
    await rs.upsertMember(VR.id, CO, "cohost");
    await rs.setVoiceEnabled(VR.id, true);
    const ch = await connect(HV), cc = await connect(CO);
    const gc = await Promise.all(GS.map((id) => connect(id)));
    const st0 = await join(ch, VR.id);
    check("room:state carries stage, hands and voiceEnabled", Array.isArray(st0?.stage) && Array.isArray(st0?.hands) && st0?.voiceEnabled === true && st0.stage.length === 0, JSON.stringify([st0?.stage, st0?.hands, st0?.voiceEnabled]));
    await join(cc, VR.id); for (const c of gc) await join(c, VR.id);

    // voice off -> VOICE_OFF
    const offHost = await mk("sg_offhost"); const offGuest = await mk("sg_offguest"); const offRoom = await liveRoom(offHost, { title: "no voice" });
    const oh = await connect(offHost), og = await connect(offGuest); await join(oh, offRoom.id); await join(og, offRoom.id);
    send(og, "raise"); check("voice off: any stage message gets VOICE_OFF", await notice(og, "VOICE_OFF"));

    // raise -> hands, host accepts -> stage + persisted + LiveKit permission granted
    send(gc[0], "raise");
    check("raise: the room sees the hand", await stageNow(ch, (s) => s.hands.includes(GS[0])) && await stageNow(gc[1], (s) => s.hands.includes(GS[0])));
    send(ch, "accept", GS[0]);
    check("host accepts a raised hand: on stage, hand gone", await stageNow(gc[0], (s) => s.stage.includes(GS[0]) && !s.hands.includes(GS[0])));
    check("...persisted for reconnects, and LiveKit publish permission granted", await until(async () => (await rs.listOnStage(VR.id)).includes(GS[0])) && logOf("setCanPublish", VR.id, GS[0], true).length >= 1);
    send(gc[0], "lower");
    check("lower: back to listening, LiveKit publish revoked, no longer persisted", await stageNow(ch, (s) => !s.stage.includes(GS[0])) && await until(async () => !(await rs.listOnStage(VR.id)).includes(GS[0])) && logOf("setCanPublish", VR.id, GS[0], false).length >= 1);

    // the host gives speaking rights to anyone present, no raised hand needed
    send(ch, "accept", GS[1]);
    check("host gives speaking rights to a guest who never raised a hand", await stageNow(gc[1], (s) => s.stage.includes(GS[1])));
    // invite then accept
    send(cc, "invite", GS[2]);
    check("co-host invites; the guest is told", !!(await gc[2].waitFor((m) => m.type === "room:stage" && m.invitedYou === true)));
    send(gc[2], "accept");
    check("the invited guest accepts and is on stage", await stageNow(ch, (s) => s.stage.includes(GS[2])));
    // permissions
    send(gc[3], "accept", GS[3]); check("a guest cannot accept themselves without an invite", await notice(gc[3], "BAD_STATE"));
    send(gc[3], "accept", GS[4]); check("a guest cannot give rights to someone else", await notice(gc[3], "FORBIDDEN"));
    send(gc[3], "remove", GS[1]); check("a guest cannot remove a speaker", await notice(gc[3], "FORBIDDEN"));
    send(gc[3], "invite", GS[4]); check("a guest cannot invite", await notice(gc[3], "FORBIDDEN"));
    send(cc, "remove", HV); check("a co-host cannot act on the host", await notice(cc, "FORBIDDEN"));
    send(cc, "accept", GS[3]);
    check("a co-host can give speaking rights too", await stageNow(ch, (s) => s.stage.includes(GS[3])));
    // cap: host + co-host = 2 implicit; stage now has GS1, GS2, GS3 = 3 guests -> 5 of 6. One more fits, the next does not.
    send(ch, "accept", GS[4]); check("the sixth speaker fits", await stageNow(ch, (s) => s.stage.includes(GS[4])));
    send(ch, "accept", GS[5]); check("the seventh is refused STAGE_FULL", await notice(ch, "STAGE_FULL"));
    // remove
    send(cc, "remove", GS[1]);
    check("remove: off stage, LiveKit publish revoked, persisted flag cleared", await stageNow(ch, (s) => !s.stage.includes(GS[1])) && await until(async () => !(await rs.listOnStage(VR.id)).includes(GS[1])) && logOf("setCanPublish", VR.id, GS[1], false).length >= 1);

    // leaving: LiveKit session dropped, but the right is kept for a reconnect; a stale hand is not
    send(gc[4], "lower"); await sleep(200);
    send(gc[5], "raise"); await stageNow(ch, (s) => s.hands.includes(GS[5]));
    gc[2].send({ type: "room:leave" });
    check("a speaker who leaves is removed from LiveKit", await until(async () => logOf("remove", VR.id, GS[2]).length >= 1));
    check("...but keeps the right in the database", (await rs.listOnStage(VR.id)).includes(GS[2]));
    gc[5].send({ type: "room:leave" }); await until(async () => roomHub.roomOf(GS[5]) === null);
    const back = await join(gc[2], VR.id);
    check("rejoining restores the stage right", back?.type === "room:state" && back.stage.includes(GS[2]), JSON.stringify(back?.stage));
    const back5 = await join(gc[5], VR.id);
    check("rejoining does not restore a stale raised hand", back5?.type === "room:state" && !back5.hands.includes(GS[5]));

    // kick and ban revoke
    send(ch, "accept", GS[5]); await stageNow(ch, (s) => s.stage.includes(GS[5]));
    ch.drain(); ch.send({ type: "room:mod", action: "kick", targetId: GS[5] });
    check("kick: removed from LiveKit and the stage flag cleared", await until(async () => logOf("remove", VR.id, GS[5]).length >= 1 && !(await rs.listOnStage(VR.id)).includes(GS[5])));
    ch.send({ type: "room:mod", action: "ban", targetId: GS[2] });
    check("ban: removed from LiveKit and the stage flag cleared", await until(async () => logOf("remove", VR.id, GS[2]).length >= 2 && !(await rs.listOnStage(VR.id)).includes(GS[2])));
    check("kick/ban also drop them from the in-memory stage", await stageNow(ch, (s) => !s.stage.includes(GS[5]) && !s.stage.includes(GS[2])));

    // non-members
    const stranger = await connect(await mk("sg_stranger")); stranger.drain(); stranger.send({ type: "room:stage", action: "raise" });
    check("a socket that has not joined gets NOT_IN_ROOM", await notice(stranger, "NOT_IN_ROOM"));
    // bad input
    send(ch, "dance", GS[0]); check("an unknown action is rejected (BAD_REQUEST)", await notice(ch, "BAD_REQUEST"));
    send(ch, "accept", "nobody-here"); check("a target who is not in the room: TARGET_GONE", await notice(ch, "TARGET_GONE"));

    // voice switched off clears everything and closes the session
    await shutdownVoice(VR.id);
    check("shutdownVoice: stage emptied in memory, database and room, LiveKit session deleted", roomHub.stageOf(VR.id).stage.length === 0 && (await rs.listOnStage(VR.id)).length === 0 && logOf("delete", VR.id).length >= 1 && await stageNow(ch, (s) => s.stage.length === 0));

    // ending the room deletes the LiveKit session
    const before = logOf("delete", VR.id).length;
    await endRoom(VR.id);
    check("ending the room deletes the LiveKit session", logOf("delete", VR.id).length > before);

    // teens: speak only when everyone present is a teen; an adult joining takes teen speakers off the stage
    const TH = await mk("sg_teenhost", yearsAgo(16)), T1 = await mk("sg_t1", yearsAgo(15)), T2 = await mk("sg_t2", yearsAgo(14)), AD = await mk("sg_adult", yearsAgo(30));
    const TR = await liveRoom(TH, { title: "teens", visibility: "public", ageLimit: "all" }); await rs.setVoiceEnabled(TR.id, true);
    const th = await connect(TH), t1 = await connect(T1), t2 = await connect(T2), ad = await connect(AD);
    await join(th, TR.id); await join(t1, TR.id); await join(t2, TR.id);
    send(t1, "raise"); check("all-teen room: a teen can raise a hand", await stageNow(th, (s) => s.hands.includes(T1)));
    send(th, "accept", T1); check("all-teen room: the teen host gives a teen the mic", await stageNow(th, (s) => s.stage.includes(T1)));
    send(th, "accept", T2); await stageNow(th, (s) => s.stage.includes(T2));
    await join(ad, TR.id);
    check("an adult joins: the teen speakers come off the stage", await stageNow(th, (s) => s.stage.length === 0));
    check("...their LiveKit publish permission is revoked and the stage flag cleared", await until(async () => logOf("setCanPublish", TR.id, T1, false).length >= 1 && logOf("setCanPublish", TR.id, T2, false).length >= 1 && (await rs.listOnStage(TR.id)).length === 0));
    send(t2, "raise"); check("with an adult present a teen cannot raise a hand (NOT_ELIGIBLE)", await notice(t2, "NOT_ELIGIBLE"));
    send(th, "accept", T2); check("...and the host cannot give a teen the mic (NOT_ELIGIBLE)", await notice(th, "NOT_ELIGIBLE"));
    send(ad, "raise"); check("the adult can raise a hand", await stageNow(th, (s) => s.hands.includes(AD)));
    send(th, "accept", AD); check("...and the teen host can give the adult the mic", await stageNow(th, (s) => s.stage.includes(AD)));

    // an age-limit raise sends a staged teen out of LiveKit as well
    const AR = await liveRoom(HV, { title: "age raise" }); await rs.setVoiceEnabled(AR.id, true);
    const arT = await connect(await mk("sg_art", yearsAgo(16))); await join(ch, AR.id); await join(arT, AR.id);
    await rs.updateRoom(AR.id, { ageLimit: "18+" } as any); await enforceAgeLimit(AR.id);
    check("an age-limit raise removes the under-age person from LiveKit too", await until(async () => logOf("remove", AR.id).length >= 1));

    setVoiceServiceForTests(undefined);
  }

  // ---------------- Part 3a: synced playback (server side)
  {
    tuning.playback = { rate: 1000, burst: 1000 };
    const PH = await mk("pb_host"), PG = await mk("pb_guest"), PC = await mk("pb_co");
    const PR = await liveRoom(PH, { title: "playback" });
    await rs.upsertMember(PR.id, PC, "cohost");
    await rs.updateRoom(PR.id, { screen: { v: 1, provider: "youtube", kind: "video", url: "https://youtu.be/dQw4w9WgXcQ", embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", openUrl: "https://youtu.be/dQw4w9WgXcQ" } as any });
    const ver = (await rs.getRoom(PR.id))!.screenVersion;
    const ph = await connect(PH), pg = await connect(PG), pc = await connect(PC);
    await join(ph, PR.id); await join(pg, PR.id); await join(pc, PR.id);
    const play = (c: Client, p: object) => { [ph, pg, pc].forEach((x) => x.drain()); c.send({ type: "room:playback", ...p }); };
    const lastNp = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:playback");
    const notice = async (c: Client, code: string) => !!(await c.waitFor((m) => m.type === "room:notice" && m.code === code));
    const quiet = async (c: Client) => c.none((m) => m.type === "room:playback", 600);

    const t0 = Date.now();
    play(ph, { state: "playing", positionMs: 5000, screenVersion: ver });
    const got = await pg.waitFor((m) => m.type === "room:playback" && !!m.nowPlaying);
    check("host plays at 5000 ms: everyone gets it stamped by the server with serverNowMs", got?.nowPlaying?.state === "playing" && got.nowPlaying.positionMs === 5000 && got.nowPlaying.screenVersion === ver && got.nowPlaying.atServerMs >= t0 && got.serverNowMs >= got.nowPlaying.atServerMs && !!(await ph.waitFor((m) => m.type === "room:playback")), JSON.stringify(got));
    check("...and it is persisted", await until(async () => (await rs.getRoom(PR.id))?.nowPlaying?.state === "playing"));
    play(pg, { state: "paused", positionMs: 1, screenVersion: ver });
    check("a guest cannot control playback (FORBIDDEN) and nothing changes", await notice(pg, "FORBIDDEN") && (await rs.getRoom(PR.id))?.nowPlaying?.state === "playing");
    play(pc, { state: "paused", positionMs: 9000, screenVersion: ver });
    check("a co-host can", !!(await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying?.state === "paused" && m.nowPlaying.positionMs === 9000)));
    play(ph, { state: "playing", positionMs: 5, screenVersion: ver - 1 });
    check("a stale screenVersion is rejected and not broadcast", await notice(ph, "BAD_REQUEST") && await quiet(pg));
    for (const bad of [{ state: "play", positionMs: 5 }, { state: "playing", positionMs: "5" }, { state: "playing" }, { state: "playing", positionMs: null }]) {
      play(ph, { ...bad, screenVersion: ver });
      check(`junk is rejected: ${JSON.stringify(bad)}`, await notice(ph, "BAD_REQUEST") && await quiet(pg));
    }
    play(ph, { state: "playing", positionMs: 9e12, screenVersion: ver });
    check("an enormous position is clamped to a day", (await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying?.positionMs === 86_400_000))?.nowPlaying?.positionMs === 86_400_000);
    play(ph, { state: "playing", positionMs: -50, screenVersion: ver });
    check("a negative position is clamped to 0", (await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying?.positionMs === 0))?.nowPlaying?.positionMs === 0);

    play(ph, { state: "cue", positionMs: 0, inMs: 5000, screenVersion: ver });
    const cue = (await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying?.state === "cue"))?.nowPlaying;
    check("a cue stores startAtServerMs about five seconds ahead", !!cue && cue.startAtServerMs >= cue.atServerMs + 4900 && cue.startAtServerMs <= cue.atServerMs + 5100, JSON.stringify(cue));

    const late = await connect(await mk("pb_late")); const lateState = await join(late, PR.id);
    check("a late joiner's room:state carries the stored now-playing", lateState?.nowPlaying?.state === "cue" && lateState.nowPlaying.screenVersion === ver, JSON.stringify(lateState?.nowPlaying));
    roomHub.end(PR.id);
    const afterReset = await rs.getRoom(PR.id);
    check("now-playing survives a hub reset (it lives in the database)", afterReset?.nowPlaying?.state === "cue");

    // a new screen resets playback and bumps the version for everyone
    await join(ph, PR.id); await join(pg, PR.id);
    ph.drain(); pg.drain();
    ph.send({ type: "room:screen", screen: "https://vimeo.com/76979871" });
    const reset = await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying === null);
    const scr = await pg.waitFor((m) => m.type === "room:screen");
    const after = await rs.getRoom(PR.id);
    check("changing the screen clears now-playing, bumps the version, and tells everyone (screen message carries the new version)", !!reset && after?.screenVersion === ver + 1 && after.nowPlaying === null && scr?.screenVersion === ver + 1, JSON.stringify([reset, scr?.screenVersion, after?.screenVersion]));
    play(ph, { state: "playing", positionMs: 100, screenVersion: ver });
    check("playback for the previous screen is now stale", await notice(ph, "BAD_REQUEST"));
    play(ph, { state: "playing", positionMs: 100, screenVersion: ver + 1 });
    check("playback for the new screen is accepted", !!(await pg.waitFor((m) => m.type === "room:playback" && m.nowPlaying?.screenVersion === ver + 1)));

    // flood: rate limited
    tuning.playback = { rate: 4, burst: 8 };
    const PF = await mk("pb_flood"); await rs.upsertMember(PR.id, PF, "cohost");
    const pf = await connect(PF); await join(pf, PR.id); pf.drain(); pg.drain();
    for (let i = 0; i < 25; i++) pf.send({ type: "room:playback", state: "playing", positionMs: i, screenVersion: ver + 1 });
    await sleep(2500);
    const delivered = pg.all((m) => m.type === "room:playback").length;
    check("a burst of 25 playback messages is rate limited", delivered >= 8 && delivered < 25, `${delivered}`);
    check("the flooding host is told", pf.all((m) => m.type === "room:notice" && m.code === "RATE_LIMITED").length >= 1);
    tuning.playback = { rate: 1000, burst: 1000 };
  }

  // ---------------- Part 3a final review fixes (WebSocket side)
  {
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const { sweepVoice, reconcileVoice } = await import("../server/rooms/stage");
    const fake = new FakeVoice();
    setVoiceServiceForTests(fake);
    tuning.stage = { rate: 1000, burst: 1000 };
    const logOf = (op: string, roomId: string, userId?: string, canPublish?: boolean) =>
      fake.calls.filter((c) => c.op === op && c.roomId === roomId && (userId === undefined || c.userId === userId) && (canPublish === undefined || c.canPublish === canPublish));
    const lastStage = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:stage" && !m.invitedYou);
    const stageNow = async (c: Client, pred: (s: any) => boolean) => { await until(async () => { const s = lastStage(c); return !!s && pred(s); }); const s = lastStage(c); return !!s && pred(s); };
    const send = (c: Client, action: string, targetId?: string) => { c.drain(); c.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }); };

    // C1: a person LiveKit still has but the room does not (banned, removed, token replay) is swept out; wrong permissions are corrected
    const SH = await mk("rv_host"), SG = await mk("rv_guest"), SS = await mk("rv_stage");
    const SR = await liveRoom(SH, { title: "sweep" }); await rs.setVoiceEnabled(SR.id, true);
    const sh = await connect(SH), sg = await connect(SG), ss = await connect(SS);
    await join(sh, SR.id); await join(sg, SR.id); await join(ss, SR.id);
    send(sh, "accept", SS); await stageNow(sh, (s) => s.stage.includes(SS));
    fake.calls.length = 0;
    fake.participants = [{ identity: "banned-person", canPublish: true }, { identity: SG, canPublish: true }, { identity: SS, canPublish: false }, { identity: SH, canPublish: true }];
    await sweepVoice(SR.id);
    check("sweep: someone in LiveKit who is not in the room is removed", logOf("remove", SR.id, "banned-person").length === 1);
    check("sweep: a listener who can publish is switched to listen only", logOf("setCanPublish", SR.id, SG, false).length === 1);
    check("sweep: a stage guest who cannot publish is given publish", logOf("setCanPublish", SR.id, SS, true).length === 1);
    check("sweep: someone already correct is left alone", logOf("remove", SR.id, SH).length === 0 && logOf("setCanPublish", SR.id, SH).length === 0);
    fake.participants = [];

    // I2: concurrent stage actions on one person end consistent (LiveKit's last word matches the stage list)
    send(sh, "accept", SG); send(sh, "remove", SG); sh.send({ type: "room:stage", action: "accept", targetId: SG }); sh.send({ type: "room:stage", action: "remove", targetId: SG });
    await sleep(3000);
    const finalOn = roomHub.stageOf(SR.id).stage.includes(SG);
    const lastCall = [...logOf("setCanPublish", SR.id, SG)].pop();
    check("concurrent accept/remove: LiveKit's last instruction matches the stage", !!lastCall && lastCall.canPublish === finalOn, `${finalOn} ${JSON.stringify(lastCall)}`);
    check("...and the database agrees", (await rs.listOnStage(SR.id)).includes(SG) === finalOn);

    // I5: reconnecting cannot take a guest past the speaker cap
    const CH = await mk("rv_capH"); const CRoom = await liveRoom(CH, { title: "cap restore" }); await rs.setVoiceEnabled(CRoom.id, true);
    const caps = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mk(`rv_cap${i}`)));
    const chc = await connect(CH); await join(chc, CRoom.id);
    const cgc = await Promise.all(caps.map((id) => connect(id))); for (const c of cgc) await join(c, CRoom.id);
    for (let i = 0; i < 5; i++) { send(chc, "accept", caps[i]); await stageNow(chc, (s) => s.stage.includes(caps[i])); } // host + 5 = 6
    cgc[0].send({ type: "room:leave" }); await until(async () => roomHub.roomOf(caps[0]) === null);
    check("a speaker who left keeps the persisted right", (await rs.listOnStage(CRoom.id)).includes(caps[0]));
    send(chc, "accept", caps[5]); check("their seat was given to someone else (still 6 speakers)", await stageNow(chc, (s) => s.stage.includes(caps[5])));
    const back = await join(cgc[0], CRoom.id);
    check("rejoining when the stage is full does not restore them (cap holds at 6)", back?.type === "room:state" && !back.stage.includes(caps[0]) && roomHub.stageOf(CRoom.id).stage.length === 5, JSON.stringify(back?.stage));
    check("...and their stored right is cleared", !(await rs.listOnStage(CRoom.id)).includes(caps[0]));

    // I9: stage guests and raised hands are always in room:state even beyond the 40-member cap
    const BH = await mk("rv_bigH"); const BR = await liveRoom(BH, { title: "big stage" }); await rs.setVoiceEnabled(BR.id, true);
    const bh = await connect(BH); await join(bh, BR.id);
    for (let i = 0; i < 44; i++) roomHub.join(BR.id, { userId: `ghost-${i}`, role: "guest", muted: false, joinedAt: i + 1, age: 30, send: () => {}, info: { username: `ghost${i}` } });
    const lateSpeaker = await mk("rv_late"); const lc = await connect(lateSpeaker);
    roomHub.setVoiceOn(BR.id, true);
    await join(lc, BR.id);
    roomHub.setStage(BR.id, { stage: [lateSpeaker], hands: [], invited: [] });
    const bstate = await join(bh, BR.id);
    check("the 45th member who is on stage is in room:state members although the cap is 40", bstate?.members.some((m: any) => m.userId === lateSpeaker) && bstate.members.length <= 41, `${bstate?.members?.length}`);
    check("room:state carries serverNowMs for clock correction", typeof bstate?.serverNowMs === "number" && Math.abs(bstate.serverNowMs - Date.now()) < 60_000);
    check("room:state never carries anyone's age", !/"age"/.test(JSON.stringify(bstate)));
    roomHub.end(BR.id);

    // teen host: publish follows the teen rule as adults come and go
    const TH = await mk("rv_teenhost", yearsAgo(16)), T1 = await mk("rv_teen1", yearsAgo(15)), AD = await mk("rv_adult", yearsAgo(30));
    const TR = await liveRoom(TH, { title: "teen host" }); await rs.setVoiceEnabled(TR.id, true);
    const th = await connect(TH), t1 = await connect(T1), ad = await connect(AD);
    await join(th, TR.id); await join(t1, TR.id);
    roomHub.get(TR.id, TH)!.publish = true; // what the token route records when a token is minted
    fake.calls.length = 0;
    await join(ad, TR.id);
    check("an adult arrives: the teen host's publish permission is revoked", await until(async () => logOf("setCanPublish", TR.id, TH, false).length >= 1));
    ad.send({ type: "room:leave" }); await until(async () => roomHub.roomOf(AD) === null);
    check("the adult leaves: the teen host's publish permission is restored", await until(async () => logOf("setCanPublish", TR.id, TH, true).length >= 1));

    // last person out of a room also leaves LiveKit; a ban of someone who is not present removes them too
    const LH = await mk("rv_lastH"); const LR = await liveRoom(LH, { title: "last out" }); await rs.setVoiceEnabled(LR.id, true);
    const lh = await connect(LH); await join(lh, LR.id); fake.calls.length = 0;
    lh.send({ type: "room:leave" });
    check("the last person leaving is removed from LiveKit", await until(async () => logOf("remove", LR.id, LH).length >= 1));

    setVoiceServiceForTests(undefined);
  }

  // ---------------- Live screen: one person at a time streams camera + mic, granted by the host
  {
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const { sweepVoice, stopAllLive, shutdownVoice } = await import("../server/rooms/stage");
    const fake = new FakeVoice();
    setVoiceServiceForTests(fake);
    tuning.stage = { rate: 1000, burst: 1000 };
    const calls = (roomId: string, userId: string) => fake.calls.filter((c) => c.op === "setCanPublish" && c.roomId === roomId && c.userId === userId);
    const lastLive = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:live");
    const liveNow = async (c: Client, pred: (l: any) => boolean) => { await until(async () => { const l = lastLive(c); return !!l && pred(l); }); const l = lastLive(c); return !!l && pred(l); };
    const sendLive = (c: Client, action: string, targetId?: string) => { c.drain(); c.send({ type: "room:live", action, ...(targetId ? { targetId } : {}) }); };
    const sendStage = (c: Client, action: string, targetId?: string) => { c.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }); };
    const notice = async (c: Client, code: string) => !!(await c.waitFor((m) => m.type === "room:notice" && m.code === code));

    const LHost = await mk("lv_host"), LA = await mk("lv_a"), LB = await mk("lv_b"), LC = await mk("lv_c");
    const LR = await liveRoom(LHost, { title: "live screen" });
    await rs.setVoiceEnabled(LR.id, true); await rs.setLiveVideo(LR.id, true);
    const lh = await connect(LHost), la = await connect(LA), lb = await connect(LB), lc = await connect(LC);
    const lst = await join(lh, LR.id);
    check("live: room:state carries liveVideo, holder and asks", lst?.room?.liveVideo === true && lst.holder === null && Array.isArray(lst.asks) && lst.asks.length === 0, JSON.stringify([lst?.room?.liveVideo, lst?.holder, lst?.asks]));
    await join(la, LR.id); await join(lb, LR.id); await join(lc, LR.id);
    sendStage(lh, "accept", LA); sendStage(lh, "accept", LB);
    await until(async () => roomHub.stageOf(LR.id).stage.length === 2);

    sendLive(lc, "ask");
    check("live: asking from off the stage is refused (NOT_ON_STAGE)", await notice(lc, "NOT_ON_STAGE"));
    sendLive(la, "ask");
    check("live: an on-stage guest asks, everyone sees the ask", await liveNow(lh, (l) => l.asks.includes(LA) && l.holder === null) && await liveNow(lc, (l) => l.asks.includes(LA)));
    sendLive(la, "grant", LB);
    check("live: a guest cannot grant (NOT_ALLOWED)", await notice(la, "NOT_ALLOWED"));

    sendLive(lh, "grant", LA);
    check("live: the host grants: holder set, ask cleared, room told", await liveNow(lb, (l) => l.holder === LA && !l.asks.includes(LA)));
    check("live: LiveKit gives the holder the camera", await until(async () => calls(LR.id, LA).some((c) => c.canPublish === true && c.camera === true)));
    check("live: nobody else got the camera", calls(LR.id, LB).every((c) => !c.camera) && calls(LR.id, LHost).every((c) => !c.camera));

    sendLive(lh, "grant", LB);
    check("live: a second grant replaces the holder", await liveNow(lc, (l) => l.holder === LB));
    const lastA = calls(LR.id, LA).at(-1)!, firstB = calls(LR.id, LB).find((c) => c.camera)!;
    check("live: the old holder loses the camera before the new holder gets it", !!firstB && !lastA.camera && fake.calls.indexOf(lastA) < fake.calls.indexOf(firstB));

    sendLive(lh, "stop");
    check("live: the host stops the stream: holder cleared, camera removed", await liveNow(la, (l) => l.holder === null) && await until(async () => !calls(LR.id, LB).at(-1)!.camera));
    sendLive(lh, "grant", LA); await liveNow(lh, (l) => l.holder === LA);
    sendLive(la, "stop");
    check("live: the holder may stop their own stream", await liveNow(lh, (l) => l.holder === null));

    sendLive(lh, "grant", LA); await liveNow(lh, (l) => l.holder === LA);
    lh.drain(); la.send({ type: "room:leave" });
    check("live: the holder leaving clears the screen", await liveNow(lh, (l) => l.holder === null));
    await join(la, LR.id); sendStage(lh, "accept", LA); await until(async () => roomHub.stageOf(LR.id).stage.includes(LA));

    sendLive(lh, "grant", LA); await liveNow(lh, (l) => l.holder === LA);
    lh.send({ type: "room:mod", action: "kick", targetId: LA });
    check("live: kicking the holder clears the screen and the camera", await liveNow(lh, (l) => l.holder === null) && await until(async () => fake.calls.some((c) => c.op === "remove" && c.userId === LA)));
    await join(la, LR.id); await rs.setMemberFlag(LR.id, LA, { kicked: false } as any).catch(() => {});

    // late joiner sees the holder, never an age
    sendLive(lh, "grant", LB); await liveNow(lh, (l) => l.holder === LB);
    const late = await mk("lv_late"); const lt = await connect(late);
    const lts = await join(lt, LR.id);
    check("live: a late joiner's room:state has the holder and no ages", lts?.holder === LB && !/"age"/.test(JSON.stringify(lts)), JSON.stringify(lts)?.slice(0, 200));

    // switching live video off (or voice off) clears everything
    roomHub.setLiveVideoOn(LR.id, false);
    await stopAllLive(LR.id);
    check("live: live video off clears the holder and removes the camera", await liveNow(lh, (l) => l.holder === null) && !calls(LR.id, LB).at(-1)!.camera);
    sendLive(lb, "ask");
    check("live: asking while live video is off is refused (LIVE_OFF)", await notice(lb, "LIVE_OFF"));
    roomHub.setLiveVideoOn(LR.id, true);
    sendLive(lh, "grant", LB); await liveNow(lh, (l) => l.holder === LB);
    await shutdownVoice(LR.id);
    check("live: voice off clears the holder, live video and persists it off", await liveNow(lh, (l) => l.holder === null) && !roomHub.liveVideoOn(LR.id) && (await rs.getRoom(LR.id))?.liveVideo === false);

    // sweep: someone with a camera who is not the holder loses it
    await rs.setVoiceEnabled(LR.id, true); roomHub.setVoiceOn(LR.id, true); await rs.setLiveVideo(LR.id, true); roomHub.setLiveVideoOn(LR.id, true);
    fake.participants = [{ identity: LC, canPublish: false, canCamera: true }];
    fake.calls.length = 0;
    await sweepVoice(LR.id);
    check("live: the sweep removes a camera permission from a non-holder", calls(LR.id, LC).some((c) => c.canPublish === false && !c.camera));
    fake.participants = [{ identity: LC, canPublish: false, canCamera: false, hasCamera: true }];
    fake.calls.length = 0;
    await sweepVoice(LR.id);
    check("live: the sweep removes someone who is publishing a camera track without holding the screen", fake.calls.some((c) => c.op === "remove" && c.userId === LC));
    fake.participants = [];

    // a failed revoke must not leave two cameras: the old holder is removed from LiveKit instead
    const FH = await mk("lv_fh"), FA = await mk("lv_fa"), FB = await mk("lv_fb");
    const FR = await liveRoom(FH, { title: "failed revoke" }); await rs.setVoiceEnabled(FR.id, true); await rs.setLiveVideo(FR.id, true);
    const fh = await connect(FH), fa = await connect(FA), fb = await connect(FB);
    await join(fh, FR.id); await join(fa, FR.id); await join(fb, FR.id);
    sendStage(fh, "accept", FA); sendStage(fh, "accept", FB); await until(async () => roomHub.stageOf(FR.id).stage.length === 2);
    sendLive(fh, "grant", FA); await liveNow(fh, (l) => l.holder === FA);
    fake.failOn = (c) => c.op === "setCanPublish" && c.userId === FA && !c.camera;
    fake.calls.length = 0;
    sendLive(fh, "grant", FB);
    check("live: if taking the camera from the old holder fails, they are removed from LiveKit instead", await liveNow(fh, (l) => l.holder === FB) && await until(async () => fake.calls.some((c) => c.op === "remove" && c.userId === FA)));
    fake.failOn = null;

    // the teen rule: an adult arriving takes the screen from a teen holder
    const TH = await mk("lv_teenhost", yearsAgo(16)), T1 = await mk("lv_teen1", yearsAgo(15)), AD = await mk("lv_adult", yearsAgo(30));
    const TR = await liveRoom(TH, { title: "teen live" }); await rs.setVoiceEnabled(TR.id, true); await rs.setLiveVideo(TR.id, true);
    const th = await connect(TH), t1 = await connect(T1), ad = await connect(AD);
    await join(th, TR.id); await join(t1, TR.id);
    sendStage(th, "accept", T1); await until(async () => roomHub.stageOf(TR.id).stage.includes(T1));
    sendLive(th, "grant", T1);
    check("live: an all-teen room lets a teen on stage hold the screen", await liveNow(th, (l) => l.holder === T1));
    await join(ad, TR.id);
    check("live: an adult arriving clears the teen holder and takes the camera away", await liveNow(th, (l) => l.holder === null) && await until(async () => !calls(TR.id, T1).at(-1)!.camera));

    // live video off for the room: asks and grants are refused
    const NH = await mk("lv_nolive"), NG = await mk("lv_noliveg"); const NR = await liveRoom(NH, { title: "voice only" }); await rs.setVoiceEnabled(NR.id, true);
    const nh = await connect(NH), ng = await connect(NG); await join(nh, NR.id); await join(ng, NR.id);
    sendStage(nh, "accept", NG); await until(async () => roomHub.stageOf(NR.id).stage.includes(NG));
    sendLive(nh, "grant", NG);
    check("live: a room without live video refuses a grant (LIVE_OFF)", await notice(nh, "LIVE_OFF"));
    setVoiceServiceForTests(undefined);
  }

  // ---------------- Live screen: a dropped holder keeps the screen for the hold window
  {
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const { endRoom } = await import("../server/rooms/roomSocket");
    const fake = new FakeVoice();
    setVoiceServiceForTests(fake);
    tuning.stage = { rate: 1000, burst: 1000 };
    const savedGrace = tuning.liveGraceMs;
    tuning.liveGraceMs = 4000; // a join is several round trips to the scratch DB: the window must outlast one
    const lastLive = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:live");
    const liveNow = async (c: Client, pred: (l: any) => boolean) => { await until(async () => { const l = lastLive(c); return !!l && pred(l); }); const l = lastLive(c); return !!l && pred(l); };
    const sendLive = (c: Client, action: string, targetId?: string) => { c.drain(); c.send({ type: "room:live", action, ...(targetId ? { targetId } : {}) }); };
    const sendStage = (c: Client, action: string, targetId?: string) => { c.send({ type: "room:stage", action, ...(targetId ? { targetId } : {}) }); };
    const removed = (u: string) => fake.calls.filter((c) => c.op === "remove" && c.userId === u).length;

    const AH = await mk("ah_host"), AA = await mk("ah_a"), AB = await mk("ah_b");
    const AR = await liveRoom(AH, { title: "away hold" }); await rs.setVoiceEnabled(AR.id, true); await rs.setLiveVideo(AR.id, true);
    const ah = await connect(AH); let aa = await connect(AA), ab = await connect(AB);
    await join(ah, AR.id); await join(aa, AR.id); await join(ab, AR.id);
    sendStage(ah, "accept", AA); sendStage(ah, "accept", AB); await until(async () => roomHub.stageOf(AR.id).stage.length === 2);
    sendLive(ah, "grant", AA); await liveNow(ah, (l) => l.holder === AA);

    // the holder's connection drops: the spot is held, nobody is told they left, LiveKit is not touched
    ah.drain(); aa.close();
    check("hold: the room is told the holder is away, with when the hold ends", await liveNow(ah, (l) => l.holder === AA && typeof l.away === "number" && l.away > Date.now() - 1000));
    check("hold: the holder is not removed (no room:left, no LiveKit removal)", await ah.none((m) => m.type === "room:left" && m.userId === AA, 300) && removed(AA) === 0 && roomHub.get(AR.id, AA) !== undefined);

    // they come back inside the window: nothing was lost
    aa = await connect(AA);
    const back = await join(aa, AR.id);
    const resumed = await liveNow(ah, (l) => l.holder === AA && l.away === null);
    check("hold: coming back within the window resumes: still the holder, away cleared, member listed once", resumed && back?.holder === AA && back?.away === null && back.members.filter((m: any) => m.userId === AA).length === 1, JSON.stringify({ resumed, type: back?.type, holder: back?.holder, away: back?.away, n: back?.members?.filter((m: any) => m.userId === AA).length, last: lastLive(ah) }));
    await sleep(4400);
    check("hold: the old timer does not fire after a resume", roomHub.get(AR.id, AA) !== undefined && roomHub.liveOf(AR.id).holder === AA);

    // they do not come back: after the window everything is released like a normal leave
    ah.drain(); aa.close();
    check("hold: after the window the screen is released, the member leaves, LiveKit removes them", await liveNow(ah, (l) => l.holder === null) && !!(await ah.waitFor((m) => m.type === "room:left" && m.userId === AA, 9000)) && await until(async () => removed(AA) >= 1) && roomHub.get(AR.id, AA) === undefined);

    // the host takes the screen back while the holder is away: released at once, no ghost, no second leave
    aa = await connect(AA); await join(aa, AR.id); sendStage(ah, "accept", AA); await until(async () => roomHub.stageOf(AR.id).stage.includes(AA));
    sendLive(ah, "grant", AA); await liveNow(ah, (l) => l.holder === AA);
    ah.drain(); aa.close(); await liveNow(ah, (l) => typeof l.away === "number");
    sendLive(ah, "revoke", AA);
    check("hold: a host revoke during the hold releases the member at once", await liveNow(ah, (l) => l.holder === null) && !!(await ah.waitFor((m) => m.type === "room:left" && m.userId === AA, 600)));
    await sleep(4400);
    check("hold: ...and no second room:left when the old timer would have fired", ah.all((m) => m.type === "room:left" && m.userId === AA).length === 1);

    // someone who does not hold the screen still leaves at once
    ah.drain(); ab.close();
    check("hold: a dropped non-holder leaves immediately (no hold)", !!(await ah.waitFor((m) => m.type === "room:left" && m.userId === AB, 1500)));

    // voice switched off while the holder is away: nothing is left to hold, so the member is released at once (no ghost seat)
    {
      const { shutdownVoice } = await import("../server/rooms/stage");
      const vc = await connect(AA); await join(vc, AR.id); sendStage(ah, "accept", AA); await until(async () => roomHub.stageOf(AR.id).stage.includes(AA));
      sendLive(ah, "grant", AA); await liveNow(ah, (l) => l.holder === AA);
      ah.drain(); vc.close(); await liveNow(ah, (l) => typeof l.away === "number");
      await shutdownVoice(AR.id);
      check("hold: voice switched off while the holder is away releases the member at once", !!(await ah.waitFor((m) => m.type === "room:left" && m.userId === AA, 3000)) && roomHub.get(AR.id, AA) === undefined);
      await rs.setVoiceEnabled(AR.id, true); roomHub.setVoiceOn(AR.id, true); await rs.setLiveVideo(AR.id, true); roomHub.setLiveVideoOn(AR.id, true);
    }

    // a returning holder is never removed by a release that was already queued
    {
      const rc = await connect(AA); await join(rc, AR.id); sendStage(ah, "accept", AA); await until(async () => roomHub.stageOf(AR.id).stage.includes(AA));
      sendLive(ah, "grant", AA); await liveNow(ah, (l) => l.holder === AA);
      ah.drain(); rc.close(); await liveNow(ah, (l) => typeof l.away === "number");
      const back2 = await connect(AA); const st = await join(back2, AR.id);       // they are back
      sendLive(ah, "revoke", AA);                                                 // the host takes the screen after they returned
      await sleep(600);
      const noLeft = await ah.none((m) => m.type === "room:left" && m.userId === AA, 100);
      check("hold: a holder who came back is still in the room after a later revoke (not released as if away)", st?.holder === AA && noLeft && roomHub.get(AR.id, AA) !== undefined && roomHub.get(AR.id, AA)?.away === undefined);
    }

    // the room ending while a holder is away leaves no timer behind
    const ec = await connect(AA); await join(ec, AR.id); sendStage(ah, "accept", AA); await until(async () => roomHub.stageOf(AR.id).stage.includes(AA));
    sendLive(ah, "grant", AA); await liveNow(ah, (l) => l.holder === AA);
    ec.close(); await sleep(150);
    await endRoom(AR.id);
    await sleep(4400);
    check("hold: ending the room while the holder is away is clean", roomHub.liveOf(AR.id).holder === null && roomHub.get(AR.id, AA) === undefined);

    tuning.liveGraceMs = savedGrace;
    setVoiceServiceForTests(undefined);
  }

  // ---------------- link screens off: the WebSocket refuses them (clearing is fine)
  {
    roomFeatures.linkScreens = false;
    const OH = await mk("lo_host"); const OR = await liveRoom(OH, { title: "links off" });
    const oc = await connect(OH); await join(oc, OR.id);
    oc.drain(); oc.send({ type: "room:screen", screen: "https://youtu.be/dQw4w9WgXcQ" });
    check("room:screen with a link is refused (FEATURE_OFF) while the feature is off", !!(await oc.waitFor((m) => m.type === "room:notice" && m.code === "FEATURE_OFF")) && (await rs.getRoom(OR.id))?.screen === null);
    oc.drain(); oc.send({ type: "room:playback", state: "playing", positionMs: 5, screenVersion: 0 });
    check("room:playback is refused too (FEATURE_OFF)", !!(await oc.waitFor((m) => m.type === "room:notice" && m.code === "FEATURE_OFF")));
    roomFeatures.linkScreens = true;
  }

  // ---------------- server restart: live room with no hub state and no host ends after grace
  const R4 = await liveRoom(G1, { title: "orphan" });
  await rehydrateLiveRooms();
  check("rehydrate sweep ends live rooms whose host never returns", await until(async () => (await rs.getRoom(R4.id))?.status === "ended", tuning.graceMs + 6000));
  const R5 = await liveRoom(H, { title: "H still live" });
  await rehydrateLiveRooms();
  const hr = await connect(H); await join(hr, R5.id);
  await sleep(tuning.graceMs + 1500);
  check("rehydrate sweep is cancelled when the host rejoins", (await rs.getRoom(R5.id))?.status === "live");
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
