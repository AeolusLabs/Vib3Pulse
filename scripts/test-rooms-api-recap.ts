// Phase 6 lane A over a throwaway database: recap access and fields, the spray notification batch (multi-call, injected
// clock), the money notifications, and notifyFriendsLive.   npm run test:rooms
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
const notify = await import("../server/rooms/notify");
const rs = await import("../server/rooms/roomStorage");
const { SPRAY_BATCH_WINDOW_MS, sprayBatchKey } = await import("../shared/roomNotifications");

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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.14.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
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
async function delivered(roomId: string, hostId: string, payerId: string, recipientId: string): Promise<void> {
  const stage = recipientId !== hostId;
  const [host, guest, platform] = stage ? [30000, 10000, 10000] : [40000, null, 10000];
  await q(
    `insert into spray_payments (idempotency_key, request_hash, room_id, host_id, payer_id, recipient_id, tier, v3c, amount_kobo,
                                 vat_kobo, fee_kobo, reserve_kobo, platform_kobo, host_kobo, guest_kobo, provider, provider_ref, status, delivered_at)
     values ($1, 'h', $2, $3, $4, $5, 'note', 50000, 50000, 0, 0, 0, $6, $7, $8, 'paystack', $9, 'delivered', now())`,
    [crypto.randomUUID(), roomId, hostId, payerId, recipientId, platform, host, guest, `rc-test-${stamp}-${refSeq++}`],
  );
}
const sprayNotes = (uid: string, roomId: string) =>
  q(`select id, title, message, link, related_user_id, is_read from notifications where user_id=$1 and type='spray_received' and related_entity_id=$2`, [uid, sprayBatchKey(roomId)]);

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

  // ------------------------------------------------------------------ spray batching
  notify.notifyTestHooks.noTrailing = true;
  const R2 = await mkRoom(H, "live", "Batch Room");
  let now = Date.UTC(2026, 9, 20, 12, 0, 0);
  notify.notifyClock.now = () => now;
  await delivered(R2, H, P, H);
  await notify.notifySprayReceived(H, R2, 40000);
  let notes = await sprayNotes(H, R2);
  check("first spray: one notification", notes.length === 1 && /₦400/.test(notes[0].title), JSON.stringify(notes));
  check("spray notification never carries the payer", notes.every((n: any) => n.related_user_id === null && !/Payer|rc_payer/.test(`${n.title} ${n.message}`)));
  check("spray notification links to earnings", notes[0]?.link === "/rooms/earnings");

  // 300 deliveries in under a minute, calls fired concurrently: still ONE notification, unchanged inside the window
  for (let i = 0; i < 300; i++) await delivered(R2, H, P, H);
  const burst: Promise<void>[] = [];
  for (let i = 0; i < 300; i++) { now += 150; burst.push(notify.notifySprayReceived(H, R2, 40000)); }
  await Promise.all(burst);
  notes = await sprayNotes(H, R2);
  check("300 sprays in a minute: still one notification", notes.length === 1, String(notes.length));
  check("inside the minute the batch was not rewritten", /₦400\b/.test(notes[0]?.title ?? ""), notes[0]?.title);
  // Also from a second "process": a direct flush (same SQL path) inside the window does not insert a second row.
  const f2 = await notify.flushSprayBatch(H, R2);
  check("a second flush inside the window waits (multi-process safe by the row, not memory)", f2.outcome === "wait" && (await sprayNotes(H, R2)).length === 1, JSON.stringify(f2));
  now += SPRAY_BATCH_WINDOW_MS;
  await notify.notifySprayReceived(H, R2, 40000);
  notes = await sprayNotes(H, R2);
  check("after the window: the same notification updated to the stored total (301 x 400 naira)", notes.length === 1 && notes[0].title.includes("₦120,400"), notes[0]?.title);

  // stage guest gets their share, the host their cut, separately
  await delivered(R2, H, P, S);
  await notify.notifySprayReceived(S, R2, 10000);
  const sn = await sprayNotes(S, R2);
  check("a stage guest is told their own share only", sn.length === 1 && sn[0].title.includes("₦100") && !sn[0].title.includes("₦300"), JSON.stringify(sn));

  // read -> next spray starts a new batch
  await q(`update notifications set is_read = true where user_id = $1 and type = 'spray_received'`, [H]);
  await delivered(R2, H, P, H);
  now += 1000;
  await notify.notifySprayReceived(H, R2, 40000);
  check("once read, the next spray makes a fresh unread notification", (await sprayNotes(H, R2)).filter((n: any) => !n.is_read).length === 1);

  // a refused / undelivered spray is never counted
  await q(`update spray_payments set status = 'reversed' where room_id = $1 and recipient_id = $2`, [R2, S]);
  check("reversed sprays add nothing (flush has nothing to say)", (await notify.flushSprayBatch(S, R2)).outcome !== "insert");

  // ------------------------------------------------------------------ fire-and-forget
  notify.notifyTestHooks.fail = () => true;
  let threw = false;
  try { await notify.notifySprayReceived(H, R2, 40000); await notify.notifyTicketIssued(G, R); await notify.notifyPayoutPaid(H, R, 1000); }
  catch { threw = true; }
  check("a failing notification never rejects (money paths are unaffected)", !threw);
  notify.notifyTestHooks.fail = undefined;
  check("bad input is ignored, never thrown", await notify.notifyPayoutPaid(H, R, -5).then(() => true, () => false)
    && await notify.notifySprayReceived("x' or 1=1", R, 1).then(() => true, () => false));

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
  check("start works", st.status === 200, st.text);
  check("opted-out host: followers are NOT told it is live", (await q(`select 1 from notifications where user_id=$1 and type='room_live' and related_entity_id=$2`, [F, S2])).length === 0);
  await http("POST", `/api/rooms/${S2}/end`, H2);
  await http("PUT", "/api/users/me/room-privacy", H2, { interactions: "mutuals", appearInLists: true, allowInvites: true, notifyFriendsLive: true });
  const S3 = (await q(`insert into rooms (host_id, title, kind, visibility, age_limit, status) values ($1,'Loud','party','public','18+','scheduled') returning id`, [H2]))[0].id;
  await http("POST", `/api/rooms/${S3}/start`, H2);
  check("opted-in host: followers are told", (await q(`select 1 from notifications where user_id=$1 and type='room_live' and related_entity_id=$2`, [F, S3])).length === 1);
  await http("POST", `/api/rooms/${S3}/end`, H2);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  notify.resetNotifyStateForTests();
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
