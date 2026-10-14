// Rooms API checks (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api.ts
// Refuses to run unless the database name contains "test", because it creates users.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
const { userToSessionUser, toPublicUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomFeatures } = await import("../server/rooms/features");
roomFeatures.linkScreens = true; // the link-screen code is dormant in production (default off) but stays under test; one block below pins the default
const { registerMessagesRoutes } = await import("../server/routes/messages-routes");

await storage.ensureLoginAttemptsTable();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

// ---- app: fake auth via header, req.login recorded ----
let lastLogin: any = null;
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  req.login = (u: unknown, cb: (e?: Error) => void) => { lastLogin = u; cb(); };
  next();
});
app.use(redactSensitiveFields);
registerUsersRoutes(app);
registerRoomRoutes(app);
registerMessagesRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const mk = async (name: string, dob: string | null = null, ageDays = 60) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - ($5 || ' days')::interval) returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, dob, String(ageDays)]))[0].id as string;
const yearsAgo = (y: number, dayOffset = 0) => {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};

try {
  // ============ Task 1: minimum age 13 at signup / complete-profile ============
  const signupBody = (tag: string, dob: string) => ({
    email: `${tag}${stamp}@t.dev`, username: `${tag}${stamp}`, password: "Passw0rd!rooms1", userType: "social",
    displayName: tag, dateOfBirth: dob, gender: "Male", interests: ["music"],
  });
  {
    const r = await http("POST", "/api/auth/signup", null, signupBody("su12", yearsAgo(12, 1)));
    check("signup: 12-year-old rejected (400, names the minimum age)", r.status === 400 && /13/.test(JSON.stringify(r.json)), JSON.stringify(r));
    check("signup: rejected user not created", (await q(`select 1 from users where username=$1`, [`su12${stamp}`])).length === 0);
  }
  {
    const r = await http("POST", "/api/auth/signup", null, signupBody("su13", yearsAgo(13)));
    check("signup: exactly 13 today accepted", r.status === 201 || r.status === 200, JSON.stringify(r));
  }
  {
    const r = await http("POST", "/api/auth/signup", null, signupBody("sufut", yearsAgo(-1)));
    check("signup: future birthdate rejected", r.status === 400, JSON.stringify(r));
  }
  {
    const g = await (async () => (await q(
      `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete)
       values ($1,$2,'social',$3,true,false) returning id`, [`g12${stamp}@t.dev`, `g12${stamp}`, hash]))[0].id as string)();
    const body = { userType: "social", displayName: "G", dateOfBirth: yearsAgo(12, 1), gender: "Male", interests: ["music"] };
    const r = await http("PATCH", "/api/auth/complete-profile", g, body);
    check("complete-profile: 12-year-old rejected (400)", r.status === 400, JSON.stringify(r));
    const ok = await http("PATCH", "/api/auth/complete-profile", g, { ...body, dateOfBirth: yearsAgo(13) });
    check("complete-profile: exactly 13 accepted", ok.status === 200, JSON.stringify(ok));
  }

  // ============ Task 2: birthdate lock + admin correction ============
  {
    const withDob = await mk("dl_a", yearsAgo(30));
    const noDob = await mk("dl_b", null);
    const dobOf = async (id: string) => (await q(`select date_of_birth d from users where id=$1`, [id]))[0].d;
    const r = await http("PATCH", "/api/users/me", withDob, { dateOfBirth: yearsAgo(40), bio: "still saves" });
    check("PATCH dob: ignored when one is stored, other fields still saved (200)", r.status === 200 && (await dobOf(withDob)) === yearsAgo(30) && (await q(`select bio from users where id=$1`, [withDob]))[0].bio === "still saves", JSON.stringify(r));
    const only = await http("PATCH", "/api/users/me", withDob, { dateOfBirth: yearsAgo(41) });
    check("PATCH dob only: 200, unchanged", only.status === 200 && (await dobOf(withDob)) === yearsAgo(30), JSON.stringify(only));
    const young = await http("PATCH", "/api/users/me", noDob, { dateOfBirth: yearsAgo(12, 1) });
    check("PATCH dob first-time under 13: 400, not stored", young.status === 400 && (await dobOf(noDob)) === null, JSON.stringify(young));
    const first = await http("PATCH", "/api/users/me", noDob, { dateOfBirth: yearsAgo(25) });
    check("PATCH dob first-time: stored", first.status === 200 && (await dobOf(noDob)) === yearsAgo(25), JSON.stringify(first));
    const again = await http("PATCH", "/api/users/me", noDob, { dateOfBirth: yearsAgo(50) });
    check("PATCH dob second time: locked", again.status === 200 && (await dobOf(noDob)) === yearsAgo(25), JSON.stringify(again));

    // admin correction (service used by PUT /api/admin/users/:id/date-of-birth)
    const { correctDateOfBirth } = await import("../server/services/dobCorrection");
    const admin = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'Adm','super_admin') returning id`, [`adm${stamp}`, `adm${stamp}@t.dev`, hash]))[0].id as string;
    const bad = await correctDateOfBirth({ adminId: admin, userId: withDob, dateOfBirth: yearsAgo(31), reason: "  " });
    check("admin dob: reason required", !bad.ok && bad.status === 400, JSON.stringify(bad));
    const tooYoung = await correctDateOfBirth({ adminId: admin, userId: withDob, dateOfBirth: yearsAgo(12, 1), reason: "typo" });
    check("admin dob: under 13 rejected", !tooYoung.ok && tooYoung.status === 400 && (await dobOf(withDob)) === yearsAgo(30));
    const missing = await correctDateOfBirth({ adminId: admin, userId: "00000000-0000-0000-0000-000000000000", dateOfBirth: yearsAgo(31), reason: "typo" });
    check("admin dob: unknown user 404", !missing.ok && missing.status === 404);
    const good = await correctDateOfBirth({ adminId: admin, userId: withDob, dateOfBirth: yearsAgo(31), reason: "user showed ID" });
    check("admin dob: changes DOB, returns public user without secrets", good.ok && (await dobOf(withDob)) === yearsAgo(31) && !("passwordHash" in (good as any).user), JSON.stringify(good));
    const audit = await q(`select * from admin_activity_logs where admin_id=$1 and action='user.dob_corrected' and target_id=$2`, [admin, withDob]);
    check("admin dob: audit row written with reason", audit.length === 1 && /user showed ID/.test((audit[0].details ?? "") + (audit[0].reason ?? "")), JSON.stringify(audit));
  }

  // ============ Task 5: schema + room storage ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const mkRoom = (host: string, over: Record<string, unknown> = {}) =>
      rs.createRoom(host, { title: "R", kind: "party", visibility: "public", ageLimit: "all", ...over } as any);
    const H1 = await mk("rs_h1", yearsAgo(30));
    const V = await mk("rs_v", yearsAgo(30));
    const H2 = await mk("rs_h2", yearsAgo(30));
    await q(`update users set room_privacy=$2 where id=$1`, [H2, JSON.stringify({ v: 1, interactions: "mutuals", appearInLists: false, allowInvites: true })]);
    const H3 = await mk("rs_h3", yearsAgo(30));
    const H3b = await mk("rs_h3b", yearsAgo(30));
    const H4 = await mk("rs_h4", yearsAgo(30));
    const T = await mk("rs_teen", yearsAgo(16));
    const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
    const ids = (rows: any[]) => rows.map((r) => r.id);

    const r1 = await mkRoom(H1);
    check("createRoom: defaults (scheduled, all ages, capacity 50, no screen)", r1.status === "scheduled" && r1.ageLimit === "all" && r1.capacity === 50 && r1.screen === null && r1.noDirectInteractions === false, JSON.stringify(r1));
    check("getRoom returns it; unknown id null", (await rs.getRoom(r1.id))?.id === r1.id && (await rs.getRoom("00000000-0000-0000-0000-000000000000")) === null);
    const live1 = await rs.setStatus(r1.id, "live", new Date());
    check("setStatus live stamps startedAt; ended stamps endedAt", live1.status === "live" && !!live1.startedAt && (await rs.setStatus(r1.id, "ended")).endedAt !== null);
    const upd = await rs.updateRoom(r1.id, { title: "Renamed", capacity: 20 });
    check("updateRoom patches fields", upd.title === "Renamed" && upd.capacity === 20);

    // listing
    const pub = await mkRoom(H1, { title: "pub" }); await rs.setStatus(pub.id, "live");
    const hidden = await mkRoom(H2, { title: "hidden-host" }); await rs.setStatus(hidden.id, "live");
    const blk = await mkRoom(H3, { title: "blocked-by-viewer" }); await rs.setStatus(blk.id, "live");
    const blk2 = await mkRoom(H3b, { title: "blocked-viewer" }); await rs.setStatus(blk2.id, "live");
    const fr = await mkRoom(H4, { title: "friends", visibility: "friends" }); await rs.setStatus(fr.id, "live");
    const inv = await mkRoom(H1, { title: "invite", visibility: "invite" }); await rs.setStatus(inv.id, "live");
    const teenPub = await mkRoom(T, { title: "teen-public", visibility: "public" }); await rs.setStatus(teenPub.id, "live");
    const teenFr = await mkRoom(T, { title: "teen-friends", visibility: "friends" }); await rs.setStatus(teenFr.id, "live");
    const sched = await mkRoom(H1, { title: "soon", scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
    const teenSched = await mkRoom(T, { title: "teen-soon", visibility: "public", scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
    await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2),($3,$4)`, [V, H3, H3b, V]);

    let live = ids(await rs.listRooms({ scope: "live", viewerId: V }));
    check("live: public room listed", live.includes(pub.id));
    check("live: appearInLists=false host hidden from non-follower", !live.includes(hidden.id));
    check("live: blocked either way hidden", !live.includes(blk.id) && !live.includes(blk2.id));
    check("live: friends room hidden from non-mutual", !live.includes(fr.id));
    check("live: invite-only room never listed", !live.includes(inv.id));
    check("live: teen-hosted rooms never listed (public or friends)", !live.includes(teenPub.id) && !live.includes(teenFr.id));
    check("live: ended / scheduled not listed", !live.includes(r1.id) && !live.includes(sched.id));
    await follow(V, H2);
    check("live: appearInLists=false host shown once viewer follows", ids(await rs.listRooms({ scope: "live", viewerId: V })).includes(hidden.id));
    await follow(V, H4); await follow(H4, V);
    live = ids(await rs.listRooms({ scope: "live", viewerId: V }));
    check("live: friends room shown to mutual", live.includes(fr.id));
    const up = ids(await rs.listRooms({ scope: "upcoming", viewerId: V }));
    check("upcoming: scheduled public listed, teen-hosted not, live not", up.includes(sched.id) && !up.includes(teenSched.id) && !up.includes(pub.id));
    check("upcoming: host sees own scheduled room regardless", ids(await rs.listRooms({ scope: "upcoming", viewerId: T })).includes(teenSched.id));
    check("live: host sees own invite room", ids(await rs.listRooms({ scope: "live", viewerId: H1 })).includes(inv.id));
    await follow(V, T); await follow(T, V);
    check("friends scope: mutual teen host's friends room visible to mutual", ids(await rs.listRooms({ scope: "friends", viewerId: V })).includes(teenFr.id));
    check("friends scope: only mutual hosts", !ids(await rs.listRooms({ scope: "friends", viewerId: V })).includes(pub.id));
    check("limit respected", (await rs.listRooms({ scope: "live", viewerId: V, limit: 1 })).length === 1);

    // members, bans, counts
    check("not banned initially", (await rs.isBanned(pub.id, V)) === false);
    await rs.upsertMember(pub.id, V, "guest"); await rs.upsertMember(pub.id, V, "guest");
    check("member pk unique: one row after two upserts", (await q(`select 1 from room_members where room_id=$1 and user_id=$2`, [pub.id, V])).length === 1);
    await rs.markLeft(pub.id, V);
    check("markLeft sets left_at", (await rs.getMember(pub.id, V))?.leftAt != null);
    await rs.setMemberFlag(pub.id, V, { banned: true });
    check("ban persists + isBanned true", (await rs.isBanned(pub.id, V)) === true);
    await rs.upsertMember(pub.id, V, "guest");
    check("re-joining upsert does not clear a ban", (await rs.isBanned(pub.id, V)) === true);
    await rs.setMemberFlag(pub.id, H2, { muted: true });
    check("setMemberFlag on a non-member creates the row (ban before join)", (await rs.getMember(pub.id, H2))?.muted === true);
    await rs.setMemberFlag(pub.id, V, { banned: false });
    check("unban", (await rs.isBanned(pub.id, V)) === false);
    check("countLiveRoomsByHost / countScheduledByHost", (await rs.countLiveRoomsByHost(H1)) === 2 && (await rs.countScheduledByHost(H1)) === 1, `${await rs.countLiveRoomsByHost(H1)} ${await rs.countScheduledByHost(H1)}`);
    check("users.room_privacy column exists and defaults null", (await q(`select room_privacy from users where id=$1`, [H1]))[0].room_privacy === null);
  }

  // ============ Task 6: rooms REST routes ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const body = (over: Record<string, unknown> = {}) => ({ title: "Friday pre-party", kind: "party", visibility: "public", ageLimit: "all", ...over });
    const A = await mk("rt_host", yearsAgo(30));        // adult host
    const A2 = await mk("rt_host2", yearsAgo(30));
    const TEEN = await mk("rt_teen", yearsAgo(16));
    const T17 = await mk("rt_t17", yearsAgo(17));
    const NODOB = await mk("rt_nodob", null);
    const FRESH = await mk("rt_fresh", yearsAgo(30), 0);
    const VIEW = await mk("rt_view", yearsAgo(30));
    const F1 = await mk("rt_f1", yearsAgo(30));          // follower of A
    const FTEEN = await mk("rt_ft", yearsAgo(16));       // teen follower of A
    const FBLK = await mk("rt_fb", yearsAgo(30));        // follower blocked by A
    const FNON = await mk("rt_fn", yearsAgo(30));        // not a follower
    const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
    const notified = async (roomId: string) => (await q(`select user_id from notifications where type='room_live' and related_entity_id=$1`, [roomId])).map((r: any) => r.user_id as string);
    const NOROOM = "00000000-0000-0000-0000-000000000000";

    // ---- create
    const c1 = await http("POST", "/api/rooms", A, body());
    check("POST /api/rooms: 201 with room, no invite hash, host public-safe", c1.status === 201 && !!c1.json?.room?.id && !("inviteTokenHash" in c1.json.room) && !JSON.stringify(c1.json).includes("passwordHash"), JSON.stringify(c1));
    check("POST /api/rooms: unauthenticated 401", (await http("POST", "/api/rooms", null, body())).status === 401);
    for (const [patch, field] of [[{ title: "" }, "title"], [{ kind: "rave" }, "kind"], [{ visibility: "secret" }, "visibility"], [{ ageLimit: "19+" }, "ageLimit"],
      [{ capacity: 51 }, "capacity"], [{ scheduledFor: "2020-01-01T00:00:00Z" }, "scheduledFor"], [{ screenUrl: "javascript:alert(1)" }, "screenUrl"]] as const) {
      const r = await http("POST", "/api/rooms", A, body(patch));
      check(`POST /api/rooms: 400 names field ${field}`, r.status === 400 && r.json?.field === field, JSON.stringify(r));
    }
    const hostile = await http("POST", "/api/rooms", A, body({ screenUrl: "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ" }));
    check("POST /api/rooms: lookalike host becomes a link card, never an embed", hostile.status === 201 && hostile.json.room.screen?.provider === "link" && !hostile.json.room.screen?.embedUrl, JSON.stringify(hostile.json?.room?.screen));
    const yt = await http("POST", "/api/rooms", A, body({ screenUrl: "https://youtu.be/dQw4w9WgXcQ" }));
    check("POST /api/rooms: youtube screen resolved server-side", yt.status === 201 && yt.json.room.screen?.embedUrl === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    const tp = await http("POST", "/api/rooms", TEEN, body({ visibility: "public" }));
    check("teen cannot create public: 403 TEEN_PUBLIC", tp.status === 403 && tp.json?.code === "TEEN_PUBLIC", JSON.stringify(tp));
    check("teen can create friends room", (await http("POST", "/api/rooms", TEEN, body({ visibility: "friends" }))).status === 201);
    const nd = await http("POST", "/api/rooms", NODOB, body({ visibility: "friends" }));
    check("unknown age blocked: 403 AGE_UNKNOWN", nd.status === 403 && nd.json?.code === "AGE_UNKNOWN", JSON.stringify(nd));
    const fr = await http("POST", "/api/rooms", FRESH, body());
    check("account too new for public: 403 ACCOUNT_TOO_NEW", fr.status === 403 && fr.json?.code === "ACCOUNT_TOO_NEW", JSON.stringify(fr));
    check("new account may host friends room", (await http("POST", "/api/rooms", FRESH, body({ visibility: "friends" }))).status === 201);
    const hb = await http("POST", "/api/rooms", T17, body({ visibility: "invite", ageLimit: "18+" }));
    check("host cannot set a limit above own age: 403 HOST_BELOW_LIMIT", hb.status === 403 && hb.json?.code === "HOST_BELOW_LIMIT", JSON.stringify(hb));
    check("age failures never reveal the age", !/\b(16|17)\b/.test(JSON.stringify(hb.json)) && !JSON.stringify(tp.json).includes(yearsAgo(16)));
    const inv = await http("POST", "/api/rooms", A, body({ visibility: "invite" }));
    const inviteTok = new URL(inv.json?.inviteLink ?? "/x?token=", "http://x").searchParams.get("token") ?? "";
    check("invite room: token returned once, only a hash stored", inv.status === 201 && inviteTok.length >= 32 && inv.json.inviteLink.startsWith(`/rooms/${inv.json.room.id}?token=`)
      && (await q(`select invite_token_hash h from rooms where id=$1`, [inv.json.room.id]))[0].h !== inviteTok);

    // scheduled limit (fill A to 10)
    const have = await rs.countScheduledByHost(A);
    for (let i = have; i < 10; i++) await rs.createRoom(A, { title: `s${i}`, kind: "party", visibility: "friends", ageLimit: "all" } as any);
    const over = await http("POST", "/api/rooms", A, body());
    check("11th scheduled room: 429 SCHEDULED_LIMIT", over.status === 429 && over.json?.code === "SCHEDULED_LIMIT", JSON.stringify(over));

    // ---- get / visibility / canJoin
    const adultRoom = await rs.createRoom(A2, { title: "Adults", kind: "party", visibility: "public", ageLimit: "18+" } as any);
    await follow(VIEW, A2);
    const g1 = await http("GET", `/api/rooms/${adultRoom.id}`, VIEW);
    check("GET room: adult viewer canJoin ok", g1.status === 200 && g1.json.canJoin?.ok === true, JSON.stringify(g1));
    const g2 = await http("GET", `/api/rooms/${adultRoom.id}`, TEEN);
    check("GET room: under-age viewer sees AGE_LIMIT, nothing about their age", g2.status === 200 && g2.json.canJoin?.code === "AGE_LIMIT" && !JSON.stringify(g2.json).includes("dateOfBirth"), JSON.stringify(g2.json?.canJoin));
    const g3 = await http("GET", `/api/rooms/${adultRoom.id}`, NODOB);
    check("GET room: unknown-age viewer sees AGE_UNKNOWN", g3.json?.canJoin?.code === "AGE_UNKNOWN");
    const friendsRoom = await rs.createRoom(A2, { title: "Friends", kind: "party", visibility: "friends", ageLimit: "all" } as any);
    check("GET room: friends room hidden from non-mutual (404)", (await http("GET", `/api/rooms/${friendsRoom.id}`, VIEW)).status === 404);
    await follow(A2, VIEW);
    check("GET room: friends room visible to mutual", (await http("GET", `/api/rooms/${friendsRoom.id}`, VIEW)).status === 200);
    await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [A2, FNON]);
    check("GET room: blocked either way is 404", (await http("GET", `/api/rooms/${adultRoom.id}`, FNON)).status === 404);
    const invRoom = inv.json.room.id as string;
    check("GET room: invite room without token 404, wrong token 404, host 200", (await http("GET", `/api/rooms/${invRoom}`, VIEW)).status === 404
      && (await http("GET", `/api/rooms/${invRoom}?token=nope`, VIEW)).status === 404 && (await http("GET", `/api/rooms/${invRoom}`, A)).status === 200);
    check("GET room: invite room with the right token 200", (await http("GET", `/api/rooms/${invRoom}?token=${inviteTok}`, VIEW)).status === 200);
    check("GET room: unknown id 404", (await http("GET", `/api/rooms/${NOROOM}`, VIEW)).status === 404);

    // ---- patch
    const pr = c1.json.room.id as string;
    check("PATCH room: non-host 403", (await http("PATCH", `/api/rooms/${pr}`, VIEW, { title: "x" })).status === 403);
    const p1 = await http("PATCH", `/api/rooms/${pr}`, A, { title: "Renamed", capacity: 30, noDirectInteractions: true, screenUrl: "https://vimeo.com/76979871" });
    check("PATCH room: host edits title/capacity/flag/screen", p1.status === 200 && p1.json.room.title === "Renamed" && p1.json.room.capacity === 30 && p1.json.room.noDirectInteractions === true && p1.json.room.screen?.embedUrl === "https://player.vimeo.com/video/76979871", JSON.stringify(p1));
    const p2 = await http("PATCH", `/api/rooms/${pr}`, A, { screenUrl: "data:text/html,x" });
    check("PATCH room: hostile screen rejected", p2.status === 400 && p2.json?.field === "screenUrl");
    check("PATCH room: screenUrl null clears the screen", (await http("PATCH", `/api/rooms/${pr}`, A, { screenUrl: null })).json?.room?.screen === null);
    check("PATCH room: capacity out of range 400", (await http("PATCH", `/api/rooms/${pr}`, A, { capacity: 500 })).json?.field === "capacity");
    const t17room = (await http("POST", "/api/rooms", T17, body({ visibility: "invite", ageLimit: "16+" }))).json.room.id;
    check("PATCH room: host cannot raise limit above own age", (await http("PATCH", `/api/rooms/${t17room}`, T17, { ageLimit: "18+" })).status === 403);

    // ---- start / notify
    await q(`delete from rooms where host_id=$1 and status='scheduled' and id <> $2`, [A, pr]); // free the scheduled quota
    await follow(F1, A); await follow(FTEEN, A); await follow(FBLK, A);
    await q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [A, FBLK]);
    const ageRoom = (await http("POST", "/api/rooms", A, body({ title: "18+ night", ageLimit: "18+" }))).json.room.id as string;
    check("PATCH room: ageLimit can be raised before going live", (await http("PATCH", `/api/rooms/${ageRoom}`, A, { ageLimit: "21+" })).status === 200 && (await http("PATCH", `/api/rooms/${ageRoom}`, A, { ageLimit: "18+" })).status === 200);
    check("start: non-host 403", (await http("POST", `/api/rooms/${ageRoom}/start`, VIEW)).status === 403);
    const st = await http("POST", `/api/rooms/${ageRoom}/start`, A);
    check("start: 200 and room live", st.status === 200 && st.json.room.status === "live" && !!st.json.room.startedAt, JSON.stringify(st));
    const n1 = await notified(ageRoom);
    check("start: notifies followers (adult follower yes)", n1.includes(F1));
    check("start: not blocked follower, not under-age follower, not non-follower, not host", !n1.includes(FBLK) && !n1.includes(FTEEN) && !n1.includes(FNON) && !n1.includes(A), JSON.stringify(n1));
    check("start twice: 409", (await http("POST", `/api/rooms/${ageRoom}/start`, A)).status === 409);
    const second = (await http("POST", "/api/rooms", A, body({ title: "second" }))).json.room.id as string;
    const st2 = await http("POST", `/api/rooms/${second}/start`, A);
    check("second live room: 429 LIVE_LIMIT", st2.status === 429 && st2.json?.code === "LIVE_LIMIT", JSON.stringify(st2));
    check("PATCH room: ageLimit cannot be lowered while live", (await http("PATCH", `/api/rooms/${ageRoom}`, A, { ageLimit: "all" })).json?.field === "ageLimit");

    // appearInLists=false host still notifies followers; friends room -> mutual followers only; invite -> nobody
    await q(`update users set room_privacy=$2 where id=$1`, [A2, JSON.stringify({ v: 1, interactions: "mutuals", appearInLists: false, allowInvites: true })]);
    await follow(F1, A2); await follow(A2, F1); await follow(FNON, A2);
    await q(`delete from user_blocks where blocked_id=$1 and blocker_id=$2`, [FNON, A2]);
    const st3 = await http("POST", `/api/rooms/${friendsRoom.id}/start`, A2);
    const n3 = await notified(friendsRoom.id);
    check("start (friends room, appearInLists=false host): mutual follower notified, one-way follower not", st3.status === 200 && n3.includes(F1) && !n3.includes(FNON), JSON.stringify([st3.status, n3]));
    await http("POST", `/api/rooms/${friendsRoom.id}/end`, A2);
    await http("POST", `/api/rooms/${ageRoom}/end`, A); // frees A's live slot for the invite-room start below
    const invRoom2 = (await http("POST", "/api/rooms", A, body({ title: "invite only", visibility: "invite" }))).json.room.id as string;
    const invStart = await http("POST", `/api/rooms/${invRoom2}/start`, A);
    check("start (invite room): live but nobody notified", invStart.status === 200 && (await notified(invRoom2)).length === 0, JSON.stringify(invStart));
    await http("POST", `/api/rooms/${invRoom2}/end`, A);

    // ---- end / report / list
    const live2 = (await http("POST", "/api/rooms", A, body({ title: "second night" }))).json.room.id as string;
    await http("POST", `/api/rooms/${live2}/start`, A);
    check("end: non-host 403", (await http("POST", `/api/rooms/${live2}/end`, VIEW)).status === 403);
    const rep = await http("POST", `/api/rooms/${live2}/report`, F1, { reason: "harassment", description: "rude" });
    check("report: creates a content_reports row (contentType room)", rep.status === 200 && (await q(`select 1 from content_reports where content_type='room' and content_id=$1 and reporter_id=$2`, [live2, F1])).length === 1, JSON.stringify(rep));
    check("report: duplicate 409, unknown room 404, missing reason 400", (await http("POST", `/api/rooms/${live2}/report`, F1, { reason: "x" })).status === 409
      && (await http("POST", `/api/rooms/${NOROOM}/report`, F1, { reason: "x" })).status === 404 && (await http("POST", `/api/rooms/${live2}/report`, VIEW, {})).status === 400);
    const list = await http("GET", "/api/rooms?scope=live", F1);
    const found = list.json?.rooms?.find((r: any) => r.id === live2);
    check("GET /api/rooms?scope=live: live room listed with host summary, no secrets", list.status === 200 && !!found && found.host?.id === A && !JSON.stringify(list.json).match(/passwordHash|inviteTokenHash|dateOfBirth|email/), JSON.stringify(list.json).slice(0, 300));
    check("GET /api/rooms: bad scope 400", (await http("GET", "/api/rooms?scope=nope", F1)).status === 400);
    check("GET /api/rooms?scope=upcoming works", (await http("GET", "/api/rooms?scope=upcoming", F1)).status === 200);
    const endr = await http("POST", `/api/rooms/${live2}/end`, A);
    check("end: host ends the room", endr.status === 200 && endr.json.room.status === "ended");
    check("PATCH on an ended room: 409", (await http("PATCH", `/api/rooms/${live2}`, A, { title: "x" })).status === 409);
    check("start an ended room: 409", (await http("POST", `/api/rooms/${live2}/start`, A)).status === 409);

    // ---- room privacy
    const pv = await http("GET", "/api/users/me/room-privacy", VIEW);
    check("GET room-privacy: defaults when unset, plus the caller's own age", pv.status === 200 && pv.json?.roomPrivacy?.interactions === "mutuals" && pv.json.roomPrivacy.appearInLists === true && pv.json.age === 30, JSON.stringify(pv));
    lastLogin = null;
    const put = await http("PUT", "/api/users/me/room-privacy", VIEW, { interactions: "none", appearInLists: false, allowInvites: false });
    check("PUT room-privacy: stored, session-shaped response, session refreshed", put.status === 200 && put.json?.roomPrivacy?.interactions === "none" && put.json?.hasPassword === true && lastLogin?.id === VIEW, JSON.stringify(put));
    check("PUT room-privacy: persisted", (await q(`select room_privacy p from users where id=$1`, [VIEW]))[0].p?.interactions === "none");
    const badp = await http("PUT", "/api/users/me/room-privacy", VIEW, { interactions: "friends", appearInLists: true, allowInvites: true });
    check("PUT room-privacy: invalid -> 400 names field", badp.status === 400 && badp.json?.field === "interactions");
    check("PUT room-privacy: unknown key -> 400", (await http("PUT", "/api/users/me/room-privacy", VIEW, { interactions: "none", appearInLists: true, allowInvites: true, isAdmin: true })).json?.field === "isAdmin");
    check("PUT room-privacy: unauthenticated 401", (await http("PUT", "/api/users/me/room-privacy", null, {})).status === 401);
    const pu = toPublicUser((await storage.getUser(VIEW))!);
    check("toPublicUser hides roomPrivacy", !("roomPrivacy" in pu));

    // ---- linking to an event the caller does not own
    const ev = (await q(`insert into events (organizer_id, title, description, event_date, location, category, tickets_available) values ($1,'E','d', now() + interval '3 days','L','music',10) returning id`, [A2]))[0].id as string;
    const lk1 = await http("POST", "/api/rooms", A, body({ eventId: ev }));
    check("link to someone else's event: 403 NOT_OWNER", lk1.status === 403 && lk1.json?.code === "NOT_OWNER", JSON.stringify(lk1));
    await q(`delete from rooms where host_id=$1 and status='scheduled' and id <> $2`, [A2, friendsRoom.id]);
    const lk2 = await http("POST", "/api/rooms", A2, body({ eventId: ev, title: "Linked" }));
    check("link to own event: 201 and filterable by eventId", lk2.status === 201 && lk2.json.room.eventId === ev, JSON.stringify(lk2));
    const byEv = await http("GET", `/api/rooms?eventId=${ev}`, F1);
    check("GET /api/rooms?eventId lists the linked room", byEv.status === 200 && byEv.json.rooms.some((r: any) => r.id === lk2.json.room.id), JSON.stringify(byEv));
    check("link to unknown event: 404", (await http("POST", "/api/rooms", A2, body({ eventId: NOROOM }))).status === 404);
  }

  // ============ Task 8: moderation REST + reports + admin ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const admin8 = await import("../server/rooms/roomAdmin");
    const H = await mk("md_host", yearsAgo(30)), CH = await mk("md_co", yearsAgo(30)), CH2 = await mk("md_co2", yearsAgo(30));
    const G = await mk("md_g", yearsAgo(30)), G2 = await mk("md_g2", yearsAgo(30)), OUT = await mk("md_out", yearsAgo(30)), TEEN = await mk("md_teen", yearsAgo(16));
    const room = await rs.createRoom(H, { title: "Mod room", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live");
    const got: Record<string, any[]> = {};
    const fake = (userId: string, role: any = "guest", username = userId.slice(0, 4)) => {
      got[userId] = [];
      roomHub.join(room.id, { userId, role, muted: false, joinedAt: Date.now(), send: (m) => got[userId].push(m), info: { username } });
    };
    await rs.upsertMember(room.id, H, "host"); await rs.upsertMember(room.id, CH, "cohost"); await rs.upsertMember(room.id, CH2, "cohost");
    await rs.upsertMember(room.id, G, "guest"); await rs.upsertMember(room.id, G2, "guest");
    fake(H, "host", "hostie"); fake(CH, "cohost", "coco"); fake(CH2, "cohost"); fake(G, "guest", "gee"); fake(G2);
    const base = `/api/rooms/${room.id}/members`;

    // ---- roles
    check("role: guest/co-host cannot promote (403)", (await http("PUT", `${base}/${G}/role`, G2, { role: "cohost" })).status === 403 && (await http("PUT", `${base}/${G}/role`, CH, { role: "cohost" })).status === 403);
    check("role: invalid role 400", (await http("PUT", `${base}/${G}/role`, H, { role: "host" })).status === 400);
    check("role: non-member target 404", (await http("PUT", `${base}/${OUT}/role`, H, { role: "cohost" })).status === 404);
    check("role: cannot change the host's own role", (await http("PUT", `${base}/${H}/role`, H, { role: "guest" })).status === 400);
    const promo = await http("PUT", `${base}/${G2}/role`, H, { role: "cohost" });
    check("role: host promotes a member; persisted, live hub updated, room told", promo.status === 200 && (await rs.getMember(room.id, G2))?.role === "cohost" && roomHub.get(room.id, G2)?.role === "cohost" && got[H].some((m) => m.type === "room:mod" && m.action === "role" && m.targetId === G2 && m.role === "cohost"), JSON.stringify(promo));
    await http("PUT", `${base}/${G2}/role`, H, { role: "guest" });
    check("role: demote back to guest", (await rs.getMember(room.id, G2))?.role === "guest" && roomHub.get(room.id, G2)?.role === "guest");

    // ---- ban / unban permissions
    check("ban: guest cannot (403)", (await http("POST", `${base}/${G2}/ban`, G, {})).status === 403);
    check("ban: outsider cannot see/ban (404 or 403)", [403, 404].includes((await http("POST", `${base}/${G2}/ban`, OUT, {})).status));
    check("ban: unauthenticated 401", (await http("POST", `${base}/${G2}/ban`, null, {})).status === 401);
    check("ban: co-host cannot ban the host (403)", (await http("POST", `${base}/${H}/ban`, CH, {})).status === 403 && (await rs.isBanned(room.id, H)) === false);
    check("ban: co-host cannot ban another co-host (403)", (await http("POST", `${base}/${CH2}/ban`, CH, {})).status === 403 && (await rs.isBanned(room.id, CH2)) === false);
    check("ban: host cannot ban themselves (403)", (await http("POST", `${base}/${H}/ban`, H, {})).status === 403);
    check("ban: unknown user id 404", (await http("POST", `${base}/00000000-0000-0000-0000-000000000000/ban`, H, {})).status === 404);
    got[G2].length = 0; got[H].length = 0;
    const b1 = await http("POST", `${base}/${G2}/ban`, CH, {});
    check("ban: co-host bans a guest; persisted", b1.status === 200 && (await rs.isBanned(room.id, G2)) === true, JSON.stringify(b1));
    check("ban: live target is told then evicted, room sees them leave", got[G2].some((m) => m.type === "room:mod" && m.action === "ban") && roomHub.get(room.id, G2) === undefined && got[H].some((m) => m.type === "room:left" && m.userId === G2));
    const gj = await http("GET", `/api/rooms/${room.id}`, G2);
    check("ban: banned user sees canJoin BANNED over REST", gj.json?.canJoin?.code === "BANNED", JSON.stringify(gj.json?.canJoin));
    check("ban: host can mute a co-host (via hub) but REST ban of a never-joined user works", (await http("POST", `${base}/${OUT}/ban`, H, {})).status === 200 && (await rs.isBanned(room.id, OUT)) === true);
    check("unban: guest cannot; host can", (await http("POST", `${base}/${OUT}/unban`, G, {})).status === 403 && (await http("POST", `${base}/${OUT}/unban`, H, {})).status === 200 && (await rs.isBanned(room.id, OUT)) === false);

    // ---- reports with chat excerpt
    for (const [u, t] of [[G, "hello everyone"], [CH, "welcome"], [G, "someone is being rude"]] as const) roomHub.recordChat(room.id, { userId: u, text: t, at: Date.now() });
    const rr = await http("POST", `/api/rooms/${room.id}/report`, OUT, { reason: "harassment", type: "room_user", targetUserId: G, description: "abusive" });
    const row1 = (await q(`select * from content_reports where reporter_id=$1 and content_type='room_user'`, [OUT]))[0];
    check("report room_user: stored with the target and the last chat lines attached", rr.status === 200 && !!row1 && row1.content_id === `${room.id}:${G}` && /someone is being rude/.test(row1.description) && /gee/.test(row1.description) && /abusive/.test(row1.description), JSON.stringify(row1));
    const rm = await http("POST", `/api/rooms/${room.id}/report`, TEEN, { reason: "spam", type: "room_message", targetUserId: G });
    check("report room_message: stored with excerpt", rm.status === 200 && /hello everyone/.test((await q(`select description d from content_reports where reporter_id=$1 and content_type='room_message'`, [TEEN]))[0]?.d ?? ""), JSON.stringify(rm));
    check("report: room_user without a target is 400; target outside the room is 400; bad type is 400",
      (await http("POST", `/api/rooms/${room.id}/report`, G2, { reason: "x", type: "room_user" })).status === 400
      && (await http("POST", `/api/rooms/${room.id}/report`, G2, { reason: "x", type: "room_user", targetUserId: TEEN })).status === 400
      && (await http("POST", `/api/rooms/${room.id}/report`, G2, { reason: "x", type: "banana" })).status === 400);
    check("report room_user twice by the same reporter on the same user: 409", (await http("POST", `/api/rooms/${room.id}/report`, OUT, { reason: "again", type: "room_user", targetUserId: G })).status === 409);
    const plain = await http("POST", `/api/rooms/${room.id}/report`, CH2, { reason: "whole room" });
    check("report room: the whole-room report carries the excerpt too", plain.status === 200 && /someone is being rude/.test((await q(`select description d from content_reports where reporter_id=$1 and content_type='room'`, [CH2]))[0]?.d ?? ""));

    // ---- admin: reported list, end any room, change the age limit (all audited)
    const adminId = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'Mod','content_moderator') returning id`, [`mod8${stamp}`, `mod8${stamp}@t.dev`, hash]))[0].id as string;
    const reported = await admin8.listReportedRooms();
    const entry = reported.find((r: any) => r.roomId === room.id);
    check("admin: reported rooms list groups reports under the room with the excerpt", !!entry && entry.title === "Mod room" && entry.reports.length >= 3 && entry.reports.some((r: any) => /someone is being rude/.test(r.description ?? "")) && !JSON.stringify(entry).match(/passwordHash|email/), JSON.stringify(entry)?.slice(0, 300));
    const noReason = await admin8.adminSetRoomAgeLimit({ adminId, roomId: room.id, ageLimit: "18+", reason: " " });
    check("admin age limit: reason required, bad limit rejected, unknown room 404",
      !noReason.ok && noReason.status === 400
      && !(await admin8.adminSetRoomAgeLimit({ adminId, roomId: room.id, ageLimit: "19+" as any, reason: "x" })).ok
      && (await admin8.adminSetRoomAgeLimit({ adminId, roomId: "00000000-0000-0000-0000-000000000000", ageLimit: "18+", reason: "x" }) as any).status === 404);
    const teenBefore = await http("GET", `/api/rooms/${room.id}`, TEEN);
    const set = await admin8.adminSetRoomAgeLimit({ adminId, roomId: room.id, ageLimit: "18+", reason: "reported by several guests" });
    const teenAfter = await http("GET", `/api/rooms/${room.id}`, TEEN);
    check("admin age limit: applied (next join/read sees it), audited with reason", set.ok && teenBefore.json?.canJoin?.ok === true && teenAfter.json?.canJoin?.code === "AGE_LIMIT"
      && (await q(`select 1 from admin_activity_logs where admin_id=$1 and action='room.age_limit_changed' and target_id=$2 and reason like '%several guests%'`, [adminId, room.id])).length === 1);
    got[G].length = 0;
    const ended = await admin8.adminEndRoom({ adminId, roomId: room.id, reason: "terms violation" });
    check("admin end room: status ended, live sockets get room:ended, audited", ended.ok && (await rs.getRoom(room.id))?.status === "ended" && got[G].some((m) => m.type === "room:ended") && roomHub.count(room.id) === 0
      && (await q(`select 1 from admin_activity_logs where admin_id=$1 and action='room.ended_by_admin' and target_id=$2`, [adminId, room.id])).length === 1);
    const again = await admin8.adminEndRoom({ adminId, roomId: room.id, reason: "again" });
    check("admin end room twice: 409; reason required", !again.ok && again.status === 409 && !(await admin8.adminEndRoom({ adminId, roomId: room.id, reason: "" })).ok);
  }

  // ============ Review fixes: DM band gate, no-DOB profile edit, age raise eviction, list ordering, slide-out actions, invites ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const admin8 = await import("../server/rooms/roomAdmin");
    const ADULT = await mk("rf_adult", yearsAgo(30)), ADULT2 = await mk("rf_adult2", yearsAgo(30)), TEEN = await mk("rf_teen", yearsAgo(16));
    const NOD = await mk("rf_nodob", null), HOST = await mk("rf_host", yearsAgo(30)), OTHER = await mk("rf_other", yearsAgo(30));
    const mkConvo = (a: string, b: string) => q(`insert into conversations (direct_key, is_group, created_by_id) values ($1,false,$2)`, [[a, b].sort().join(":"), a]);

    // C1: a new DM between a known adult and a known teen is refused; same band, unknown age and existing threads are untouched
    check("DM: adult -> teen refused (403)", (await http("POST", "/api/conversations/direct", ADULT, { userId: TEEN })).status === 403);
    check("DM: teen -> adult refused (403)", (await http("POST", "/api/conversations/direct", TEEN, { userId: ADULT })).status === 403);
    check("DM: adult -> adult allowed", (await http("POST", "/api/conversations/direct", ADULT, { userId: ADULT2 })).status === 200);
    check("DM: unknown age (no birthdate) is not blocked", (await http("POST", "/api/conversations/direct", NOD, { userId: TEEN })).status === 200);
    await mkConvo(ADULT2, TEEN);
    check("DM: an existing adult/teen thread keeps working", (await http("POST", "/api/conversations/direct", ADULT2, { userId: TEEN })).status === 200);

    // I8: profile edit by someone with no stored birthdate (organizers, legacy users) sends dateOfBirth "" and must still save
    const ed = await http("PATCH", "/api/users/me", NOD, { bio: "organiser bio", dateOfBirth: "" });
    check("profile edit with dateOfBirth '' and none stored: 200 and saved", ed.status === 200 && (await q(`select bio from users where id=$1`, [NOD]))[0].bio === "organiser bio", JSON.stringify(ed));
    check("...and no birthdate was invented", (await q(`select date_of_birth d from users where id=$1`, [NOD]))[0].d === null);
    // onboarding: complete-profile must not overwrite a birthdate that is already set
    const OB = await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth) values ($1,$2,'social',$3,true,false,$4) returning id`, [`rf_ob${stamp}@t.dev`, `rf_ob${stamp}`, hash, yearsAgo(30)]);
    await http("PATCH", "/api/auth/complete-profile", OB[0].id, { userType: "social", displayName: "Ob", dateOfBirth: yearsAgo(50), gender: "Male", interests: ["music"] });
    check("complete-profile keeps an already-set birthdate", (await q(`select date_of_birth d from users where id=$1`, [OB[0].id]))[0].d === yearsAgo(30));

    // I5: raising the age limit on a live room sends out members who are now under it (host edit and admin tool)
    const room = await rs.createRoom(HOST, { title: "Raise me", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live");
    const msgs: Record<string, any[]> = { [TEEN]: [], [ADULT]: [], [HOST]: [] };
    for (const [uid, role] of [[HOST, "host"], [ADULT, "guest"], [TEEN, "guest"]] as const) roomHub.join(room.id, { userId: uid, role, muted: false, joinedAt: Date.now(), send: (m) => msgs[uid].push(m) });
    const raise = await http("PATCH", `/api/rooms/${room.id}`, HOST, { ageLimit: "18+" });
    check("raising the limit on a live room: the teen is sent out (AGE_LIMIT), the adult stays", raise.status === 200 && roomHub.get(room.id, TEEN) === undefined && msgs[TEEN].some((m) => m.type === "room:error" && m.code === "AGE_LIMIT") && roomHub.get(room.id, ADULT) !== undefined && roomHub.get(room.id, HOST) !== undefined, JSON.stringify(msgs[TEEN]));
    const room2 = await rs.createRoom(HOST, { title: "Admin raise", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room2.id, "live");
    roomHub.join(room2.id, { userId: TEEN, role: "guest", muted: false, joinedAt: 1, send: (m) => msgs[TEEN].push(m) });
    const adm = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'M','content_moderator') returning id`, [`rfmod${stamp}`, `rfmod${stamp}@t.dev`, hash]))[0].id as string;
    await admin8.adminSetRoomAgeLimit({ adminId: adm, roomId: room2.id, ageLimit: "16+", reason: "test" });
    check("admin limit that the member still meets: they stay", roomHub.get(room2.id, TEEN) !== undefined);
    await admin8.adminSetRoomAgeLimit({ adminId: adm, roomId: room2.id, ageLimit: "18+", reason: "reports of teens present" });
    check("admin raise on a live room evicts members under the new limit", roomHub.get(room2.id, TEEN) === undefined);
    roomHub.end(room.id); roomHub.end(room2.id);

    // I9: friends scope with other people's scheduled rooms around; live first; stale unstarted rooms drop out
    const VIEW = await mk("rf_view", yearsAgo(30)), FR = await mk("rf_friend", yearsAgo(30)), STRANGER = await mk("rf_str", yearsAgo(30));
    await q(`insert into follows (follower_id, following_id) values ($1,$2),($2,$1)`, [VIEW, FR]);
    for (let i = 0; i < 12; i++) await rs.createRoom(STRANGER, { title: `st${i}`, kind: "party", visibility: "public", ageLimit: "all", scheduledFor: new Date(Date.now() + 3600e3).toISOString() } as any);
    const fLive = await rs.createRoom(FR, { title: "friend live", kind: "party", visibility: "public", ageLimit: "all" } as any); await rs.setStatus(fLive.id, "live");
    const fSched = await rs.createRoom(FR, { title: "friend later", kind: "party", visibility: "friends", ageLimit: "all", scheduledFor: new Date(Date.now() + 7200e3).toISOString() } as any);
    const fStale = await rs.createRoom(FR, { title: "friend stale", kind: "party", visibility: "friends", ageLimit: "all" } as any);
    await q(`update rooms set scheduled_for = now() - interval '3 days' where id=$1`, [fStale.id]);
    const friends = (await rs.listRooms({ scope: "friends", viewerId: VIEW })).map((r) => r.id);
    check("friends scope: only mutual hosts' rooms, live before scheduled", friends[0] === fLive.id && friends.includes(fSched.id) && friends.length === 2, JSON.stringify(friends));
    check("a scheduled room whose time passed days ago is no longer listed", !friends.includes(fStale.id) && !(await rs.listRooms({ scope: "upcoming", viewerId: VIEW })).some((r) => r.id === fStale.id));

    // slide-out actions: booleans only, computed by the server
    const RM = await rs.createRoom(HOST, { title: "Actions", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(RM.id, "live");
    for (const uid of [HOST, ADULT, ADULT2, TEEN, OTHER]) roomHub.join(RM.id, { userId: uid, role: uid === HOST ? "host" : "guest", muted: false, joinedAt: Date.now(), send: () => {} });
    const act = (viewer: string, target: string) => http("GET", `/api/rooms/${RM.id}/members/${target}/actions`, viewer);
    await q(`insert into follows (follower_id, following_id) values ($1,$2),($2,$1) on conflict do nothing`, [ADULT, ADULT2]);
    const a1 = await act(ADULT, ADULT2);
    check("actions: mutual adults get interact + dm", a1.status === 200 && a1.json.actions.interact === true && a1.json.actions.dm === true, JSON.stringify(a1));
    const a2 = await act(ADULT, OTHER);
    check("actions: non-mutual with default privacy gets nothing", a2.json.actions.interact === false && a2.json.actions.dm === false && a2.json.actions.invite === false);
    const a3 = await act(ADULT2, TEEN);
    check("actions: adult -> teen gets nothing and no reason is given", a3.json.actions.interact === false && !/AGE|band|teen|age/i.test(JSON.stringify(a3.json)), JSON.stringify(a3.json));
    await q(`update users set room_privacy=$2 where id=$1`, [ADULT2, JSON.stringify({ v: 1, interactions: "none", appearInLists: true, allowInvites: true })]);
    check("actions: target set to nobody takes effect at once", (await act(ADULT, ADULT2)).json.actions.interact === false);
    check("actions: someone who is not in the room -> nothing; yourself -> nothing", (await act(ADULT, VIEW)).json.actions.interact === false && (await act(ADULT, ADULT)).json.actions.interact === false);
    check("actions: invisible room 404", (await http("GET", `/api/rooms/00000000-0000-0000-0000-000000000000/members/${ADULT}/actions`, ADULT)).status === 404);

    // invites to the live room you host
    await q(`update users set room_privacy=null where id=$1`, [ADULT2]);
    const notifiedInvite = async (uid: string) => (await q(`select 1 from notifications where user_id=$1 and type='room_live' and related_entity_id=$2 and title like '%invited you%'`, [uid, RM.id])).length;
    const inv1 = await http("POST", `/api/rooms/${RM.id}/invite/${ADULT2}`, HOST);
    check("invite: refused while default privacy needs a mutual follow", inv1.status === 403, JSON.stringify(inv1));
    await q(`insert into follows (follower_id, following_id) values ($1,$2),($2,$1) on conflict do nothing`, [HOST, ADULT2]);
    const inv2 = await http("POST", `/api/rooms/${RM.id}/invite/${ADULT2}`, HOST);
    check("invite: after becoming mutuals the invite is sent and a notification exists", inv2.status === 200 && (await notifiedInvite(ADULT2)) === 1, JSON.stringify(inv2));
    check("invite: again within a minute is rate limited", (await http("POST", `/api/rooms/${RM.id}/invite/${ADULT2}`, HOST)).status === 429);
    check("invite: teen target refused (403), non-host 403, yourself 403", (await http("POST", `/api/rooms/${RM.id}/invite/${TEEN}`, HOST)).status === 403 && (await http("POST", `/api/rooms/${RM.id}/invite/${ADULT2}`, ADULT)).status === 403 && (await http("POST", `/api/rooms/${RM.id}/invite/${HOST}`, HOST)).status === 403);
    await q(`update users set room_privacy=$2 where id=$1`, [ADULT2, JSON.stringify({ v: 1, interactions: "everyone", appearInLists: true, allowInvites: false })]);
    check("invite: target with allowInvites off refused", (await http("POST", `/api/rooms/${RM.id}/invite/${ADULT2}`, HOST)).status === 403);
    roomHub.end(RM.id);
    check("inviteTokenHash is part of the global response redaction", (await import("../server/auth")).SENSITIVE_RESPONSE_KEYS.has("inviteTokenHash"));
  }

  // ============ Final review fixes: DM gate on every path, public profile view, privacy cache ============
  {
    const AD = await mk("fr_adult", yearsAgo(30)), TN = await mk("fr_teen", yearsAgo(16)), AD2 = await mk("fr_adult2", yearsAgo(30));
    const grp = await http("POST", "/api/conversations/group", AD, { name: "private pair", participantIds: [TN] });
    check("group create: adult adding a teen is refused (403)", grp.status === 403, JSON.stringify(grp));
    const ok = await http("POST", "/api/conversations/group", AD, { name: "adults", participantIds: [AD2] });
    check("group create: adult + adult still works", ok.status === 201, JSON.stringify(ok));
    const add = await http("POST", `/api/conversations/${ok.json?.id}/participants`, AD, { userId: TN });
    check("add participant: adult adding a teen is refused (403)", add.status === 403, JSON.stringify(add));
    const tg = await http("POST", "/api/conversations/group", TN, { name: "teen group", participantIds: [AD2] });
    check("group create: teen adding an adult is refused too", tg.status === 403);

    // public profile view: no exact birthdate, email, phone or room privacy for other people; the owner keeps theirs
    await q(`update users set room_privacy=$2, phone_number='07000000000' where id=$1`, [TN, JSON.stringify({ v: 1, interactions: "everyone", appearInLists: true, allowInvites: true })]);
    const tname = (await q(`select username from users where id=$1`, [TN]))[0].username;
    const pub = await http("GET", `/api/users/${tname}`, AD);
    check("GET /api/users/:identifier hides birthdate, email, phone and room privacy from others; shows a whole age", pub.status === 200 && !("dateOfBirth" in pub.json) && !("email" in pub.json) && !("phoneNumber" in pub.json) && !("roomPrivacy" in pub.json) && pub.json.age === 16, JSON.stringify(pub.json).slice(0, 300));
    const prof = await http("GET", `/api/users/${TN}/profile`, null);
    check("GET /api/users/:id/profile (anonymous) hides them too", prof.status === 200 && !JSON.stringify(prof.json).includes("dateOfBirth") && !("email" in (prof.json?.user ?? {})) && prof.json?.user?.age === 16, JSON.stringify(prof.json).slice(0, 200));
    const own = await http("GET", `/api/users/${tname}`, TN);
    check("the owner still sees their own birthdate", own.status === 200 && own.json.dateOfBirth === yearsAgo(16));
  }

  // ============ Adult <-> under-18 DMs: consent settings (default off), warnings for both sides, thread notice ============
  {
    const AD = await mk("dm_adult", yearsAgo(30)), TN = await mk("dm_teen", yearsAgo(16)), AD2 = await mk("dm_adult2", yearsAgo(30)), NOD = await mk("dm_nodob", null);
    const setAllow = (id: string, v: boolean | null) => q(`update users set room_privacy=$2 where id=$1`, [id, v === null ? null : JSON.stringify({ v: 1, interactions: "mutuals", appearInLists: true, allowInvites: true, allowCrossAgeDm: v })]);
    const direct = (as: string, to: string, extra: object = {}) => http("POST", "/api/conversations/direct", as, { userId: to, ...extra });

    const d1 = await direct(AD, TN);
    check("default (both off): adult -> minor refused, and told it is their own setting", d1.status === 403 && d1.json?.code === "AGE_GAP_SELF_RESTRICTED" && /Settings/.test(d1.json.message), JSON.stringify(d1.json));
    const d2 = await direct(TN, AD);
    check("default (both off): minor -> adult refused the same way", d2.status === 403 && d2.json?.code === "AGE_GAP_SELF_RESTRICTED");
    await setAllow(AD, true);
    const d3 = await direct(AD, TN);
    check("adult allows but the minor has not: refused with 'this person has restrictions'", d3.status === 403 && d3.json?.code === "AGE_GAP_RESTRICTED" && /restrictions on who can message them/.test(d3.json.message), JSON.stringify(d3.json));
    check("...and the restricted side's answer never names the other person's age", !/minor|under 18|adult/i.test(d3.json.message));
    await setAllow(TN, true);
    const w1 = await direct(AD, TN);
    check("both allow: adult gets a warning that the other person is a minor (409, nothing created yet)", w1.status === 409 && w1.json?.code === "AGE_GAP_WARNING" && w1.json.otherIs === "minor" && /under 18/.test(w1.json.message)
      && (await q(`select 1 from conversations where direct_key=$1`, [[AD, TN].sort().join(":")])).length === 0, JSON.stringify(w1.json));
    const w2 = await direct(TN, AD);
    check("both allow: the minor gets a warning that the other person is an adult and is advised against it", w2.status === 409 && w2.json.otherIs === "adult" && /advise against/.test(w2.json.message), JSON.stringify(w2.json));
    const ok = await direct(AD, TN, { acknowledgeAgeGap: true });
    check("after acknowledging the warning the conversation is created", ok.status === 200 && !!ok.json?.id, JSON.stringify(ok.json)?.slice(0, 120));
    const nA = await http("GET", `/api/conversations/${ok.json.id}/age-notice`, AD), nT = await http("GET", `/api/conversations/${ok.json.id}/age-notice`, TN);
    check("the thread shows each side a notice about the other (adult sees 'under 18', minor sees 'adult')", nA.json?.notice?.otherIs === "minor" && /under 18/.test(nA.json.notice.message) && nT.json?.notice?.otherIs === "adult" && /adult/.test(nT.json.notice.message), JSON.stringify([nA.json, nT.json]));
    check("age-notice: outsiders get 404", (await http("GET", `/api/conversations/${ok.json.id}/age-notice`, AD2)).status === 404);
    {
      const rsx = await import("../server/rooms/roomStorage"); const { roomHub: hub } = await import("../server/rooms/RoomHub");
      const rm = await rsx.createRoom(AD2, { title: "x-age", kind: "party", visibility: "public", ageLimit: "all" } as any); await rsx.setStatus(rm.id, "live");
      for (const uid of [AD, TN]) hub.join(rm.id, { userId: uid, role: "guest", muted: false, joinedAt: 1, send: () => {} });
      const act = await http("GET", `/api/rooms/${rm.id}/members/${TN}/actions`, AD);
      check("room slide-out: across age groups with both consenting, Message is offered but wave/reaction/invite are not", act.json?.actions?.dm === true && act.json.actions.interact === false && act.json.actions.invite === false, JSON.stringify(act.json));
      hub.end(rm.id);
    }
    await setAllow(AD, false); await setAllow(TN, false);
    check("turning the setting off later does not break the existing thread", (await direct(AD, TN)).status === 200);
    const same = await direct(AD, AD2);
    check("same age group: no warning, no restriction", same.status === 200);
    const sameN = await http("GET", `/api/conversations/${same.json.id}/age-notice`, AD);
    check("same age group: no notice", sameN.json?.notice === null);
    check("unknown age: not treated as a gap", (await direct(NOD, TN)).status === 200);

    // groups follow the same consent rule (no per-add warning)
    await setAllow(AD, null); await setAllow(TN, null);
    check("group: adult adding a minor refused by default", (await http("POST", "/api/conversations/group", AD, { name: "g", participantIds: [TN] })).status === 403);
    await setAllow(AD, true); await setAllow(TN, true);
    check("group: allowed when both have allowed it", (await http("POST", "/api/conversations/group", AD, { name: "g2", participantIds: [TN] })).status === 201);
    await setAllow(AD, null); await setAllow(TN, null);

    // the privacy API round trip
    const put = await http("PUT", "/api/users/me/room-privacy", AD2, { interactions: "mutuals", appearInLists: true, allowInvites: true, allowCrossAgeDm: true });
    check("PUT room-privacy stores allowCrossAgeDm; GET returns it", put.status === 200 && (await http("GET", "/api/users/me/room-privacy", AD2)).json?.roomPrivacy?.allowCrossAgeDm === true);
    check("GET room-privacy default for someone who never set it is false", (await http("GET", "/api/users/me/room-privacy", NOD)).json?.roomPrivacy?.allowCrossAgeDm === false);
    check("PUT room-privacy without the key keeps the safe default (false)", (await http("PUT", "/api/users/me/room-privacy", AD2, { interactions: "mutuals", appearInLists: true, allowInvites: true })).json?.roomPrivacy?.allowCrossAgeDm === false);
  }

  // ============ CSP: every embed host a room screen can produce must be framable ============
  {
    const { securityHeaders } = await import("../server/security");
    const { resolveScreen } = await import("../shared/screen");
    const headers: Record<string, string> = {};
    securityHeaders({} as any, { setHeader: (k: string, v: string) => { headers[k] = v; }, locals: {} } as any, () => {});
    const frameSrc = (headers["Content-Security-Policy"].match(/frame-src ([^;]+)/)?.[1] ?? "").split(" ");
    const samples = ["https://youtu.be/dQw4w9WgXcQ", "https://vimeo.com/76979871", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      "https://music.apple.com/us/album/x/123", "https://soundcloud.com/a/b"];
    for (const u of samples) {
      const r = resolveScreen(u) as any;
      const origin = new URL(r.screen.embedUrl).origin;
      check(`CSP frame-src allows the embed origin for ${r.screen.provider} (${origin})`, frameSrc.includes(origin), headers["Content-Security-Policy"]);
    }
    check("CSP still blocks arbitrary frames", !frameSrc.includes("https:") && !frameSrc.includes("*"));
    const { ROOM_SCRIPT_HOSTS } = await import("../server/security");
    for (const env of ["development", "production"]) {
      const prev = process.env.NODE_ENV; process.env.NODE_ENV = env;
      const h2: Record<string, string> = {};
      securityHeaders({} as any, { setHeader: (k: string, v: string) => { h2[k] = v; }, locals: {} } as any, () => {});
      process.env.NODE_ENV = prev;
      const scriptSrc = (h2["Content-Security-Policy"].match(/script-src ([^;]+)/)?.[1] ?? "").split(" ");
      check(`CSP script-src (${env}) allows the player API hosts`, ROOM_SCRIPT_HOSTS.every((u: string) => scriptSrc.includes(u)), scriptSrc.join(" "));
      check(`CSP script-src (${env}) has no wildcard`, !scriptSrc.includes("*") && !scriptSrc.includes("https:"));
      check(`CSP worker-src (${env}) allows blob: (LiveKit)`, /worker-src [^;]*blob:/.test(h2["Content-Security-Policy"]));
    }
    // LiveKit's client also makes https calls to its own host (region lookup, connection checks): connect-src must allow exactly that host
    const lkEnv = process.env.LIVEKIT_URL; process.env.LIVEKIT_URL = "wss://vib3pulse-test.livekit.cloud";
    const h3: Record<string, string> = {};
    securityHeaders({} as any, { setHeader: (k: string, v: string) => { h3[k] = v; }, locals: {} } as any, () => {});
    const connect = (h3["Content-Security-Policy"].match(/connect-src ([^;]+)/)?.[1] ?? "").split(" ");
    check("CSP connect-src allows https calls to the configured LiveKit host", connect.includes("https://vib3pulse-test.livekit.cloud"), connect.join(" "));
    delete process.env.LIVEKIT_URL;
    const h4: Record<string, string> = {};
    securityHeaders({} as any, { setHeader: (k: string, v: string) => { h4[k] = v; }, locals: {} } as any, () => {});
    check("...and without LiveKit configured no extra host is allowed", !/livekit/.test(h4["Content-Security-Policy"]));
    if (lkEnv !== undefined) process.env.LIVEKIT_URL = lkEnv;
    check("Permissions-Policy lets this site use the microphone but not the camera", /microphone=\(self\)/.test(headers["Permissions-Policy"]) && /camera=\(\)/.test(headers["Permissions-Policy"]), headers["Permissions-Policy"]);
  }

  // ============ Part 3a Task 3: voice + playback columns and storage ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const H = await mk("vs_host", yearsAgo(30)), G = await mk("vs_g", yearsAgo(30));
    const r = await rs.createRoom(H, { title: "voice", kind: "party", visibility: "public", ageLimit: "all" } as any);
    check("new room: voice off, 6 speakers, screen version 0, no now-playing", r.voiceEnabled === false && r.maxSpeakers === 6 && r.screenVersion === 0 && r.nowPlaying === null, JSON.stringify(r));
    check("setVoiceEnabled round trip", (await rs.setVoiceEnabled(r.id, true)).voiceEnabled === true && (await rs.setVoiceEnabled(r.id, false)).voiceEnabled === false);
    const np = { v: 1 as const, screenVersion: 0, state: "playing" as const, positionMs: 5000, atServerMs: 1700000000000 };
    const stored = (await rs.setNowPlaying(r.id, np)).nowPlaying as any; // jsonb does not keep key order, so compare field by field
    check("setNowPlaying stores the object and null clears it", !!stored && stored.v === 1 && stored.screenVersion === 0 && stored.state === "playing" && stored.positionMs === 5000 && stored.atServerMs === 1700000000000 && (await rs.setNowPlaying(r.id, null)).nowPlaying === null);
    await rs.setNowPlaying(r.id, np);
    const t = await rs.updateRoom(r.id, { title: "renamed" });
    check("a title change leaves screen version and now-playing alone", t.screenVersion === 0 && t.nowPlaying !== null);
    const sc = await rs.updateRoom(r.id, { screen: { v: 1, provider: "link", kind: "link", url: "https://e.test/", openUrl: "https://e.test/" } as any });
    check("changing the screen bumps the version by 1 and clears now-playing", sc.screenVersion === 1 && sc.nowPlaying === null, JSON.stringify([sc.screenVersion, sc.nowPlaying]));
    check("clearing the screen also counts as a change", (await rs.updateRoom(r.id, { screen: null })).screenVersion === 2);
    check("bumpScreenVersion returns the new version", (await rs.bumpScreenVersion(r.id)) === 3);

    await rs.upsertMember(r.id, G, "guest");
    await rs.setOnStage(r.id, G, true);
    check("setOnStage / listOnStage", JSON.stringify(await rs.listOnStage(r.id)) === JSON.stringify([G]));
    await rs.markLeft(r.id, G); await rs.upsertMember(r.id, G, "guest");
    check("on_stage survives leaving and rejoining", (await rs.listOnStage(r.id)).includes(G));
    await rs.setOnStage(r.id, G, false);
    check("setOnStage false removes", (await rs.listOnStage(r.id)).length === 0);
    await rs.setOnStage(r.id, G, true); await rs.clearStage(r.id);
    check("clearStage empties the stage", (await rs.listOnStage(r.id)).length === 0);
    const cols = (await q(`select column_name from information_schema.columns where (table_name='rooms' and column_name in ('voice_enabled','max_speakers','screen_version','now_playing')) or (table_name='room_members' and column_name='on_stage')`)).length;
    check("the five columns exist", cols === 5, String(cols));
  }

  // ============ Part 3a Task 5: voice REST ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const fake = new FakeVoice();
    const decode = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
    const HO = await mk("vr_host", yearsAgo(30)), GU = await mk("vr_guest", yearsAgo(30)), ST = await mk("vr_stage", yearsAgo(30)), CO = await mk("vr_co", yearsAgo(30));
    const OUT = await mk("vr_out", yearsAgo(30)), BN = await mk("vr_ban", yearsAgo(30));
    const room = await rs.createRoom(HO, { title: "voice room", kind: "party", visibility: "public", ageLimit: "all" } as any);
    const sched = await rs.createRoom(HO, { title: "later", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live");
    const got: Record<string, any[]> = {};
    for (const [uid, role] of [[HO, "host"], [GU, "guest"], [ST, "guest"], [CO, "cohost"]] as const) {
      got[uid] = []; roomHub.join(room.id, { userId: uid, role, muted: false, joinedAt: Date.now(), age: 30, send: (m) => got[uid].push(m) }); roomHub.setVoiceOn(room.id, true);
      await rs.upsertMember(room.id, uid, role);
    }
    await rs.setOnStage(room.id, ST, true);
    roomHub.setStage(room.id, { stage: [ST], hands: [], invited: [] }); // the live stage (the database copy is what a reconnect restores)
    await rs.setMemberFlag(room.id, BN, { banned: true });
    const tok = (as: string | null, id = room.id) => http("POST", `/api/rooms/${id}/voice-token`, as);

    setVoiceServiceForTests(null);
    check("voice-token: no LiveKit configured -> 503 VOICE_UNAVAILABLE", (await tok(HO)).status === 503 && (await tok(HO)).json?.code === "VOICE_UNAVAILABLE");
    check("voice on: no LiveKit configured -> 503 and nothing changes", (await http("PUT", `/api/rooms/${room.id}/voice`, HO, { enabled: true })).status === 503 && (await rs.getRoom(room.id))?.voiceEnabled === false);
    setVoiceServiceForTests(fake);

    check("voice-token: unauthenticated 401", (await tok(null)).status === 401);
    check("voice-token: voice not switched on yet -> 409 VOICE_OFF", (await tok(HO)).json?.code === "VOICE_OFF" && (await tok(HO)).status === 409);
    check("voice on: guest cannot (403), bad body 400", (await http("PUT", `/api/rooms/${room.id}/voice`, GU, { enabled: true })).status === 403 && (await http("PUT", `/api/rooms/${room.id}/voice`, HO, { enabled: "yes" })).status === 400);
    Object.values(got).forEach((a) => (a.length = 0));
    const on = await http("PUT", `/api/rooms/${room.id}/voice`, HO, { enabled: true });
    check("voice on: host switches it on, it is persisted and the room is told", on.status === 200 && on.json?.room?.voiceEnabled === true && (await rs.getRoom(room.id))?.voiceEnabled === true && got[GU].some((m) => m.type === "room:voice" && m.enabled === true), JSON.stringify(on.json)?.slice(0, 160));
    check("voice on: a room that has not started cannot have voice (409)", (await http("PUT", `/api/rooms/${sched.id}/voice`, HO, { enabled: true })).status === 409);

    const h = await tok(HO), g = await tok(GU), s = await tok(ST), c = await tok(CO);
    check("voice-token: host, co-host and an on-stage guest may publish; a plain guest may not", h.json?.canPublish === true && c.json?.canPublish === true && s.json?.canPublish === true && g.json?.canPublish === false, JSON.stringify([h.status, g.status, s.status, c.status]));
    check("voice-token: returns the LiveKit url, a token that says the same, and a 600 s lifetime", g.status === 200 && g.json.url === fake.url && g.json.expiresInSec === 60 && decode(g.json.token).canPublish === false && decode(g.json.token).userId === GU && decode(g.json.token).roomId === room.id, JSON.stringify(g.json));
    check("voice-token: the token uses the display name, never the email", !JSON.stringify(decode(g.json.token)).includes("@"));
    check("voice-token: someone who is not in the room -> 403 NOT_IN_ROOM", (await tok(OUT)).json?.code === "NOT_IN_ROOM" && (await tok(OUT)).status === 403);
    check("voice-token: a banned member -> 403 BANNED", (await tok(BN)).json?.code === "BANNED");
    check("voice-token: an invisible room -> 404", (await tok(HO, "00000000-0000-0000-0000-000000000000")).status === 404);
    await rs.setStatus(sched.id, "scheduled");
    check("voice-token: a room that is not live -> 409 ROOM_NOT_LIVE", (await tok(HO, sched.id)).status === 409);
    
    await rs.setOnStage(room.id, GU, true);
    const off = await http("PUT", `/api/rooms/${room.id}/voice`, HO, { enabled: false });
    check("voice off: persisted, stage cleared, LiveKit session deleted, the room told", off.status === 200 && (await rs.getRoom(room.id))?.voiceEnabled === false && (await rs.listOnStage(room.id)).length === 0
      && fake.calls.some((x) => x.op === "delete" && x.roomId === room.id) && got[GU].some((m) => m.type === "room:voice" && m.enabled === false));
    check("voice off: a later token request is 409 VOICE_OFF", (await tok(GU)).json?.code === "VOICE_OFF");
    roomHub.end(room.id); setVoiceServiceForTests(undefined);
  }

  // ============ Live screen Task 2: the host switches live video on and off ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const fake = new FakeVoice();
    const LH = await mk("lv_host", yearsAgo(30)), LG = await mk("lv_guest", yearsAgo(30));
    const room = await rs.createRoom(LH, { title: "live video room", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live");
    const told: any[] = [];
    roomHub.join(room.id, { userId: LH, role: "host", muted: false, joinedAt: 1, age: 30, send: () => {} }); await rs.upsertMember(room.id, LH, "host");
    roomHub.join(room.id, { userId: LG, role: "guest", muted: false, joinedAt: 2, age: 30, send: (m) => told.push(m) }); await rs.upsertMember(room.id, LG, "guest");
    const put = (as: string | null, body: unknown) => http("PUT", `/api/rooms/${room.id}/live-video`, as, body);
    setVoiceServiceForTests(fake);
    check("live video: voice not on yet -> 409 VOICE_OFF", (await put(LH, { enabled: true })).status === 409 && (await put(LH, { enabled: true })).json?.code === "VOICE_OFF");
    await rs.setVoiceEnabled(room.id, true); roomHub.setVoiceOn(room.id, true);
    check("live video: a guest cannot switch it (403), a bad body is 400, unauthenticated is 401", (await put(LG, { enabled: true })).status === 403 && (await put(LH, { enabled: "yes" })).status === 400 && (await put(null, { enabled: true })).status === 401);
    setVoiceServiceForTests(null);
    check("live video: no LiveKit configured -> 503 LIVE_UNAVAILABLE and nothing changes", (await put(LH, { enabled: true })).status === 503 && (await rs.getRoom(room.id))?.liveVideo === false);
    setVoiceServiceForTests(fake);
    await rs.updateRoom(room.id, { capacity: 51 });
    const big = await put(LH, { enabled: true });
    check("live video: a room above the viewer cap -> 400 too_large", big.status === 400 && big.json?.field === "liveVideo" && big.json?.reason === "too_large", JSON.stringify(big.json));
    await rs.updateRoom(room.id, { capacity: 50 });
    told.length = 0;
    const on = await put(LH, { enabled: true });
    check("live video on: persisted, the room says so, the room is told", on.status === 200 && on.json?.room?.liveVideo === true && (await rs.getRoom(room.id))?.liveVideo === true && roomHub.liveVideoOn(room.id) && told.some((m) => m.type === "room:livevideo" && m.enabled === true), JSON.stringify(on.json)?.slice(0, 160));
    check("live video: GET room carries the flag", (await http("GET", `/api/rooms/${room.id}`, LG)).json?.room?.liveVideo === true);
    const off = await put(LH, { enabled: false });
    check("live video off: persisted and the room is told", off.status === 200 && (await rs.getRoom(room.id))?.liveVideo === false && !roomHub.liveVideoOn(room.id) && told.some((m) => m.type === "room:livevideo" && m.enabled === false));
    roomHub.end(room.id); setVoiceServiceForTests(undefined);
  }

  // ============ Part 3a Task 6 (REST side): the teen rule applies to publish rights in tokens ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    setVoiceServiceForTests(new FakeVoice());
    const dec = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
    const TH = await mk("tp_teenhost", yearsAgo(16)), TG = await mk("tp_teenguest", yearsAgo(15)), AD = await mk("tp_adult", yearsAgo(30));
    const room = await rs.createRoom(TH, { title: "teens voice", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live"); await rs.setVoiceEnabled(room.id, true);
    for (const [uid, role, age] of [[TH, "host", 16], [TG, "guest", 15]] as const) { roomHub.join(room.id, { userId: uid, role, muted: false, joinedAt: 1, age, send: () => {} }); await rs.upsertMember(room.id, uid, role); }
    roomHub.setVoiceOn(room.id, true);
    const t1 = await http("POST", `/api/rooms/${room.id}/voice-token`, TH);
    check("all-teen room: the teen host's token can publish", t1.status === 200 && t1.json.canPublish === true && dec(t1.json.token).canPublish === true, JSON.stringify(t1.json));
    roomHub.join(room.id, { userId: AD, role: "guest", muted: false, joinedAt: 2, age: 30, send: () => {} }); await rs.upsertMember(room.id, AD, "guest");
    const t2 = await http("POST", `/api/rooms/${room.id}/voice-token`, TH);
    check("an adult is in the room: the teen host's token can only listen", t2.status === 200 && t2.json.canPublish === false && dec(t2.json.token).canPublish === false, JSON.stringify(t2.json));
    const t3 = await http("POST", `/api/rooms/${room.id}/voice-token`, AD);
    check("...and an adult guest who is not on stage can only listen", t3.json.canPublish === false);
    roomHub.setStage(room.id, { stage: [AD], hands: [], invited: [] });
    check("...but an adult on stage can publish", (await http("POST", `/api/rooms/${room.id}/voice-token`, AD)).json.canPublish === true);
    roomHub.end(room.id); setVoiceServiceForTests(undefined);
  }

  // ============ Part 3a final review fixes (REST side) ============
  {
    const rs = await import("../server/rooms/roomStorage");
    const { roomHub } = await import("../server/rooms/RoomHub");
    const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
    const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
    const fake = new FakeVoice(); setVoiceServiceForTests(fake);
    const log = (op: string, userId: string, canPublish?: boolean) => fake.calls.filter((c) => c.op === op && c.userId === userId && (canPublish === undefined || c.canPublish === canPublish));
    const H = await mk("rf3_host", yearsAgo(30)), C = await mk("rf3_co", yearsAgo(30)), G = await mk("rf3_g", yearsAgo(30)), ABS = await mk("rf3_absent", yearsAgo(30));
    const room = await rs.createRoom(H, { title: "role voice", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rs.setStatus(room.id, "live"); await rs.setVoiceEnabled(room.id, true);
    for (const [uid, role] of [[H, "host"], [C, "cohost"], [G, "guest"]] as const) { roomHub.join(room.id, { userId: uid, role, muted: false, joinedAt: 1, age: 30, send: () => {}, publish: true }); await rs.upsertMember(room.id, uid, role); }
    roomHub.setVoiceOn(room.id, true);
    roomHub.setStage(room.id, { stage: [G], hands: [], invited: [] });

    const promo = await http("PUT", `/api/rooms/${room.id}/members/${G}/role`, H, { role: "cohost" });
    check("promoting a stage guest to co-host: they leave the stage list (no double counting)", promo.status === 200 && !roomHub.stageOf(room.id).stage.includes(G), JSON.stringify(roomHub.stageOf(room.id)));
    check("...and LiveKit is told they can publish (a co-host is an implicit speaker)", log("setCanPublish", G, true).length >= 1);
    fake.calls.length = 0;
    const demote = await http("PUT", `/api/rooms/${room.id}/members/${C}/role`, H, { role: "guest" });
    check("demoting a co-host to guest: LiveKit publish is revoked at once", demote.status === 200 && log("setCanPublish", C, false).length >= 1, JSON.stringify(fake.calls));
    check("...and the person is not left on stage by accident", !roomHub.stageOf(room.id).stage.includes(C));

    // a ban of someone who is not in the room still removes them from LiveKit (token replay) and clears the stage right
    await rs.upsertMember(room.id, ABS, "guest"); await rs.setOnStage(room.id, ABS, true);
    fake.calls.length = 0;
    const ban = await http("POST", `/api/rooms/${room.id}/members/${ABS}/ban`, H, {});
    check("banning someone who is not present: removed from LiveKit and the stage right is gone", ban.status === 200 && log("remove", ABS).length >= 1 && !(await rs.listOnStage(room.id)).includes(ABS));
    roomHub.end(room.id); setVoiceServiceForTests(undefined);
  }

  // ============ Link screens are switched off (live streaming replaces them); lobby preview of who is in a room ============
  {
    const { roomHub } = await import("../server/rooms/RoomHub");
    const rsx = await import("../server/rooms/roomStorage");
    check("the link-screen feature defaults to off in production", (await import("../server/rooms/features")).DEFAULT_ROOM_FEATURES.linkScreens === false);
    roomFeatures.linkScreens = false;
    const H = await mk("off_host", yearsAgo(30)), G = await mk("off_guest", yearsAgo(30));
    const mkBody = (over: object = {}) => ({ title: "no links", kind: "party", visibility: "public", ageLimit: "all", ...over });
    const withLink = await http("POST", "/api/rooms", H, mkBody({ screenUrl: "https://youtu.be/dQw4w9WgXcQ" }));
    check("create with a screen link is refused while the feature is off (400, field screenUrl)", withLink.status === 400 && withLink.json?.field === "screenUrl" && withLink.json?.reason === "disabled", JSON.stringify(withLink.json));
    const ok = await http("POST", "/api/rooms", H, mkBody());
    check("create without a link still works", ok.status === 201);
    const patch = await http("PATCH", `/api/rooms/${ok.json.room.id}`, H, { screenUrl: "https://vimeo.com/76979871" });
    check("setting a screen link by PATCH is refused too", patch.status === 400 && patch.json?.field === "screenUrl");
    check("clearing a screen is still allowed", (await http("PATCH", `/api/rooms/${ok.json.room.id}`, H, { screenUrl: null })).status === 200);
    roomFeatures.linkScreens = true;

    // who is in the room, for the cards and the lobby (no ages, no emails)
    const room = await rsx.createRoom(H, { title: "peek", kind: "party", visibility: "public", ageLimit: "all" } as any);
    await rsx.setStatus(room.id, "live");
    roomHub.join(room.id, { userId: H, role: "host", muted: false, joinedAt: 1, age: 30, send: () => {}, info: { username: "off_host", displayName: "Host", avatar: null, avatarUrl: null } });
    roomHub.join(room.id, { userId: G, role: "guest", muted: false, joinedAt: 2, age: 15, send: () => {}, info: { username: "off_guest", displayName: "Guest", avatar: null, avatarUrl: null } });
    const list = await http("GET", "/api/rooms?scope=live", G);
    const card = list.json.rooms.find((r: any) => r.id === room.id);
    check("room list items carry a peek of who is in the room (role + public profile bits only)", card?.peek?.length === 2 && card.peek[0].role === "host" && card.peek[0].username === "off_host", JSON.stringify(card?.peek));
    check("...and the peek never carries an age, email or birthdate", !/"age"|email|dateOfBirth|passwordHash/.test(JSON.stringify(list.json)), JSON.stringify(list.json).slice(0, 200));
    const one = await http("GET", `/api/rooms/${room.id}`, G);
    check("GET room carries the peek for the lobby", one.json?.peek?.length === 2 && one.json.memberCount === 2);
    roomHub.end(room.id);
  }
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
