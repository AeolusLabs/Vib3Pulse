// Minors' rooms over REST (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-minorsroom.ts
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix mrA_.
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
const { roomHub } = await import("../server/rooms/RoomHub");
const { tuning } = await import("../server/rooms/roomSocket");
const rs = await import("../server/rooms/roomStorage");
const { MINORS_ROOM_WARNING } = await import("../shared/rooms");

tuning.graceMs = 30 * 60_000; // nobody connects a socket here: a started room must not auto-end behind the tests

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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.12.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
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
   values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days') returning id`, [`mrA_${name}${stamp}@t.dev`, `mrA_${name}${stamp}`, hash, dob]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [a, b]);
const mutual = async (a: string, b: string) => { await follow(a, b); await follow(b, a); };
const block = (a: string, b: string) => q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [a, b]);
const notes = async (uid: string, roomId: string) => q(`select title, message, link from notifications where user_id=$1 and related_entity_id=$2`, [uid, roomId]);
const listIds = async (as: string, scope: string) => ((await http("GET", `/api/rooms?scope=${scope}`, as)).json?.rooms ?? []).map((r: any) => r.id as string);
const SECRET_KEYS = /passwordHash|password_hash|dateOfBirth|date_of_birth|"email"|resetToken|verificationToken/;

try {
  const T = await mk("teenhost", yearsAgo(15));
  const T2 = await mk("teen2", yearsAgo(16));
  const A = await mk("adultfriend", yearsAgo(30)); // mutual friend of the teen host, never invited
  const B = await mk("invited", yearsAgo(30));     // invited and acknowledges
  const F = await mk("invited2", yearsAgo(40));    // invited later, used for revoke / ban
  const C = await mk("stranger", yearsAgo(30));    // no relation to the host
  const D = await mk("blocked", yearsAgo(30));     // mutual friend, but the host blocked them
  const N = await mk("nodob", null);               // unknown age, mutual friend
  const E = await mk("member", yearsAgo(30));      // an adult with a member row but no invite
  const AH = await mk("adulthost", yearsAgo(30));
  for (const x of [A, B, F, D, N, T2, E]) await mutual(T, x);
  await block(T, D);
  const title = `Secret teen title ${stamp}`;

  // ---- creation: the flag comes from the host's age only
  const cr = await http("POST", "/api/rooms", T, { title, kind: "party", visibility: "friends", minorsRoom: false });
  check("teen host's new room is a minors' room (client-sent minorsRoom:false ignored)", cr.status === 201 && cr.json?.room?.minorsRoom === true, JSON.stringify(cr.json));
  const R = cr.json.room.id as string;
  const ca = await http("POST", "/api/rooms", AH, { title: "Adult room", kind: "party", visibility: "friends", minorsRoom: true });
  check("adult host's new room is not a minors' room (client-sent minorsRoom:true ignored)", ca.status === 201 && ca.json?.room?.minorsRoom === false, JSON.stringify(ca.json));
  const AR = ca.json.room.id as string;
  const pub = await http("POST", "/api/rooms", T, { title: "pub", kind: "party", visibility: "public" });
  check("existing rule unchanged: a teen host still cannot host a public room (TEEN_PUBLIC)", pub.status === 403 && pub.json?.code === "TEEN_PUBLIC", JSON.stringify(pub.json));
  const pt = await http("PATCH", `/api/rooms/${R}`, T, { minorsRoom: false, title });
  check("PATCH cannot clear the flag", pt.status === 200 && (await rs.getRoom(R))!.minorsRoom === true, JSON.stringify(pt.json));

  // ---- personal invite: who may be invited
  const nonHost = await http("POST", `/api/rooms/${R}/adult-invites/${B}`, T2);
  check("only the host can invite an adult (a teen guest gets 403)", nonHost.status === 403, JSON.stringify(nonHost));
  const adultTry = await http("POST", `/api/rooms/${R}/adult-invites/${C}`, A);
  check("an adult cannot invite (even themself): the room reads as not found", adultTry.status === 404, JSON.stringify(adultTry));
  for (const [label, who] of [["a teen", T2], ["unknown age", N], ["a blocked adult", D], ["the host", T], ["a missing user", "00000000-0000-0000-0000-000000000000"]] as const) {
    const r = await http("POST", `/api/rooms/${R}/adult-invites/${who}`, T);
    check(`inviting ${label} is refused with the one NOT_ALLOWED answer`, r.status === 403 && r.json?.code === "NOT_ALLOWED" && r.json?.message === "You can't invite this person.", JSON.stringify(r));
  }
  const notMinors = await http("POST", `/api/rooms/${AR}/adult-invites/${B}`, AH);
  check("adult invites only exist for minors' rooms (409 NOT_MINORS_ROOM)", notMinors.status === 409 && notMinors.json?.code === "NOT_MINORS_ROOM", JSON.stringify(notMinors));

  const inv = await http("POST", `/api/rooms/${R}/adult-invites/${B}`, T);
  check("host invites an adult: 200, not yet acknowledged", inv.status === 200 && inv.json?.ok === true && inv.json?.invite?.acknowledged === false && inv.json?.invite?.userId === B, JSON.stringify(inv));
  const bn = await notes(B, R);
  check("invite notification says only 'X invited you to a room': no room title", bn.length === 1 && /invited you to a room$/.test(bn[0].title) && !bn[0].title.includes(title) && !bn[0].message.includes(title) && bn[0].link === `/rooms/${R}`, JSON.stringify(bn));

  // ---- invited but not acknowledged
  const bAck = await http("GET", `/api/rooms/${R}`, B);
  check("invited, not acknowledged: GET is 403 MINORS_ROOM_ACK with the warning", bAck.status === 403 && bAck.json?.code === "MINORS_ROOM_ACK" && bAck.json?.warning === MINORS_ROOM_WARNING, JSON.stringify(bAck));
  check("...and nothing about the room (no title, host, members)", !bAck.text.includes(title) && !bAck.text.includes(T) && !bAck.text.includes("teenhost") && JSON.stringify(Object.keys(bAck.json).sort()) === JSON.stringify(["canJoin", "code", "message", "warning"]), bAck.text);
  check("invited, not acknowledged: not in the upcoming list", !(await listIds(B, "upcoming")).includes(R));

  // ---- acknowledgement is per user and recorded with a time
  const aAckTry = await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, A, { ack: true });
  check("an uninvited adult cannot acknowledge their way in (403 MINORS_ROOM + warning)", aAckTry.status === 403 && aAckTry.json?.code === "MINORS_ROOM" && aAckTry.json?.warning === MINORS_ROOM_WARNING, JSON.stringify(aAckTry));
  const cAckTry = await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, C, { ack: true });
  check("a stranger acknowledging gets 404 (the room is not even confirmed)", cAckTry.status === 404, JSON.stringify(cAckTry));
  const tAck = await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, T2);
  check("a teen has nothing to acknowledge (409 NOT_NEEDED)", tAck.status === 409 && tAck.json?.code === "NOT_NEEDED", JSON.stringify(tAck));
  const ack = await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B, { ack: false, acknowledged: false });
  const ackRow = (await q(`select acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B]))[0];
  check("the invited adult acknowledges: 200 and the time is stored (body flags ignored)", ack.status === 200 && ack.json?.acknowledged === true && ackRow?.acknowledged_at instanceof Date, JSON.stringify({ ack, ackRow }));
  await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B);
  const ackRow2 = (await q(`select acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B]))[0];
  check("acknowledging again keeps the first time", ackRow2.acknowledged_at.getTime() === ackRow.acknowledged_at.getTime());
  const bOk = await http("GET", `/api/rooms/${R}`, B);
  check("invited + acknowledged adult: GET is 200 with the room", bOk.status === 200 && bOk.json?.room?.title === title && bOk.json?.canJoin?.ok === true, JSON.stringify(bOk.json));
  check("the invite does not transfer: the adult friend is still refused", (await http("GET", `/api/rooms/${R}`, A)).json?.code === "MINORS_ROOM");

  // ---- start: live notifications go to teens and acknowledged invitees only
  await follow(A, T); await follow(B, T); await follow(T2, T); await follow(N, T); await follow(C, T);
  const st = await http("POST", `/api/rooms/${R}/start`, T);
  check("teen host starts the room", st.status === 200 && st.json?.room?.status === "live", JSON.stringify(st.json));
  const liveNote = async (u: string) => (await notes(u, R)).filter((n: any) => /is live/.test(n.title));
  check("room_live notification: the teen follower gets it", (await liveNote(T2)).length === 1);
  check("room_live notification: the acknowledged invitee gets it", (await liveNote(B)).length === 1);
  check("room_live notification: the adult mutual friend does NOT", (await liveNote(A)).length === 0 && (await notes(A, R)).length === 0);
  check("room_live notification: unknown age and strangers do NOT", (await notes(N, R)).length === 0 && (await notes(C, R)).length === 0);

  // ---- lists
  check("live list: the adult mutual friend does not see it", !(await listIds(A, "live")).includes(R));
  check("friends list: the adult mutual friend does not see it", !(await listIds(A, "friends")).includes(R));
  check("live list: unknown age does not see it", !(await listIds(N, "live")).includes(R));
  check("live list: the blocked adult does not see it", !(await listIds(D, "live")).includes(R));
  check("live list: the teen friend sees it", (await listIds(T2, "live")).includes(R));
  check("live list: the acknowledged invitee sees it", (await listIds(B, "live")).includes(R));
  check("live list: the host sees it", (await listIds(T, "live")).includes(R));

  // ---- GET for everyone else
  const aGet = await http("GET", `/api/rooms/${R}`, A);
  check("adult friend without invite: GET 403 MINORS_ROOM, exact warning", aGet.status === 403 && aGet.json?.code === "MINORS_ROOM" && aGet.json?.warning === MINORS_ROOM_WARNING && aGet.json?.message === MINORS_ROOM_WARNING, JSON.stringify(aGet));
  check("...no title, no host, no members, no counts", !aGet.text.includes(title) && !aGet.text.includes(T) && JSON.stringify(Object.keys(aGet.json ?? {}).sort()) === JSON.stringify(["canJoin", "code", "message", "warning"]), aGet.text);
  const nGet = await http("GET", `/api/rooms/${R}`, N);
  check("unknown age: GET 403 AGE_UNKNOWN, no room details and no warning", nGet.status === 403 && nGet.json?.code === "AGE_UNKNOWN" && !nGet.text.includes(title) && !nGet.text.includes("legal action"), nGet.text);
  const cGet = await http("GET", `/api/rooms/${R}`, C);
  const missing = await http("GET", `/api/rooms/00000000-0000-0000-0000-000000000000`, C);
  check("stranger (not a friend): plain 404, same as a room that does not exist", cGet.status === 404 && cGet.text === missing.text, cGet.text);
  const dGet = await http("GET", `/api/rooms/${R}`, D);
  check("blocked adult: same 404 as does-not-exist", dGet.status === 404 && dGet.text === missing.text, dGet.text);
  const t2Get = await http("GET", `/api/rooms/${R}`, T2);
  check("teen friend: GET 200, no warning", t2Get.status === 200 && t2Get.json?.room?.title === title && !t2Get.text.includes("legal action"), t2Get.text.slice(0, 200));
  const hGet = await http("GET", `/api/rooms/${R}`, T);
  check("host: GET 200", hGet.status === 200 && hGet.json?.you?.role === "host");

  // ---- every other endpoint treats the room as not found for an adult without access
  roomHub.join(R, { userId: T, role: "host", muted: false, joinedAt: Date.now(), send: () => {} });
  roomHub.join(R, { userId: T2, role: "guest", muted: false, joinedAt: Date.now(), send: () => {} });
  const act = await http("GET", `/api/rooms/${R}/members/${T2}/actions`, A);
  check("actions endpoint: 404 for the adult friend", act.status === 404, JSON.stringify(act));
  const rep = await http("POST", `/api/rooms/${R}/report`, A, { reason: "x" });
  check("report endpoint: 404 for the adult friend", rep.status === 404, JSON.stringify(rep));
  const vt = await http("POST", `/api/rooms/${R}/voice-token`, A);
  check("voice-token endpoint: 404 for the adult friend", vt.status === 404, JSON.stringify(vt));
  const ban = await http("POST", `/api/rooms/${R}/members/${T2}/ban`, A);
  check("moderation endpoints: 404 for the adult friend", ban.status === 404, JSON.stringify(ban));
  const list = await http("GET", `/api/rooms/${R}/adult-invites`, A);
  check("adult invite list: 404 for an adult, 403 for a teen guest", list.status === 404 && (await http("GET", `/api/rooms/${R}/adult-invites`, T2)).status === 403);

  // ---- the generic room invite never sends a minors' room to an adult
  const gInvA = await http("POST", `/api/rooms/${R}/invite/${A}`, T);
  check("generic invite of an adult to a minors' room is refused (it would name the room)", gInvA.status === 403 && (await notes(A, R)).length === 0, JSON.stringify(gInvA));

  // ---- invite-token link: never enough for an adult
  const ri = await http("POST", "/api/rooms", T, { title: `Invite only ${stamp}`, kind: "party", visibility: "invite" });
  const link = ri.json?.inviteLink as string;
  const tok = new URL(`http://x${link}`).searchParams.get("token")!;
  const RI = ri.json.room.id as string;
  const cTok = await http("GET", `/api/rooms/${RI}?token=${tok}`, C);
  check("invite link used by an adult without a personal invite: 403 MINORS_ROOM + warning, no title", cTok.status === 403 && cTok.json?.code === "MINORS_ROOM" && cTok.json?.warning === MINORS_ROOM_WARNING && !cTok.text.includes("Invite only"), cTok.text);
  const t2Tok = await http("GET", `/api/rooms/${RI}?token=${tok}`, T2);
  check("the same link works for a teen", t2Tok.status === 200, JSON.stringify(t2Tok.json));
  const cTokRep = await http("POST", `/api/rooms/${RI}/report?token=${tok}`, C, { reason: "x" });
  check("report with the link: 404 for that adult", cTokRep.status === 404);

  // ---- host's invite list: sanitized
  const hl = await http("GET", `/api/rooms/${R}/adult-invites`, T);
  check("host's invite list shows the invited adult, acknowledged", hl.status === 200 && hl.json?.invites?.length === 1 && hl.json.invites[0].user?.id === B && hl.json.invites[0].acknowledged === true, JSON.stringify(hl.json));
  check("...with public profile bits only (no birthdate, email, password hash, tokens)", !SECRET_KEYS.test(hl.text), hl.text);

  // ---- co-host promotion of an adult
  await rs.upsertMember(R, E, "guest"); // an adult who somehow has a member row but no invite
  const coE = await http("PUT", `/api/rooms/${R}/members/${E}/role`, T, { role: "cohost" });
  check("an adult without an invite cannot be made co-host", coE.status === 403, JSON.stringify(coE));
  const eGet = await http("GET", `/api/rooms/${R}`, E);
  check("...and a member row alone does not open the room to an adult", eGet.status === 403 && eGet.json?.code === "MINORS_ROOM", JSON.stringify(eGet));
  await rs.upsertMember(R, B, "guest");
  const coB = await http("PUT", `/api/rooms/${R}/members/${B}/role`, T, { role: "cohost" });
  check("an invited, acknowledged adult can be made co-host", coB.status === 200, JSON.stringify(coB));

  // ---- revoke removes the adult (role, access, live presence)
  const gotB: any[] = [];
  roomHub.join(R, { userId: B, role: "cohost", muted: false, joinedAt: Date.now(), send: (m) => gotB.push(m) });
  const rv = await http("DELETE", `/api/rooms/${R}/adult-invites/${B}`, T);
  check("host revokes: 200 revoked", rv.status === 200 && rv.json?.revoked === true, JSON.stringify(rv));
  check("revoke removes the adult from the live room", !roomHub.get(R, B));
  check("...telling them why, with the warning", gotB.some((m) => m.type === "room:error" && m.code === "MINORS_ROOM" && m.warning === MINORS_ROOM_WARNING), JSON.stringify(gotB));
  check("...the co-host role goes with the invite", (await rs.getMember(R, B))?.role === "guest");
  check("...GET is refused again (MINORS_ROOM)", (await http("GET", `/api/rooms/${R}`, B)).json?.code === "MINORS_ROOM");
  check("...and the room leaves their list", !(await listIds(B, "live")).includes(R));
  check("...the revoke time is kept with the acknowledgement time", (await q(`select revoked_at, acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B])).every((r: any) => r.revoked_at && r.acknowledged_at));
  const nonHostRv = await http("DELETE", `/api/rooms/${R}/adult-invites/${F}`, T2);
  check("only the host can revoke", nonHostRv.status === 403);
  const reInv = await http("POST", `/api/rooms/${R}/adult-invites/${B}`, T);
  check("re-inviting after a revoke needs a fresh acknowledgement", reInv.status === 200 && reInv.json?.invite?.acknowledged === false && (await http("GET", `/api/rooms/${R}`, B)).json?.code === "MINORS_ROOM_ACK", JSON.stringify(reInv));

  // ---- a ban outranks an old invite
  await http("POST", `/api/rooms/${R}/adult-invites/${F}`, T);
  await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, F);
  check("F invited and acknowledged", (await http("GET", `/api/rooms/${R}`, F)).status === 200);
  const bF = await http("POST", `/api/rooms/${R}/members/${F}/ban`, T);
  check("host bans the invited adult", bF.status === 200, JSON.stringify(bF));
  const fGet = await http("GET", `/api/rooms/${R}`, F);
  check("banned adult with an old invite: refused, no room details", fGet.status === 403 && fGet.json?.code === "MINORS_ROOM" && !fGet.text.includes(title), fGet.text);
  const fInv = await http("POST", `/api/rooms/${R}/adult-invites/${F}`, T);
  check("a banned adult cannot be invited again", fInv.status === 403 && fInv.json?.code === "NOT_ALLOWED", JSON.stringify(fInv));
  await http("POST", `/api/rooms/${R}/members/${F}/unban`, T);
  check("unbanning does not bring the old invite back", (await http("GET", `/api/rooms/${R}`, F)).json?.code === "MINORS_ROOM");

  // ---- rate limit on adult invites (per host)
  let limited = false;
  const Hs = await mk("rlhost", yearsAgo(14));
  const rr = await http("POST", "/api/rooms", Hs, { title: "rl", kind: "party", visibility: "friends" });
  const targets = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(`rl${i}`, yearsAgo(25))));
  for (const t of targets) { const r = await http("POST", `/api/rooms/${rr.json.room.id}/adult-invites/${t}`, Hs); if (r.status === 429 && r.json?.code === "RATE_LIMITED") limited = true; }
  check("adult invites are rate limited per host (429 RATE_LIMITED after a burst of 10)", limited);

  // ---- host turns 18 mid-room: the room stays a minors' room; their new rooms are normal
  await q(`update users set date_of_birth=$1 where id=$2`, [yearsAgo(18), T]);
  check("host turned 18: the live room is still a minors' room for an adult", (await http("GET", `/api/rooms/${R}`, A)).json?.code === "MINORS_ROOM");
  check("...the host themself is never blocked", (await http("GET", `/api/rooms/${R}`, T)).status === 200);
  const later = await http("POST", "/api/rooms", T, { title: "now adult", kind: "party", visibility: "friends" });
  check("...and their next new room is a normal room", later.status === 201 && later.json?.room?.minorsRoom === false, JSON.stringify(later.json));

  // ---- an admin birthdate correction that makes a guest an adult takes them out of the minors' room
  const { correctDateOfBirth } = await import("../server/services/dobCorrection");
  const admin = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A','super_admin') returning id`,
    [`mrA_adm${stamp}`, `mrA_adm${stamp}@t.dev`, hash]))[0].id as string;
  const T3 = await mk("teen3", yearsAgo(16));
  const gotT3: any[] = [];
  roomHub.join(R, { userId: T3, role: "guest", muted: false, joinedAt: Date.now(), send: (m) => gotT3.push(m) });
  const fix = await correctDateOfBirth({ adminId: admin, userId: T3, dateOfBirth: yearsAgo(25), reason: "test correction" });
  check("DOB correction to an adult: the person is taken out of the minors' room, with the warning", fix.ok && !roomHub.get(R, T3) && gotT3.some((m) => m.type === "room:error" && m.code === "MINORS_ROOM" && m.warning === MINORS_ROOM_WARNING), JSON.stringify({ fix: fix.ok, gotT3 }));
  const T4 = await mk("teen4", yearsAgo(15));
  roomHub.join(R, { userId: T4, role: "guest", muted: false, joinedAt: Date.now(), send: () => {} });
  await correctDateOfBirth({ adminId: admin, userId: T4, dateOfBirth: yearsAgo(16), reason: "test correction" });
  check("...a correction that keeps them a teen leaves them in", !!roomHub.get(R, T4));

  // ---- a host corrected to under 18: open rooms become minors' rooms, uninvited adults inside are taken out
  const AH2 = await mk("fixhost", yearsAgo(30)), X = await mk("fixadult", yearsAgo(30)), Y = await mk("fixteen", yearsAgo(15));
  const LR = await rs.createRoom(AH2, { title: "was adult", kind: "party", visibility: "friends", ageLimit: "all" } as any); await rs.setStatus(LR.id, "live");
  const SR2 = await rs.createRoom(AH2, { title: "later", kind: "party", visibility: "friends", ageLimit: "all", scheduledFor: new Date(Date.now() + 3600e3).toISOString() } as any);
  const ER = await rs.createRoom(AH2, { title: "over", kind: "party", visibility: "friends", ageLimit: "all" } as any); await rs.setStatus(ER.id, "ended");
  const gotX: any[] = [];
  roomHub.join(LR.id, { userId: AH2, role: "host", muted: false, joinedAt: Date.now(), send: () => {} });
  roomHub.join(LR.id, { userId: X, role: "guest", muted: false, joinedAt: Date.now(), send: (m) => gotX.push(m) });
  roomHub.join(LR.id, { userId: Y, role: "guest", muted: false, joinedAt: Date.now(), send: () => {} });
  await correctDateOfBirth({ adminId: admin, userId: AH2, dateOfBirth: yearsAgo(15), reason: "test correction" });
  const flag = async (id: string) => (await rs.getRoom(id))!.minorsRoom;
  check("host corrected to 15: their live room becomes a minors' room", await flag(LR.id));
  check("...and their scheduled room", await flag(SR2.id));
  check("...but not an ended room", !(await flag(ER.id)));
  check("...the uninvited adult inside is taken out with the warning", !roomHub.get(LR.id, X) && gotX.some((m) => m.type === "room:error" && m.code === "MINORS_ROOM" && m.warning === MINORS_ROOM_WARNING), JSON.stringify(gotX));
  check("...the teen guest and the host stay", !!roomHub.get(LR.id, Y) && !!roomHub.get(LR.id, AH2));
  await correctDateOfBirth({ adminId: admin, userId: AH2, dateOfBirth: yearsAgo(30), reason: "test correction back" });
  check("...correcting them back to an adult never clears the flag", await flag(LR.id));

  // ---- backfill of rooms created before the flag existed (the exact statements ensureSchema and the migration run)
  const { MINORS_ROOMS_SCHEMA_SQL, MINORS_ROOMS_BACKFILL } = await import("../server/rooms/minorsRoomsMigration");
  const BT = await mk("bf_teen", yearsAgo(16)), BA = await mk("bf_adult", yearsAgo(30)), BE = await mk("bf_edge18", yearsAgo(18));
  const BJ = await mk("bf_junk", "2010-13-45"), BN = await mk("bf_null", null), BX = await mk("bf_text", "not a date");
  const exact18 = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 18); return d.toISOString().slice(0, 10); })();
  await q(`update users set date_of_birth=$1 where id=$2`, [exact18, BE]); // 18 today: an adult
  const seed = async (host: string, status: "live" | "scheduled" | "ended", visibility = "friends") => {
    const r = await rs.createRoom(host, { title: `bf ${status}`, kind: "party", visibility, ageLimit: "all" } as any);
    if (status !== "scheduled") await rs.setStatus(r.id, status);
    return r.id;
  };
  const bTeenLive = await seed(BT, "live"), bTeenSched = await seed(BT, "scheduled", "invite"), bTeenEnded = await seed(BT, "ended");
  const bAdultLive = await seed(BA, "live"), bEdge = await seed(BE, "live"), bJunk = await seed(BJ, "live"), bNull = await seed(BN, "scheduled"), bText = await seed(BX, "scheduled");
  check("backfill seed: all start with the flag off", !(await Promise.all([bTeenLive, bTeenSched, bTeenEnded, bAdultLive, bEdge, bJunk, bNull, bText].map(flag))).some(Boolean));
  await pool.query(MINORS_ROOMS_SCHEMA_SQL); // full batch: DDL is a no-op on an existing schema, then the backfill
  check("backfill: teen host's live friends room flipped", await flag(bTeenLive));
  check("backfill: teen host's scheduled invite room flipped", await flag(bTeenSched));
  check("backfill: teen host's ended room left alone", !(await flag(bTeenEnded)));
  check("backfill: adult host's room left alone", !(await flag(bAdultLive)));
  check("backfill: a host who is exactly 18 today is an adult (left alone)", !(await flag(bEdge)));
  check("backfill: malformed, null and non-date birthdates neither fail the statement nor flip anything", !(await flag(bJunk)) && !(await flag(bNull)) && !(await flag(bText)));
  const again = await pool.query(MINORS_ROOMS_BACKFILL);
  check("backfill: re-running changes nothing (idempotent) and keeps the flags", again.rowCount === 0 && (await flag(bTeenLive)) && !(await flag(bAdultLive)), String(again.rowCount));

  // ---- audit trail: a renewed invite needs a new acknowledgement but keeps the first one
  const fa = (await q(`select acknowledged_at, first_acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, F]))[0];
  check("audit: first_acknowledged_at is kept after ban/revoke (acknowledged_at too, on the revoked row)", fa?.first_acknowledged_at instanceof Date, JSON.stringify(fa));
  const bRow = (await q(`select acknowledged_at, first_acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B]))[0];
  check("audit: B's re-invite reset acknowledged_at but kept first_acknowledged_at from the first acknowledgement", bRow.acknowledged_at === null && bRow.first_acknowledged_at?.getTime() === ackRow.acknowledged_at.getTime(), JSON.stringify(bRow));
  await http("POST", `/api/rooms/${R}/adult-invites/acknowledge`, B);
  const bRow2 = (await q(`select acknowledged_at, first_acknowledged_at from room_adult_invites where room_id=$1 and user_id=$2`, [R, B]))[0];
  check("audit: acknowledging the renewed invite sets a new acknowledged_at and leaves first_acknowledged_at", bRow2.acknowledged_at instanceof Date && bRow2.acknowledged_at.getTime() > bRow2.first_acknowledged_at.getTime() && bRow2.first_acknowledged_at.getTime() === ackRow.acknowledged_at.getTime(), JSON.stringify(bRow2));
  // Accounts are normally soft-deleted; a hard delete of the inviting account must still not erase the evidence row.
  const tmpHost = await mk("bf_delhost", yearsAgo(15)), tmpAdult = await mk("bf_deladult", yearsAgo(30));
  const tr = await rs.createRoom(tmpHost, { title: "d", kind: "party", visibility: "friends", ageLimit: "all", minorsRoom: true } as any);
  const tr2 = await rs.createRoom(BT, { title: "d2", kind: "party", visibility: "friends", ageLimit: "all", minorsRoom: true } as any);
  await q(`insert into room_adult_invites (room_id, user_id, invited_by) values ($1,$2,$3)`, [tr2.id, tmpAdult, tmpHost]);
  await q(`delete from rooms where id=$1`, [tr.id]); await q(`delete from users where id=$1`, [tmpHost]);
  const kept = await q(`select invited_by from room_adult_invites where room_id=$1 and user_id=$2`, [tr2.id, tmpAdult]);
  check("audit: deleting the inviting account keeps the invite row, invited_by becomes null", kept.length === 1 && kept[0].invited_by === null, JSON.stringify(kept));

  check("no response in this file leaked the warning to a teen", t2Get.text.indexOf("legal action") === -1 && t2Tok.text.indexOf("legal action") === -1);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
