// Rooms gaming over a real WebSocket server (same harness as test-rooms-ws.ts), with a FakeVoice standing in for LiveKit.
//   npm run test:rooms     Needs a scratch database whose name contains "test". Usernames use the prefix gm_.
// The scratch DB can be remote (about 200 ms per query): every check waits for its event, never a fixed short sleep.
import http from "node:http";
import bcrypt from "bcrypt";
import pg from "pg";
import WebSocket from "ws";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
delete process.env.ROOMS_GAMING; // the suite switches the flag itself
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { wsManager } = await import("../server/websocket");
const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");
const { roomFeatures } = await import("../server/rooms/features");
const { tuning } = await import("../server/rooms/roomSocket");
const { broadcastLive, reconcileVoice, sweepVoice } = await import("../server/rooms/stage");
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

const fakeStore = { get: (sid: string, cb: (e: any, s: any) => void) => cb(null, { passport: { user: sid } }) };
const server = http.createServer();
const fake = new FakeVoice();
setVoiceServiceForTests(fake);
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
  async waitFor(pred: (m: any) => boolean, ms = 10000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.msgs.slice(this.base).find(pred);
      if (m) return m;
      await sleep(15);
    }
    return null;
  }
  async none(pred: (m: any) => boolean, ms = 500) { await sleep(ms); return !this.msgs.slice(this.base).some(pred); }
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
const mk = async (name: string, dob: string | null = yearsAgo(30)) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`gm_${name}${stamp}@t.dev`, `gm_${name}${stamp}`, hash, dob]))[0].id as string;
const uname = (name: string) => `gm_${name}${stamp}`;
/** A live room with voice and live video on, made a game room of this format (and drop timeout) BEFORE anyone joins. */
const gameRoom = async (host: string, format: number | null, dropMs = 120_000) => {
  const r = await rs.createRoom(host, { title: "G", kind: "party", visibility: "public", ageLimit: "all", capacity: 20 } as any);
  await rs.setStatus(r.id, "live");
  await rs.setVoiceEnabled(r.id, true);
  await rs.setLiveVideo(r.id, true);
  await q(`update rooms set game_format = $2, game_drop_timeout_ms = $3 where id = $1`, [r.id, format, dropMs]);
  return r.id as string;
};
const lastGame = (c: Client) => [...c.msgs].reverse().find((m) => m.type === "room:game")?.game;
const gameNow = async (c: Client, pred: (g: any) => boolean) => until(() => { const g = lastGame(c); return !!g && pred(g); });
const sendGame = (c: Client, o: object) => c.send({ type: "room:game", ...o });
const notice = async (c: Client, code: string) => !!(await c.waitFor((m) => m.type === "room:notice" && m.code === code));
const sourcesOf = (roomId: string, userId: string) => fake.calls.filter((c) => c.roomId === roomId && c.userId === userId && (c.op === "setPublishSources" || c.op === "setCanPublish"));
const SCREEN = JSON.stringify(["screen_share", "screen_share_audio"]);

tuning.join = { rate: 1000, burst: 1000 };
tuning.stage = { rate: 1000, burst: 1000 };
tuning.sweepMs = 0;
tuning.graceMs = 10 * 60_000; // a host socket may drop between blocks; the room must not end behind the tests

