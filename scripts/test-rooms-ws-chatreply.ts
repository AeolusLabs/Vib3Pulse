// Chat reply checks over a real WebSocket server (same harness as test-rooms-ws.ts).   npm run test:rooms
// Needs a scratch database whose name contains "test".
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
tuning.graceMs = 6000; // the scratch DB can be remote (about 200 ms per query): a join is several round trips and was seen taking over 2.5 s, so keep the grace well above one
const until = async (f: () => Promise<boolean>, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };
tuning.chat = { rate: 1000, burst: 1000 }; // chat limiter lifted; set before any socket creates its buckets

const chatOf = (c: Client, text: string) => c.waitFor((m) => m.type === "room:chat" && m.text === text);

try {
  const H = await mk("cr_host"), A = await mk("cr_a"), B = await mk("cr_b"), C = await mk("cr_c");
  const R = await liveRoom(H);
  const h = await connect(H), a = await connect(A), b = await connect(B), c = await connect(C);
  for (const x of [h, a, b, c]) await join(x, R.id);

  // B says something, A replies to it.
  b.send({ type: "room:chat", text: "earlier" });
  await chatOf(a, "earlier");
  b.drain();
  a.send({ type: "room:chat", text: "hello", replyTo: { userId: B, text: "earlier" } });
  const got = await chatOf(b, "hello");
  check("reply: B receives the quote", !!got && JSON.stringify(got.replyTo) === JSON.stringify({ userId: B, text: "earlier" }), JSON.stringify(got));
  check("reply: the sender stays the real author", got?.userId === A);

  // Invalid shapes are dropped, the message still goes out.
  for (const [label, rt] of [["number", 5], ["bad userId", { userId: 5, text: "earlier" }], ["extra key", { userId: B, text: "earlier", evil: 1 }], ["empty text", { userId: B, text: "  " }], ["array", [B, "earlier"]]] as const) {
    const txt = `inv-${label}`;
    a.send({ type: "room:chat", text: txt, replyTo: rt });
    const m = await chatOf(b, txt);
    check(`invalid replyTo (${label}) dropped, message delivered`, !!m && m.replyTo === undefined, JSON.stringify(m));
  }

  // Forged and unknown quotes degrade to a plain message.
  a.send({ type: "room:chat", text: "forged", replyTo: { userId: B, text: "I never said this" } });
  const forged = await chatOf(b, "forged");
  check("forged quote (words B never said) is dropped", !!forged && forged.replyTo === undefined, JSON.stringify(forged));
  a.send({ type: "room:chat", text: "wrong-author", replyTo: { userId: C, text: "earlier" } });
  const wrong = await chatOf(b, "wrong-author");
  check("quote attributed to the wrong author is dropped", !!wrong && wrong.replyTo === undefined, JSON.stringify(wrong));
  a.send({ type: "room:chat", text: "never-spoke", replyTo: { userId: C, text: "anything" } });
  const never = await chatOf(b, "never-spoke");
  check("quote of someone who never spoke is dropped", !!never && never.replyTo === undefined);
  a.send({ type: "room:chat", text: "ghost-id", replyTo: { userId: "00000000-0000-0000-0000-000000000000", text: "x" } });
  const ghost = await chatOf(b, "ghost-id");
  check("quote of an unknown user id is dropped", !!ghost && ghost.replyTo === undefined);

  // HTML in a quoted line was already stripped when it was first sent; the quote carries the stored text.
  c.send({ type: "room:chat", text: "<b>bold</b> R&B" });
  const plain = await a.waitFor((m) => m.type === "room:chat" && m.userId === C && /R&B/.test(m.text));
  a.send({ type: "room:chat", text: "quote-plain", replyTo: { userId: C, text: plain?.text ?? "?" } });
  const qp = await chatOf(b, "quote-plain");
  check("quote text is the plain text the server stored", !!plain && qp?.replyTo?.text === plain.text && !/[<>]/.test(qp.replyTo.text), JSON.stringify(qp));

  // Long lines: the quote is cut to 120.
  const long = "z".repeat(250);
  c.send({ type: "room:chat", text: long });
  await chatOf(a, long);
  a.send({ type: "room:chat", text: "quote-long", replyTo: { userId: C, text: long } });
  const ql = await chatOf(b, "quote-long");
  check("long quote is cut to 120", ql?.replyTo?.text === "z".repeat(120), JSON.stringify(ql?.replyTo));

  // A reply to a member who has left still carries the quote (the server remembers the line).
  c.send({ type: "room:leave" });
  await until(async () => roomHub.roomOf(C) === null);
  a.send({ type: "room:chat", text: "quote-left", replyTo: { userId: C, text: "z".repeat(120) } });
  const left = await chatOf(b, "quote-left");
  check("reply to a member who left still delivers the quote", left?.replyTo?.userId === C, JSON.stringify(left));


  // ---- kick and ban purge the person's lines: nobody can keep quoting them
  const K = await mk("cr_k"), N = await mk("cr_n");
  const k = await connect(K), n = await connect(N);
  await join(k, R.id); await join(n, R.id);
  k.send({ type: "room:chat", text: "kicked words" });
  await chatOf(a, "kicked words");
  h.send({ type: "room:mod", action: "kick", targetId: K });
  await until(async () => roomHub.roomOf(K) === null);
  check("kick purges the person's lines from the ring", !roomHub.recentChat(R.id).some((l) => l.userId === K));
  b.drain();
  a.send({ type: "room:chat", text: "quote-kicked", replyTo: { userId: K, text: "kicked words" } });
  const qk = await chatOf(b, "quote-kicked");
  check("quote of a kicked member degrades to a plain message", !!qk && qk.replyTo === undefined, JSON.stringify(qk));
  n.send({ type: "room:chat", text: "banned words" });
  await chatOf(a, "banned words");
  h.send({ type: "room:mod", action: "ban", targetId: N });
  await until(async () => roomHub.roomOf(N) === null);
  check("ban purges the person's lines and flags them", !roomHub.recentChat(R.id).some((l) => l.userId === N) && roomHub.isChatBanned(R.id, N));
  a.send({ type: "room:chat", text: "quote-banned", replyTo: { userId: N, text: "banned words" } });
  const qn = await chatOf(b, "quote-banned");
  check("quote of a banned member degrades to a plain message", !!qn && qn.replyTo === undefined, JSON.stringify(qn));

  // ---- muted, rate limited, oversize id, hostile shapes
  const M = await mk("cr_m"); const mu = await connect(M); await join(mu, R.id);
  h.send({ type: "room:mod", action: "mute", targetId: M });
  await mu.waitFor((m) => m.type === "room:mod" && m.action === "mute");
  b.drain();
  mu.send({ type: "room:chat", text: "muted reply", replyTo: { userId: B, text: "earlier" } });
  check("a muted member's reply is dropped like any chat", await b.none((m) => m.type === "room:chat" && m.text === "muted reply") && !!(await mu.waitFor((m) => m.type === "room:notice" && m.code === "MUTED")));

  tuning.chat = { rate: 0.001, burst: 2 };
  const L = await mk("cr_l"); const lm = await connect(L); await join(lm, R.id);
  for (let i = 0; i < 4; i++) lm.send({ type: "room:chat", text: `lim${i}`, replyTo: { userId: B, text: "earlier" } });
  check("rate limit applies to replies (RATE_LIMITED notice)", !!(await lm.waitFor((m) => m.type === "room:notice" && m.code === "RATE_LIMITED")));
  check("...and only the allowed two were broadcast", (await until(async () => b.all((m) => m.type === "room:chat" && /^lim/.test(m.text)).length >= 2)) && await b.none((m) => m.type === "room:chat" && m.text === "lim3", 600));
  tuning.chat = { rate: 1000, burst: 1000 };

  b.drain();
  a.send({ type: "room:chat", text: "longid", replyTo: { userId: "u".repeat(65), text: "earlier" } });
  const li = await chatOf(b, "longid");
  check("userId over 64 chars: quote dropped, message delivered", !!li && li.replyTo === undefined);
  a.send({ type: "room:chat", text: "nested", replyTo: { userId: B, text: "earlier", replyTo: { userId: B, text: "earlier" } } });
  const ne = await chatOf(b, "nested");
  check("nested replyTo (extra key) dropped, message delivered", !!ne && ne.replyTo === undefined);
  a.ws.send(`{"type":"room:chat","text":"proto","replyTo":{"__proto__":{"polluted":1},"userId":"${B}","text":"earlier"}}`);
  const pr = await chatOf(b, "proto");
  check("__proto__ shape: message delivered, nothing polluted", !!pr && (pr.replyTo === undefined || JSON.stringify(pr.replyTo) === JSON.stringify({ userId: B, text: "earlier" })) && ({} as any).polluted === undefined, JSON.stringify(pr));
  a.send({ type: "room:chat", text: "alive", replyTo: { userId: B, text: "earlier" } });
  check("socket still alive after hostile shapes", !!(await chatOf(b, "alive")));

  // Ring buffer replay (what a new joiner or a report gets) keeps replyTo.
  const ring = roomHub.recentChat(R.id);
  const line = ring.find((l) => l.text === "hello");
  check("ring buffer keeps replyTo", JSON.stringify(line?.replyTo) === JSON.stringify({ userId: B, text: "earlier" }), JSON.stringify(line));
  check("ring buffer lines without a quote have none", ring.find((l) => l.text === "forged")?.replyTo === undefined);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  for (const c of conns) try { c.close(); } catch { /* ignore */ }
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
