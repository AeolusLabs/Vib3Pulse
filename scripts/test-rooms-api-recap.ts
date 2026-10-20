// Phase 6 over a throwaway database: recap access and fields (members only, moderation, untracked rooms, the admin read
// path), one notification per spray (fix round owner decision), the money notifications, notifyFriendsLive and the
// all-followers go-live notice.   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-recap.ts
// Refuses to run unless the database name contains "test", because it creates users. Usernames use the prefix rc_.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
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
const { registerRoomRecapAdminRoute } = await import("../server/rooms/recap");
const { liveNoticeSettled, LIVE_NOTIFY_CHUNK } = await import("../server/rooms/liveNotify");
const notify = await import("../server/rooms/notify");
const rs = await import("../server/rooms/roomStorage");
const { sprayNoticeKey } = await import("../shared/roomNotifications");

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
  // Admin session stand-in (the real gate reads req.session.adminId and re-reads the admin row).
  const adminId = req.header("x-test-admin");
  req.session = adminId ? { adminId, destroy: (cb: any) => cb?.() } : { destroy: (cb: any) => cb?.() };
  req.isAuthenticated = () => !!req.user;
  req.login = (_u: unknown, cb: (e?: unknown) => void) => cb();
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
registerRoomRecapAdminRoute(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown, admin?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json", "x-forwarded-for": `10.14.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`,
      ...(as ? { "x-test-user": as } : {}), ...(admin ? { "x-test-admin": admin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const mk = async (name: string) => (await q(
  `insert into users (email, username, display_name, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,$3,'social',$4,true,true,$5, now() - interval '60 days') returning id`,
  [`rc_${name}${stamp}@t.dev`, `rc_${name}${stamp}`, `Payer${name}Secret`, hash, yearsAgo(30)]))[0].id as string;
const follow = (a: string, b: string) => q(`insert into follows (follower_id, following_id, created_at) values ($1,$2,$3) on conflict do nothing`, [a, b, new Date().toISOString()]);
const block = (a: string, b: string) => q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [a, b]);

/** A room that went live an hour ago and ended now (or is still live / never started). */
async function mkRoom(hostId: string, state: "ended" | "live" | "cancelled", title = "Friday Pre-Drinks"): Promise<string> {
  const started = state === "cancelled" ? null : new Date(Date.now() - 3600_000).toISOString();
  const ended = state === "live" ? null : new Date(Date.now() - 1000).toISOString();
  return (await q(
    `insert into rooms (host_id, title, kind, visibility, age_limit, status, started_at, ended_at)
     values ($1, $2, 'party', 'public', '18+', $3, $4::timestamp, $5::timestamp) returning id`,
    [hostId, title, state === "live" ? "live" : "ended", started, ended]))[0].id as string;
}
const member = (roomId: string, userId: string, role: string, secondsIn: number, messages: number) => q(
  `insert into room_members (room_id, user_id, role, joined_at, left_at, seconds_in, messages_sent)
   values ($1,$2,$3, now() - interval '50 minutes', now(), $4, $5)`, [roomId, userId, role, secondsIn, messages]);

let refSeq = 0;
/** A delivered spray: tier note, 500 naira. host share 40000, a stage guest's 10000 when recipient is not the host. */
async function delivered(roomId: string, hostId: string, payerId: string, recipientId: string): Promise<string> {
  const stage = recipientId !== hostId;
  const [host, guest, platform] = stage ? [30000, 10000, 10000] : [40000, null, 10000];
  return (await q(
    `insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo,
                                 vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, guest_kobo, provider, provider_ref, status, paid_at, delivered_at)
     values ($1, 'h', $2, $3, $4, $5, 'note', 50000, 50000, 0, 0, 0, $6, $7, $8, 'paystack', $9, 'delivered', now(), now()) returning id`,
    [crypto.randomUUID(), roomId, hostId, payerId, recipientId, platform, host, guest, `rc-test-${stamp}-${refSeq++}`],
  ))[0].id as string;
}
/** Every spray notice this person has for sprays in this room. */
const sprayNotes = (uid: string, roomId: string) =>
  q(`select n.id, n.title, n.message, n.link, n.related_user_id, n.related_entity_id, n.is_read
       from notifications n
      where n.user_id = $1 and n.type = 'spray_received'
        and n.related_entity_id in (select 'spray-received:' || s.id::text from spray_payments s where s.room_id = $2)`, [uid, roomId]);

try {
  const H = await mk("host"), G = await mk("guest"), N = await mk("never"), B = await mk("banned"), K = await mk("blocked"), P = await mk("payer"), S = await mk("stage");

  // ------------------------------------------------------------------ recap access
  const R = await mkRoom(H, "ended");
  await member(R, H, "host", 3500, 3);
  await member(R, G, "guest", 1500, 7);
  await member(R, B, "guest", 600, 1); await q(`update room_members set banned = true where room_id=$1 and user_id=$2`, [R, B]);
  await member(R, K, "guest", 600, 1); await block(H, K);
  await rs.setMemberFlag(R, N, { muted: true }); // a row for someone who never joined (NEVER_JOINED)
  await q(`update rooms set peak_members = 12 where id = $1`, [R]);

  const g = await http("GET", `/api/rooms/${R}/recap`, G);
  check("guest who was in the ended room gets a recap", g.status === 200 && g.json?.isHost === false, g.text);
  check("guest recap: own minutes and messages", g.json?.recap?.minutesIn === 25 && g.json?.recap?.messages === 7, JSON.stringify(g.json?.recap));
  check("guest never sees host-only fields", !!g.json && ["minutes", "peak", "ticketsSold", "followersGained", "earnedKobo"].every((k) => !(k in g.json.recap)), JSON.stringify(g.json?.recap));
  check("guest recap names nobody but the host", !g.text.includes(`rc_banned${stamp}`) && !g.text.includes(`rc_blocked${stamp}`) && !g.text.includes("PayerpayerSecret"));

  const nv = await http("GET", `/api/rooms/${R}/recap`, N);
  check("a viewer who never joined (ban-before-arrival row) gets 404", nv.status === 404, nv.text);
  const stranger = await http("GET", `/api/rooms/${R}/recap`, P);
  check("a viewer with no membership gets 404", stranger.status === 404);
  check("a banned member gets 404", (await http("GET", `/api/rooms/${R}/recap`, B)).status === 404);
  check("a member blocked with the host gets 404", (await http("GET", `/api/rooms/${R}/recap`, K)).status === 404);
  check("unauthenticated gets 401", (await http("GET", `/api/rooms/${R}/recap`, null)).status === 401);
  check("unknown room gets 404", (await http("GET", `/api/rooms/${crypto.randomUUID()}/recap`, G)).status === 404);

  const L = await mkRoom(H, "live");
  await member(L, G, "guest", 60, 1);
  check("a room that has not ended gets 404 (even for its host)", (await http("GET", `/api/rooms/${L}/recap`, G)).status === 404 && (await http("GET", `/api/rooms/${L}/recap`, H)).status === 404);
  const C = await mkRoom(H, "cancelled");
  check("a room that never went live gets 404", (await http("GET", `/api/rooms/${C}/recap`, H)).status === 404);

  // host numbers, from stored rows only
  await delivered(R, H, P, H);
  await delivered(R, H, P, S);
  await q(`insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status)
           values ($1,$2,200000,0,0,0,30000,170000,'paystack',$3,'paid')`, [R, P, `rc-t-${stamp}-1`]);
  await q(`insert into room_tickets (room_id, user_id, amount_kobo, vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, provider, provider_ref, status, refund_reason)
           values ($1,$2,200000,0,0,0,30000,170000,'paystack',$3,'refunded','buyer')`, [R, G, `rc-t-${stamp}-2`]);
  await follow(G, H); // G was in the room and followed while it was "live"? created_at = now, after ended_at: not counted
  const h = await http("GET", `/api/rooms/${R}/recap`, H);
  check("host recap: peak from rooms.peak_members", h.status === 200 && h.json?.recap?.peak === 12, h.text);
  check("host recap: ticketsSold counts paid tickets only", h.json?.recap?.ticketsSold === 1, JSON.stringify(h.json?.recap));
  check("host recap: earnedKobo = paid ticket host_kobo + delivered sprays' host_kobo", h.json?.recap?.earnedKobo === 170000 + 40000 + 30000, JSON.stringify(h.json?.recap));
  check("host recap: a follow made after the room ended is not a follower gained", h.json?.recap?.followersGained === 0, JSON.stringify(h.json?.recap));
  check("host recap: minutes the room was live", h.json?.recap?.minutes === 59 || h.json?.recap?.minutes === 60, JSON.stringify(h.json?.recap));
  check("guest recap now shows follow true", (await http("GET", `/api/rooms/${R}/recap`, G)).json?.recap?.follow === true);

  // next room: only one the viewer may see
  const fut = new Date(Date.now() + 86400_000).toISOString();
  await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for) values ($1,'Hidden','party','invite','18+','scheduled',$2::timestamp)`, [H, fut]);
  check("next room: an invite-only room is not offered to a guest", (await http("GET", `/api/rooms/${R}/recap`, G)).json?.recap?.next === null);
  const nextId = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status, scheduled_for) values ($1,'Next','party','public','18+','scheduled',$2::timestamp) returning id`,
    [H, new Date(Date.now() + 2 * 86400_000).toISOString()]))[0].id;
  check("next room: the host's next public room is offered", (await http("GET", `/api/rooms/${R}/recap`, G)).json?.recap?.next?.roomId === nextId);

  // peak is never in a room object for anyone
  const rv = await http("GET", `/api/rooms/${R}`, G);
  check("GET /api/rooms/:id never carries peakMembers", rv.status === 200 && !("peakMembers" in (rv.json?.room ?? {})), rv.text.slice(0, 200));

  // ------------------------------------------------------------------ recap: fix round (moderation, untracked rooms, admin)
  const M = await mkRoom(H, "ended", "Taken down");
  await member(M, H, "host", 600, 1); await member(M, G, "guest", 600, 2);
  await q(`update rooms set peak_members = 3, moderation_status = 'removed' where id = $1`, [M]);
  check("a room taken down by moderation: no recap for the host or a guest (r2 m4)",
    (await http("GET", `/api/rooms/${M}/recap`, H)).status === 404 && (await http("GET", `/api/rooms/${M}/recap`, G)).status === 404);
  const OLD = await mkRoom(H, "ended", "Before tracking");
  await member(OLD, G, "guest", 0, 0); // peak_members stays NULL: ended before the counters existed
  const old = await http("GET", `/api/rooms/${OLD}/recap`, G);
  check("a room that ended before tracking: minutesIn and messages are null, never a false 0 (r2 I5)",
    old.status === 200 && old.json?.recap?.minutesIn === null && old.json?.recap?.messages === null, JSON.stringify(old.json?.recap));
  const oldHost = await http("GET", `/api/rooms/${OLD}/recap`, H);
  check("... and the host's peak is null too", oldHost.json?.recap?.peak === null && oldHost.json?.recap?.minutesIn === null, JSON.stringify(oldHost.json?.recap));

  const admin = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A','content_moderator') returning id`,
    [`rc_adm${stamp}`, `rc_adm${stamp}@t.dev`, hash]))[0].id as string;
  const support = (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A','user_support') returning id`,
    [`rc_sup${stamp}`, `rc_sup${stamp}@t.dev`, hash]))[0].id as string;
  const ad = await http("GET", `/api/admin/rooms/${R}/recap`, null, undefined, admin);
  check("admin read path: the host's view (host-only fields), marked adminView", ad.status === 200 && ad.json?.adminView === true
    && ad.json?.recap?.earnedKobo === 170000 + 40000 + 30000 && ad.json?.recap?.peak === 12, ad.text);
  check("admin read path: audited", (await q(`select 1 from admin_activity_logs where admin_id = $1 and action = 'room.recap_viewed' and target_id = $2`, [admin, R])).length === 1);
  check("admin read path: a taken-down room is still readable by an admin", (await http("GET", `/api/admin/rooms/${M}/recap`, null, undefined, admin)).status === 200);
  check("admin read path: a user session (even the host) never reaches it", [401, 403].includes((await http("GET", `/api/admin/rooms/${R}/recap`, H)).status));
  check("admin read path: an admin without a moderator role gets 403", (await http("GET", `/api/admin/rooms/${R}/recap`, null, undefined, support)).status === 403);
  check("admin read path: a user id presented as an admin id is refused", [401, 403].includes((await http("GET", `/api/admin/rooms/${R}/recap`, null, undefined, H)).status));
  check("admin read path: a live room has no recap (404)", (await http("GET", `/api/admin/rooms/${L}/recap`, null, undefined, admin)).status === 404);

  // ------------------------------------------------------------------ one notification per spray (owner decision)
  const R2 = await mkRoom(H, "live", "Spray Room");
  const s1 = await delivered(R2, H, P, H);
  await notify.notifySprayReceived(H, R2, 40000, s1);
  let notes = await sprayNotes(H, R2);
  check("a spray: one notification with THAT spray's amount", notes.length === 1 && /₦400\b/.test(notes[0].title) && notes[0].related_entity_id === sprayNoticeKey(s1), JSON.stringify(notes));
  check("spray notification never carries the payer", notes.every((n: any) => n.related_user_id === null && !/Payer|rc_payer/.test(`${n.title} ${n.message}`)));
  check("spray notification links to earnings", notes[0]?.link === "/rooms/earnings");
  await notify.notifySprayReceived(H, R2, 40000, s1);
  check("a retried finalize for the same spray never notifies twice", (await sprayNotes(H, R2)).length === 1);

  // 300 sprays: 300 notifications, each with its own amount (never a running total); concurrency is capped, nothing lost.
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) ids.push(await delivered(R2, H, P, H));
  await Promise.all(ids.map((id) => notify.notifySprayReceived(H, R2, 40000, id)));
  notes = await sprayNotes(H, R2);
  check("300 sprays: 300 notifications (one each)", notes.length === 301, String(notes.length));
  check("every one states only its own spray's amount", notes.every((n: any) => /You received ₦400 in /.test(n.title)), notes.find((n: any) => !/₦400 in/.test(n.title))?.title);
  // A burst of the same ids again (retries): still 301.
  await Promise.all(ids.slice(0, 50).map((id) => notify.notifySprayReceived(H, R2, 40000, id)));
  check("retries of the burst add nothing", (await sprayNotes(H, R2)).length === 301);

  // stage guest gets their share, the host their cut, separately
  const s2 = await delivered(R2, H, P, S);
  await notify.notifySprayReceived(S, R2, 10000, s2);
  await notify.notifySprayReceived(H, R2, 30000, s2);
  const sn = await sprayNotes(S, R2);
  check("a stage guest is told their own share only", sn.length === 1 && sn[0].title.includes("₦100") && !sn[0].title.includes("₦300"), JSON.stringify(sn));
  check("the host is told their cut of that spray", (await q(`select title from notifications where user_id=$1 and related_entity_id=$2`, [H, sprayNoticeKey(s2)]))[0]?.title?.includes("₦300"));

  // a refused / undelivered spray is never announced
  const s3 = await delivered(R2, H, P, S);
  await q(`update spray_payments set status = 'reversed', delivered_at = null where id = $1`, [s3]);
  check("a reversed spray says nothing", (await notify.insertSprayNotice(S, s3)) === "nothing");
  check("someone the spray did not reach is never told", (await notify.insertSprayNotice(G, s1)) === "nothing");

  // ------------------------------------------------------------------ fire-and-forget
  notify.notifyTestHooks.fail = () => true;
  let threw = false;
  try { await notify.notifySprayReceived(H, R2, 40000, s1); await notify.notifyTicketIssued(G, R); await notify.notifyPayoutPaid(H, R, 1000); }
  catch { threw = true; }
  check("a failing notification never rejects (money paths are unaffected)", !threw);
  notify.notifyTestHooks.fail = undefined;
  check("bad input is ignored, never thrown", await notify.notifyPayoutPaid(H, R, -5).then(() => true, () => false)
    && await notify.notifySprayReceived("x' or 1=1", R, 1, s1).then(() => true, () => false)
    && await notify.notifySprayReceived(H, R2, 1, "x' or 1=1").then(() => true, () => false));

  await notify.notifyTicketIssued(G, R);
  const tk = await q(`select title, message, link from notifications where user_id=$1 and type='room_ticket'`, [G]);
  check("ticket issued: one notification linking to the room", tk.length === 1 && tk[0].link === `/rooms/${R}`, JSON.stringify(tk));
  await notify.notifyPayoutPaid(H, R, 240000);
  const pp = await q(`select title, message, link from notifications where user_id=$1 and type='payout_paid'`, [H]);
  check("payout paid: copy with the stored amount, link to earnings", pp.length === 1 && pp[0].message.includes("₦2,400") && pp[0].link === "/rooms/earnings", JSON.stringify(pp));
  await notify.notifyPayoutPaid(H, R, 0);
  check("a zero payout (all clawed back) is never announced", (await q(`select 1 from notifications where user_id=$1 and type='payout_paid'`, [H])).length === 1);

  // ------------------------------------------------------------------ privacy: notifyFriendsLive
  const H2 = await mk("host2"), F = await mk("fan");
  await follow(F, H2);
  const put = await http("PUT", "/api/users/me/room-privacy", H2, { interactions: "mutuals", appearInLists: true, allowInvites: true, notifyFriendsLive: false });
  check("PUT room-privacy accepts notifyFriendsLive false", put.status === 200 && put.json?.roomPrivacy?.notifyFriendsLive === false, put.text);
  check("PUT room-privacy rejects a non-boolean", (await http("PUT", "/api/users/me/room-privacy", H2, { interactions: "mutuals", appearInLists: true, allowInvites: true, notifyFriendsLive: "no" })).status === 400);
  const oldClient = await http("PUT", "/api/users/me/room-privacy", H2, { interactions: "mutuals", appearInLists: true, allowInvites: true });
  check("an old client's PUT (field omitted) keeps the opt-out", oldClient.json?.roomPrivacy?.notifyFriendsLive === false, oldClient.text);
  const S2 = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Quiet','party','public','18+','scheduled') returning id`, [H2]))[0].id;
  const st = await http("POST", `/api/rooms/${S2}/start`, H2);
  await (await import("../server/rooms/liveNotify")).liveNoticeSettled(S2);
  check("start works", st.status === 200, st.text);
  check("opted-out host: followers are NOT told it is live", (await q(`select 1 from notifications where user_id=$1 and type='room_live' and related_entity_id=$2`, [F, S2])).length === 0);
  await http("POST", `/api/rooms/${S2}/end`, H2);
  await http("PUT", "/api/users/me/room-privacy", H2, { interactions: "mutuals", appearInLists: true, allowInvites: true, notifyFriendsLive: true });
  const S3 = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Loud','party','public','18+','scheduled') returning id`, [H2]))[0].id;
  await http("POST", `/api/rooms/${S3}/start`, H2);
  await (await import("../server/rooms/liveNotify")).liveNoticeSettled(S3);
  check("opted-in host: followers are told", (await q(`select 1 from notifications where user_id=$1 and type='room_live' and related_entity_id=$2`, [F, S3])).length === 1);
  await http("POST", `/api/rooms/${S3}/end`, H2);

  // ------------------------------------------------------------------ go-live notice: ALL eligible followers (owner decision)
  const H3 = await mk("bighost");
  const many = LIVE_NOTIFY_CHUNK + 60; // more than one chunk, and more than the old cap of 200
  const fans = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
     select 'rc_fan' || g || '_' || $1 || '@t.dev', 'rc_fan' || g || '_' || $1, 'social', $2, true, true, $3::date, now() - interval '60 days'
       from generate_series(1, $4::int) g returning id`,
    [stamp, hash, yearsAgo(30), many],
  )).map((r: any) => r.id as string);
  await q(`insert into follows (follower_id, following_id) select unnest($1::varchar[]), $2 on conflict do nothing`, [fans, H3]);
  const teenFan = (await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth)
    values ($1,$2,'social',$3,true,true,$4) returning id`, [`rc_teenfan${stamp}@t.dev`, `rc_teenfan${stamp}`, hash, yearsAgo(15)]))[0].id as string;
  const blockedFan = await mk("blockedfan");
  const goneFan = await mk("gonefan");
  for (const f of [teenFan, blockedFan, goneFan]) await follow(f, H3);
  await block(H3, blockedFan);
  await q(`update users set deleted_at = now() where id = $1`, [goneFan]);
  const BIG = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Big','party','public','18+','scheduled') returning id`, [H3]))[0].id;
  const t0 = Date.now();
  const bst = await http("POST", `/api/rooms/${BIG}/start`, H3);
  check("start answers without waiting for the notice", bst.status === 200, bst.text);
  const told = await liveNoticeSettled(BIG);
  const live = await q(`select user_id from notifications where type='room_live' and related_entity_id=$1`, [BIG]);
  const liveSet = new Set(live.map((r: any) => r.user_id as string));
  check(`every eligible follower is told (${many}, more than one chunk and the old cap)`, fans.every((f) => liveSet.has(f)) && live.length === many, `${live.length} told=${told} in ${Date.now() - t0} ms`);
  check("never a teen follower of an 18+ room, a blocked follower, or a deleted account", !liveSet.has(teenFan) && !liveSet.has(blockedFan) && !liveSet.has(goneFan));
  // friends-only: only mutual follows
  const mutualFan = fans[0];
  await follow(H3, mutualFan);
  await http("POST", `/api/rooms/${BIG}/end`, H3);
  const FR = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Friends','party','friends','18+','scheduled') returning id`, [H3]))[0].id;
  await http("POST", `/api/rooms/${FR}/start`, H3);
  await liveNoticeSettled(FR);
  const fr = await q(`select user_id from notifications where type='room_live' and related_entity_id=$1`, [FR]);
  check("a friends-only room tells mutual follows only", fr.length === 1 && fr[0].user_id === mutualFan, JSON.stringify(fr));
  await http("POST", `/api/rooms/${FR}/end`, H3);
  const INV = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Invite','party','invite','18+','scheduled') returning id`, [H3]))[0].id;
  await http("POST", `/api/rooms/${INV}/start`, H3);
  await liveNoticeSettled(INV);
  check("an invite-only room tells no follower", (await q(`select 1 from notifications where type='room_live' and related_entity_id=$1 and title like '%is live'`, [INV])).length === 0);
  await http("POST", `/api/rooms/${INV}/end`, H3);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  notify.resetNotifyStateForTests();
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
