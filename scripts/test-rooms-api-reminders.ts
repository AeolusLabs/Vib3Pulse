// Room reminders over REST plus the reminder job (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-reminders.ts
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix rm_.
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
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { runReminderPass } = await import("../server/rooms/reminders");
const rs = await import("../server/rooms/roomStorage");
const { reminderTitle } = await import("../shared/roomReminders");

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
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  req.login = (_u: unknown, cb: (e?: unknown) => void) => cb();
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.13.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const mk = async (name: string, dob: string | null) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`rm_${name}${stamp}@t.dev`, `rm_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const block = (a: string, b: string) => q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [a, b]);
const starting = async (uid: string, roomId: string) => q(`select title, message, link from notifications where user_id=$1 and related_entity_id=$2 and type='room_starting'`, [uid, roomId]);
/**
 * scheduled_for is written from the JS clock (the same clock runReminderPass uses), as an ISO string: Postgres drops the
 * "Z" for a timestamp without time zone, which is exactly how drizzle writes and reads it (a pg Date parameter would be
 * sent in the process's local time instead).
 */
const startOf = new Map<string, Date>();
const setStart = async (id: string, minutesAhead: number) => {
  const at = new Date(Date.now() + minutesAhead * 60_000);
  startOf.set(id, at);
  await q(`update rooms set scheduled_for = $2::timestamp where id=$1`, [id, at.toISOString()]);
  return at;
};
/** A scheduled room starting `minutesAhead` from now (default 14.5: inside the window, with margin for slow queries). */
const mkRoom = async (host: string, title: string, visibility = "friends", minutesAhead = 14.5) => {
  const r = await http("POST", "/api/rooms", host, { title, kind: "party", visibility });
  const id = r.json?.room?.id as string;
  await setStart(id, minutesAhead);
  return id;
};

try {
  const H = await mk("host", yearsAgo(30));
  const U1 = await mk("u1", yearsAgo(25));
  const U2 = await mk("u2", yearsAgo(25));
  const S = await mk("stranger", yearsAgo(25)); // not a friend of the host
  for (const x of [U1, U2]) await mutual(H, x);
  const now = () => new Date();
  // Rooms left behind by earlier runs (or other suites) in this scratch database that are due within the next hour would
  // be claimed by our passes too and blur the "exactly one pass sent" checks: mark them claimed first. None of this run's
  // rooms exist yet.
  await q(`update rooms set reminder_notified_at = now() where status='scheduled' and reminder_notified_at is null and scheduled_for <= $1::timestamp`, [new Date(Date.now() + 3600_000).toISOString()]);

  // ---- set and clear
  const R1 = await mkRoom(H, `Reminder room ${stamp}`);
  const set = await http("PUT", `/api/rooms/${R1}/reminder`, U1);
  check("set a reminder: 200 { reminder: true }", set.status === 200 && set.json?.reminder === true, JSON.stringify(set));
  const set2 = await http("PUT", `/api/rooms/${R1}/reminder`, U1);
  check("setting twice is fine (idempotent, still one row)", set2.status === 200 && set2.json?.reminder === true && (await q(`select 1 from room_reminders where room_id=$1 and user_id=$2`, [R1, U1])).length === 1, JSON.stringify(set2));
  const g1 = await http("GET", `/api/rooms/${R1}`, U1);
  const g2 = await http("GET", `/api/rooms/${R1}`, U2);
  check("GET /api/rooms/:id tells the viewer their own reminderSet", g1.json?.reminderSet === true && g2.json?.reminderSet === false, `${g1.text} ${g2.text}`);
  check("the room object never carries reminder_notified_at", !("reminderNotifiedAt" in (g1.json?.room ?? {})));
  const clr = await http("DELETE", `/api/rooms/${R1}/reminder`, U1);
  check("clear a reminder: 200 { reminder: false }, row gone", clr.status === 200 && clr.json?.reminder === false && (await q(`select 1 from room_reminders where room_id=$1`, [R1])).length === 0, JSON.stringify(clr));
  const clr2 = await http("DELETE", `/api/rooms/${R1}/reminder`, U1);
  check("clearing again is fine (idempotent)", clr2.status === 200 && clr2.json?.reminder === false, JSON.stringify(clr2));
  const anon = await http("PUT", `/api/rooms/${R1}/reminder`, null);
  check("signed out is refused", anon.status === 401, JSON.stringify(anon));

  // ---- not viewable: 404 like a missing room
  const strangerPut = await http("PUT", `/api/rooms/${R1}/reminder`, S);
  const missing = await http("PUT", `/api/rooms/00000000-0000-0000-0000-000000000000/reminder`, S);
  check("a friends-only room the caller cannot see: PUT is 404, same as a missing room", strangerPut.status === 404 && missing.status === 404 && strangerPut.text === missing.text, `${strangerPut.text} | ${missing.text}`);
  const strangerDel = await http("DELETE", `/api/rooms/${R1}/reminder`, S);
  check("...and DELETE is 404 too", strangerDel.status === 404, JSON.stringify(strangerDel));
  check("no reminder row was created for the stranger", (await q(`select 1 from room_reminders where user_id=$1`, [S])).length === 0);

  // ---- only while scheduled
  const RL = await mkRoom(H, `Live room ${stamp}`, "public");
  await q(`update rooms set status='live', started_at=now() where id=$1`, [RL]);
  const liveSet = await http("PUT", `/api/rooms/${RL}/reminder`, U1);
  check("a room that is not scheduled cannot get a reminder (409)", liveSet.status === 409 && liveSet.json?.code === "BAD_STATE", JSON.stringify(liveSet));

  // ---- the job: twice sends once; host gets one; copy
  const R2 = await mkRoom(H, `Job room ${stamp}`);
  await http("PUT", `/api/rooms/${R2}/reminder`, U1);
  await http("PUT", `/api/rooms/${R2}/reminder`, U2);
  const at1 = now();
  const n1 = await runReminderPass(at1);
  const n2 = await runReminderPass(now());
  check("the first pass sent to U1, U2 and the host; the second sent nothing", n1 >= 3 && n2 === 0, `${n1} ${n2}`);
  check("each person has exactly one reminder", (await starting(U1, R2)).length === 1 && (await starting(U2, R2)).length === 1 && (await starting(H, R2)).length === 1);
  const sample = (await starting(U1, R2))[0];
  const want = reminderTitle(`Job room ${stamp}`, startOf.get(R2)!, at1);
  check("copy says the real minutes left ('<title> starts in N minutes', N from the start time and the pass time) and links to the room",
    sample?.title === want && /starts in (13|14|15) minutes$/.test(sample.title) && sample.link === `/rooms/${R2}`, `${JSON.stringify(sample)} want ${want}`);
  check("the claim is on the room, and notified_at is set on the reminder rows", (await q(`select reminder_notified_at from rooms where id=$1`, [R2]))[0].reminder_notified_at !== null && (await q(`select 1 from room_reminders where room_id=$1 and notified_at is null`, [R2])).length === 0);
  const [p1, p2] = await Promise.all([runReminderPass(now()), runReminderPass(now())]);
  check("two passes at the same moment on an already-claimed room send nothing", p1 === 0 && p2 === 0 && (await starting(U1, R2)).length === 1);

  // two instances racing on a fresh room: only one of them may send
  const R3 = await mkRoom(H, `Race room ${stamp}`);
  await http("PUT", `/api/rooms/${R3}/reminder`, U1);
  const [a, b] = await Promise.all([runReminderPass(now()), runReminderPass(now())]);
  check("two instances racing on a fresh room: exactly one sends, one reminder each", (a === 0) !== (b === 0) && (await starting(U1, R3)).length === 1 && (await starting(H, R3)).length === 1, `${a} ${b}`);

  // ---- not claimed: wrong window, ended
  const RF = await mkRoom(H, `Far room ${stamp}`);
  await setStart(RF, 40);
  const RE = await mkRoom(H, `Ended room ${stamp}`);
  await q(`update rooms set status='ended', ended_at=now() where id=$1`, [RE]);
  await runReminderPass(now());
  check("rooms outside the window, or ended, are not claimed and nobody is told", (await q(`select id from rooms where id in ($1,$2) and reminder_notified_at is not null`, [RF, RE])).length === 0 && (await starting(H, RF)).length + (await starting(H, RE)).length === 0);

  // ---- a room set up less than 15 minutes ahead is reminded at the next tick, with the real time left
  const R9 = await mkRoom(H, `Soon room ${stamp}`, "friends", 9);
  await http("PUT", `/api/rooms/${R9}/reminder`, U1);
  const at9 = now();
  await runReminderPass(at9);
  const soon = await starting(U1, R9);
  check("a room 9 minutes away is reminded at the next pass, saying 9 minutes (not 15)",
    soon.length === 1 && soon[0].title === reminderTitle(`Soon room ${stamp}`, startOf.get(R9)!, at9) && /starts in (8|9) minutes$/.test(soon[0].title), JSON.stringify(soon));

  // ---- a reschedule re-arms the reminder (rs.updateRoom with scheduledFor, the RoomPatch funnel)
  const moved = new Date(Date.now() + 12 * 60_000);
  startOf.set(R9, moved);
  await rs.updateRoom(R9, { scheduledFor: moved });
  const afterMove = await q(`select (select reminder_notified_at from rooms where id=$1) as claimed, (select count(*)::int from room_reminders where room_id=$1 and notified_at is not null) as notified`, [R9]);
  check("rescheduling clears the room's claim and every reminder row's notified_at", afterMove[0].claimed === null && afterMove[0].notified === 0, JSON.stringify(afterMove));
  const atMove = now();
  await runReminderPass(atMove);
  const again = await starting(U1, R9);
  const newest = again.find((n: any) => n.title === reminderTitle(`Soon room ${stamp}`, moved, atMove));
  check("...and the next pass reminds again with the new time", again.length === 2 && !!newest && /starts in (11|12) minutes$/.test(newest.title), JSON.stringify(again));
  check("...once: a further pass sends nothing more", (await runReminderPass(now())) === 0 && (await starting(U1, R9)).length === 2);

  // ---- moderation: a room taken down is never announced
  const RM = await mkRoom(H, `Removed room ${stamp}`);
  await http("PUT", `/api/rooms/${RM}/reminder`, U1);
  await q(`update rooms set moderation_status='removed' where id=$1`, [RM]);
  await runReminderPass(now());
  check("a room whose moderation status is not approved is not claimed and nobody is told",
    (await q(`select reminder_notified_at from rooms where id=$1`, [RM]))[0].reminder_notified_at === null && (await starting(U1, RM)).length === 0 && (await starting(H, RM)).length === 0);
  await q(`update rooms set moderation_status='approved' where id=$1`, [RM]);
  await runReminderPass(now());
  check("approved again while still in the window: reminded at the next pass", (await starting(U1, RM)).length === 1);

  // ---- lost access before send time
  const R4 = await mkRoom(H, `Lost access ${stamp}`);
  await http("PUT", `/api/rooms/${R4}/reminder`, U1);
  await http("PUT", `/api/rooms/${R4}/reminder`, U2);
  await block(H, U2); // U2 can no longer see the room
  await runReminderPass(now());
  check("a reminder user who lost access gets nothing; the other still does; the host gets one", (await starting(U2, R4)).length === 0 && (await starting(U1, R4)).length === 1 && (await starting(H, R4)).length === 1);
  const afterBlock = await http("PUT", `/api/rooms/${R4}/reminder`, U2);
  check("and a blocked user cannot set one (404)", afterBlock.status === 404, JSON.stringify(afterBlock));

  // ---- minors' rooms
  const T = await mk("teenhost", yearsAgo(15));
  const T2 = await mk("teen2", yearsAgo(16));
  const AD = await mk("adult", yearsAgo(30));      // mutual friend of the teen host, never invited
  const AI = await mk("adultinv", yearsAgo(30));   // personally invited and acknowledged
  const AR = await mk("adultrev", yearsAgo(30));   // acknowledged, then revoked before send time
  for (const x of [T2, AD, AI, AR]) await mutual(T, x);
  const secret = `Secret teen title ${stamp}`;
  const M = await mkRoom(T, secret);
  check("setup: the teen host's room is a minors' room", (await q(`select minors_room from rooms where id=$1`, [M]))[0].minors_room === true);
  const adultPut = await http("PUT", `/api/rooms/${M}/reminder`, AD);
  check("an adult without an acknowledged invite cannot set a reminder on a scheduled minors' room (404)", adultPut.status === 404 && !adultPut.text.includes(secret), JSON.stringify(adultPut));
  const teenPut = await http("PUT", `/api/rooms/${M}/reminder`, T2);
  check("a teen mutual friend can", teenPut.status === 200 && teenPut.json?.reminder === true, JSON.stringify(teenPut));
  await q(`insert into room_adult_invites (room_id, user_id, invited_by, acknowledged_at, first_acknowledged_at) values ($1,$2,$3,now(),now()), ($1,$4,$3,now(),now())`, [M, AI, T, AR]);
  check("an adult with an acknowledged invite can", (await http("PUT", `/api/rooms/${M}/reminder`, AI)).status === 200);
  check("(second invitee too)", (await http("PUT", `/api/rooms/${M}/reminder`, AR)).status === 200);
  await q(`update room_adult_invites set revoked_at=now() where room_id=$1 and user_id=$2`, [M, AR]);
  // A row that should never exist (an adult with no invite) must still be refused at send time.
  await q(`insert into room_reminders (room_id, user_id) values ($1,$2) on conflict do nothing`, [M, AD]);
  await runReminderPass(now());
  check("minors' room: the teen, the invited adult and the host are told", (await starting(T2, M)).length === 1 && (await starting(AI, M)).length === 1 && (await starting(T, M)).length === 1);
  check("minors' room: an adult with no invite, and one whose invite was revoked, are NOT told", (await starting(AD, M)).length === 0 && (await starting(AR, M)).length === 0);
  const leaked = await q(`select 1 from notifications where related_entity_id=$1 and user_id in ($2,$3) and (title like $4 or message like $4)`, [M, AD, AR, `%${secret}%`]);
  check("no notification naming the minors' room went to anyone not allowed to see it", leaked.length === 0);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
