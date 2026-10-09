// Cross-cutting checks for social events: the things no single phase owns.
//   * the REAL csrfProtection middleware in front of every new write route
//   * a programmatic sweep of EVERY registered route: no unauthenticated 2xx, no stranger / wrong-role 2xx
//   * an address + token leak sweep over a full multi-actor journey
//   * the price-0 ticket path (an invitation IS a free ticket in the existing pipeline)
//   * text sanitising on every host-typed field, flood limiting, token strength, listing endpoints,
//     and the startup backfill that once silently approved events held for review
//
//   DATABASE_URL=<fresh scratch db> DISABLE_GEOCODING=1 SESSION_SECRET=x npx tsx scripts/test-social-events-phase6.ts
// Refuses to run unless the database name contains "test".
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(1);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
delete process.env.ADMIN_MFA_REQUIRED; // the shipped default: password-only admin sign-in

const { storage, ensureSchema } = await import("../server/storage");
const { redactSensitiveFields, csrfProtection } = await import("../server/security");
const { setupAdminRoutes } = await import("../server/admin-routes");
const { registerSocialEventGate, registerSocialEventRoutes, registerGuestDataExportBlock } = await import("../server/routes/social-events-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
const { registerPhoneRoutes } = await import("../server/routes/phone-routes");
const { deviceMiddleware } = await import("../server/services/enforcement");
const { toPublicUser } = await import("../server/auth");

await storage.ensureLoginAttemptsTable();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

// ---- app: same order as server/index.ts (cookies -> auth -> device -> redaction -> CSRF -> routes) ----------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use((req: any, _res, next) => {
  const id = req.header("x-test-user");
  req.user = id ? { id, username: id, email: "", userType: "social" } : undefined;
  req.isAuthenticated = () => !!id;
  req.logout = (cb: (e?: Error) => void) => cb();
  req.login = (_u: unknown, cb: (e?: Error) => void) => cb();
  next();
});
app.use("/api", deviceMiddleware);
app.use(redactSensitiveFields);
app.use("/api", csrfProtection); // the real one
registerGuestDataExportBlock(app);
setupAdminRoutes(app);
registerSocialEventGate(app);
registerEventsRoutes(app);
registerSocialEventRoutes(app);
registerUsersRoutes(app);
registerPhoneRoutes(app);
let buddiesMounted = false;
try {
  const { buddyRouter } = await import("../server/buddyRoutes");
  app.use("/api/safety", buddyRouter);
  buddiesMounted = true;
} catch { /* SMS providers need keys; the buddy check is then skipped */ }
let paymentsMounted = false;
try {
  const { registerPaymentRoutes } = await import("../server/payment-routes");
  registerPaymentRoutes(app);
  paymentsMounted = true;
} catch { /* payment SDKs need provider keys; covered by a source check below instead */ }

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// ---- http helper: real CSRF double-submit cookie, cookie jar for admin sessions, response recorder -------------------
const CSRF = (await fetch(base + "/api/__csrf_bootstrap")).headers.getSetCookie().find((c) => c.startsWith("csrf-token="))!.split(";")[0].split("=")[1];
type Who = { id: string; username: string; role: string; cookie: string };
type Rec = { actor: string; method: string; path: string; status: number; text: string; addr: boolean; tok: boolean };
const recorded: Rec[] = [];
let ipSeq = 1;
async function http(method: string, path: string, o: { who?: Who; user?: string; token?: string; body?: unknown; ip?: string; csrf?: "ok" | "none" | "cookie-only" | "wrong"; label?: string; addr?: boolean; tok?: boolean } = {}) {
  const mode = o.csrf ?? "ok";
  const headers: Record<string, string> = { "X-Forwarded-For": o.ip ?? `10.7.${(ipSeq >> 8) & 255}.${ipSeq & 255}` };
  ipSeq++;
  const cookies: string[] = [];
  if (mode !== "none") cookies.push(`csrf-token=${CSRF}`);
  if (o.who?.cookie) cookies.push(o.who.cookie);
  if (cookies.length) headers["Cookie"] = cookies.join("; ");
  if (mode === "ok") headers["x-csrf-token"] = CSRF;
  if (mode === "wrong") headers["x-csrf-token"] = "0".repeat(64);
  if (o.user) headers["x-test-user"] = o.user;
  if (o.token) headers["x-rsvp-token"] = o.token;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  recorded.push({ actor: o.label ?? o.who?.role ?? o.user ?? "anon", method, path, status: res.status, text, addr: !!o.addr, tok: !!o.tok });
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie().find((c) => c.startsWith("admin.sid=")) ?? null };
}

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 360) : ""); }
}

