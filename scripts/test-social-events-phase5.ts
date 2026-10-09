// End-to-end check of social events Phase 5: guest privacy.
// Real routes, real storage and services, the real delete-account route; only authentication is faked
// (x-test-user header). Refuses to run unless the database name contains "test".
//
//   DATABASE_URL=<fresh scratch db> DISABLE_GEOCODING=1 SESSION_SECRET=x npx tsx scripts/test-social-events-phase5.ts
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(1);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { setupAdminRoutes } = await import("../server/admin-routes");
const { registerSocialEventGate, registerSocialEventRoutes, registerGuestDataExportBlock } = await import("../server/routes/social-events-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
const { deviceMiddleware } = await import("../server/services/enforcement");
const { getConfig, invalidateConfigCache } = await import("../server/services/moderationConfig");
const { runRetentionPurge, eraseSocialDataForUser, purgeEventGuestData } = await import("../server/services/guestPrivacy");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use((req: any, _res, next) => {
  const id = req.header("x-test-user");
  req.user = id ? { id, username: id, email: "", userType: "social" } : undefined;
  req.isAuthenticated = () => !!id;
  req.logout = (cb: (e?: Error) => void) => cb();
  req.session = { destroy: (cb: () => void) => cb() };
  next();
});
app.use("/api", deviceMiddleware);
app.use(redactSensitiveFields);
registerGuestDataExportBlock(app); // first, exactly as in routes.ts
setupAdminRoutes(app);
// Deliberately careless handlers: the export blocker must stop them even if somebody writes one.
app.get("/api/social-events/__rogue", (_req, res) => { res.setHeader("Content-Type", "text/csv"); res.send("name,plus\nAda,1"); });
app.get("/api/invite/__rogue", (_req, res) => { res.setHeader("Content-Disposition", 'attachment; filename="guests.txt"'); res.send("Ada"); });

registerSocialEventGate(app);
registerEventsRoutes(app);
registerSocialEventRoutes(app);
registerUsersRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function call(method: string, path: string, o: { user?: string; token?: string; body?: unknown; accept?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.user) headers["x-test-user"] = o.user;
  if (o.token) headers["x-rsvp-token"] = o.token;
  if (o.accept) headers["Accept"] = o.accept;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 320) : ""); }
}

const tag = crypto.randomBytes(3).toString("hex");
let phoneSeq = 20000 + Math.floor(Math.random() * 60000);
async function mkUser(name: string, o: { phone?: boolean } = {}) {
  const [u] = await q(`insert into users (email, username, user_type, is_verified, display_name, date_of_birth) values ($1,$2,'social',true,$3,'1990-01-01') returning id`, [`${name}-${tag}@test.local`, `${name}_${tag}`, name]);
  if (o.phone) await q(`update users set verified_phone=$2, phone_verified_at=now() where id=$1`, [u.id, `+4477002${String(phoneSeq++).padStart(5, "0")}`]);
  return u.id as string;
}
const ADDRESS = "12 Secret Street, Hidden Town";
// endedDaysAgo: how long ago the event finished (negative = in the future)
async function mkEvent(host: string, o: { title: string; endedDaysAgo: number; visibility?: string; status?: string; sold?: number; cancelled?: boolean; withToken?: boolean; kind?: string }) {
  const [e] = await q(
    `insert into events (organizer_id, title, description, event_date, event_end_date, location, category, ticket_price, tickets_available, tickets_sold, kind, visibility, social_type, exact_address, moderation_status, invite_token, max_plus_ones, is_cancelled)
     values ($1,$2,'d', now() - ($3 || ' days')::interval - interval '4 hours', now() - ($3 || ' days')::interval, 'Soho, London','social',0,50,$4,$5,$6,'party',$7,$8,$9,2,$10) returning id, invite_token`,
    [host, o.title, String(o.endedDaysAgo), o.sold ?? 0, o.kind ?? "social", o.visibility ?? "private", ADDRESS, o.status ?? "approved", o.withToken === false ? null : crypto.randomBytes(12).toString("base64url"), !!o.cancelled],
  );
  return { id: e.id as string, token: e.invite_token as string };
}
const addTicket = (userId: string | null, eventId: string, name: string, o: { status?: string; plus?: number; tokenHash?: string } = {}) =>
  q(`insert into tickets (user_id, event_id, guest_name, status, plus_one_count, payment_provider, amount_paid, guest_token_hash) values ($1,$2,$3,$4,$5,'free',0,$6) returning id`, [userId, eventId, name, o.status ?? "confirmed", o.plus ?? 0, o.tokenHash ?? null]);