try {
  // ---------------- flag OFF: nothing new is reachable, payloads unchanged
  roomFeatures.gaming = false;
  {
    const H = await mk("off_h"), G = await mk("off_g");
    const R = await gameRoom(H, 2);
    const h = await connect(H), g = await connect(G);
    const st = await join(h, R); await join(g, R);
    check("flag off: room:state has no game key (even for a room with game_format set)", st?.type === "room:state" && !("game" in st), JSON.stringify(Object.keys(st ?? {})));
    g.drain(); sendGame(g, { action: "ask", side: "A" });
    check("flag off: room:game is refused FEATURE_OFF", await notice(g, "FEATURE_OFF"));
    check("flag off: no LiveKit source change happened", fake.calls.every((c) => c.op !== "setPublishSources"));
    check("flag off: the hub knows no game", !roomHub.gameOn(R));
    h.drain(); broadcastLive(R);
    const live = await h.waitFor((m) => m.type === "room:live");
    check("flag off: the legacy room:live payload is exactly type/holder/asks/away", JSON.stringify(live) === JSON.stringify({ type: "room:live", holder: null, asks: [], away: null }), JSON.stringify(live));
    roomHub.end(R);
  }

  roomFeatures.gaming = true;

  // ---------------- teams, asks, accept / remove, sources
  {
    const H = await mk("h"), P1 = await mk("p1"), P2 = await mk("p2"), P3 = await mk("p3"), P4 = await mk("p4"), P5 = await mk("p5"), G = await mk("g");
    const T = await mk("teen", yearsAgo(15));
    const R = await gameRoom(H, 4);
    const h = await connect(H), p1 = await connect(P1), p2 = await connect(P2), p3 = await connect(P3), p4 = await connect(P4), p5 = await connect(P5), g = await connect(G);
    const st = await join(h, R);
    check("flag on: room:state carries the game view (format 4, empty teams, no away)", st?.game?.format === 4 && st.game.teams.A.length === 0 && st.game.teams.B.length === 0 && JSON.stringify(st.game.away) === "{}", JSON.stringify(st?.game));
    for (const c of [p1, p2, p3, p4, p5, g]) await join(c, R);

    // The legacy live screen payload is unchanged with the flag on as well.
    h.drain(); broadcastLive(R);
    const live = await h.waitFor((m) => m.type === "room:live");
    check("flag on: the legacy room:live payload is still exactly type/holder/asks/away", JSON.stringify(Object.keys(live ?? {})) === JSON.stringify(["type", "holder", "asks", "away"]), JSON.stringify(live));

    sendGame(p1, { action: "ask", side: "A" });
    check("a guest asks: everyone sees the ask", await gameNow(g, (x) => x.asks.some((a: any) => a.userId === P1 && a.side === "A")));
    g.drain(); sendGame(g, { action: "accept", targetId: P1 });
    check("a guest cannot accept (NOT_ALLOWED)", await notice(g, "NOT_ALLOWED"));

    fake.calls.length = 0;
    sendGame(h, { action: "accept", targetId: P1 });
    check("the host accepts the asker: on team A, ask cleared, featured", await gameNow(g, (x) => x.teams.A.includes(P1) && x.asks.length === 0 && x.featured.A === P1));
    check("...LiveKit gives exactly the screen sources (no microphone)", await until(() => sourcesOf(R, P1).some((c) => c.op === "setPublishSources" && JSON.stringify(c.sources) === SCREEN)), JSON.stringify(sourcesOf(R, P1)));
    check("...and never the microphone or camera",
      sourcesOf(R, P1).filter((c) => c.op === "setPublishSources").every((c) => !c.sources!.includes("microphone") && !c.sources!.includes("camera"))
      && !sourcesOf(R, P1).some((c) => c.op === "setCanPublish" && c.canPublish === true), JSON.stringify(sourcesOf(R, P1)));
    check("...players are not put on the stage list (the stage is the microphone)", !roomHub.stageOf(R).stage.includes(P1));

    for (const id of [P2, P3, P4]) { sendGame(h, { action: "accept", targetId: id, side: "A" }); await gameNow(h, (x) => x.teams.A.includes(id)); }
    h.drain(); sendGame(h, { action: "accept", targetId: P5, side: "A" });
    check("accepting a 5th player into a 4-player team -> TEAM_FULL", await notice(h, "TEAM_FULL"));

    const tc = await connect(T); await join(tc, R);
    tc.drain(); sendGame(tc, { action: "ask", side: "B" });
    check("a teen in an adult-hosted room cannot ask (TEEN_RULE: not eligible to play)", await notice(tc, "TEEN_RULE"));
    h.drain(); sendGame(h, { action: "accept", targetId: T, side: "B" });
    check("...nor can the host put them in (TEEN_RULE)", await notice(h, "TEEN_RULE"));

    // Review Focus 5: a second socket of the same user cannot make a second slot.
    const h2 = await connect(H); await join(h2, R);
    h2.drain(); sendGame(h2, { action: "accept", targetId: P1, side: "A" });
    check("RF5: the host's second tab re-accepting a player -> NO_CHANGE", await notice(h2, "NO_CHANGE"));
    const p1b = await connect(P1); await join(p1b, R);
    p1b.drain(); sendGame(p1b, { action: "ask", side: "B" });
    check("RF5: a player's second tab asking again -> NO_CHANGE, and they hold one slot", await notice(p1b, "NO_CHANGE") && roomHub.gameOf(R).teams.A.filter((x) => x === P1).length === 1 && !roomHub.gameOf(R).teams.B.includes(P1));
    p1b.close(); h2.close();
    await until(() => !!roomHub.get(R, P1) && !!roomHub.get(R, H));

    fake.calls.length = 0;
    sendGame(h, { action: "remove", targetId: P4 });
    check("the host removes a player: the room sees them gone", await gameNow(g, (x) => !x.teams.A.includes(P4)));
    check("...and LiveKit takes their screen (no publish right left)", await until(() => sourcesOf(R, P4).some((c) => c.op === "setCanPublish" && c.canPublish === false)), JSON.stringify(sourcesOf(R, P4)));

    // Review Focus 1: the browser's "Stop sharing" ends the track; the client sends remove for itself.
    sendGame(p3, { action: "remove", targetId: P3 });
    check("RF1: a player removing themselves (their track ended) releases the slot", await gameNow(h, (x) => !x.teams.A.includes(P3)));

    sendGame(h, { action: "feature", targetId: P2 });
    check("the host features another player of team A", await gameNow(g, (x) => x.featured.A === P2));
    sendGame(h, { action: "score", side: "A", value: 2 });
    check("the host sets the score", await gameNow(g, (x) => x.score[0] === 2 && x.score[1] === 0));
    h.drain(); sendGame(h, { action: "score", side: "A", value: -1 });
    check("a negative score -> BAD_VALUE", await notice(h, "BAD_VALUE"));
    h.drain(); sendGame(h, { action: "nonsense" });
    check("an unknown action -> BAD_REQUEST", await notice(h, "BAD_REQUEST"));
    h.drain(); sendGame(h, { action: "remove", targetId: 42 });
    check("a target that is not an id is refused (never read as yourself)", await notice(h, "BAD_REQUEST") && roomHub.gameOf(R).teams.A.includes(P2));

    // leaving, kick and ban all drop the player
    sendGame(h, { action: "accept", targetId: P5, side: "B" }); await gameNow(h, (x) => x.teams.B.includes(P5));
    p2.send({ type: "room:leave" });
    check("a player who leaves is dropped (and featured moves on)", await gameNow(h, (x) => !x.teams.A.includes(P2) && x.featured.A !== P2));
    h.send({ type: "room:mod", action: "kick", targetId: P1 });
    check("a kicked player is dropped", await gameNow(h, (x) => !x.teams.A.includes(P1)));
    h.send({ type: "room:mod", action: "ban", targetId: P5 });
    check("a banned player is dropped", await gameNow(h, (x) => !x.teams.B.includes(P5)));

    // the teen rule, through the reconcile path (an admin birthdate correction): a player who may no longer play is dropped
    sendGame(h, { action: "accept", targetId: G, side: "B" }); await gameNow(h, (x) => x.teams.B.includes(G));
    roomHub.refreshAge(R, G, 15);
    await reconcileVoice(R);
    check("a player corrected to 15 in an adult-hosted room is dropped by the reconcile", await gameNow(h, (x) => !x.teams.B.includes(G)));
    roomHub.refreshAge(R, G, 30);

    // live video off: no game
    sendGame(h, { action: "accept", targetId: G, side: "B" }); await gameNow(h, (x) => x.teams.B.includes(G));
    const { stopAllLive } = await import("../server/rooms/stage");
    roomHub.setLiveVideoOn(R, false);
    await stopAllLive(R);
    check("live video switched off: every player goes", await gameNow(h, (x) => x.teams.A.length === 0 && x.teams.B.length === 0));
    h.drain(); sendGame(h, { action: "accept", targetId: G, side: "B" });
    check("...and nobody can be added (GAME_OFF)", await notice(h, "GAME_OFF"));
    roomHub.end(R);
  }

  // ---------------- drops: reconnecting, dropped out, back, hold
  {
    const DROP_MS = 6000;
    tuning.gameDropMs = DROP_MS; // must outlast a rejoin (several round trips to a possibly remote scratch DB)
    const H = await mk("dh"), P = await mk("dp"), Q = await mk("dq");
    const R = await gameRoom(H, 2, 30_000);
    const h = await connect(H); let p = await connect(P); let qc = await connect(Q);
    await join(h, R); await join(p, R); await join(qc, R);
    sendGame(h, { action: "accept", targetId: P, side: "A" }); sendGame(h, { action: "accept", targetId: Q, side: "B" });
    await gameNow(h, (x) => x.teams.A.includes(P) && x.teams.B.includes(Q));

    h.drain(); qc.close();
    check("a player's connection drops: the slot shows a release time", await gameNow(h, (x) => x.teams.B.includes(Q) && typeof x.away[Q] === "number" && x.away[Q] > Date.now()));
    qc = await connect(Q); await join(qc, R);
    check("...they come back in time: away cleared, slot kept", await gameNow(h, (x) => x.teams.B.includes(Q) && !(Q in x.away)));
    check("...and the room is told they are back (system line)", !!(await h.waitFor((m) => m.type === "room:chat" && m.system === "game_back" && m.text === `${uname("dq")} is back`)));

    h.drain(); p.close();
    check("a player who does not come back is released after the timeout", await gameNow(h, (x) => !x.teams.A.includes(P)) && await until(() => !roomHub.get(R, P), 8000));
    check("...and the room is told '<name> has dropped out'", !!(await h.waitFor((m) => m.type === "room:chat" && m.system === "game_drop" && m.text === `${uname("dp")} has dropped out`)));
    roomHub.end(R);

    // hold slot (timeout 0): no timer, the slot stays until the host removes it
    const H2 = await mk("hh"), P2 = await mk("hp");
    const R2 = await gameRoom(H2, 1, 0);
    const h2 = await connect(H2); const p2 = await connect(P2);
    await join(h2, R2); await join(p2, R2);
    sendGame(h2, { action: "accept", targetId: P2, side: "A" }); await gameNow(h2, (x) => x.teams.A.includes(P2));
    h2.drain(); p2.close();
    check("hold slot: the dropped player shows away = null (held)", await gameNow(h2, (x) => x.teams.A.includes(P2) && P2 in x.away && x.away[P2] === null));
    await sleep(DROP_MS + 1000);
    check("hold slot: still held after the test timeout", roomHub.gameOf(R2).teams.A.includes(P2) && !!roomHub.get(R2, P2));
    sendGame(h2, { action: "remove", targetId: P2 });
    check("hold slot: the host removes them: slot gone and the away member is let go", await gameNow(h2, (x) => !x.teams.A.includes(P2)) && await until(() => !roomHub.get(R2, P2)));
    roomHub.end(R2);
    tuning.gameDropMs = null;
  }

  // ---------------- sweep: screen tracks only from current players
  {
    const H = await mk("sh"), P = await mk("sp"), X = await mk("sx");
    const R = await gameRoom(H, 1);
    const h = await connect(H), p = await connect(P), x = await connect(X);
    await join(h, R); await join(p, R); await join(x, R);
    sendGame(h, { action: "accept", targetId: P, side: "A" }); await gameNow(h, (g) => g.teams.A.includes(P));
    fake.participants = [
      { identity: X, canPublish: true, sources: ["screen_share"], publishing: ["screen_share"] }, // not a player, sharing a screen
      { identity: P, canPublish: false, sources: [] },                                            // a player whose grant was lost
    ];
    fake.calls.length = 0;
    await sweepVoice(R);
    check("sweep: a non-player publishing a screen is removed from the session", fake.calls.some((c) => c.op === "remove" && c.userId === X), JSON.stringify(fake.calls));
    check("sweep: a player whose grant is wrong gets exactly the screen sources back", fake.calls.some((c) => c.op === "setPublishSources" && c.userId === P && JSON.stringify(c.sources) === SCREEN), JSON.stringify(fake.calls));
    fake.calls.length = 0;
    await sweepVoice(R);
    check("sweep: once right, nothing changes on the next sweep", !fake.calls.some((c) => c.userId === P), JSON.stringify(fake.calls));
    fake.participants = [];
    roomHub.end(R);
  }

  // ---------------- flag switched off while a client still sends room:game
  {
    const H = await mk("st_h"); const R = await gameRoom(H, 1);
    const h = await connect(H); await join(h, R);
    roomFeatures.gaming = false;
    h.drain(); sendGame(h, { action: "format", value: 2 });
    check("RF5: a stale client sending room:game after the flag went off -> FEATURE_OFF", await notice(h, "FEATURE_OFF"));
    roomFeatures.gaming = true;
    roomHub.end(R);
  }
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