// ---- fixtures ------------------------------------------------------------------------------------------------------
const tag = crypto.randomBytes(3).toString("hex");
const PASSWORD = "Passw0rd!x-test";
const pwHash = await bcrypt.hash(PASSWORD, 4);
let phoneSeq = 40000 + Math.floor(Math.random() * 50000);
async function mkUser(name: string, o: { phone?: boolean; ageDays?: number } = {}) {
  const [u] = await q(`insert into users (email, username, user_type, is_verified, display_name, date_of_birth, created_at) values ($1,$2,'social',true,$3,'1990-01-01', now() - ($4 || ' days')::interval) returning id`, [`${name}-${tag}@test.local`, `${name}_${tag}`, name, String(o.ageDays ?? 90)]);
  if (o.phone) await q(`update users set verified_phone=$2, phone_verified_at=now() where id=$1`, [u.id, `+4477003${String(phoneSeq++).padStart(5, "0")}`]);
  return u.id as string;
}
async function mkAdmin(name: string, role: string): Promise<Who> {
  const [a] = await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning id`, [`${name}-${tag}@test.local`, `${name}_${tag}`, pwHash, name, role]);
  const w: Who = { id: a.id, username: `${name}_${tag}`, role, cookie: "" };
  const r = await http("POST", "/api/admin/login", { body: { username: w.username, password: PASSWORD }, label: `login:${role}` });
  w.cookie = r.setCookie?.split(";")[0] ?? "";
  return w;
}
const ADDRESS = "12 Secret Street, Hidden Town";
async function mkPublicEvent(host: string, title: string, o: { status?: string } = {}) {
  const [e] = await q(
    `insert into events (organizer_id, title, description, event_date, location, category, ticket_price, tickets_available, tickets_sold, kind, visibility, social_type, exact_address, moderation_status, invite_token, max_plus_ones)
     values ($1,$2,'A public night',now() + interval '9 days','Shoreditch, London','social',0,30,0,'social','public','party',$3,$4,$5,2) returning id`,
    [host, title, ADDRESS, o.status ?? "approved", crypto.randomBytes(12).toString("base64url")],
  );
  return e.id as string;
}
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({ title: "Ada's 30th", description: "Come celebrate", socialType: "birthday", visibility: "private", eventDate: future(10), location: "Shoreditch, London", exactAddress: ADDRESS, capacity: 20, maxPlusOnes: 2, ...over });

try {
  const host = await mkUser("host");
  const stranger = await mkUser("stranger");
  const guestAcct = await mkUser("guestacct");
  const pubHost = await mkUser("pubhost", { phone: true });
  const superA = await mkAdmin("superA", "super_admin");
  const mod = await mkAdmin("mod", "content_moderator");
  const adm = await mkAdmin("adm", "admin");
  const viewer = await mkAdmin("viewer", "analytics_viewer");
  const finance = await mkAdmin("fin", "finance_manager");

  // =====================================================================
  console.log("\nCSRF: the real middleware sits in front of every new write route");
  const cs = (m: string, p: string, b: unknown, mode: "none" | "cookie-only" | "wrong", extra: { user?: string; who?: Who } = {}) => http(m, p, { body: b, csrf: mode, ...extra });
  for (const mode of ["none", "cookie-only", "wrong"] as const) {
    const r = await cs("POST", "/api/social-events", body(), mode, { user: host });
    check(`create event with CSRF '${mode}' -> 403`, r.status === 403, r.status);
  }
  check("RSVP (PUT) without a CSRF token -> 403", (await cs("PUT", "/api/invite/anything-long-enough/rsvp", { name: "A", attending: true, plusOneCount: 0 }, "none")).status === 403);
  check("opt-out (DELETE) without a CSRF token -> 403", (await cs("DELETE", "/api/invite/anything-long-enough/rsvp", undefined, "none")).status === 403);
  check("host actions (cancel / rotate / appeal / guest approve) without CSRF -> 403", (await Promise.all([
    cs("POST", "/api/social-events/x/cancel", {}, "none", { user: host }), cs("POST", "/api/social-events/x/rotate-invite", {}, "wrong", { user: host }),
    cs("POST", "/api/social-events/x/appeal", { message: "please look again at this" }, "none", { user: host }), cs("POST", "/api/social-events/x/guests/y/approve", {}, "none", { user: host }),
  ])).every((r) => r.status === 403));
  check("phone verification + account appeals without CSRF -> 403", (await Promise.all([cs("POST", "/api/auth/phone/request", { phone: "+447700900123" }, "none", { user: host }), cs("POST", "/api/auth/phone/verify", { code: "123456" }, "none", { user: host }), cs("POST", "/api/social-events/appeals", {}, "none", { user: host })])).every((r) => r.status === 403));
  check("account deletion without CSRF -> 403 (and the account is untouched)", (await cs("POST", "/api/auth/delete-account", { confirmation: "DELETE" }, "none", { user: stranger })).status === 403 && (await q(`select deleted_at from users where id=$1`, [stranger]))[0].deleted_at === null);
  check("admin writes without CSRF -> 403 before anything else (login, queue action, config, grants, strikes)", (await Promise.all([
    cs("POST", "/api/admin/login", { username: "x", password: "y" }, "none"), cs("POST", "/api/admin/moderation/bulk", {}, "none", { who: superA }), cs("PUT", "/api/admin/moderation/config/queue_sla_hours", { value: 5, reason: "nope" }, "none", { who: adm }),
    cs("POST", "/api/admin/reveal-grants", {}, "none", { who: superA }), cs("POST", "/api/admin/hosts/x/strikes", {}, "none", { who: adm }),
  ])).every((r) => r.status === 403));
  check("GET requests are unaffected by CSRF", (await http("GET", "/api/social-events", { user: host, csrf: "none" })).status === 200);
  const created = await http("POST", "/api/social-events", { user: host, body: body(), addr: true, tok: true, label: "host" });
  check("with a correct CSRF token the same create succeeds", created.status === 201, created.json);
  const priv = { id: created.json.id as string, token: created.json.inviteUrl.split("/i/")[1] as string };

  // =====================================================================
  console.log("\nauthorisation sweep: every registered route");
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of (app as any)._router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path as string });
  }
  const mine = routes.filter((r) => /^\/api\/(social-events|invite|auth\/phone|admin)/.test(r.path));
  const PUBLIC_OK = new Set(["GET /api/admin/setup/status"]); // the only intentionally-open 2xx among these
  const sub = (p: string, map: Record<string, string> = {}) => p.replace(/:([A-Za-z]+)/g, (_m, n) => map[n] ?? "x");
  const unauth = await Promise.all(mine.map(async (r) => ({ r, res: await http(r.method, sub(r.path), { body: r.method === "GET" ? undefined : {}, label: "anon-sweep" }) })));
  const open = unauth.filter((u) => u.res.status >= 200 && u.res.status < 400 && !PUBLIC_OK.has(`${u.r.method} ${u.r.path}`));
  check(`${mine.length} routes swept unauthenticated: none answers 2xx/3xx (except the setup-status probe)`, mine.length > 60 && open.length === 0, open.map((u) => `${u.r.method} ${u.r.path} -> ${u.res.status}`));
  const noOpenInvite = unauth.filter((u) => u.r.path.startsWith("/api/invite")).every((u) => u.res.status === 404);
  check("invitation routes give a bad token a plain 404 (no oracle)", noOpenInvite);

  const [tk] = await q(`insert into tickets (user_id, event_id, guest_name, status, payment_provider, amount_paid) values ($1,$2,'Sweep Guest','confirmed','free',0) returning id`, [guestAcct, priv.id]);
  const ids = { id: priv.id, ticketId: tk.id as string };
  const hostRoutes = mine.filter((r) => r.path.startsWith("/api/social-events/:id"));
  const PER_USER_OK = new Set(["GET /api/social-events", "GET /api/social-events/notices", "GET /api/social-events/privacy-info"]);
  const strangerHits = await Promise.all(hostRoutes.map(async (r) => ({ r, res: await http(r.method, sub(r.path, ids), { user: stranger, body: r.method === "GET" ? undefined : {}, label: "stranger-sweep" }) })));
  const leaked = strangerHits.filter((s) => s.res.status >= 200 && s.res.status < 400);
  check(`${hostRoutes.length} per-event host routes as an unrelated logged-in user: none answers 2xx`, hostRoutes.length >= 8 && leaked.length === 0, leaked.map((s) => `${s.r.method} ${s.r.path} -> ${s.res.status}`));
  check("the per-user list endpoints answer a stranger with THEIR OWN (empty) data only", (await http("GET", "/api/social-events", { user: stranger })).json?.length === 0 && PER_USER_OK.size === 3);

  const NEW_ADMIN = mine.filter((r) => /^\/api\/admin\/(moderation|hosts|strikes|bans|reveal-grants|reveal-activity|moderators|social\/metrics|events\/:id\/reveal|users\/admins\/:id\/reset-mfa)/.test(r.path));
  const finHits = await Promise.all(NEW_ADMIN.map(async (r) => ({ r, res: await http(r.method, sub(r.path, ids), { who: finance, body: r.method === "GET" ? undefined : {} }) })));
  const finLeak = finHits.filter((f) => f.res.status >= 200 && f.res.status < 400);
  check(`${NEW_ADMIN.length} social-event admin routes as a finance manager: every one refused`, NEW_ADMIN.length >= 25 && finLeak.length === 0, finLeak.map((f) => `${f.r.method} ${f.r.path} -> ${f.res.status}`));
  const SUPER_ONLY = NEW_ADMIN.filter((r) => /reveal-grants|reveal-activity|moderators|reset-mfa/.test(r.path) && !/reveal-grants\/mine/.test(r.path));
  const modHits = await Promise.all(SUPER_ONLY.map(async (r) => ({ r, res: await http(r.method, sub(r.path, ids), { who: mod, body: r.method === "GET" ? undefined : {} }) })));
  check(`${SUPER_ONLY.length} super-admin-only routes as a moderator: every one refused`, SUPER_ONLY.length >= 5 && modHits.every((m) => m.res.status === 403), modHits.filter((m) => m.res.status !== 403).map((m) => `${m.r.method} ${m.r.path} -> ${m.res.status}`));
  const HOST_ADMIN = NEW_ADMIN.filter((r) => /^\/api\/admin\/(hosts|strikes|bans|moderation\/config)/.test(r.path));
  const modHost = await Promise.all(HOST_ADMIN.map(async (r) => ({ r, res: await http(r.method, sub(r.path, ids), { who: mod, body: r.method === "GET" ? undefined : {} }) })));
  check(`${HOST_ADMIN.length} host/config routes as a moderator: every one refused`, HOST_ADMIN.length >= 8 && modHost.every((m) => m.res.status === 403), modHost.filter((m) => m.res.status !== 403).map((m) => `${m.r.method} ${m.r.path} -> ${m.res.status}`));
  const QUEUE = NEW_ADMIN.filter((r) => /^\/api\/admin\/moderation\/(queue|events|bulk)/.test(r.path));
  const admQueue = await Promise.all(QUEUE.map(async (r) => ({ r, res: await http(r.method, sub(r.path, ids), { who: adm, body: r.method === "GET" ? undefined : {} }) })));
  check(`the plain admin role is kept out of all ${QUEUE.length} moderation-queue routes`, QUEUE.length >= 3 && admQueue.every((m) => m.res.status === 403));

  // =====================================================================
  console.log("\nprice-0 ticket path: an invitation IS a free ticket");
  const priv2 = (await http("POST", "/api/social-events", { user: host, body: body({ title: "Ticket path" }), label: "host", addr: true, tok: true })).json;
  const tok2 = priv2.inviteUrl.split("/i/")[1];
  await http("PUT", `/api/invite/${tok2}/rsvp`, { user: guestAcct, body: { name: "Acct Guest", attending: true, plusOneCount: 1 }, label: "guestAcct", addr: true });
  const anonRsvp = await http("PUT", `/api/invite/${tok2}/rsvp`, { body: { name: "Anon Guest", attending: true, plusOneCount: 0 }, label: "anon-guest", addr: true });
  const anonTok = anonRsvp.json.manageToken as string;
  const [evRow] = await q(`select ticket_price, requires_rsvp, kind, currency from events where id=$1`, [priv2.id]);
  check("the event is a price-0 event that requires an RSVP", evRow.ticket_price === 0 && evRow.requires_rsvp === true && evRow.kind === "social", evRow);
  const trows = await q(`select user_id, guest_token_hash, amount_paid, payment_provider, status, validation_code, plus_one_count from tickets where event_id=$1 order by purchase_date`, [priv2.id]);
  check("each RSVP is a row in the SAME tickets table: amount 0, provider 'free', confirmed", trows.length === 2 && trows.every((t: any) => t.amount_paid === 0 && t.payment_provider === "free" && t.status === "confirmed"), trows);
  check("each ticket has its own unique validation code (what a scanner reads)", new Set(trows.map((t: any) => t.validation_code)).size === 2 && trows.every((t: any) => typeof t.validation_code === "string" && t.validation_code.length >= 32));
  check("an account guest's invitation shows up in their ticket wallet", (await storage.getUserTickets(guestAcct)).some((t) => t.eventId === priv2.id && t.amountPaid === 0));
  check("no money ever moves: no payment_transactions row, no ticket tiers", (await q(`select count(*)::int n from payment_transactions where event_id=$1`, [priv2.id]))[0].n === 0 && (await q(`select count(*)::int n from ticket_tiers where event_id=$1`, [priv2.id]))[0].n === 0);
  check("tiers can't be added to a social event (generic ticket routes 404)", (await http("POST", `/api/events/${priv2.id}/ticket-tiers`, { user: host, body: {} })).status === 404);
  const acctTicket = trows.find((t: any) => t.user_id === guestAcct);
  const [tid] = await q(`select id from tickets where event_id=$1 and guest_token_hash is not null`, [priv2.id]);
  const scan1 = await storage.checkInTicket(tid.id, host);
  const scan2 = await storage.checkInTicket(tid.id, host);
  check("the existing scanner primitive works on a no-account guest's ticket, once only (atomic)", !!scan1?.checkedInAt && scan2 === null && acctTicket !== undefined);
  check("capacity uses the existing counter: 1 + 1 (plus-one) + 1 = 3 heads", (await q(`select tickets_sold from events where id=$1`, [priv2.id]))[0].tickets_sold === 3);
  if (paymentsMounted) {
    const co = await http("POST", "/api/payments/event/checkout", { user: guestAcct, body: { eventId: priv2.id }, label: "guestAcct" });
    check("paid checkout refuses a free social event", co.status === 400 && /RSVP/i.test(co.json?.message ?? ""), co.json);
    const pr = await http("POST", "/api/payments/event/promote/intent", { user: host, body: { eventId: priv2.id, durationDays: 7 }, label: "host" });
    check("paid promotion refuses a social event", pr.status === 400, pr.json);
  } else {
    const src = (await import("fs")).readFileSync("server/payment-routes.ts", "utf8");
    check("checkout rejects price-0 events and all 4 promotion routes reject social events (source check; payment SDKs not loadable here)", /Free events use RSVP/.test(src) && (src.match(/Social events can't be promoted/g) ?? []).length === 4);
  }

  // =====================================================================
  console.log("\nnon-user invite flow end to end (no account anywhere)");
  const anonGet = await http("GET", `/api/invite/${tok2}/rsvp`, { token: anonTok, label: "anon-guest", addr: true });
  check("a guest with no account sees their answer and the address using only their private token", anonGet.json?.attending === true && anonGet.json?.address === ADDRESS);
  const anonEdit = await http("PUT", `/api/invite/${tok2}/rsvp`, { token: anonTok, body: { name: "Anon Guest", attending: false, plusOneCount: 0 }, label: "anon-guest" });
  check("...changes their mind (address withdrawn, seat released)", anonEdit.json?.attending === false && anonEdit.json?.address === null && (await q(`select tickets_sold from events where id=$1`, [priv2.id]))[0].tickets_sold === 2);
  check("...and the host never needed to know an email, phone or account for them", (await q(`select user_id, guest_name from tickets where guest_token_hash is not null and event_id=$1`, [priv2.id]))[0].user_id === null);

  // =====================================================================
  console.log("\nleak sweep: the exact address and invite link appear ONLY where intended");
  const pubId = await mkPublicEvent(pubHost, "Public rooftop");
  await http("GET", "/api/social-events", { user: host, label: "host", addr: true, tok: true });
  await http("GET", `/api/social-events/${priv.id}`, { user: host, label: "host", addr: true, tok: true });
  await http("PATCH", `/api/social-events/${priv.id}`, { user: host, body: { dressCode: "Smart" }, label: "host", addr: true, tok: true });
  await http("GET", `/api/social-events/${priv.id}/guests`, { user: host, label: "host" });
  await http("GET", `/api/invite/${priv.token}`, { label: "anon" });
  await http("GET", `/api/invite/${priv.token}/rsvp`, { label: "anon" });
  const gSession = await http("PUT", `/api/invite/${priv.token}/rsvp`, { user: guestAcct, body: { name: "Acct Guest", attending: true, plusOneCount: 0 }, label: "guestAcct", addr: true });
  await http("GET", `/api/invite/${priv.token}/rsvp`, { user: guestAcct, label: "guestAcct", addr: true });
  await http("GET", "/api/tickets", { user: guestAcct, label: "guestAcct" });
  await http("GET", "/api/notifications", { user: host, label: "host" });
  await http("GET", "/api/search?q=Ada", { user: stranger, label: "stranger" });
  await http("GET", `/api/social-events/${priv.id}`, { user: stranger, label: "stranger" });
  await http("GET", `/api/social-events/${priv.id}/guests`, { user: stranger, label: "stranger" });
  await http("GET", `/api/events/${priv.id}`, { user: host, label: "host" });
  // public event: pending guest sees no address; after approval they do
  await http("PUT", `/api/invite/${pubId}/rsvp`, { user: guestAcct, body: { name: "Acct Guest", attending: true, plusOneCount: 0 }, label: "guestAcct" });
  await http("GET", `/api/invite/${pubId}/rsvp`, { user: guestAcct, label: "guestAcct" });
  await http("GET", `/api/invite/${pubId}`, { label: "anon" });
  await http("GET", `/api/events/${pubId}`, { label: "anon" });
  await http("GET", "/api/events", { label: "anon" });
  await http("GET", "/api/events/featured", { label: "anon" });
  await http("GET", "/api/events/promoted", { label: "anon" });
  const pubTicket = (await q(`select id from tickets where event_id=$1 and user_id=$2`, [pubId, guestAcct]))[0].id;
  await http("POST", `/api/social-events/${pubId}/guests/${pubTicket}/approve`, { user: pubHost, label: "pubHost" });
  await http("GET", `/api/invite/${pubId}/rsvp`, { user: guestAcct, label: "guestAcct", addr: true });
  // admin side: everything RSVP-count only
  for (const who of [superA, mod, adm, viewer]) await http("GET", "/api/admin/events?limit=100", { who });
  await http("GET", "/api/admin/moderation/queue", { who: mod });
  await http("GET", `/api/admin/moderation/events/${pubId}/reports`, { who: mod });
  await http("GET", `/api/admin/hosts/${pubHost}`, { who: adm });
  await http("GET", "/api/admin/social/metrics", { who: viewer });
  await http("GET", "/api/admin/moderation/config", { who: adm });
  await http("GET", "/api/admin/reveal-activity", { who: superA });
  const [rpt] = await q(`insert into content_reports (reporter_id, content_type, content_id, reason) values ($1,'event',$2,'scam') returning id`, [stranger, pubId]);
  const gr = await http("POST", "/api/admin/reveal-grants", { who: superA, body: { granteeId: mod.id, eventId: pubId, case: { caseType: "report", caseId: rpt.id }, reason: "Welfare check on the venue address" }, label: "superA" });
  check("setup: super-admin delegates reveal access to a moderator", gr.status === 201, gr.json);
  await http("POST", `/api/admin/events/${pubId}/reveal`, { who: superA, body: { scope: "address", case: { caseType: "report", caseId: rpt.id }, reason: "Investigating a scam report" }, addr: true, label: "superA" });
  await http("POST", `/api/admin/events/${pubId}/reveal`, { who: mod, body: { scope: "address", grantId: gr.json?.id }, addr: true, label: "mod" });
  await http("POST", `/api/admin/events/${pubId}/reveal`, { who: mod, body: { scope: "address" }, label: "mod-no-grant" });
  // every listing endpoint, for the PRIVATE event
  const listings = ["/api/events", "/api/events/featured", "/api/events/promoted", "/api/events/by-category/social", "/api/events/by-category/party", "/api/events/nearby?lat=51.5&lon=-0.1", "/api/events/happening-now?lat=51.5&lon=-0.1", "/api/events/trending-in-city?city=Shoreditch", "/api/events/trending-in-city?city=London", `/api/search?q=${encodeURIComponent("Ada's 30th")}`];
  const lists = await Promise.all(listings.map((p) => http("GET", p, { user: stranger, label: "listing" })));
  check(`${listings.length} discovery / search endpoints: the private event appears in none`, lists.every((l) => l.status === 200 && !l.text.includes(priv.id) && !l.text.includes("Ada's 30th")), lists.map((l) => l.status));
  check("the public event IS discoverable (the listings aren't just empty)", (await http("GET", "/api/events", { label: "listing" })).text.includes(pubId));

  const addrLeaks = recorded.filter((r) => r.text.includes(ADDRESS) && !r.addr);
  check(`address leak sweep over ${recorded.length} recorded responses: every appearance was expected`, addrLeaks.length === 0, addrLeaks.map((r) => `${r.actor} ${r.method} ${r.path} -> ${r.status}`));
  const tokLeaks = recorded.filter((r) => (r.text.includes(priv.token) || r.text.includes(tok2)) && !r.tok && !/\/api\/invite\/|\/rsvp/.test(r.path));
  check("the private invite token appears only in the host's own views", tokLeaks.length === 0, tokLeaks.map((r) => `${r.actor} ${r.method} ${r.path}`));
  const everyBody = recorded.map((r) => r.text).join("\n");
  check("no response anywhere contains a password hash, guest-token hash, raw phone, or the raw column names", !/passwordHash|password_hash|guestTokenHash|guest_token_hash|"exactAddress"|"inviteToken"|"verifiedPhone"|valueHash/.test(everyBody));
  check("an admin looking at the queue, event list, host profile and metrics never saw the address or a guest name", !recorded.filter((r) => /^\/api\/admin\/(events|moderation|hosts|social)/.test(r.path) && !/\/reveal$/.test(r.path)).some((r) => r.text.includes(ADDRESS) || /Acct Guest|Anon Guest/.test(r.text)));
  check("only the two authorised reveals returned the address to admins", recorded.filter((r) => /\/reveal$/.test(r.path) && r.text.includes(ADDRESS)).length === 2 && recorded.find((r) => r.actor === "mod-no-grant")!.status === 403);

  // =====================================================================
  console.log("\ntext sanitising on every host- and guest-typed field");
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>Hello';
  const evilShort = '<b onclick=x()>1pm</b>'; // the schedule time field is capped at 40 characters
  const xss = await http("POST", "/api/social-events", { user: host, label: "host", addr: true, tok: true, body: body({ title: evil, description: evil, location: evil, city: evil, exactAddress: evil, dressCode: evil, schedule: [{ name: evil, time: evilShort }] }) });
  const xr = (await q(`select title, description, location, city, exact_address, dress_code, lineup::text as lineup from events where id=$1`, [xss.json.id]))[0];
  check("a title/description/area/city/address/dress code/schedule full of markup is stored as plain text", xss.status === 201 && Object.values(xr).every((v) => !/<\s*[a-z!\/]|onerror\s*=/i.test(String(v))), xr);
  const xt = await http("PUT", `/api/invite/${xss.json.inviteUrl.split("/i/")[1]}/rsvp`, { body: { name: '<b onmouseover=alert(1)>Mallory</b><script>x</script>', attending: true, plusOneCount: 0 }, label: "anon-guest", addr: true });
  check("a guest name full of markup is stored as plain text (the host reads it in a list)", xt.status === 200 && !/<\s*[a-z!\/]|onmouseover/i.test((await q(`select guest_name from tickets where event_id=$1`, [xss.json.id]))[0].guest_name));
  const sqli = await http("POST", "/api/social-events", { user: host, label: "host", addr: true, tok: true, body: body({ title: "x'); DROP TABLE events; --" }) });
  check("SQL metacharacters are just text (parameterised): the table is still there", sqli.status === 201 && (await q(`select count(*)::int n from events`))[0].n > 3);

  // =====================================================================
  console.log("\nflood limiting and token strength");
  const flood = [];
  for (let i = 0; i < 44; i++) flood.push(await http("GET", `/api/invite/${tok2}`, { ip: "198.51.100.77", label: "flood" }));
  check("44 requests from one IP in a burst: the first 40 pass, the rest are rate-limited (429)", flood.slice(0, 40).every((f) => f.status === 200) && flood.slice(40).every((f) => f.status === 429), flood.map((f) => f.status).join(","));
  check("a different IP is unaffected", (await http("GET", `/api/invite/${tok2}`, { ip: "198.51.100.78", label: "flood" })).status === 200);
  check("invite tokens are long and unguessable (>= 24 url-safe chars), unique per event", priv.token.length >= 24 && /^[A-Za-z0-9_-]+$/.test(priv.token) && new Set([priv.token, tok2, xss.json.inviteUrl.split("/i/")[1]]).size === 3);
  check("guest manage tokens are even longer (>= 32 chars)", anonTok.length >= 32);
  const guesses = await Promise.all(Array.from({ length: 12 }, (_, i) => http("GET", `/api/invite/${crypto.randomBytes(18).toString("base64url")}`, { label: "guess" })));
  check("random guesses at invite links all 404 with an identical body (no enumeration signal)", guesses.every((g) => g.status === 404 && g.text === guesses[0].text));

  // =====================================================================
  console.log("\nevent timing");
  const over = await mkPublicEvent(pubHost, "Already finished");
  await q(`update events set event_date = now() - interval '2 days', moderation_status='approved' where id=$1`, [over]);
  const late = await http("PUT", `/api/invite/${over}/rsvp`, { user: guestAcct, body: { name: "Late", attending: true, plusOneCount: 0 }, label: "guestAcct" });
  check("RSVP to an event that has finished -> 400 CLOSED", late.status === 400 && late.json?.code === "CLOSED", late.json);
  const today = await mkPublicEvent(pubHost, "Tonight");
  await q(`update events set event_date = now() - interval '2 hours', event_end_date = now() + interval '3 hours' where id=$1`, [today]);
  check("RSVP while an event is under way (end time still ahead) is allowed", (await http("PUT", `/api/invite/${today}/rsvp`, { user: guestAcct, body: { name: "Just in time", attending: true, plusOneCount: 0 }, label: "guestAcct" })).status === 200);

  // =====================================================================
  console.log("\nsignup can't grant privileges; the profile phone can't be set or leaked");
  const signupBody = {
    email: `Mass-${tag}@Test.Local`, username: `mass_${tag}`, password: "Passw0rd!x-ok", userType: "social", displayName: "Mallory", dateOfBirth: "1990-01-01", gender: "Female", interests: ["Music"], bio: "hello",
    // none of these may be accepted from a signup request:
    isVerified: true, isOfficial: true, freePromotionCredits: 99, verifiedPhone: "+447700900999", phoneVerifiedAt: new Date().toISOString(),
    phoneNumber: "+447700900888", usernameChangesRemaining: 99, zernioProfileId: "zernio-x", onboardingComplete: false, readReceiptsEnabled: false, deletedAt: new Date().toISOString(),
  };
  const sg = await http("POST", "/api/auth/signup", { body: signupBody, label: "signup" });
  check("a signup carrying forbidden fields still succeeds (extras are dropped, not fatal)", sg.status >= 200 && sg.status < 300, { s: sg.status, j: sg.json });
  const [nu] = await q(`select is_verified, is_official, free_promotion_credits, verified_phone, phone_verified_at, phone_number, username_changes_remaining, zernio_profile_id, onboarding_complete, read_receipts_enabled, deleted_at, email, display_name, interests, user_type from users where username=$1`, [`mass_${tag}`]);
  check("none of the privileged / verification fields were taken from the request", nu && nu.is_verified === false && nu.is_official === false && nu.free_promotion_credits === 0 && nu.verified_phone === null && nu.phone_verified_at === null && nu.phone_number === null && nu.username_changes_remaining === 2 && nu.zernio_profile_id === null && nu.onboarding_complete === true && nu.read_receipts_enabled === true && nu.deleted_at === null, nu);
  check("the legitimate signup fields were stored (email lower-cased, name, interests, type)", nu?.email === `mass-${tag}@test.local` && nu?.display_name === "Mallory" && nu?.interests?.[0] === "Music" && nu?.user_type === "social");
  const orgSignup = await http("POST", "/api/auth/signup", { label: "signup", body: { email: `org-${tag}@test.local`, username: `org_${tag}`, password: "Passw0rd!x-ok", userType: "organizer", organizationName: "Club Co", contactEmail: "hi@club.test", socialMediaLinks: ["https://club.test"], canManageVenues: true, bio: "b", isOfficial: true } });
  const [ou] = await q(`select organization_name, contact_email, can_manage_venues, is_official from users where username=$1`, [`org_${tag}`]);
  check("an organiser signup keeps its own fields (venue-manager checkbox, org name) but not isOfficial", orgSignup.status < 300 && ou?.organization_name === "Club Co" && ou?.can_manage_venues === true && ou?.is_official === false, ou);
  const unverified = await mkUser("emailunverified"); await q(`update users set is_verified=false where id=$1`, [unverified]);
  check("so a fresh signup is NOT treated as email-verified: it can't host", (await http("POST", "/api/social-events", { user: unverified, body: body(), label: "unverified" })).json?.code === "EMAIL_NOT_VERIFIED");

  const phoneUser = await mkUser("phoneuser");
  const pr = await http("PATCH", "/api/users/me", { user: phoneUser, body: { bio: "updated bio", phoneNumber: "+447700900777" }, label: "profile" });
  const [pu] = await q(`select bio, phone_number from users where id=$1`, [phoneUser]);
  check("a profile update ignores phoneNumber but still saves the rest", pr.status === 200 && pu.bio === "updated bio" && pu.phone_number === null, { s: pr.status, pu });
  check("the profile response itself carries no phoneNumber key", !/phoneNumber/.test(pr.text));

  await q(`update users set phone_number='+447700900555', verified_phone='+447700900556', phone_verified_at=now() where id=$1`, [phoneUser]);
  const [rawU] = await q(`select * from users where id=$1`, [phoneUser]);
  const camel = { ...rawU, phoneNumber: rawU.phone_number, verifiedPhone: rawU.verified_phone };
  const pub2 = toPublicUser(camel as never) as Record<string, unknown>;
  check("toPublicUser removes the profile phone AND the verified phone (and still the credentials)", !("phoneNumber" in pub2) && !("verifiedPhone" in pub2) && !("passwordHash" in pub2));
  const adminUsers = await http("GET", `/api/admin/users?search=phoneuser_${tag}`, { who: superA });
  check("the admin user list (which embeds public users) shows neither number", adminUsers.status === 200 && adminUsers.json.users.length >= 1 && !/4477009055/.test(adminUsers.text), adminUsers.status);
  const srch = await http("GET", `/api/search?q=phoneuser_${tag}`, { user: stranger, label: "stranger" });
  check("user search shows neither number to another user", srch.status === 200 && !/4477009055/.test(srch.text) && srch.text.includes(`phoneuser_${tag}`), srch.status);
  if (buddiesMounted) {
    await q(`insert into safety_buddies (user_id, name, phone_number, confirmation_status) values ($1,'Trusted Buddy','+447700900123','confirmed')`, [phoneUser]);
    const bd = await http("GET", "/api/safety/buddies", { user: phoneUser, label: "profile" });
    check("regression: a safety buddy's phone is still returned to its owner (the hiding is not a blanket key strip)", bd.status === 200 && bd.json?.buddies?.[0]?.phoneNumber === "+447700900123", bd.json);
    const other = await http("GET", "/api/safety/buddies", { user: stranger, label: "stranger" });
    check("...and not to anyone else", other.status === 200 && !other.text.includes("+447700900123"));
  } else {
    check("buddy endpoint not mountable here (skipped; covered by the key-name reasoning in auth.ts)", true);
  }

  // =====================================================================
  console.log("\nstartup backfill: a restart must never approve events held for review");
  const held = await mkPublicEvent(pubHost, "Held for review", { status: "pending" });
  const [commercial] = await q(`insert into events (organizer_id, title, description, event_date, location, category, ticket_price, tickets_available, moderation_status, is_published) values ($1,'Club night','x', now() + interval '3 days','Soho','music',10,10,'pending',true) returning id`, [host]);
  await ensureSchema(); // exactly what runs at every server start
  check("a social event held for review is STILL pending after the startup migration ran", (await q(`select moderation_status from events where id=$1`, [held]))[0].moderation_status === "pending");
  check("(existing behaviour, unchanged) a pending commercial event is approved by it", (await q(`select moderation_status from events where id=$1`, [commercial.id]))[0].moderation_status === "approved");
} catch (e) {
  failures++;
  console.error("\nUNEXPECTED ERROR", e);
} finally {
  server.close();
  await pool.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
