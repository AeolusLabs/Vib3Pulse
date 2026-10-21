// Rooms gaming: OBS / RTMP ingest (throwaway database, FakeVoice for LiveKit, hub members placed directly):
//   npm run test:rooms     (usernames use the prefix gi_)
// The stream key is a secret: only its own player gets it, it is never in a log line, room state or broadcast, and it stops
// working (deleteIngress) on remove, leave, ban and room end.
import express from "express";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
delete process.env.ROOMS_GAMING;
process.env.LIVEKIT_INGRESS = "1";
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

// every console line is captured, so the secrecy checks can read what the server logged
const logged: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomFeatures } = await import("../server/rooms/features");
const { roomHub } = await import("../server/rooms/RoomHub");
const rs = await import("../server/rooms/roomStorage");
const { handleGame, gameView } = await import("../server/rooms/game");
const { dropFromVoice } = await import("../server/rooms/stage");
const { applyMod, endRoom } = await import("../server/rooms/roomSocket");
const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
const { newGame } = await import("../shared/gameScreen");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const fake = new FakeVoice();
setVoiceServiceForTests(fake);
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
async function http(method: string, path: string, as: string) {
  const res = await fetch(base + path, { method, headers: { "x-forwarded-for": `10.34.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as } });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json, cache: res.headers.get("cache-control") };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`gi_${name}${stamp}@t.dev`, `gi_${name}${stamp}`, hash, yearsAgo(30)]))[0].id as string;
const sent: object[] = []; // everything any hub member was sent (broadcasts included)
const member = (userId: string, role: "host" | "guest") => ({ userId, role, muted: false, joinedAt: Date.now(), send: (m: object) => { sent.push(m); }, info: {}, age: 30 });
const deletes = (ingressId: string) => fake.calls.filter((c) => c.op === "deleteIngress" && c.ingressId === ingressId).length;

try {
  roomFeatures.gaming = true;
  const H = await mk("host"), P = await mk("player"), P2 = await mk("player2"), P3 = await mk("player3"), G = await mk("guest");
  const room = await rs.createRoom(H, { title: "OBS", kind: "party", visibility: "public", ageLimit: "all", capacity: 20, gameFormat: 4 } as any);
  await rs.setStatus(room.id, "live");
  const R = room.id as string;
  for (const [id, role] of [[H, "host"], [P, "guest"], [P2, "guest"], [P3, "guest"], [G, "guest"]] as const) roomHub.join(R, member(id, role));
  roomHub.setVoiceOn(R, true); roomHub.setLiveVideoOn(R, true);
  roomHub.setGameOn(R, true, { dropMs: 120_000, ageLane: null });
  const g = newGame(4); g.teams.A = [P, P2, P3]; g.featured.A = P; roomHub.setGame(R, g);

  const ng = await http("POST", `/api/rooms/${R}/game/ingress`, G);
  check("a non-player gets 403 NOT_ALLOWED (one fixed shape, no key)", ng.status === 403 && JSON.stringify(Object.keys(ng.json ?? {})) === JSON.stringify(["message", "code"]) && ng.json.code === "NOT_ALLOWED", JSON.stringify(ng));
  const host403 = await http("POST", `/api/rooms/${R}/game/ingress`, H);
  check("the host who is not playing gets the same 403", host403.status === 403 && JSON.stringify(host403.json) === JSON.stringify(ng.json), JSON.stringify(host403));

  const one = await http("POST", `/api/rooms/${R}/game/ingress`, P);
  check("a player gets their own ingest url and stream key, not cached", one.status === 200 && typeof one.json?.url === "string" && typeof one.json?.streamKey === "string" && one.cache === "no-store", JSON.stringify([one.status, one.cache]));
  const two = await http("POST", `/api/rooms/${R}/game/ingress`, P);
  check("a second call returns the same ingress (idempotent, never a second one)", two.status === 200 && two.json.streamKey === one.json.streamKey && fake.ingresses.size === 1, JSON.stringify([fake.ingresses.size]));
  const KEY = one.json.streamKey as string;
  const inId = Array.from(fake.ingresses.values())[0].ingressId;

  check("secrecy: the key is in no server log line", !logged.some((l) => l.includes(KEY)));
  check("secrecy: the key is in no message sent to anyone in the room", !JSON.stringify(sent).includes(KEY));
  check("secrecy: the key is not in the game view (room:state / room:game)", !JSON.stringify(gameView(R)).includes(KEY));
  check("secrecy: the LiveKit call log never records it either", !JSON.stringify(fake.calls).includes(KEY));

  // removal by the host revokes it
  const rm = await handleGame(H, R, { action: "remove", targetId: P });
  check("remove: the host removes the player -> deleteIngress", rm.ok && deletes(inId) === 1, JSON.stringify(fake.calls.slice(-4)));
  const after = await http("POST", `/api/rooms/${R}/game/ingress`, P);
  check("remove: a removed player gets the same 403", after.status === 403 && JSON.stringify(after.json) === JSON.stringify(ng.json));

  // leaving revokes it
  const k2 = await http("POST", `/api/rooms/${R}/game/ingress`, P2);
  const id2 = Array.from(fake.ingresses.values()).find((i) => i.streamKey === k2.json?.streamKey)!.ingressId;
  await dropFromVoice(R, P2, true); roomHub.leave(R, P2);
  check("leave: a player who leaves -> deleteIngress", deletes(id2) === 1);

  // a ban revokes it
  const k3 = await http("POST", `/api/rooms/${R}/game/ingress`, P3);
  const id3 = Array.from(fake.ingresses.values()).find((i) => i.streamKey === k3.json?.streamKey)!.ingressId;
  await applyMod(R, "ban", P3);
  check("ban: a banned player -> deleteIngress", deletes(id3) === 1);

  // the room ending revokes whatever is left
  const P4 = await mk("player4");
  roomHub.join(R, member(P4, "guest"));
  const g2 = roomHub.gameOf(R); g2.teams.B = [P4]; g2.featured.B = P4; roomHub.setGame(R, g2);
  const k4 = await http("POST", `/api/rooms/${R}/game/ingress`, P4);
  const id4 = Array.from(fake.ingresses.values()).find((i) => i.streamKey === k4.json?.streamKey)!.ingressId;
  await endRoom(R);
  check("room end: every remaining key -> deleteIngress", deletes(id4) === 1);
  check("secrecy: still no key in any log line after all that", ![KEY, k2.json?.streamKey, k3.json?.streamKey, k4.json?.streamKey].some((k) => logged.some((l) => l.includes(k))));

  process.env.LIVEKIT_INGRESS = "0";
  const off = await http("POST", `/api/rooms/${R}/game/ingress`, P);
  check("LIVEKIT_INGRESS off: the route is not there (404)", off.status === 404, JSON.stringify(off));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.gaming = false;
  setVoiceServiceForTests(undefined);
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
