// Rooms gaming: the game fields of POST / PATCH / GET /api/rooms (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-game.ts      (usernames use the prefix ga_)
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
delete process.env.ROOMS_GAMING;
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomFeatures } = await import("../server/rooms/features");
const { roomHub } = await import("../server/rooms/RoomHub");
const rs = await import("../server/rooms/roomStorage");
const { newGame } = await import("../shared/gameScreen");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

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
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ipSeq = 1;
async function http(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.31.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`ga_${name}${stamp}@t.dev`, `ga_${name}${stamp}`, hash, yearsAgo(30)]))[0].id as string;
const base_ = { title: "game night", kind: "party", visibility: "public", capacity: 20 };
const row = async (id: string) => (await q(`select game_format, game_drop_timeout_ms, age_lane, parent_room_id from rooms where id = $1`, [id]))[0];
const GAME_KEYS = ["gameFormat", "gameDropTimeoutMs", "ageLane", "parentRoomId"];
const hasGameKey = (o: any) => !!o && GAME_KEYS.some((k) => k in o);

try {
  const H = await mk("host"), V = await mk("viewer");

  // ---------------- flag off: the fields are ignored, nothing about games appears anywhere
  roomFeatures.gaming = false;
  const off = await http("POST", "/api/rooms", H, { ...base_, gameFormat: 2, gameDropTimeoutMs: 30000 });
  check("flag off: create succeeds and ignores the game fields", off.status === 201 && (await row(off.json.room.id)).game_format === null && (await row(off.json.room.id)).game_drop_timeout_ms === 120000, JSON.stringify(off.json));
  check("flag off: no game key on the host's room object", !hasGameKey(off.json.room), JSON.stringify(Object.keys(off.json.room ?? {})));
  const offBad = await http("POST", "/api/rooms", H, { ...base_, gameFormat: "two" });
  check("flag off: even an invalid game value is ignored (201)", offBad.status === 201, JSON.stringify(offBad));
  const offPatch = await http("PATCH", `/api/rooms/${off.json.room.id}`, H, { gameFormat: 3 });
  check("flag off: PATCH ignores gameFormat", offPatch.status === 200 && (await row(off.json.room.id)).game_format === null, JSON.stringify(offPatch));
  await q(`update rooms set game_format = 2 where id = $1`, [off.json.room.id]);
  const offGet = await http("GET", `/api/rooms/${off.json.room.id}`, H);
  check("flag off: GET never carries the game columns, even when the row has them", offGet.status === 200 && !hasGameKey(offGet.json.room), JSON.stringify(Object.keys(offGet.json?.room ?? {})));

  roomFeatures.gaming = true;

  // ---------------- create
  const ok = await http("POST", "/api/rooms", H, { ...base_, gameFormat: 2, gameDropTimeoutMs: 30000 });
  check("create: valid gameFormat and timeout are stored", ok.status === 201 && (await row(ok.json.room.id)).game_format === 2 && (await row(ok.json.room.id)).game_drop_timeout_ms === 30000, JSON.stringify(ok.json));
  check("create: the host's room object carries both fields", ok.json?.room?.gameFormat === 2 && ok.json.room.gameDropTimeoutMs === 30000, JSON.stringify(ok.json?.room));
  const hold = await http("POST", "/api/rooms", H, { ...base_, gameFormat: 1, gameDropTimeoutMs: 0 });
  check("create: the hold timeout (0) is accepted", hold.status === 201 && (await row(hold.json.room.id)).game_drop_timeout_ms === 0, JSON.stringify(hold));
  for (const [field, value] of [["gameFormat", 0], ["gameFormat", 5], ["gameFormat", "2"], ["gameFormat", 1.5], ["gameDropTimeoutMs", 60000], ["gameDropTimeoutMs", "30000"], ["gameDropTimeoutMs", -1]] as const) {
    const r = await http("POST", "/api/rooms", H, { ...base_, [field]: value });
    check(`create: ${field} = ${JSON.stringify(value)} -> 400 { field, reason }`, r.status === 400 && r.json?.field === field && r.json?.reason === "invalid", JSON.stringify(r));
  }
  const big = await http("POST", "/api/rooms", H, { ...base_, capacity: 100, gameFormat: 2 });
  check("create: a game room too big for live video -> 400 needs_live_video", big.status === 400 && big.json?.field === "gameFormat" && big.json?.reason === "needs_live_video", JSON.stringify(big));
  const plain = await http("POST", "/api/rooms", H, { ...base_ });
  check("create: no game fields -> an ordinary room (null format, default timeout)", plain.status === 201 && (await row(plain.json.room.id)).game_format === null && plain.json.room.gameFormat === null, JSON.stringify(plain.json?.room));

  // ---------------- GET: host only
  const R = ok.json.room.id as string;
  const hg = await http("GET", `/api/rooms/${R}`, H);
  check("GET: the host sees gameFormat and gameDropTimeoutMs", hg.status === 200 && hg.json.room.gameFormat === 2 && hg.json.room.gameDropTimeoutMs === 30000, JSON.stringify(hg.json?.room));
  const vg = await http("GET", `/api/rooms/${R}`, V);
  check("GET: anyone else never sees a game column", vg.status === 200 && !hasGameKey(vg.json.room), JSON.stringify(Object.keys(vg.json?.room ?? {})));
  const list = await http("GET", "/api/rooms?scope=upcoming", V);
  check("list: no room object in the list carries a game column", list.status === 200 && (list.json.rooms as any[]).every((r) => !hasGameKey(r)), JSON.stringify(list.json?.rooms?.[0]));

  // ---------------- PATCH (scheduled)
  const p1 = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: 4, gameDropTimeoutMs: 0 });
  check("PATCH scheduled: format and timeout change", p1.status === 200 && p1.json.room.gameFormat === 4 && p1.json.room.gameDropTimeoutMs === 0 && (await row(R)).game_format === 4, JSON.stringify(p1));
  const p2 = await http("PATCH", `/api/rooms/${R}`, H, { gameDropTimeoutMs: 45000 });
  check("PATCH: an invalid timeout -> 400 { field, reason }", p2.status === 400 && p2.json?.field === "gameDropTimeoutMs", JSON.stringify(p2));
  const p3 = await http("PATCH", `/api/rooms/${R}`, H, { capacity: 100, gameFormat: 4 });
  check("PATCH scheduled: growing past live video size with a game -> needs_live_video", p3.status === 400 && p3.json?.reason === "needs_live_video", JSON.stringify(p3));
  const p4 = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: null });
  check("PATCH: gameFormat null makes it an ordinary room", p4.status === 200 && (await row(R)).game_format === null, JSON.stringify(p4));
  const co = await http("PATCH", `/api/rooms/${R}`, V, { gameFormat: 2 });
  check("PATCH by someone else -> 403 (only the host)", co.status === 403, JSON.stringify(co));

  // ---------------- PATCH (live): voice and live video must be on
  await rs.setStatus(R, "live");
  const live1 = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: 2 });
  check("PATCH live without voice / live video -> 400 needs_live_video", live1.status === 400 && live1.json?.reason === "needs_live_video", JSON.stringify(live1));
  await rs.setVoiceEnabled(R, true); await rs.setLiveVideo(R, true);
  const live2 = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: 2 });
  check("PATCH live with voice and live video -> 200", live2.status === 200 && (await row(R)).game_format === 2, JSON.stringify(live2));

  // a live game with two players on team A cannot shrink to 1v1, nor be switched off
  roomHub.join(R, { userId: H, role: "host", muted: false, joinedAt: Date.now(), send: () => {}, info: {}, age: 30 });
  roomHub.setGameOn(R, true, { dropMs: 120_000, ageLane: null });
  const g = newGame(2); g.teams.A = ["x1", "x2"]; g.featured.A = "x1"; roomHub.setGame(R, g);
  const shrink = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: 1 });
  check("PATCH live: a format smaller than a team -> 409 TEAM_FULL", shrink.status === 409 && shrink.json?.code === "TEAM_FULL", JSON.stringify(shrink));
  const offLive = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: null });
  check("PATCH live: switching the game off with players in it -> 409 GAME_IN_PROGRESS", offLive.status === 409 && offLive.json?.code === "GAME_IN_PROGRESS", JSON.stringify(offLive));
  const grow = await http("PATCH", `/api/rooms/${R}`, H, { gameFormat: 3, gameDropTimeoutMs: 30000 });
  check("PATCH live: a bigger format is applied to the live game and the hub learns the timeout", grow.status === 200 && roomHub.gameOf(R).format === 3 && roomHub.gameOf(R).teams.A.length === 2 && roomHub.gameInfo(R)?.dropMs === 30000, JSON.stringify([grow.status, roomHub.gameOf(R), roomHub.gameInfo(R)]));
  roomHub.end(R);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.gaming = false;
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
