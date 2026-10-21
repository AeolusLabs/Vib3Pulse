// Rooms gaming: age lanes over REST (throwaway database):   npm run test:rooms     (usernames use the prefix gl_)
// Review Focus 2: a 16-year-old and a 30-year-old opening the same game room land in different lanes, and nothing about one
// lane (its id, count, people, reminder) ever reaches the other. Hub members are placed directly (no sockets) for counts.
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
const { runReminderPass } = await import("../server/rooms/reminders");
const { laneForAge, laneAgeLimit, resolveLaneRoom } = await import("../server/rooms/gameLanes");
const { MINORS_LANE_WARNING, MINORS_ROOM_WARNING } = await import("../shared/rooms");

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
    method, headers: { "content-type": "application/json", "x-forwarded-for": `10.32.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "x-test-user": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const mk = async (name: string, dob: string | null) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`gl_${name}${stamp}@t.dev`, `gl_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const member = (userId: string, role: "host" | "guest", age: number) => ({ userId, role, muted: false, joinedAt: Date.now(), send: () => {}, info: { username: userId }, age });

try {
  // ---------------- pure helpers
  check("laneForAge: 12 none, 13 and 17 teen, 18 adult, unknown none",
    laneForAge(12) === null && laneForAge(13) === "teen" && laneForAge(17) === "teen" && laneForAge(18) === "adult" && laneForAge(null) === null);
  check("laneAgeLimit: adult lane 18+ (21+ kept); a teen lane keeps the limit; no teen lane in an 18+ room",
    laneAgeLimit("all", "adult") === "18+" && laneAgeLimit("21+", "adult") === "21+" && laneAgeLimit("16+", "teen") === "16+" && laneAgeLimit("18+", "teen") === null);

  const A = await mk("adult_host", yearsAgo(30)), B = await mk("adult_b", yearsAgo(30)), C = await mk("adult_c", yearsAgo(40));
  const T = await mk("teen_host", yearsAgo(16)), T2 = await mk("teen_two", yearsAgo(15)), N = await mk("nodob", null);
  await mutual(A, T); await mutual(T, T2);

  // ---------------- flag off: lanes are not reachable
  roomFeatures.gaming = false;
  const offc = await http("POST", "/api/rooms", A, { title: "off", kind: "party", visibility: "public", capacity: 20, gameFormat: 2, lanes: true });
  check("flag off: lanes is ignored (one ordinary room, no lane key)", offc.status === 201 && !("lane" in offc.json) && (await q(`select count(*)::int n from rooms where parent_room_id = $1`, [offc.json.room.id]))[0].n === 0, JSON.stringify(offc.json));
  const offl = await http("POST", `/api/rooms/${offc.json.room.id}/lanes`, T, { lane: "teen" });
  check("flag off: the open-lane route answers 404", offl.status === 404, JSON.stringify(offl));
  roomFeatures.gaming = true;

  // ---------------- create: game room + the creator's lane, in one go
  const noGame = await http("POST", "/api/rooms", A, { title: "x", kind: "party", visibility: "public", capacity: 20, lanes: true });
  check("create: lanes without a game format -> 400 needs_game", noGame.status === 400 && noGame.json?.reason === "needs_game", JSON.stringify(noGame));
  const cr = await http("POST", "/api/rooms", A, { title: "Game night", kind: "party", visibility: "public", capacity: 20, gameFormat: 2, lanes: true });
  const P = cr.json?.room?.id as string, AL = cr.json?.lane?.id as string;
  check("create: 201 with the game room and the adult creator's adult lane", cr.status === 201 && !!P && !!AL && cr.json.lane.ageLane === "adult" && cr.json.lane.parentRoomId === P && cr.json.lane.ageLimit === "18+", JSON.stringify(cr.json));
  const alRow = (await q(`select minors_room, game_format, scheduled_for, age_lane from rooms where id = $1`, [AL]))[0];
  check("create: the lane is a game room of the same format, not a minors' room, with no reminder time of its own", alRow.minors_room === false && alRow.game_format === 2 && alRow.scheduled_for === null && alRow.age_lane === "adult", JSON.stringify(alRow));

  // ---------------- opening the teen lane (owner decision: a teen hosts it)
  const adultTeen = await http("POST", `/api/rooms/${P}/lanes`, B, { lane: "teen" });
  check("open lane: an adult opening the teen lane -> 403 teen_host_required", adultTeen.status === 403 && adultTeen.json?.reason === "teen_host_required", JSON.stringify(adultTeen));
  const stranger = await http("POST", `/api/rooms/${P}/lanes`, T2, { lane: "teen" });
  check("open lane: a teen who is not the host's mutual follow -> 403", stranger.status === 403, JSON.stringify(stranger));
  const pub = await http("POST", `/api/rooms/${P}/lanes`, T, { lane: "teen", visibility: "public" });
  check("open lane: a teen lane is never public -> 400", pub.status === 400 && pub.json?.field === "visibility", JSON.stringify(pub));
  const tl = await http("POST", `/api/rooms/${P}/lanes`, T, { lane: "teen" });
  const TL = tl.json?.room?.id as string;
  const tlRow = (await q(`select minors_room, host_id, age_lane, parent_room_id, visibility from rooms where id = $1`, [TL]))[0];
  check("open lane: the teen friend opens the teen lane: a minors' room they host, friends-only", tl.status === 201 && tlRow?.minors_room === true && tlRow.host_id === T && tlRow.age_lane === "teen" && tlRow.parent_room_id === P && tlRow.visibility === "friends", JSON.stringify([tl, tlRow]));
  const again = await http("POST", `/api/rooms/${P}/lanes`, T, { lane: "teen" });
  check("open lane: the same lane twice -> 409 LANE_EXISTS", again.status === 409 && again.json?.code === "LANE_EXISTS", JSON.stringify(again));
  const r18 = await http("POST", "/api/rooms", A, { title: "18 only", kind: "party", visibility: "public", ageLimit: "18+", capacity: 20, gameFormat: 1, lanes: true });
  const noTeen = await http("POST", `/api/rooms/${r18.json?.room?.id}/lanes`, T, { lane: "teen" });
  check("open lane: no teen lane in an 18+ game room", noTeen.status === 409 && noTeen.json?.reason === "age_limit", JSON.stringify(noTeen));

  // ---------------- start: the game room starts the host's own lane
  const st = await http("POST", `/api/rooms/${P}/start`, A);
  check("start: starting the game room starts the host's lane, and the game room is live", st.status === 200 && st.json?.room?.id === AL && (await q(`select status from rooms where id = $1`, [P]))[0].status === "live", JSON.stringify(st));
  const st2 = await http("POST", `/api/rooms/${TL}/start`, T);
  check("start: the teen host starts the teen lane", st2.status === 200 && (await q(`select status from rooms where id = $1`, [TL]))[0].status === "live", JSON.stringify(st2));

  // ---------------- routing at the door
  const resT = await resolveLaneRoom(P, T2), resA = await resolveLaneRoom(P, B), resN = await resolveLaneRoom(P, N);
  check("resolveLaneRoom: 15-year-old -> teen lane, 30-year-old -> adult lane, no birthdate -> NO_AGE",
    "roomId" in resT && resT.roomId === TL && "roomId" in resA && resA.roomId === AL && "refused" in resN && resN.refused === "NO_AGE", JSON.stringify([resT, resA, resN]));

  // people in each lane (hub only), so counts and peeks differ
  roomHub.join(AL, member(A, "host", 30)); roomHub.join(AL, member(B, "guest", 30)); roomHub.join(AL, member(C, "guest", 40));
  roomHub.join(TL, member(T, "host", 16));
  const gt = await http("GET", `/api/rooms/${P}`, T2), ga = await http("GET", `/api/rooms/${P}`, B);
  check("GET game room as a 15-year-old: their teen lane (lane block), never the adult lane", gt.status === 200 && gt.json?.room?.id === TL && gt.json.lane?.roomId === TL && gt.json.lane.parentRoomId === P && gt.json.lane.ageLane === "teen" && !JSON.stringify(gt.json).includes(AL), JSON.stringify(gt.json));
  check("...count and peek are the teen lane's only", gt.json?.memberCount === 1 && (gt.json.peek as any[]).every((p) => p.userId === T), JSON.stringify([gt.json?.memberCount, gt.json?.peek]));
  check("GET game room as a 30-year-old: the adult lane, never the teen lane", ga.status === 200 && ga.json?.room?.id === AL && ga.json.memberCount === 3 && !JSON.stringify(ga.json).includes(TL) && !(ga.json.peek as any[]).some((p) => p.userId === T), JSON.stringify(ga.json));
  const gn = await http("GET", `/api/rooms/${P}`, N);
  check("GET game room without a birthdate -> 403 AGE_UNKNOWN (nothing about either lane)", gn.status === 403 && gn.json?.code === "AGE_UNKNOWN" && !JSON.stringify(gn.json).includes(AL) && !JSON.stringify(gn.json).includes(TL), JSON.stringify(gn));

  // the other lane by its own id
  const teenToAdult = await http("GET", `/api/rooms/${AL}`, T2);
  check("a teen opening the adult lane by id -> 404 (no count, no people)", teenToAdult.status === 404, JSON.stringify(teenToAdult));
  const adultToTeen = await http("GET", `/api/rooms/${TL}`, B);
  check("an uninvited adult opening the teen lane by id -> 404", adultToTeen.status === 404, JSON.stringify(adultToTeen));
  await q(`insert into room_adult_invites (room_id, user_id, invited_by) values ($1,$2,$3)`, [TL, C, T]);
  const invited = await http("GET", `/api/rooms/${TL}`, C);
  check("an invited adult who has not acknowledged gets the teen-lane warning (minor or minors, recorded and investigated)",
    invited.status === 403 && invited.json?.code === "MINORS_ROOM_ACK" && invited.json.warning === MINORS_LANE_WARNING && /minor or minors/.test(MINORS_LANE_WARNING) && /recorded and investigated/.test(MINORS_LANE_WARNING), JSON.stringify(invited));
  check("the minors' room wording elsewhere is unchanged", MINORS_LANE_WARNING !== MINORS_ROOM_WARNING);
  const peekOther = await http("GET", `/api/rooms/${AL}/members/${B}/actions`, T2);
  check("profile peek: a teen asking about someone in the adult lane -> 404 (the lane does not exist for them)", peekOther.status === 404, JSON.stringify(peekOther));

  // the rooms list: the game room once, the viewer's own lane's count and people
  const lt = await http("GET", "/api/rooms?scope=live", T2), la = await http("GET", "/api/rooms?scope=live", B);
  const rowT = (lt.json?.rooms as any[] ?? []).filter((r) => r.id === P), rowA = (la.json?.rooms as any[] ?? []).filter((r) => r.id === P);
  check("list: the game room appears once and no lane is ever listed", rowT.length === 1 && rowA.length === 1 && !(lt.json.rooms as any[]).some((r) => r.id === AL || r.id === TL) && !(la.json.rooms as any[]).some((r) => r.id === AL || r.id === TL), JSON.stringify([rowT, rowA]));
  check("list: per-lane count and peek (teen sees 1 and only the teen host; adult sees 3 and no teen)",
    rowT[0]?.memberCount === 1 && rowT[0].peek.every((p: any) => p.userId === T) && rowA[0]?.memberCount === 3 && !rowA[0].peek.some((p: any) => p.userId === T), JSON.stringify([rowT[0], rowA[0]]));

  // reminders: only the game room has a reminder time; the notification names the game room only
  const cr2 = await http("POST", "/api/rooms", A, { title: "Later game", kind: "party", visibility: "public", capacity: 20, gameFormat: 1, lanes: true });
  const P2 = cr2.json.room.id as string, AL2 = cr2.json.lane.id as string;
  await http("POST", `/api/rooms/${P2}/lanes`, T, { lane: "teen" });
  await q(`update rooms set scheduled_for = now() + interval '5 minutes' where id = $1`, [P2]);
  for (const u of [T2, B]) await http("PUT", `/api/rooms/${P2}/reminder`, u);
  await runReminderPass(new Date());
  const notes = async (u: string) => q(`select title, message, link from notifications where user_id = $1 and type = 'room_starting' and related_entity_id = $2`, [u, P2]);
  const nt = await notes(T2), na = await notes(B);
  check("reminder: both ages get one notification for the game room, the same words and link, nothing about a lane",
    nt.length === 1 && na.length === 1 && nt[0].title === na[0].title && nt[0].link === `/rooms/${P2}` && na[0].link === `/rooms/${P2}` && !JSON.stringify([nt, na]).includes(AL2), JSON.stringify([nt, na]));
  check("reminder: lanes are never claimed for a reminder of their own", (await q(`select count(*)::int n from rooms where parent_room_id = $1 and reminder_notified_at is not null`, [P2]))[0].n === 0);

  // ending: the game room ends with its lanes
  const end = await http("POST", `/api/rooms/${P}/end`, A);
  const statuses = (await q(`select id, status from rooms where id = any($1)`, [[P, AL, TL]])).map((r) => r.status);
  check("end: ending the game room ends every lane", end.status === 200 && statuses.every((s) => s === "ended"), JSON.stringify([end.status, statuses]));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.gaming = false;
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