const ticketCount = async (eventId: string) => (await q(`select count(*)::int n from tickets where event_id=$1`, [eventId]))[0].n;
const sold = async (eventId: string) => (await q(`select tickets_sold from events where id=$1`, [eventId]))[0].tickets_sold;
const setCfg = async (key: string, value: unknown) => { await q(`insert into moderation_config (key, value) values ($1,$2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]); invalidateConfigCache(); };
const purgeAudit = async (eventId: string) => q(`select * from guest_data_audit where event_id=$1 and data_accessed='purge' order by created_at desc`, [eventId]);

const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const createBody = (over: Record<string, unknown> = {}) => ({ title: "Ada's 30th", description: "Come celebrate", socialType: "birthday", visibility: "private", eventDate: future(10), location: "Shoreditch, London", exactAddress: ADDRESS, capacity: 20, maxPlusOnes: 2, ...over });

try {
  const host = await mkUser("host");
  const hostPriv = await call("POST", "/api/social-events", { user: host, body: createBody() });
  const priv = { id: hostPriv.json.id as string, token: hostPriv.json.inviteUrl.split("/i/")[1] as string };
  const pubHost = await mkUser("pubhost", { phone: true });
  const pub = await mkEvent(pubHost, { title: "Public rooftop", endedDaysAgo: -8, visibility: "public" });

  // =====================================================================
  console.log("\ndata minimisation: only name, answer and a plus-one count");
  for (const extra of [{ dietary: "vegan" }, { allergies: "nuts" }, { health: "asthma" }, { phone: "+447700900123" }, { email: "g@example.com" }, { notes: "hi" }]) {
    const r = await call("PUT", `/api/invite/${priv.token}/rsvp`, { body: { name: "Bola", attending: true, plusOneCount: 0, ...extra } });
    check(`RSVP carrying ${Object.keys(extra)[0]} is rejected, not silently stored`, r.status === 400, { status: r.status, json: r.json });
  }
  check("nothing was stored by those rejected attempts", (await ticketCount(priv.id)) === 0);
  const cols = (await q(`select column_name from information_schema.columns where table_name='tickets'`)).map((c: any) => c.column_name as string);
  check("the tickets table has no dietary / health / contact / date-of-birth columns", !cols.some((c) => /diet|allerg|health|medic|phone|email|birth|dob|nationality|religion/i.test(c)), cols);
  const first = await call("PUT", `/api/invite/${priv.token}/rsvp`, { body: { name: "Zuzu Fernandez-Okafor", attending: true, plusOneCount: 1 } });
  const zuzuToken = first.json.manageToken as string;
  check("a valid RSVP stores a name, an answer and a plus-one count", first.status === 200 && (await q(`select guest_name, status, plus_one_count from tickets where event_id=$1`, [priv.id]))[0].guest_name === "Zuzu Fernandez-Okafor");

  console.log("\nprivacy notice on the invitation");
  const inv = await call("GET", `/api/invite/${priv.token}`);
  check("invite payload carries the privacy facts: controller + retention days", inv.json?.privacy?.controller === "Vib3Pulse" && inv.json?.privacy?.retentionDays === 30, inv.json?.privacy);
  await setCfg("guest_data_retention_days", 14);
  check("retention shown to guests is the configured value (14)", (await call("GET", `/api/invite/${priv.token}`)).json?.privacy?.retentionDays === 14);
  check("the host sees the same figure for their own guest list", (await call("GET", "/api/social-events/privacy-info", { user: host })).json?.retentionDays === 14);
  await setCfg("guest_data_retention_days", 30);
  check("the notice endpoint never leaks any guest info", !/Zuzu|Okafor/.test(inv.text));

  console.log("\nthe guest list is visible to the host only");
  const other = await mkUser("othergoer");
  await call("PUT", `/api/invite/${priv.token}/rsvp`, { user: other, body: { name: "Other Goer", attending: true, plusOneCount: 0 } });
  check("another guest (account) can't read the guest list", (await call("GET", `/api/social-events/${priv.id}/guests`, { user: other })).status === 404);
  check("a guest holding a token can't either (no login -> 401)", (await call("GET", `/api/social-events/${priv.id}/guests`, { token: zuzuToken })).status === 401);
  check("another host can't", (await call("GET", `/api/social-events/${priv.id}/guests`, { user: pubHost })).status === 404);
  check("public attendee list is closed for private events (404)", (await call("GET", `/api/events/${priv.id}/attendees`)).status === 404);
  check("...and for public social events too", (await call("GET", `/api/events/${pub.id}/attendees`)).status === 404);
  await addTicket(other, pub.id, "Public Guest");
  check("a public social event's detail never includes any guest name", !(await call("GET", `/api/events/${pub.id}`)).text.includes("Public Guest"));
  const wallet = await storage.getUserTickets(other);
  check("a guest's own wallet shows only their own RSVPs", wallet.every((t) => t.userId === other) && wallet.length === 2);
  for (let i = 0; i < 40 && (await q(`select 1 from notifications where user_id=$1`, [host])).length < 2; i++) await new Promise((r) => setTimeout(r, 250)); // notifications are fire-and-forget
  const hostNotes = await q(`select title, message from notifications where user_id=$1`, [host]);
  check("host notifications contain no guest names (they'd outlive the retention window)", hostNotes.length >= 2 && !hostNotes.some((n: any) => /Zuzu|Okafor|Other Goer/.test(n.title + n.message)), hostNotes);
  const hostList = await call("GET", `/api/social-events/${priv.id}/guests`, { user: host });
  check("the host does see names in the guest list (JSON)", hostList.status === 200 && hostList.json.guests.some((g: any) => g.name === "Zuzu Fernandez-Okafor"));
  check("host guest-list reads are audit-logged (host actor)", (await q(`select 1 from guest_data_audit where event_id=$1 and actor_type='host' and data_accessed='guest_list'`, [priv.id])).length === 1);

  // =====================================================================
  console.log("\nno export of guest lists, for anyone");
  const hostBlocked = [
    ["guests.csv", `/api/social-events/${priv.id}/guests.csv`, undefined],
    ["guests?format=csv", `/api/social-events/${priv.id}/guests?format=csv`, undefined],
    ["guests?export=xlsx", `/api/social-events/${priv.id}/guests?export=xlsx`, undefined],
    ["guests.xlsx", `/api/social-events/${priv.id}/guests.xlsx`, undefined],
  ] as const;
  for (const [label, path] of hostBlocked) check(`host: ${label} -> 404`, (await call("GET", path, { user: host })).status === 404);
  const acc = await call("GET", `/api/social-events/${priv.id}/guests`, { user: host, accept: "text/csv" });
  check("host: Accept: text/csv -> 406", acc.status === 406 && acc.json?.code === "EXPORT_BLOCKED", acc.status);
  check("host: spreadsheet Accept -> 406", (await call("GET", `/api/social-events/${priv.id}/guests`, { user: host, accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).status === 406);
  check("host: the normal JSON read still works", (await call("GET", `/api/social-events/${priv.id}/guests`, { user: host, accept: "application/json" })).status === 200);
  check("guest page: ?format=csv -> 404", (await call("GET", `/api/invite/${priv.token}/rsvp?format=csv`)).status === 404);
  check("admin: queue export -> 404 before auth, normal path -> 401", (await call("GET", "/api/admin/moderation/queue?export=csv")).status === 404 && (await call("GET", "/api/admin/moderation/queue")).status === 401);
  check("admin: reveal.csv -> 404", (await call("GET", `/api/admin/events/${priv.id}/reveal.csv`)).status === 404);
  const rogue = await call("GET", "/api/social-events/__rogue", { user: host });
  check("a careless handler that tries to send CSV is stopped (no CSV leaves the server)", rogue.status >= 500 && !rogue.text.includes("Ada,1") && !/csv/i.test(rogue.headers.get("content-type") ?? ""), { s: rogue.status, t: rogue.text.slice(0, 60) });
  const rogue2 = await call("GET", "/api/invite/__rogue");
  check("...and one that tries to force a file download", rogue2.status >= 500 && !rogue2.text.includes("Ada") && !rogue2.headers.get("content-disposition"), rogue2.status);
  check("the old commercial guestlist.csv is invisible for private social events", (await call("GET", `/api/events/${priv.id}/guestlist.csv`, { user: host })).status === 404);
  check("...and for public social events", (await call("GET", `/api/events/${pub.id}/guestlist.csv`, { user: pubHost })).status === 404);
  const comm = await mkEvent(host, { title: "Commercial night", endedDaysAgo: -3, kind: "commercial", visibility: "public" });
  const commCsv = await call("GET", `/api/events/${comm.id}/guestlist.csv`, { user: host });
  check("regression: commercial events keep their own guestlist.csv", commCsv.status === 200 && /csv/.test(commCsv.headers.get("content-type") ?? ""), commCsv.status);

  // =====================================================================
  console.log("\nopt-out: a guest deletes their own response");
  const e1 = await mkEvent(host, { title: "Opt-out event", endedDaysAgo: -5, sold: 0 });
  const rs = await call("PUT", `/api/invite/${e1.token}/rsvp`, { body: { name: "Chidi Nwosu", attending: true, plusOneCount: 2 } });
  const chidiTok = rs.json.manageToken as string;
  const rs2 = await call("PUT", `/api/invite/${e1.token}/rsvp`, { body: { name: "Declining Dan", attending: false, plusOneCount: 0 } });
  const danTok = rs2.json.manageToken as string;
  check("setup: 3 seats taken by Chidi (+2)", (await sold(e1.id)) === 3);
  check("no token -> 401 NOT_YOURS, nothing deleted", (await call("DELETE", `/api/invite/${e1.token}/rsvp`)).json?.code === "NOT_YOURS" && (await ticketCount(e1.id)) === 2);
  check("someone else's/wrong token -> 404, nothing deleted", (await call("DELETE", `/api/invite/${e1.token}/rsvp`, { token: "not-a-real-token" })).status === 404 && (await ticketCount(e1.id)) === 2);
  check("a logged-in stranger can't delete a token-guest's response", (await call("DELETE", `/api/invite/${e1.token}/rsvp`, { user: other })).status === 404 && (await ticketCount(e1.id)) === 2);
  const del = await call("DELETE", `/api/invite/${e1.token}/rsvp`, { token: chidiTok });
  check("the guest deletes their response with their own token", del.status === 200 && del.json?.deleted === true, del.json);
  check("the row is GONE: no name, no token hash, no plus-one count left behind", (await q(`select 1 from tickets where event_id=$1 and (guest_name='Chidi Nwosu' or guest_token_hash=$2)`, [e1.id, crypto.createHash("sha256").update(chidiTok).digest("hex")])).length === 0);
  check("their seats are freed (3 -> 0)", (await sold(e1.id)) === 0);
  check("the token no longer finds anything", (await call("GET", `/api/invite/${e1.token}/rsvp`, { token: chidiTok })).json?.responded === false);
  check("the host's list no longer shows them", !(await call("GET", `/api/social-events/${e1.id}/guests`, { user: host })).text.includes("Chidi"));
  const pa = (await purgeAudit(e1.id))[0];
  check("the deletion is logged without personal data (system actor, ticket id, reason)", pa.actor_type === "system" && /opted out/.test(pa.reason) && !!pa.ticket_id && !JSON.stringify(pa).includes("Chidi"), pa);
  check("deleting twice -> 404", (await call("DELETE", `/api/invite/${e1.token}/rsvp`, { token: chidiTok })).status === 404);
  check("a guest who declined can delete too, without touching the seat count", (await call("DELETE", `/api/invite/${e1.token}/rsvp`, { token: danTok })).status === 200 && (await sold(e1.id)) === 0);
  check("the guest can answer again afterwards as a fresh response", (await call("PUT", `/api/invite/${e1.token}/rsvp`, { body: { name: "Chidi N.", attending: true, plusOneCount: 0 } })).status === 200 && (await sold(e1.id)) === 1);
  const acct = await mkUser("acctguest");
  await call("PUT", `/api/invite/${e1.token}/rsvp`, { user: acct, body: { name: "Acct Guest", attending: true, plusOneCount: 1 } });
  check("an account holder deletes their response while logged in", (await call("DELETE", `/api/invite/${e1.token}/rsvp`, { user: acct })).status === 200 && (await q(`select 1 from tickets where user_id=$1 and event_id=$2`, [acct, e1.id])).length === 0);
  const ended = await mkEvent(host, { title: "Already over", endedDaysAgo: 3 });
  const [endedT] = await addTicket(null, ended.id, "Late Lena", { tokenHash: crypto.createHash("sha256").update("lena-token").digest("hex") });
  check("the right to delete doesn't lapse when the event has ended", (await call("DELETE", `/api/invite/${ended.token}/rsvp`, { token: "lena-token" })).status === 200 && endedT.id !== undefined);
  const mod = await mkEvent(pubHost, { title: "Taken down", endedDaysAgo: -5, visibility: "public", status: "removed" });
  await addTicket(null, mod.id, "Hidden Hana", { tokenHash: crypto.createHash("sha256").update("hana-token").digest("hex") });
  check("...nor when moderation has taken the event down (the link works for deletion only)", (await call("GET", `/api/invite/${mod.token}`)).status === 404 && (await call("DELETE", `/api/invite/${mod.token}/rsvp`, { token: "hana-token" })).status === 200);

  // =====================================================================
  console.log("\nretention: guest data auto-deleted N days after the event");
  const a = await mkEvent(host, { title: "R: ended 40d", endedDaysAgo: 40 });
  const b = await mkEvent(host, { title: "R: ended 10d", endedDaysAgo: 10 });
  const c = await mkEvent(host, { title: "R: upcoming", endedDaysAgo: -6 });
  const d = await mkEvent(pubHost, { title: "R: cancelled 45d", endedDaysAgo: 45, visibility: "public", cancelled: true });
  const g1 = await mkUser("ret1"), g2 = await mkUser("ret2");
  for (const ev of [a, b, c, d]) {
    await addTicket(g1, ev.id, `Name On ${ev.id.slice(0, 4)}`, { plus: 1 });
    await addTicket(null, ev.id, "Token Person", { tokenHash: crypto.randomBytes(8).toString("hex") });
    await q(`insert into notifications (user_id, type, title, message, related_entity_id) values ($1,'event_rsvp','New RSVP','A guest is coming',$2)`, [host, ev.id]);
  }
  const commOld = await mkEvent(host, { title: "R: commercial old", endedDaysAgo: 400, kind: "commercial", visibility: "public" });
  await addTicket(g2, commOld.id, "Commercial Buyer");
  const s1 = await runRetentionPurge();
  check("run 1 purges the 40-day and the cancelled 45-day event (retention 30d)", s1.eventsPurged >= 2 && (await ticketCount(a.id)) === 0 && (await ticketCount(d.id)) === 0, s1);
  check("their guest-side notifications are deleted with them", (await q(`select 1 from notifications where related_entity_id = any($1)`, [[a.id, d.id]])).length === 0);
  check("the event is marked purged", (await q(`select guest_data_purged_at from events where id=$1`, [a.id]))[0].guest_data_purged_at !== null);
  check("the 10-day-old and the upcoming events keep their guest data", (await ticketCount(b.id)) === 2 && (await ticketCount(c.id)) === 2);
  check("commercial events and their ticket buyers are never touched", (await ticketCount(commOld.id)) === 1);
  const pa2 = (await purgeAudit(a.id))[0];
  check("the purge is audit-logged (system actor, count, reason) without personal data", pa2.actor_type === "system" && /2 RSVP records deleted/.test(pa2.reason) && !/Name On|Token Person/.test(JSON.stringify(pa2)), pa2);
  check("running it again is a no-op", (await runRetentionPurge()).eventsPurged === 0);
  check("after the purge the host's guest list for that event is empty", (await call("GET", `/api/social-events/${a.id}/guests`, { user: host })).json?.guests?.length === 0);
  await setCfg("guest_data_retention_days", 5);
  const s2 = await runRetentionPurge();
  check("retention is config-driven: at 5 days the 10-day-old event goes too", s2.eventsPurged >= 1 && (await ticketCount(b.id)) === 0 && (await ticketCount(c.id)) === 2, s2);
  await setCfg("guest_data_retention_days", 30);

  console.log("\nretention: a bounded hold while a moderation case is open");
  await setCfg("guest_data_hold_extra_days", 30);
  const h1 = await mkEvent(pubHost, { title: "H: 45d with open appeal", endedDaysAgo: 45, visibility: "public", status: "rejected" });
  const h2 = await mkEvent(pubHost, { title: "H: 65d with open appeal", endedDaysAgo: 65, visibility: "public", status: "rejected" });
  const h3 = await mkEvent(pubHost, { title: "H: 45d pending review", endedDaysAgo: 45, visibility: "public", status: "pending" });
  const h4 = await mkEvent(pubHost, { title: "H: 45d unreviewed report", endedDaysAgo: 45, visibility: "public", status: "approved" });
  const h5 = await mkEvent(pubHost, { title: "H: 45d no case", endedDaysAgo: 45, visibility: "public", status: "approved" });
  const rep = await mkUser("reporter1");
  for (const ev of [h1, h2, h3, h4, h5]) await addTicket(g1, ev.id, "Held Person");
  await q(`insert into moderation_appeals (user_id, subject_type, subject_id, message) values ($1,'event',$2,'please review'), ($1,'event',$3,'please review')`, [pubHost, h1.id, h2.id]);
  await q(`insert into content_reports (reporter_id, content_type, content_id, reason) values ($1,'event',$2,'scam')`, [rep, h4.id]);
  const s3 = await runRetentionPurge();
  check("open appeal (45d): held, not deleted", (await ticketCount(h1.id)) === 1);
  check("event still pending review (45d): held", (await ticketCount(h3.id)) === 1);
  check("unreviewed report (45d): held", (await ticketCount(h4.id)) === 1);
  check("no open case (45d): deleted on schedule", (await ticketCount(h5.id)) === 0);
  check("the hold has a hard stop: 65d with an open appeal is deleted anyway (30+30)", (await ticketCount(h2.id)) === 0, s3);
  check("held events are counted in the summary", s3.heldForCase >= 3, s3);
  await setCfg("guest_data_hold_extra_days", 0);
  await runRetentionPurge();
  check("the hold window is config-driven: at 0 extra days everything is deleted", (await ticketCount(h1.id)) === 0 && (await ticketCount(h3.id)) === 0 && (await ticketCount(h4.id)) === 0);
  await setCfg("guest_data_hold_extra_days", 30);

  // =====================================================================
  console.log("\naccount deletion: through the real delete-account route");
  const delGuest = await mkUser("delguest", { phone: true });
  await q(`insert into user_devices (user_id, device_hash) values ($1,'dev-del-1')`, [delGuest]);
  await q(`insert into phone_verifications (user_id, phone, code_hash, expires_at) values ($1,'+447700911222','x', now() + interval '5 minutes')`, [delGuest]);
  const ev1 = await mkEvent(host, { title: "Del: private", endedDaysAgo: -4 });
  const ev2 = await mkEvent(pubHost, { title: "Del: public", endedDaysAgo: -6, visibility: "public" });
  await addTicket(delGuest, ev1.id, "Del Guest", { plus: 2 }); await addTicket(delGuest, ev2.id, "Del Guest", { plus: 0 });
  await q(`update events set tickets_sold = 3 where id=$1`, [ev1.id]); await q(`update events set tickets_sold = 1 where id=$1`, [ev2.id]);
  await q(`insert into moderation_appeals (user_id, subject_type, subject_id, message) values ($1,'strike','x','my appeal text')`, [delGuest]);
  const dr = await call("POST", "/api/auth/delete-account", { user: delGuest, body: { confirmation: "DELETE" } });
  check("delete-account responds 200", dr.status === 200, dr.json);
  check("the guest's RSVPs are deleted everywhere", (await q(`select 1 from tickets where user_id=$1`, [delGuest])).length === 0);
  check("their seats were freed", (await sold(ev1.id)) === 0 && (await sold(ev2.id)) === 0);
  check("an audit row records each deletion by reason, without the name", (await purgeAudit(ev1.id)).some((r: any) => /guest account deleted/.test(r.reason)) && !JSON.stringify(await purgeAudit(ev1.id)).includes("Del Guest"));
  const [gu] = await q(`select verified_phone, phone_verified_at, deleted_at, display_name from users where id=$1`, [delGuest]);
  check("verified phone, verification codes, devices and appeals are deleted too", gu.verified_phone === null && gu.phone_verified_at === null && (await q(`select 1 from phone_verifications where user_id=$1`, [delGuest])).length === 0 && (await q(`select 1 from user_devices where user_id=$1`, [delGuest])).length === 0 && (await q(`select 1 from moderation_appeals where user_id=$1`, [delGuest])).length === 0);
  check("the account itself is anonymised as before", !!gu.deleted_at && gu.display_name === "Deleted user");

  const delHost = await mkUser("delhost", { phone: true });
  const upc = await mkEvent(delHost, { title: "Host upcoming public", endedDaysAgo: -9, visibility: "public" });
  const past = await mkEvent(delHost, { title: "Host past private", endedDaysAgo: 3 });
  const gA = await mkUser("hostguestA");
  await addTicket(gA, upc.id, "Guest A"); await addTicket(null, past.id, "Guest Past", { tokenHash: crypto.randomBytes(8).toString("hex") });
  await q(`insert into bans (kind, value_hash, user_id, reason, admin_id) select 'user', $1, $2, 'earlier ban', id from admin_users limit 1`, [delHost, delHost]).catch(() => null);
  const hdr = await call("POST", "/api/auth/delete-account", { user: delHost, body: { confirmation: "DELETE" } });
  check("a host can delete their account (their events are closed for them)", hdr.status === 200, hdr.json);
  const [uRow] = await q(`select moderation_status, is_cancelled, is_published, exact_address, invite_token from events where id=$1`, [upc.id]);
  check("the upcoming event is cancelled, unpublished, removed, with address and invite link erased", uRow.is_cancelled === true && uRow.is_published === false && uRow.moderation_status === "removed" && uRow.exact_address === null && uRow.invite_token === null, uRow);
  check("all guest data on the host's events is deleted (upcoming and past)", (await ticketCount(upc.id)) === 0 && (await ticketCount(past.id)) === 0);
  check("the old invitation link stops working", (await call("GET", `/api/invite/${upc.token}`)).status === 404);
  check("the event is gone from discovery", !(await storage.getEvents()).some((e) => e.id === upc.id));
  check("a guest's own wallet no longer lists the closed event", !(await storage.getUserTickets(gA)).some((t) => t.eventId === upc.id));

  console.log("\naccess-log coverage (host, admin and grantee paths are in the phase 4 suite)");
  const kinds = (await q(`select actor_type, data_accessed, count(*)::int n from guest_data_audit group by 1,2`)).map((r: any) => `${r.actor_type}:${r.data_accessed}`);
  check("host guest-list reads and system purges are both in the access log", kinds.includes("host:guest_list") && kinds.includes("system:purge"), kinds);
  const direct = await purgeEventGuestData(ev1.id, "manual purge test");
  check("purgeEventGuestData is safe on an already-empty event and logs itself", direct === 0 && (await purgeAudit(ev1.id))[0].reason.startsWith("manual purge test"));
  check("guest_data_hold_extra_days has a seeded default of 30", (await getConfig("guest_data_hold_extra_days")) === 30);
} catch (e) {
  failures++;
  console.error("\nUNEXPECTED ERROR", e);
} finally {
  server.close();
  await pool.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
