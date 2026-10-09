// End-to-end check of social events Phase 3: public events + automated abuse controls.
// Real routes, real storage, real services, real global redaction; only authentication is faked
// (x-test-user header) and the SMS sender is replaced by a recorder.
//
//   DATABASE_URL=<scratch db> DISABLE_GEOCODING=1 SESSION_SECRET=x npx tsx scripts/test-social-events-phase3.ts
//
// Refuses to run unless the database name contains "test" - never point it at prod.
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

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerSocialEventGate, registerSocialEventRoutes } = await import("../server/routes/social-events-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");
const { registerPhoneRoutes } = await import("../server/routes/phone-routes");
const { deviceMiddleware, addStrike, banUser, liftBan, getLinkedAccounts, countActiveStrikes, hashPhone } = await import("../server/services/enforcement");
const { scanContent } = await import("../server/services/contentScan");
const { invalidateConfigCache } = await import("../server/services/moderationConfig");
const { setSmsSenderForTests, normalizeE164 } = await import("../server/services/phoneVerification");
const { ageFromDob, getFeaturableHostIds } = await import("../server/services/eventAbuse");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

// ---- fixtures -------------------------------------------------------------
const tag = crypto.randomBytes(3).toString("hex");
let phoneSeq = 1000;
async function mkUser(name: string, o: { ageDays?: number; verified?: boolean; phone?: boolean; dob?: string | null } = {}) {
  const [u] = await q(
    `insert into users (email, username, user_type, is_verified, display_name, date_of_birth, created_at)
     values ($1,$2,'social',$3,$4,$5, now() - ($6 || ' days')::interval) returning id`,
    [`${name}-${tag}@test.local`, `${name}_${tag}`, o.verified ?? true, name, o.dob === undefined ? "1990-01-01" : o.dob, String(o.ageDays ?? 90)],
  );
  if (o.phone !== false) {
    const phone = `+4477009${String(phoneSeq++).padStart(5, "0")}`;
    await q(`update users set verified_phone=$2, phone_verified_at=now() where id=$1`, [u.id, phone]);
  }
  return u.id as string;
}
const [admin] = await q(`insert into admin_users (email, username, password_hash, display_name, role) values ($1,$2,'x','Test Admin','super_admin') returning id`, [`admin-${tag}@test.local`, `admin_${tag}`]);
const adminId = admin.id as string;
const setCfg = async (key: string, value: unknown) => {
  await q(`insert into moderation_config (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
  invalidateConfigCache();
};

const sms: Array<{ to: string; body: string }> = [];
setSmsSenderForTests(async (to, body) => { sms.push({ to, body }); });
const lastCode = () => /\b(\d{6})\b/.exec(sms[sms.length - 1]?.body ?? "")?.[1] ?? "";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req: any, _res, next) => {
  const id = req.header("x-test-user");
  req.user = id ? { id, username: id, email: "", userType: "social" } : undefined;
  req.isAuthenticated = () => !!id;
  next();
});
app.use("/api", deviceMiddleware);
app.use("/api", redactSensitiveFields);
registerSocialEventGate(app);
registerEventsRoutes(app);
registerSocialEventRoutes(app);
registerPhoneRoutes(app);
let paymentsMounted = false;
try {
  const { registerPaymentRoutes } = await import("../server/payment-routes");
  registerPaymentRoutes(app);
  paymentsMounted = true;
} catch { /* payment SDKs need env keys; the guard is then verified by a source check below */ }

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function call(method: string, path: string, o: { user?: string; token?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.user) headers["x-test-user"] = o.user;
  if (o.token) headers["x-rsvp-token"] = o.token;
  if (o.cookie) headers["Cookie"] = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json, text, headers: res.headers, setCookie, cookiePair: setCookie?.split(";")[0] };
}

// Device upserts are fire-and-forget (and the DB is remote), so poll instead of sleeping a fixed time.
async function until(fn: () => Promise<boolean>, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; }

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); }
}

const ADDRESS = "12 Secret Street, Hidden Town";
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({
  title: "Rooftop sunset session", description: "Good music, good people", socialType: "party", visibility: "public",
  eventDate: future(10), location: "Shoreditch, London", exactAddress: ADDRESS, capacity: 20, maxPlusOnes: 2, ...over,
});
const idOf = (r: { json: any }) => r.json.id as string;

try {
  // =====================================================================
  console.log("\ncontent scanner (pure)");
  const flags = (t: string, extra: string[] = []) => scanContent([t], extra).sort().join(",");
  check("clean copy -> no flags", flags("A relaxed rooftop evening. Doors 7pm, dress code smart casual.") === "");
  check("date + time are not phone numbers", flags("Starts 2027-03-20 19:00, ends 20/03/2027 23:30") === "");
  check("street address digits are fine", flags("Meet at 12 Secret Street, E2 7AA") === "");
  check("WhatsApp -> contact_pattern", flags("Join our WhatsApp group").includes("contact_pattern"));
  check("'w h a t s a p p' evasion caught", flags("message me on w h a t s a p p").includes("contact_pattern"));
  check("zero-width evasion caught", flags("whats​app me").includes("contact_pattern"));
  check("Telegram -> contact_pattern", flags("DM me on telegram").includes("contact_pattern"));
  check("https URL -> external_link", flags("tickets at https://evil.example/x").includes("external_link"));
  check("www.domain -> external_link", flags("see www.partytime.co").includes("external_link"));
  check("bare domain -> external_link", flags("book at partytime.com tonight").includes("external_link"));
  check("'[dot]' evasion caught", flags("partytime [dot] com").includes("external_link"));
  check("t.me / wa.me shorteners -> external_link", flags("t.me/abc").includes("external_link") && flags("wa.me/4477").includes("external_link"));
  check("phone number -> contact_pattern", flags("call 0801 234 5678 now").includes("contact_pattern"));
  check("intl phone with + -> contact_pattern", flags("text +44 7700 900123").includes("contact_pattern"));
  check("email -> contact_pattern", flags("write to host@example.org").includes("contact_pattern"));
  check("free entry + pay -> free_entry_payment", flags("FREE ENTRY! Just pay a £10 deposit to confirm").includes("free_entry_payment"));
  check("free entry + booking fee -> free_entry_payment", flags("Free entry. Booking fee applies").includes("free_entry_payment"));
  check("plain 'free entry' is NOT flagged", flags("Free entry all night, come as you are") === "");
  check("admin-editable pattern list extends the floor", flags("send your cashtag", ["cashtag"]).includes("contact_pattern"));

  console.log("\nhelpers (pure)");
  check("E.164 accepts +447700900123", normalizeE164("+44 7700-900123") === "+447700900123");
  check("E.164 rejects local format and junk", normalizeE164("07700900123") === null && normalizeE164("+0123456789") === null && normalizeE164("hello") === null && normalizeE164("+123") === null);
  check("ageFromDob: birthday not reached yet", ageFromDob("2000-12-31", new Date("2026-06-01T00:00:00Z")) === 25 && ageFromDob("2000-06-01", new Date("2026-06-01T00:00:00Z")) === 26);
  check("ageFromDob: missing/garbage -> null", ageFromDob(null) === null && ageFromDob("not-a-date") === null);

  // =====================================================================
  console.log("\nphone verification (OTP)");
  const p1 = await mkUser("otp1", { phone: false });
  const p2 = await mkUser("otp2", { phone: false });
  const PHONE = "+447700911111";
  check("unauthenticated -> 401", (await call("POST", "/api/auth/phone/request", { body: { phone: PHONE } })).status === 401);
  const badFmt = await call("POST", "/api/auth/phone/request", { user: p1, body: { phone: "07700911111" } });
  check("local-format number -> 400 INVALID_PHONE", badFmt.status === 400 && badFmt.json?.code === "INVALID_PHONE", badFmt.json);
  const req1 = await call("POST", "/api/auth/phone/request", { user: p1, body: { phone: PHONE } });
  check("request -> 200 and the code is texted, never returned", req1.status === 200 && sms.length === 1 && sms[0].to === PHONE && !req1.text.includes(lastCode()), req1.json);
  const [stored] = await q(`select code_hash, attempts from phone_verifications where user_id=$1`, [p1]);
  check("only a hash of the code is stored", stored.code_hash !== lastCode() && stored.code_hash.length === 64);
  const cool = await call("POST", "/api/auth/phone/request", { user: p1, body: { phone: PHONE } });
  check("immediate resend -> 429 COOLDOWN", cool.status === 429 && cool.json?.code === "COOLDOWN", cool.json);
  const goodCode = lastCode();
  const wrong = goodCode === "000000" ? "111111" : "000000";
  const w1 = await call("POST", "/api/auth/phone/verify", { user: p1, body: { code: wrong } });
  check("wrong code -> 400 WRONG_CODE, tries counted", w1.status === 400 && w1.json?.code === "WRONG_CODE" && /4 tries left/.test(w1.json?.message), w1.json);
  for (let i = 0; i < 4; i++) await call("POST", "/api/auth/phone/verify", { user: p1, body: { code: wrong } });
  const locked = await call("POST", "/api/auth/phone/verify", { user: p1, body: { code: goodCode } });
  check("5 wrong tries lock the code, even the right code is refused", locked.status === 429 && locked.json?.code === "TOO_MANY_ATTEMPTS", locked.json);
  check("account still unverified", (await q(`select verified_phone from users where id=$1`, [p1]))[0].verified_phone === null);
  await q(`update phone_verifications set created_at = now() - interval '5 minutes' where user_id=$1`, [p1]);
  await call("POST", "/api/auth/phone/request", { user: p1, body: { phone: PHONE } });
  const code2 = lastCode();
  const ok2 = await call("POST", "/api/auth/phone/verify", { user: p1, body: { code: code2 } });
  check("fresh correct code -> verified", ok2.status === 200 && ok2.json?.verified === true && ok2.json?.phoneLast4 === "1111", ok2.json);
  const [vu] = await q(`select verified_phone, phone_verified_at from users where id=$1`, [p1]);
  check("users.verified_phone set (E.164) + timestamp", vu.verified_phone === PHONE && !!vu.phone_verified_at);
  check("code is single-use", (await call("POST", "/api/auth/phone/verify", { user: p1, body: { code: code2 } })).json?.code === "CODE_EXPIRED");
  const dup = await call("POST", "/api/auth/phone/request", { user: p2, body: { phone: PHONE } });
  check("same number on another account -> 409 PHONE_IN_USE", dup.status === 409 && dup.json?.code === "PHONE_IN_USE", dup.json);
  await call("POST", "/api/auth/phone/request", { user: p2, body: { phone: "+447700922222" } });
  await q(`update phone_verifications set expires_at = now() - interval '1 second' where user_id=$1`, [p2]);
  check("expired code -> CODE_EXPIRED", (await call("POST", "/api/auth/phone/verify", { user: p2, body: { code: lastCode() } })).json?.code === "CODE_EXPIRED");
  // per-number send cap (stops using us to spam someone's phone from many accounts)
  const spam = "+447700933333";
  for (let i = 0; i < 5; i++) { const u = await mkUser(`spam${i}`, { phone: false }); await q(`insert into phone_verifications (user_id, phone, code_hash, expires_at) values ($1,$2,'x', now() + interval '5 minutes')`, [u, spam]); }
  const spamUser = await mkUser("spamTarget", { phone: false });
  const capped = await call("POST", "/api/auth/phone/request", { user: spamUser, body: { phone: spam } });
  check("5 codes already sent to one number this hour -> 429", capped.status === 429 && capped.json?.code === "TOO_MANY_CODES", capped.json);
  setSmsSenderForTests(async () => { throw new Error("provider down"); });
  const p3 = await mkUser("otp3", { phone: false });
  const failSend = await call("POST", "/api/auth/phone/request", { user: p3, body: { phone: "+447700944444" } });
  check("SMS provider failure -> 502 and no dangling code row", failSend.status === 502 && (await q(`select count(*)::int n from phone_verifications where user_id=$1`, [p3]))[0].n === 0, failSend.json);
  setSmsSenderForTests(async (to, b) => { sms.push({ to, body: b }); });

  // =====================================================================
  console.log("\npublic event creation gates");
  const noPhone = await mkUser("nophone", { phone: false });
  const r1 = await call("POST", "/api/social-events", { user: noPhone, body: body() });
  check("no verified phone -> 403 PHONE_NOT_VERIFIED", r1.status === 403 && r1.json?.code === "PHONE_NOT_VERIFIED", r1.json);
  const young = await mkUser("young", { ageDays: 1 });
  const r2 = await call("POST", "/api/social-events", { user: young, body: body() });
  check("account younger than min age -> 403 ACCOUNT_TOO_NEW with days left", r2.status === 403 && r2.json?.code === "ACCOUNT_TOO_NEW" && r2.json?.daysRemaining === 6, r2.json);
  const priv = await call("POST", "/api/social-events", { user: noPhone, body: body({ visibility: "private" }) });
  check("private events need neither phone nor account age", priv.status === 201, priv.json);
  await setCfg("min_account_age_days", 0);
  check("min account age is config-driven (set to 0 -> young account passes)", (await call("POST", "/api/social-events", { user: young, body: body() })).status === 201);
  await setCfg("min_account_age_days", 7);

  const newbie = await mkUser("newbie", { ageDays: 10 }); // past min age, still inside the 30-day 'new' window
  for (const [label, text] of [
    ["WhatsApp contact", "Great night. Contact me on WhatsApp for the address"],
    ["URL", "Tickets here: https://tickets.example/abc"],
    ["bare domain", "Book at partytime.com"],
    ["phone number", "Call 0801 234 5678 to reserve"],
    ["email", "Write to host@example.org"],
  ] as const) {
    const r = await call("POST", "/api/social-events", { user: newbie, body: body({ description: text }) });
    check(`new account + ${label} -> 400 CONTENT_BLOCKED`, r.status === 400 && r.json?.code === "CONTENT_BLOCKED", r.json);
  }
  const alc = await call("POST", "/api/social-events", { user: newbie, body: body({ servesAlcohol: true, ageRestriction: "all" }) });
  check("alcohol with 'all ages' -> 400", alc.status === 400 && alc.json?.code === "ALCOHOL_NEEDS_AGE_LIMIT", alc.json);
  check("nothing was created by the rejected attempts", (await q(`select count(*)::int n from events where organizer_id=$1`, [newbie]))[0].n === 0);

  const held = await call("POST", "/api/social-events", { user: newbie, body: body({ servesAlcohol: true, ageRestriction: "18+" }) });
  check("new account, clean copy -> 201 but held for review", held.status === 201 && held.json?.moderationStatus === "pending" && /reviewed/.test(held.json?.reviewNote ?? ""), held.json);
  const [heldRow] = await q(`select queue_reason, queued_at, auto_flags, latitude from events where id=$1`, [idOf(held)]);
  check("queue bookkeeping: reason new_account_review + queued_at, no coordinates", heldRow.queue_reason === "new_account_review" && !!heldRow.queued_at && heldRow.latitude === null, heldRow);
  check("held event is NOT in discovery", !(await storage.getEvents()).some((e) => e.id === idOf(held)));
  check("held event is NOT searchable", !(await storage.searchEvents("sunset")).some((e) => e.id === idOf(held)));
  check("held event page is 404 for the public", (await call("GET", `/api/events/${idOf(held)}`)).status === 404 && (await call("GET", `/api/invite/${idOf(held)}`)).status === 404);
  check("host still sees it, with the review note", (await call("GET", `/api/social-events/${idOf(held)}`, { user: newbie })).json?.moderationStatus === "pending");
  const weekly = await call("POST", "/api/social-events", { user: newbie, body: body({ title: "Second one" }) });
  check("new account: 2nd public event this week -> 429 WEEKLY_LIMIT", weekly.status === 429 && weekly.json?.code === "WEEKLY_LIMIT", weekly.json);
  check("...but a private event is still fine", (await call("POST", "/api/social-events", { user: newbie, body: body({ visibility: "private" }) })).status === 201);
  await setCfg("new_account_weekly_public_limit", 2);
  check("weekly limit is config-driven (raise to 2 -> allowed)", (await call("POST", "/api/social-events", { user: newbie, body: body({ title: "Second one" }) })).status === 201);
  await setCfg("new_account_weekly_public_limit", 1);

  const freeBait = await mkUser("freebait", { ageDays: 10 });
  const fb = await call("POST", "/api/social-events", { user: freeBait, body: body({ description: "FREE ENTRY! Just pay a small booking fee to confirm your spot" }) });
  const [fbRow] = await q(`select moderation_status, queue_reason, auto_flags from events where id=$1`, [idOf(fb)]);
  check("free-entry-to-payment is flagged into the queue (not rejected)", fb.status === 201 && fbRow.moderation_status === "pending" && fbRow.queue_reason === "auto_flag" && fbRow.auto_flags.includes("free_entry_payment"), fbRow);
  check("the host is NOT told which rule fired", !/free|fee|payment/i.test(JSON.stringify(fb.json?.reviewNote)));

  const std = await mkUser("standard", { ageDays: 90 });
  const pub = await call("POST", "/api/social-events", { user: std, body: body() });
  check("established host, clean copy -> 201 approved immediately", pub.status === 201 && pub.json?.moderationStatus === "approved", pub.json);
  const pubId = idOf(pub);
  const stdLink = await call("POST", "/api/social-events", { user: std, body: body({ description: "Details at https://partytime.example" }) });
  const [slRow] = await q(`select moderation_status, queue_reason, auto_flags from events where id=$1`, [idOf(stdLink)]);
  check("established host + link -> queued with a flag, not rejected", stdLink.status === 201 && slRow.moderation_status === "pending" && slRow.auto_flags.includes("external_link"), slRow);

  const trusted = await mkUser("trusted", { ageDays: 10 });
  await q(`insert into user_trust (user_id, trust_tier, tier_override_by, tier_override_reason, tier_override_at) values ($1,'trusted',$2,'test',now())`, [trusted, adminId]);
  const tr = await call("POST", "/api/social-events", { user: trusted, body: body({ description: "More at https://partytime.example" }) });
  check("admin-trusted host skips link/contact checks -> approved", tr.status === 201 && tr.json?.moderationStatus === "approved", tr.json);
  const trBait = await call("POST", "/api/social-events", { user: trusted, body: body({ title: "Free entry night", description: "Free entry, but you must pay a deposit" }) });
  const [trbRow] = await q(`select moderation_status from events where id=$1`, [idOf(trBait)]);
  check("...but free-entry-to-payment is still queued for trusted hosts", trbRow.moderation_status === "pending");

  console.log("\ndiscovery and address privacy for an approved public event");
  check("appears in getEvents", (await storage.getEvents()).some((e) => e.id === pubId));
  check("appears in search", (await storage.searchEvents("sunset")).some((e) => e.id === pubId));
  const detail = await call("GET", `/api/events/${pubId}`);
  check("GET /api/events/:id works for public approved event", detail.status === 200 && detail.json?.kind === "social", detail.status);
  check("...and never contains the exact address or invite token", !detail.text.includes(ADDRESS) && !/exactAddress|inviteToken/.test(detail.text));
  const att = await call("GET", `/api/events/${pubId}/attendees`);
  check("attendee list stays hidden from other guests (404)", att.status === 404);
  const inv = await call("GET", `/api/invite/${pubId}`);
  check("public invite page loads by event id, requiresLogin, no address", inv.status === 200 && inv.json?.requiresLogin === true && inv.json?.visibility === "public" && !inv.text.includes(ADDRESS), inv.json);
  check("public page is indexable (no noindex header)", !/noindex/.test(inv.headers.get("x-robots-tag") ?? ""));
  check("generic /api/rsvps still refuses social events", (await call("POST", "/api/rsvps", { user: await mkUser("rg"), body: { eventId: pubId } })).status === 400);
  if (paymentsMounted) {
    const pr = await call("POST", "/api/payments/event/promote/intent", { user: std, body: { eventId: pubId, durationDays: 7 } });
    check("promotion endpoint refuses social events", pr.status === 400 && /can't be promoted/.test(pr.json?.message ?? ""), pr.json);
  } else {
    const fs = await import("fs");
    const src = fs.readFileSync("server/payment-routes.ts", "utf8");
    check("promotion guard present on all 4 promote endpoints (source check; SDKs not loadable here)", (src.match(/Social events can't be promoted/g) ?? []).length === 4);
  }

  // =====================================================================
  console.log("\npublic RSVP: login, age gate, host approval of the address");
  const guestA = await mkUser("guestA", { dob: "1995-05-05" });
  const noLogin = await call("PUT", `/api/invite/${pubId}/rsvp`, { body: { name: "Anon", attending: true, plusOneCount: 0 } });
  check("anonymous RSVP to a public event -> 401 LOGIN_REQUIRED", noLogin.status === 401 && noLogin.json?.code === "LOGIN_REQUIRED", noLogin.json);
  const yes = await call("PUT", `/api/invite/${pubId}/rsvp`, { user: guestA, body: { name: "Guest A", attending: true, plusOneCount: 1 } });
  check("logged-in RSVP -> attending but address withheld, addressPending", yes.status === 200 && yes.json?.attending === true && yes.json?.address === null && yes.json?.addressPending === true && !yes.text.includes(ADDRESS), yes.json);
  const [ga] = await q(`select id, address_approved_at, status from tickets where user_id=$1 and event_id=$2`, [guestA, pubId]);
  check("ticket confirmed (seats held) but not approved", ga.status === "confirmed" && ga.address_approved_at === null);
  check("host was notified that an RSVP awaits approval", (await q(`select count(*)::int n from notifications where user_id=$1 and type='event_rsvp' and title='RSVP waiting for approval'`, [std]))[0].n === 1);
  const gl = await call("GET", `/api/social-events/${pubId}/guests`, { user: std });
  check("host guest list shows addressApproved=false", gl.json?.guests?.find((g: any) => g.id === ga.id)?.addressApproved === false, gl.json);
  check("another user cannot approve", (await call("POST", `/api/social-events/${pubId}/guests/${ga.id}/approve`, { user: guestA })).status === 404);
  const appr = await call("POST", `/api/social-events/${pubId}/guests/${ga.id}/approve`, { user: std });
  check("host approves -> 200", appr.status === 200, appr.json);
  const after = await call("GET", `/api/invite/${pubId}/rsvp`, { user: guestA });
  check("approved guest now sees the exact address", after.json?.address === ADDRESS && after.json?.addressPending === false, after.json);
  check("guest was notified of approval", (await q(`select count(*)::int n from notifications where user_id=$1 and type='rsvp_approved'`, [guestA]))[0].n === 1);
  const edit = await call("PUT", `/api/invite/${pubId}/rsvp`, { user: guestA, body: { name: "Guest A", attending: true, plusOneCount: 2 } });
  check("editing plus-ones keeps the host's approval", edit.json?.address === ADDRESS, edit.json);
  check("another guest is still unapproved", (await call("PUT", `/api/invite/${pubId}/rsvp`, { user: await mkUser("guestB"), body: { name: "B", attending: true, plusOneCount: 0 } })).json?.address === null);
  const [sold1] = await q(`select tickets_sold from events where id=$1`, [pubId]);
  const rem = await call("POST", `/api/social-events/${pubId}/guests/${ga.id}/remove`, { user: std });
  const [sold2] = await q(`select tickets_sold from events where id=$1`, [pubId]);
  check("host removes a guest -> seats freed (3 heads)", rem.status === 200 && sold1.tickets_sold - sold2.tickets_sold === 3, { sold1, sold2 });
  const back = await call("PUT", `/api/invite/${pubId}/rsvp`, { user: guestA, body: { name: "Guest A", attending: true, plusOneCount: 0 } });
  check("removed guest cannot RSVP again -> 403 REMOVED", back.status === 403 && back.json?.code === "REMOVED", back.json);
  check("removed guest no longer sees the address", (await call("GET", `/api/invite/${pubId}/rsvp`, { user: guestA })).json?.address === null);
  check("removed RSVP is gone from their wallet", !(await storage.getUserTickets(guestA)).some((t) => t.eventId === pubId));

  const adults = await call("POST", "/api/social-events", { user: std, body: body({ title: "Wine night", ageRestriction: "21+", servesAlcohol: true }) });
  const adultsId = idOf(adults);
  check("21+ event created by established host is approved", adults.json?.moderationStatus === "approved", adults.json);
  const young19 = await mkUser("kid19", { dob: new Date(Date.now() - 19.5 * 365.25 * 86400000).toISOString().slice(0, 10) });
  const noDob = await mkUser("nodob", { dob: null });
  const adult = await mkUser("adult30", { dob: "1990-01-01" });
  const u1 = await call("PUT", `/api/invite/${adultsId}/rsvp`, { user: young19, body: { name: "Kid", attending: true, plusOneCount: 0 } });
  check("19-year-old RSVP to 21+ -> 403 UNDER_AGE", u1.status === 403 && u1.json?.code === "UNDER_AGE", u1.json);
  const u2 = await call("PUT", `/api/invite/${adultsId}/rsvp`, { user: noDob, body: { name: "NoDob", attending: true, plusOneCount: 0 } });
  check("no date of birth on file -> 403 DOB_REQUIRED", u2.status === 403 && u2.json?.code === "DOB_REQUIRED", u2.json);
  check("declining is always allowed (no age check)", (await call("PUT", `/api/invite/${adultsId}/rsvp`, { user: young19, body: { name: "Kid", attending: false, plusOneCount: 0 } })).status === 200);
  check("30-year-old RSVP to 21+ -> 200", (await call("PUT", `/api/invite/${adultsId}/rsvp`, { user: adult, body: { name: "Adult", attending: true, plusOneCount: 0 } })).status === 200);

  console.log("\nedits to public events are re-judged");
  const swap = await call("PATCH", `/api/social-events/${pubId}`, { user: newbie, body: { description: "x" } });
  check("non-owner cannot edit", swap.status === 404);
  const upg = await call("PATCH", `/api/social-events/${pubId}`, { user: std, body: { description: "Come to https://scam.example instead" } });
  const [upRow] = await q(`select moderation_status, auto_flags from events where id=$1`, [pubId]);
  check("adding a link to an approved listing sends it back to review", upg.status === 200 && upRow.moderation_status === "pending" && upRow.auto_flags.includes("external_link"), upRow);
  await q(`update events set moderation_status='approved', auto_flags='{}' where id=$1`, [pubId]);
  const heldEdit = await call("PATCH", `/api/social-events/${idOf(held)}`, { user: newbie, body: { description: "Call 0801 234 5678" } });
  check("new account editing in a phone number -> 400 CONTENT_BLOCKED", heldEdit.status === 400 && heldEdit.json?.code === "CONTENT_BLOCKED", heldEdit.json);
  await q(`update events set moderation_status='approved' where id=$1`, [idOf(held)]);
  const newEdit = await call("PATCH", `/api/social-events/${idOf(held)}`, { user: newbie, body: { title: "Renamed rooftop night" } });
  const [neRow] = await q(`select moderation_status from events where id=$1`, [idOf(held)]);
  check("a new account's approved listing goes back to review after a text edit", newEdit.status === 200 && neRow.moderation_status === "pending", neRow);
  const altEdit = await call("PATCH", `/api/social-events/${pubId}`, { user: std, body: { servesAlcohol: true, ageRestriction: "all" } });
  check("can't add alcohol while leaving all-ages", altEdit.status === 400 && altEdit.json?.code === "ALCOHOL_NEEDS_AGE_LIMIT");
  check("visibility can't be switched by PATCH", (await call("PATCH", `/api/social-events/${pubId}`, { user: std, body: { visibility: "private" } })).status === 200 && (await q(`select visibility from events where id=$1`, [pubId]))[0].visibility === "public");

  // =====================================================================
  console.log("\nreport-to-takedown");
  const rep = [] as string[];
  for (let i = 0; i < 4; i++) rep.push(await mkUser(`rep${i}`));
  check("host cannot report own event", (await call("POST", `/api/events/${pubId}/report`, { user: std, body: { reason: "spam" } })).status === 400);
  check("report needs a login", (await call("POST", `/api/events/${pubId}/report`, { body: { reason: "spam" } })).status === 401);
  check("report needs a reason", (await call("POST", `/api/events/${pubId}/report`, { user: rep[0], body: {} })).status === 400);
  await call("POST", `/api/events/${pubId}/report`, { user: rep[0], body: { reason: "scam" } });
  const dupRep = await call("POST", `/api/events/${pubId}/report`, { user: rep[0], body: { reason: "scam" } });
  check("same reporter twice -> friendly 200, still one report", dupRep.status === 200 && /already reported/.test(dupRep.json?.message) && (await q(`select count(*)::int n from content_reports where content_id=$1`, [pubId]))[0].n === 1);
  await call("POST", `/api/events/${pubId}/report`, { user: rep[1], body: { reason: "fake_event" } });
  check("2 reporters (threshold 3) -> still visible", (await q(`select moderation_status from events where id=$1`, [pubId]))[0].moderation_status === "approved");
  await call("POST", `/api/events/${pubId}/report`, { user: rep[2], body: { reason: "unsafe" } });
  const [hid] = await q(`select moderation_status, queue_reason, queued_at from events where id=$1`, [pubId]);
  check("3rd distinct reporter auto-hides it pending review", hid.moderation_status === "hidden" && hid.queue_reason === "report_threshold" && !!hid.queued_at, hid);
  check("hidden event left discovery immediately (cache invalidated)", !(await storage.getEvents()).some((e) => e.id === pubId));
  check("hidden event page 404s for the public", (await call("GET", `/api/events/${pubId}`)).status === 404 && (await call("GET", `/api/invite/${pubId}`)).status === 404);
  const hn = await q(`select title, message, link from notifications where user_id=$1 and type='event_moderation'`, [std]);
  check("host notified with the reason and an appeal pointer", hn.length === 1 && /appeal/.test(hn[0].message) && hn[0].link === `/social-events/${pubId}`, hn);

  console.log("\nappeals");
  check("short appeal message -> 400", (await call("POST", `/api/social-events/${pubId}/appeal`, { user: std, body: { message: "no" } })).status === 400);
  check("non-host cannot appeal -> 404", (await call("POST", `/api/social-events/${pubId}/appeal`, { user: rep[0], body: { message: "this is wrongly hidden please look" } })).status === 404);
  const ap = await call("POST", `/api/social-events/${pubId}/appeal`, { user: std, body: { message: "This was a genuine rooftop event, please review." } });
  check("host appeal -> 201, lands in moderation_appeals as open", ap.status === 201 && (await q(`select status, subject_type from moderation_appeals where subject_id=$1`, [pubId]))[0]?.status === "open", ap.json);
  check("second open appeal -> 409", (await call("POST", `/api/social-events/${pubId}/appeal`, { user: std, body: { message: "Trying again, same event, please look." } })).status === 409);
  check("appeal on a healthy event -> 400", (await call("POST", `/api/social-events/${adultsId}/appeal`, { user: std, body: { message: "There is nothing to appeal here at all." } })).status === 400);

  console.log("\nreport-bombing resistance + config-driven threshold");
  const ev2 = await call("POST", "/api/social-events", { user: std, body: body({ title: "Victim event" }) });
  const ev2Id = idOf(ev2);
  await q(`insert into user_trust (user_id, abusive_reporter_at, abusive_reporter_by) values ($1, now(), $2) on conflict (user_id) do update set abusive_reporter_at = now()`, [rep[0], adminId]);
  await q(`insert into user_trust (user_id, abusive_reporter_at, abusive_reporter_by) values ($1, now(), $2) on conflict (user_id) do update set abusive_reporter_at = now()`, [rep[1], adminId]);
  for (const r of rep.slice(0, 3)) await call("POST", `/api/events/${ev2Id}/report`, { user: r, body: { reason: "spam" } });
  check("3 reports, 2 from flagged abusive reporters -> NOT hidden", (await q(`select moderation_status from events where id=$1`, [ev2Id]))[0].moderation_status === "approved");
  await call("POST", `/api/events/${ev2Id}/report`, { user: rep[3], body: { reason: "spam" } });
  check("a 2nd credible reporter still isn't enough at threshold 3", (await q(`select moderation_status from events where id=$1`, [ev2Id]))[0].moderation_status === "approved");
  await setCfg("report_auto_hide_threshold", 2);
  const ev3 = idOf(await call("POST", "/api/social-events", { user: std, body: body({ title: "Config event" }) }));
  await call("POST", `/api/events/${ev3}/report`, { user: rep[2], body: { reason: "spam" } });
  await call("POST", `/api/events/${ev3}/report`, { user: rep[3], body: { reason: "spam" } });
  check("threshold is config-driven (set to 2 -> 2 reporters hide it)", (await q(`select moderation_status from events where id=$1`, [ev3]))[0].moderation_status === "hidden");
  await setCfg("report_auto_hide_threshold", 3);

  // =====================================================================
  console.log("\ndevice cookie + linked accounts");
  const dv1 = await mkUser("dev1"), dv2 = await mkUser("dev2");
  const first = await call("GET", "/api/csrf-probe", { user: dv1 });
  check("a signed httpOnly device cookie is issued", !!first.cookiePair?.startsWith("vp_dev=") && /HttpOnly/i.test(first.setCookie ?? ""), first.setCookie);
  const again = await call("GET", "/api/csrf-probe", { user: dv1, cookie: first.cookiePair });
  check("a valid cookie is reused (no new Set-Cookie)", again.setCookie === null);
  const tampered = await call("GET", "/api/csrf-probe", { user: dv1, cookie: first.cookiePair!.slice(0, -2) + "xx" });
  check("a tampered cookie is rejected and replaced", !!tampered.setCookie && tampered.cookiePair !== first.cookiePair);
  await call("GET", "/api/csrf-probe", { user: dv2, cookie: first.cookiePair });
  await until(async () => (await getLinkedAccounts(dv1)).length > 0);
  const links = await getLinkedAccounts(dv1);
  check("two accounts on one device are linked", links.length === 1 && links[0].userId === dv2 && links[0].sharedDevices === 1, links);

  console.log("\nstrikes, bans (phone + device + account), enforcement");
  const bad = await mkUser("badhost");
  const badPhone = (await q(`select verified_phone from users where id=$1`, [bad]))[0].verified_phone as string;
  const badCookie = (await call("GET", "/api/csrf-probe", { user: bad })).cookiePair!;
  await until(async () => (await q(`select 1 from user_devices where user_id=$1`, [bad])).length > 0);
  const badEvent = idOf(await call("POST", "/api/social-events", { user: bad, body: body({ title: "Soon banned" }), cookie: badCookie }));
  check("warns don't count as strikes", (await addStrike({ userId: bad, type: "warn", reason: "w", adminId })).autoBanned === false && (await countActiveStrikes(bad)) === 0);
  await addStrike({ userId: bad, type: "strike", reason: "s1", adminId, expiresAt: new Date(Date.now() - 1000) });
  check("an expired strike doesn't count", (await countActiveStrikes(bad)) === 0);
  const revoked = await addStrike({ userId: bad, type: "strike", reason: "s-revoked", adminId });
  await q(`update user_strikes set revoked_at = now() where id=$1`, [revoked.strike.id]);
  check("a revoked strike doesn't count", (await countActiveStrikes(bad)) === 0);
  await addStrike({ userId: bad, type: "strike", reason: "s2", adminId });
  await addStrike({ userId: bad, type: "strike", reason: "s3", adminId });
  const third = await addStrike({ userId: bad, type: "strike", reason: "s4", adminId });
  check("reaching strikes_for_auto_ban (3) bans automatically", third.autoBanned === true && (await countActiveStrikes(bad)) === 3);
  const bs = await q(`select kind, value_hash from bans where user_id=$1 and lifted_at is null order by kind`, [bad]);
  check("bans written for account + phone + device", bs.map((b: any) => b.kind).join() === "device,phone,user", bs);
  check("phone is stored hashed, never in clear", bs.find((b: any) => b.kind === "phone").value_hash === hashPhone(badPhone) && !JSON.stringify(bs).includes(badPhone.slice(3)));
  check("ban hid the host's public events", (await q(`select moderation_status from events where id=$1`, [badEvent]))[0].moderation_status === "hidden");
  check("banned account cannot host (public)", (await call("POST", "/api/social-events", { user: bad, body: body() })).json?.code === "BANNED");
  check("banned account cannot host (private either)", (await call("POST", "/api/social-events", { user: bad, body: body({ visibility: "private" }) })).json?.code === "BANNED");
  const evader = await mkUser("evader");
  const viaDevice = await call("POST", "/api/social-events", { user: evader, body: body({ visibility: "private" }), cookie: badCookie });
  check("a NEW account on the banned device is blocked too", viaDevice.status === 403 && viaDevice.json?.code === "BANNED", viaDevice.json);
  const clean = await call("POST", "/api/social-events", { user: evader, body: body({ visibility: "private" }) });
  check("...but the same new account on a different device is not (device bans are best-effort)", clean.status === 201, clean.json);
  const reuse = await mkUser("reuse", { phone: false });
  const reuseReq = await call("POST", "/api/auth/phone/request", { user: reuse, body: { phone: badPhone } });
  check("a banned phone number cannot be verified on a new account", reuseReq.status === 403 && reuseReq.json?.code === "PHONE_UNAVAILABLE", reuseReq.json);
  const allBans = await q(`select id from bans where user_id=$1 and lifted_at is null`, [bad]);
  for (const b of allBans) await liftBan(b.id, adminId);
  check("lifting the bans restores hosting", (await call("POST", "/api/social-events", { user: bad, body: body({ visibility: "private" }) })).status === 201);
  const b1 = await banUser({ userId: bad, reason: "again", adminId }); const b2 = await banUser({ userId: bad, reason: "again", adminId });
  check("banUser is idempotent (re-ban creates rows once, then none)", b1.created >= 3 && b2.created === 0, { b1, b2 });

  // =====================================================================
  console.log("\nfeatured placement needs a clean history");
  const cleanHost = await mkUser("cleanhost", { ageDays: 100 });
  const strikeHost = await mkUser("strikehost", { ageDays: 100 });
  const newHost = await mkUser("newhost", { ageDays: 10 });
  const overrideOn = await mkUser("overrideon", { ageDays: 10 });
  const overrideOff = await mkUser("overrideoff", { ageDays: 100 });
  await addStrike({ userId: strikeHost, type: "strike", reason: "x", adminId });
  await q(`insert into user_trust (user_id, featured_eligible, featured_override_by, featured_override_reason, featured_override_at) values ($1,true,$3,'vouched',now()), ($2,false,$3,'suspicious',now())`, [overrideOn, overrideOff, adminId]);
  const ok = await getFeaturableHostIds([cleanHost, strikeHost, newHost, overrideOn, overrideOff]);
  check("clean established host -> eligible", ok.has(cleanHost));
  check("host with an active strike -> not eligible", !ok.has(strikeHost));
  check("new-tier host -> not eligible", !ok.has(newHost));
  check("admin override ON beats the new-tier rule", ok.has(overrideOn));
  check("admin override OFF beats a clean history", !ok.has(overrideOff));
  const mk = async (u: string, title: string) => { const id = idOf(await call("POST", "/api/social-events", { user: u, body: body({ title, eventDate: future(2) }) })); await q(`update events set moderation_status='approved' where id=$1`, [id]); return id; };
  const fClean = await mk(cleanHost, "Featured clean"), fStrike = await mk(strikeHost, "Featured struck"), fNew = await mk(newHost, "Featured new");
  const feat = await call("GET", "/api/events/featured");
  const featIds = (feat.json as any[]).map((e) => e.id);
  check("/api/events/featured includes the clean host's event", featIds.includes(fClean), featIds.length);
  check("/api/events/featured excludes struck and new hosts' events", !featIds.includes(fStrike) && !featIds.includes(fNew));

  console.log("\ncommercial events untouched");
  const cEvent = await storage.createEvent({ organizerId: cleanHost, title: "Club night", description: "x", eventDate: new Date(Date.now() + 86400000), location: "Soho", category: "music", ticketsAvailable: 10, moderationStatus: "approved" });
  check("commercial event still discoverable and featured", (await storage.getEvents()).some((e) => e.id === cEvent.id) && ((await call("GET", "/api/events/featured")).json as any[]).some((e) => e.id === cEvent.id));
  check("commercial report path unchanged (no auto-hide)", (await call("POST", `/api/events/${cEvent.id}/report`, { user: rep[0], body: { reason: "spam" } })).status === 200 && (await q(`select moderation_status from events where id=$1`, [cEvent.id]))[0].moderation_status === "approved");
} catch (e) {
  failures++;
  console.error("\nUNEXPECTED ERROR", e);
} finally {
  server.close();
  await pool.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
