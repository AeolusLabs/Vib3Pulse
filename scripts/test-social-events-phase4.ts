// End-to-end check of social events Phase 4: the admin side.
// Mounts the REAL admin routes (real sessions, real bcrypt login, real TOTP codes), the real
// social-event routes, real services and the global redaction middleware. Only host-side
// authentication is faked (x-test-user), and e-mail is replaced by a recorder.
//
//   DATABASE_URL=<scratch db> DISABLE_GEOCODING=1 SESSION_SECRET=x npx tsx scripts/test-social-events-phase4.ts
//
// Refuses to run unless the database name contains "test" - never point it at prod.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pg from "pg";
import { authenticator } from "otplib";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(1);
}
process.env.DISABLE_GEOCODING = "1";
// MFA ships switched OFF (ADMIN_MFA_REQUIRED unset). This suite turns it on to keep exercising the dormant feature,
// then proves the default (off) behaviour in the last section.
process.env.ADMIN_MFA_REQUIRED = "true";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { setupAdminRoutes } = await import("../server/admin-routes");
const { registerSocialEventGate, registerSocialEventRoutes } = await import("../server/routes/social-events-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");
const { deviceMiddleware, addStrike } = await import("../server/services/enforcement");
const { getConfig, invalidateConfigCache } = await import("../server/services/moderationConfig");
const { checkQueueSla, setSlaMailerForTests } = await import("../server/services/moderationJobs");
const { getFeaturableHostIds, getTrustInfo } = await import("../server/services/eventAbuse");

await storage.ensureLoginAttemptsTable(); // created at server start in production
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
// DB clock (zone-less text, so it compares exactly with the zone-less created_at columns) at the start of this run.
const [{ t0 }] = await q(`select localtimestamp::text as t0`);

// ---- app ------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // same as production; lets each login use its own X-Forwarded-For (the real limiter is 10 logins / 15 min / IP)
app.use(express.json());
app.use(cookieParser());
app.use((req: any, _res, next) => {
  const id = req.header("x-test-user");
  req.user = id ? { id, username: id, email: "", userType: "social" } : undefined;
  req.isAuthenticated = () => !!id;
  next();
});
app.use("/api", deviceMiddleware);
app.use(redactSensitiveFields);
setupAdminRoutes(app);
registerSocialEventGate(app);
registerEventsRoutes(app);
registerSocialEventRoutes(app);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

type Who = { id: string; username: string; role: string; cookie: string; secret?: string };
let ipSeq = 1;
async function http(method: string, path: string, o: { who?: Who; user?: string; body?: unknown; ip?: string } = {}) {
  const headers: Record<string, string> = { "X-Forwarded-For": o.ip ?? `10.9.${ipSeq >> 8}.${ipSeq & 255}` };
  ipSeq++;
  if (o.who?.cookie) headers["Cookie"] = o.who.cookie;
  if (o.user) headers["x-test-user"] = o.user;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  const cookies = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
  return { status: res.status, json, text, headers: res.headers, setCookie: cookies.find((c) => c.startsWith("admin.sid=")) ?? null, cookies };
}

const PASSWORD = "Passw0rd!x-test";
const pwHash = await bcrypt.hash(PASSWORD, 4);
const tag = crypto.randomBytes(3).toString("hex");
async function mkAdmin(name: string, role: string, active = true): Promise<Who> {
  const [a] = await q(`insert into admin_users (email, username, password_hash, display_name, role, is_active) values ($1,$2,$3,$4,$5,$6) returning id`, [`${name}-${tag}@test.local`, `${name}_${tag}`, pwHash, name, role, active]);
  return { id: a.id, username: `${name}_${tag}`, role, cookie: "" };
}
async function login(w: Who, password = PASSWORD) {
  const r = await http("POST", "/api/admin/login", { body: { username: w.username, password } });
  const c = r.setCookie?.split(";")[0];
  if (c) w.cookie = c;
  return r;
}
const nextCode = (secret: string) => authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret); // the NEXT 30s window (accepted, and newer than any code used now)
const nowCode = (secret: string) => authenticator.generate(secret);

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 320) : ""); }
}

const setCfg = async (key: string, value: unknown) => { await q(`insert into moderation_config (key, value) values ($1,$2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]); invalidateConfigCache(); };
const logs = async (action: string, targetId?: string) => q(`select * from admin_activity_logs where action = $1 and created_at >= $2 ${targetId ? "and target_id = $3" : ""} order by created_at desc`, targetId ? [action, t0, targetId] : [action, t0]);
const notes = async (userId: string, type?: string) => q(`select * from notifications where user_id=$1 ${type ? "and type=$2" : ""} order by created_at desc`, type ? [userId, type] : [userId]);

let phoneSeq = 10000 + Math.floor(Math.random() * 80000);
async function mkUser(name: string, o: { ageDays?: number; phone?: boolean } = {}) {
  const [u] = await q(`insert into users (email, username, user_type, is_verified, display_name, created_at) values ($1,$2,'social',true,$3, now() - ($4 || ' days')::interval) returning id`, [`${name}-${tag}@test.local`, `${name}_${tag}`, name, String(o.ageDays ?? 90)]);
  if (o.phone !== false) await q(`update users set verified_phone=$2, phone_verified_at=now() where id=$1`, [u.id, `+4477001${String(phoneSeq++).padStart(5, "0")}`]);
  return u.id as string;
}
const ADDRESS = "12 Secret Street, Hidden Town";
async function mkEvent(host: string, o: { title: string; status?: string; visibility?: string; flags?: string[]; reason?: string | null; queuedHoursAgo?: number | null; dateDays?: number; sold?: number } = { title: "x" }) {
  const [e] = await q(
    `insert into events (organizer_id, title, description, event_date, location, category, ticket_price, tickets_available, tickets_sold, kind, visibility, social_type, exact_address, moderation_status, queue_reason, auto_flags, queued_at, max_plus_ones, age_restriction)
     values ($1,$2,'A description',now() + ($3 || ' days')::interval,'Shoreditch, London','social',0,50,$4,'social',$5,'party',$6,$7,$8,$9, ${o.queuedHoursAgo == null ? "null" : "now() - ($10 || ' hours')::interval"},2,'all') returning id`,
    [host, o.title, String(o.dateDays ?? 5), o.sold ?? 0, o.visibility ?? "public", ADDRESS, o.status ?? "pending", o.reason ?? null, o.flags ?? [], ...(o.queuedHoursAgo == null ? [] : [String(o.queuedHoursAgo)])],
  );
  return e.id as string;
}

try {
  // =====================================================================
  console.log("\nadmin accounts");
  const superA = await mkAdmin("superA", "super_admin");
  const superB = await mkAdmin("superB", "super_admin");
  const mod = await mkAdmin("mod", "content_moderator");
  const mod2 = await mkAdmin("mod2", "event_reviewer");
  const adm = await mkAdmin("adm", "admin");
  const viewer = await mkAdmin("viewer", "analytics_viewer");
  const finance = await mkAdmin("fin", "finance_manager");
  const dead = await mkAdmin("dead", "content_moderator", false);

  // =====================================================================
  console.log("\nsuper-admin MFA (enforced in code)");
  const bad = await login(superA, "wrong-password");
  check("wrong password -> 401", bad.status === 401);
  const l1 = await login(superA);
  check("super-admin password login succeeds but reports mfa=enroll", l1.status === 200 && l1.json?.mfa === "enroll", l1.json);
  const me1 = await http("GET", "/api/admin/me", { who: superA });
  check("/me works while MFA is pending and says so", me1.status === 200 && me1.json?.mfa?.required === true && me1.json?.mfa?.verified === false && me1.json?.mfa?.enrolled === false, me1.json);
  check("password hash never in /me", !/passwordHash|password_hash/.test(me1.text));
  for (const [label, m, p, b] of [
    ["moderation queue", "GET", "/api/admin/moderation/queue", undefined],
    ["host search", "GET", "/api/admin/hosts?search=ab", undefined],
    ["config", "GET", "/api/admin/moderation/config", undefined],
    ["reveal grants list", "GET", "/api/admin/reveal-grants", undefined],
    ["create reveal grant", "POST", "/api/admin/reveal-grants", { granteeId: "x", eventId: "x", case: { caseType: "report", caseId: "x" }, reason: "0123456789" }],
    ["a legacy super-admin route (users)", "GET", "/api/admin/users", undefined],
  ] as const) {
    const r = await http(m, p, { who: superA, body: b });
    check(`super-admin without MFA: ${label} -> 403 MFA_REQUIRED`, r.status === 403 && r.json?.code === "MFA_REQUIRED" && r.json?.mfa === "enroll", { status: r.status, body: r.json });
  }
  const sNon = await http("POST", "/api/admin/mfa/setup", { who: mod });
  check("moderators can't use super-admin MFA setup (no session -> 401)", sNon.status === 401);
  const setup = await http("POST", "/api/admin/mfa/setup", { who: superA });
  check("MFA setup returns secret + otpauth URL + QR", setup.status === 200 && !!setup.json?.secret && /^otpauth:\/\/totp\//.test(setup.json?.otpauthUrl) && /^data:image\/png/.test(setup.json?.qrDataUrl), setup.status);
  superA.secret = setup.json.secret as string;
  const [stored] = await q(`select secret_enc from admin_mfa where admin_id=$1`, [superA.id]);
  check("TOTP secret is stored encrypted, not in clear", stored.secret_enc !== superA.secret && !stored.secret_enc.includes(superA.secret));
  const badConfirm = await http("POST", "/api/admin/mfa/confirm", { who: superA, body: { code: "000000" } });
  check("wrong confirmation code -> 400", badConfirm.status === 400 && badConfirm.json?.code === "bad_code", badConfirm.json);
  const enrolCode = nowCode(superA.secret);
  const confirm = await http("POST", "/api/admin/mfa/confirm", { who: superA, body: { code: enrolCode } });
  check("correct code enrols MFA and returns 8 recovery codes once", confirm.status === 200 && confirm.json?.recoveryCodes?.length === 8, confirm.json);
  const recovery: string[] = confirm.json.recoveryCodes;
  const [mfaRow] = await q(`select recovery_code_hashes, enabled_at from admin_mfa where admin_id=$1`, [superA.id]);
  check("recovery codes stored only as hashes", mfaRow.enabled_at && mfaRow.recovery_code_hashes.length === 8 && !recovery.some((c) => mfaRow.recovery_code_hashes.includes(c)));
  const afterEnrol = await http("GET", "/api/admin/moderation/queue", { who: superA });
  check("after enrolment the session is verified and super-admin routes work", afterEnrol.status === 200, afterEnrol.json);
  check("setup is closed once enrolled (409)", (await http("POST", "/api/admin/mfa/setup", { who: superA })).status === 409);

  await http("POST", "/api/admin/logout", { who: superA });
  const l2 = await login(superA);
  check("next login requires a code (mfa=verify)", l2.status === 200 && l2.json?.mfa === "verify", l2.json);
  check("...and gated routes refuse until it's given", (await http("GET", "/api/admin/moderation/queue", { who: superA })).json?.code === "MFA_REQUIRED");
  const replay = await http("POST", "/api/admin/mfa/verify", { who: superA, body: { code: enrolCode } }); // the exact code already used at enrolment
  check("replaying the code used at enrolment is refused", replay.status === 401, replay.json);
  const wrong = await http("POST", "/api/admin/mfa/verify", { who: superA, body: { code: "123456" } });
  check("wrong code -> 401 and still gated", wrong.status === 401 && (await http("GET", "/api/admin/moderation/queue", { who: superA })).status === 403);
  const goodCode = nextCode(superA.secret);
  const good = await http("POST", "/api/admin/mfa/verify", { who: superA, body: { code: goodCode } });
  check("a fresh code verifies the session", good.status === 200 && good.json?.verified === true, good.json);
  check("...and the same code can't be used again", (await http("POST", "/api/admin/mfa/verify", { who: superA, body: { code: goodCode } })).status === 401);
  check("super-admin routes work again", (await http("GET", "/api/admin/moderation/queue", { who: superA })).status === 200);

  await http("POST", "/api/admin/logout", { who: superA });
  await login(superA);
  const rc = await http("POST", "/api/admin/mfa/verify", { who: superA, body: { recoveryCode: recovery[0] } });
  check("a recovery code signs in", rc.status === 200 && rc.json?.verified === true, rc.json);
  const rcLogs = await logs("mfa_recovery_code_used");
  check("a recovery code is audit-logged when used", rcLogs.length === 1 && rcLogs[0].admin_id === superA.id, rcLogs.length);
  await http("POST", "/api/admin/logout", { who: superA });
  await login(superA);
  check("a recovery code works only once", (await http("POST", "/api/admin/mfa/verify", { who: superA, body: { recoveryCode: recovery[0] } })).status === 401);
  const rc2 = await http("POST", "/api/admin/mfa/verify", { who: superA, body: { recoveryCode: recovery[1] } });
  check("a different recovery code still works", rc2.status === 200);

  // superB enrols, then is hammered with wrong codes
  await login(superB);
  const sB = await http("POST", "/api/admin/mfa/setup", { who: superB });
  superB.secret = sB.json.secret;
  await http("POST", "/api/admin/mfa/confirm", { who: superB, body: { code: nowCode(superB.secret) } });
  await http("POST", "/api/admin/logout", { who: superB });
  await login(superB);
  let locked = false;
  for (let i = 0; i < 14 && !locked; i++) locked = (await http("POST", "/api/admin/mfa/verify", { who: superB, body: { code: "111111" }, ip: "10.77.0.1" })).status === 429;
  check("repeated wrong codes get the account throttled (429)", locked);

  // =====================================================================
  console.log("\nrole checks are live (not cached in the session)");
  await login(mod); await login(mod2); await login(adm); await login(viewer); await login(finance);
  check("deactivated account can't log in", (await login(dead)).status === 401);
  check("moderator reaches the queue", (await http("GET", "/api/admin/moderation/queue", { who: mod })).status === 200);
  await q(`update admin_users set role='analytics_viewer' where id=$1`, [mod2.id]);
  check("demoting a moderator takes effect on the very next request", (await http("GET", "/api/admin/moderation/queue", { who: mod2 })).status === 403);
  await q(`update admin_users set role='event_reviewer' where id=$1`, [mod2.id]);
  check("...and promoting back restores access without re-login", (await http("GET", "/api/admin/moderation/queue", { who: mod2 })).status === 200);
  const modTemp = await mkAdmin("modtemp", "content_moderator"); await login(modTemp);
  check("temp moderator works", (await http("GET", "/api/admin/moderation/queue", { who: modTemp })).status === 200);
  await q(`update admin_users set is_active=false where id=$1`, [modTemp.id]);
  check("deactivating an admin kills their live session immediately", (await http("GET", "/api/admin/moderation/queue", { who: modTemp })).status === 401);

  console.log("\nleast privilege matrix");
  const matrix: Array<[string, string, string, Who[], Who[]]> = [
    ["moderation queue", "GET", "/api/admin/moderation/queue", [mod, mod2, superA], [adm, viewer, finance]],
    ["host search", "GET", "/api/admin/hosts?search=zz", [adm, superA], [mod, mod2, viewer, finance]],
    ["moderation config", "GET", "/api/admin/moderation/config", [adm, superA], [mod, mod2, viewer, finance]],
    ["metrics", "GET", "/api/admin/social/metrics", [mod, adm, viewer, superA], [finance]],
    ["reveal grants list", "GET", "/api/admin/reveal-grants", [superA], [mod, mod2, adm, viewer, finance]],
    ["reveal activity", "GET", "/api/admin/reveal-activity", [superA], [mod, mod2, adm, viewer, finance]],
    ["moderator picker", "GET", "/api/admin/moderators", [superA], [mod, adm]],
    ["my grants", "GET", "/api/admin/reveal-grants/mine", [mod, mod2], [adm, viewer, finance]],
  ];
  for (const [label, m, p, allowed, denied] of matrix) {
    const okAll = (await Promise.all(allowed.map((w) => http(m, p, { who: w })))).every((r) => r.status === 200);
    const noAll = (await Promise.all(denied.map((w) => http(m, p, { who: w })))).every((r) => r.status === 403);
    check(`${label}: allowed [${allowed.map((a) => a.role).join(",")}] / refused [${denied.map((a) => a.role).join(",")}]`, okAll && noAll);
  }
  check("unauthenticated -> 401 on every new area", (await Promise.all(["/api/admin/moderation/queue", "/api/admin/hosts?search=zz", "/api/admin/moderation/config", "/api/admin/reveal-grants", "/api/admin/social/metrics"].map((p) => http("GET", p)))).every((r) => r.status === 401));

  // =====================================================================
  console.log("\nmoderation queue");
  const hostNew = await mkUser("hostnew", { ageDays: 10 });
  const hostStd = await mkUser("hoststd", { ageDays: 120 });
  const reporters = await Promise.all([1, 2, 3, 4].map((i) => mkUser(`rpt${i}`)));
  await q(`insert into user_strikes (user_id, type, reason, admin_id) values ($1,'strike','earlier trouble',$2), ($1,'warn','be nice',$2)`, [hostStd, superA.id]);
  const evA = await mkEvent(hostNew, { title: "A held new account", status: "pending", reason: "new_account_review", queuedHoursAgo: 5, dateDays: 3 });
  const evB = await mkEvent(hostStd, { title: "B auto-hidden", status: "hidden", reason: "report_threshold", queuedHoursAgo: 30, dateDays: 1, sold: 4 });
  const evC = await mkEvent(hostNew, { title: "C flagged link", status: "pending", reason: "auto_flag", flags: ["external_link"], queuedHoursAgo: 2, dateDays: 10 });
  const evD = await mkEvent(hostStd, { title: "D approved", status: "approved", dateDays: 7 });
  const evE = await mkEvent(hostStd, { title: "E rejected with appeal", status: "rejected", dateDays: 12 });
  const evF = await mkEvent(hostStd, { title: "F private", status: "pending", visibility: "private", dateDays: 2 });
  const evG = await mkEvent(hostNew, { title: "G in the past", status: "pending", reason: "new_account_review", queuedHoursAgo: 8, dateDays: -2 });
  await q(`insert into content_reports (reporter_id, content_type, content_id, reason, description) values ($1,'event',$4,'scam','looks fake'), ($2,'event',$4,'scam',null), ($3,'event',$4,'unsafe',null)`, [reporters[0], reporters[1], reporters[2], evB]);
  await q(`insert into user_trust (user_id, abusive_reporter_at, abusive_reporter_by) values ($1, now(), $2)`, [reporters[2], superA.id]);
  await q(`insert into moderation_appeals (user_id, subject_type, subject_id, message) values ($1,'event',$2,'This was a real event, please look again')`, [hostStd, evE]);

  const qr = await http("GET", "/api/admin/moderation/queue", { who: mod });
  const items: any[] = qr.json.items;
  const byId = (id: string) => items.find((i) => i.eventId === id);
  check("queue holds held, hidden, flagged and appealed public events", [evA, evB, evC, evE, evG].every((id) => !!byId(id)), items.map((i) => i.title));
  check("approved and private events are NOT in the queue", !byId(evD) && !byId(evF));
  check("default order: events happening soonest first, finished ones last", items.map((i) => i.eventId).join() === [evB, evA, evC, evE, evG].join(), items.map((i) => i.title));
  const iB = byId(evB), iA = byId(evA), iC = byId(evC), iE = byId(evE);
  check("item shows flag reason, queue reason and time in queue", iC.flags.includes("external_link") && iB.queueReason === "report_threshold" && iB.hoursInQueue > 29 && iA.hoursInQueue > 4.5 && iA.hoursInQueue < 6, { c: iC.flags, b: iB.queueReason, h: iB.hoursInQueue });
  check("SLA breach flagged on the 30h item only (target 24h)", iB.slaBreached === true && iA.slaBreached === false && qr.json.slaBreached === 1, qr.json.slaBreached);
  check("report count + reasons shown; abusive reporter not counted as credible", iB.reports.total === 3 && iB.reports.credible === 2 && iB.reports.reasons[0].reason === "scam" && iB.reports.reasons[0].count === 2, iB.reports);
  check("host history: account age, verified status, past events, strikes, reports received, tier", iB.host.accountAgeDays >= 119 && iB.host.emailVerified === true && iB.host.phoneVerified === true && iB.host.pastEvents >= 4 && iB.host.strikes.active === 1 && iB.host.strikes.warns === 1 && iB.host.reportsReceived === 3 && iB.host.tier === "standard", iB.host);
  check("new-account host tier computed as 'new'", iA.host.tier === "new" && iA.host.accountAgeDays < 15);
  check("open appeal attached to its event", iE.openAppeal?.message?.startsWith("This was a real event"), iE.openAppeal);
  check("RSVP shown as counts only", iB.rsvp.headcount === 4 && iB.rsvp.capacity === 50);
  check("queue never contains the exact address or any guest name", !qr.text.includes(ADDRESS) && !/exactAddress|guestName|inviteToken/.test(qr.text));
  check("host never shown with a full phone number or any hash", !/\+4477001|verifiedPhone|value_hash|valueHash/.test(qr.text));
  const qf = async (qs: string) => ((await http("GET", `/api/admin/moderation/queue?${qs}`, { who: mod })).json.items as any[]).map((i) => i.eventId);
  check("filter by flag type", (await qf("flag=external_link")).join() === evC);
  check("filter by queue reason (report threshold)", (await qf("flag=report_threshold")).join() === evB);
  check("filter by report count", (await qf("minReports=2")).join() === evB);
  check("filter by host trust tier", (await qf("tier=new")).sort().join() === [evA, evC, evG].sort().join() && (await qf("tier=standard")).sort().join() === [evB, evE].sort().join());
  check("filter by age in queue", (await qf("minAgeHours=24")).join() === evB);
  check("filter by event date range", (await qf(`from=${new Date(Date.now() + 2 * 86400000).toISOString()}&to=${new Date(Date.now() + 4 * 86400000).toISOString()}`)).join() === evA);
  check("sort: oldest in queue first", (await qf("sort=queued_oldest"))[0] === evB);
  check("sort: most reports first", (await qf("sort=reports"))[0] === evB);
  const tierParity = await Promise.all([hostNew, hostStd].map(async (id) => { const [u] = await q(`select id, created_at from users where id=$1`, [id]); return (await getTrustInfo({ id, createdAt: u.created_at })).tier; }));
  check("queue's tier matches the hosting-check tier (one definition)", tierParity[0] === iA.host.tier && tierParity[1] === iB.host.tier, tierParity);

  console.log("\nevent reports");
  const er = await http("GET", `/api/admin/moderation/events/${evB}/reports`, { who: mod });
  check("moderator can list an event's reports with reporter info", er.status === 200 && er.json.reports.length === 3 && er.json.reports.some((r: any) => r.reporter.markedAbusive === true), er.json);

  // =====================================================================
  console.log("\nmoderation actions (reason required, audited, host notified)");
  const act = (who: Who, id: string, action: string, reason?: string) => http("POST", `/api/admin/moderation/events/${id}/action`, { who, body: reason === undefined ? { action } : { action, reason } });
  check("no reason -> 400", (await act(mod, evA, "approve")).status === 400);
  check("too-short reason -> 400", (await act(mod, evA, "approve", "ok")).status === 400);
  check("unknown action -> 400", (await act(mod, evA, "delete", "because reasons")).status === 400);
  check("admin role can't act on the queue (403)", (await act(adm, evA, "approve", "approved by admin?")).status === 403);
  check("analytics viewer can't either (403)", (await act(viewer, evA, "approve", "viewer trying it on")).status === 403);
  const ap = await act(mod, evA, "approve", "Looks like a genuine birthday party");
  check("moderator approves a held event", ap.status === 200 && ap.json?.status === "approved", ap.json);
  const [rowA] = await q(`select moderation_status, queue_reason, queued_at from events where id=$1`, [evA]);
  check("event row updated and cleared from the queue", rowA.moderation_status === "approved" && rowA.queue_reason === null && rowA.queued_at === null, rowA);
  const [emA] = await q(`select action, reason, queued_at, admin_id from event_moderations where event_id=$1`, [evA]);
  check("moderation history row has action, reason, who, and the queue-entry snapshot", emA.action === "approve" && emA.reason.includes("genuine birthday") && emA.admin_id === mod.id && !!emA.queued_at, emA);
  const [logA] = await logs("moderation_approve", evA);
  check("immutable admin log row: who, what, when, reason", logA.admin_id === mod.id && logA.reason.includes("genuine birthday") && !!logA.created_at && logA.target_id === evA, logA);
  const hnA = await notes(hostNew, "event_moderation");
  check("host notified when approved", hnA.length === 1 && /live/i.test(hnA[0].title) && hnA[0].link === `/social-events/${evA}`, hnA);
  check("approved event now appears in discovery", (await storage.getEvents()).some((e) => e.id === evA));
  check("approving it again -> 409 invalid transition", (await act(mod, evA, "approve", "approving twice by mistake")).status === 409);

  const rj = await act(mod2, evC, "reject", "Contains an off-platform payment link");
  const [rowC] = await q(`select moderation_status, flag_outcome from events where id=$1`, [evC]);
  check("reject: status rejected + auto-flag outcome recorded as 'rejected'", rj.status === 200 && rowC.moderation_status === "rejected" && rowC.flag_outcome === "rejected", rowC);
  const hnC = (await notes(hostNew, "event_moderation")).find((n: any) => /taken down/i.test(n.title));
  check("host told WHY (the reason) and how to appeal", !!hnC && hnC.message.includes("off-platform payment link") && /appeal/i.test(hnC.message), hnC);
  check("event reviewers can act too", rj.status === 200);

  const hd = await act(mod, evD, "hide", "Reported by a trusted source, checking");
  const [rowD] = await q(`select moderation_status, queue_reason, queued_at from events where id=$1`, [evD]);
  check("hide: approved -> hidden, enters the queue, leaves discovery", hd.status === 200 && rowD.moderation_status === "hidden" && rowD.queue_reason === "admin_hidden" && !!rowD.queued_at && !(await storage.getEvents()).some((e) => e.id === evD), rowD);
  const rs = await act(mod, evD, "restore", "Checked, it's fine");
  check("restore: hidden -> approved and back in discovery", rs.status === 200 && (await storage.getEvents()).some((e) => e.id === evD));
  const re = await act(mod, evB, "request_edit", "Please remove the ticket link from the description");
  const [rowB] = await q(`select moderation_status from events where id=$1`, [evB]);
  const hnB = (await notes(hostStd, "event_moderation"))[0];
  check("request_edit: -> changes_requested, host told what to change", re.status === 200 && rowB.moderation_status === "changes_requested" && hnB.message.includes("remove the ticket link") && /Edit the event/.test(hnB.message), hnB);
  const evBan = await mkEvent(hostNew, { title: "Banned host's event", status: "hidden", reason: "host_banned", queuedHoursAgo: 1 });
  await q(`insert into bans (kind, value_hash, user_id, reason, admin_id) values ('user',$1,$3,'test ban',$2)`, [hostNew, superA.id, hostNew]);
  const rsBan = await act(mod, evBan, "restore", "Trying to restore a banned host's event");
  check("can't restore or approve a banned host's event (409 host_banned)", rsBan.status === 409 && rsBan.json?.code === "host_banned", rsBan.json);
  await q(`update bans set lifted_at=now(), lifted_by=$1 where user_id=$2`, [superA.id, hostNew]);
  const rmv = await act(mod, evBan, "remove", "Removing permanently: repeated scam listings");
  const rsRem = await act(mod, evBan, "restore", "Changed my mind about this one");
  check("remove is permanent: restore after remove -> 409", rmv.status === 200 && rsRem.status === 409, rsRem.json);
  check("legacy approve endpoint refuses social events (must use the queue)", (await http("POST", `/api/admin/events/${evD}/moderate`, { who: mod, body: { action: "approved" } })).json?.code === "USE_MODERATION_QUEUE");
  check("legacy delete endpoint refuses social events too", (await http("DELETE", `/api/admin/events/${evD}`, { who: mod })).json?.code === "USE_MODERATION_QUEUE");
  check("the event is still there after the refused delete", (await q(`select 1 from events where id=$1`, [evD])).length === 1);

  console.log("\nbulk actions");
  const bulkIds = await Promise.all([1, 2, 3].map((i) => mkEvent(hostStd, { title: `Bulk ${i}`, status: "pending", reason: "new_account_review", queuedHoursAgo: 3 })));
  const bulk = await http("POST", "/api/admin/moderation/bulk", { who: mod, body: { eventIds: [...bulkIds, evD], action: "approve", reason: "Batch review: all clean" } });
  check("bulk approve: 3 succeed, the already-approved one is reported, not fatal", bulk.status === 200 && bulk.json.succeeded === 3 && bulk.json.failed === 1 && bulk.json.results.find((r: any) => r.eventId === evD)?.ok === false, bulk.json);
  check("every bulk item has its own audit entry with the reason", (await Promise.all(bulkIds.map((id) => logs("moderation_approve", id)))).every((l) => l.length === 1 && l[0].reason === "Batch review: all clean"));
  check("bulk needs a reason", (await http("POST", "/api/admin/moderation/bulk", { who: mod, body: { eventIds: bulkIds, action: "hide" } })).status === 400);
  check("bulk is capped at 100 ids", (await http("POST", "/api/admin/moderation/bulk", { who: mod, body: { eventIds: Array.from({ length: 101 }, (_, i) => `id${i}`), action: "hide", reason: "too many at once" } })).status === 400);

  // =====================================================================
  console.log("\nappeals (back into the queue)");
  const q2 = (await http("GET", "/api/admin/moderation/queue", { who: mod })).json.items as any[];
  check("a rejected event with an open appeal is in the queue", q2.some((i) => i.eventId === evE && i.openAppeal));
  const al = await http("GET", "/api/admin/moderation/appeals", { who: mod });
  check("moderators see event appeals only", al.status === 200 && al.json.appeals.every((a: any) => a.subjectType === "event"));
  const appealE = (await q(`select id from moderation_appeals where subject_id=$1`, [evE]))[0].id;
  check("resolving needs a reason", (await http("POST", `/api/admin/moderation/appeals/${appealE}/resolve`, { who: mod, body: { decision: "uphold" } })).status === 400);
  const up = await http("POST", `/api/admin/moderation/appeals/${appealE}/resolve`, { who: mod, body: { decision: "uphold", reason: "On review the listing is fine" } });
  const [rowE] = await q(`select moderation_status from events where id=$1`, [evE]);
  check("upheld appeal restores the event", up.status === 200 && rowE.moderation_status === "approved");
  check("appellant is notified of the outcome", (await notes(hostStd, "appeal_resolved")).some((n: any) => /successful/i.test(n.title)));
  check("deciding twice -> 409", (await http("POST", `/api/admin/moderation/appeals/${appealE}/resolve`, { who: mod, body: { decision: "deny", reason: "Second thoughts here" } })).status === 409);

  // strike appeal from the host side -> admin decides
  const [st1] = await q(`select id from user_strikes where user_id=$1 and type='strike'`, [hostStd]);
  const notice = await http("GET", "/api/social-events/notices", { user: hostStd });
  check("host sees their own strike in account notices", notice.json?.notices?.some((n: any) => n.subjectId === st1.id && n.subjectType === "strike"), notice.json);
  check("host can appeal their own strike", (await http("POST", "/api/social-events/appeals", { user: hostStd, body: { subjectType: "strike", subjectId: st1.id, message: "That strike was for a misunderstanding" } })).status === 201);
  check("host can't appeal someone else's strike", (await http("POST", "/api/social-events/appeals", { user: hostNew, body: { subjectType: "strike", subjectId: st1.id, message: "Trying to appeal another host's strike" } })).status === 404);
  const strikeAppeal = (await q(`select id from moderation_appeals where subject_id=$1`, [st1.id]))[0].id;
  check("a moderator can't decide a strike appeal (403)", (await http("POST", `/api/admin/moderation/appeals/${strikeAppeal}/resolve`, { who: mod, body: { decision: "uphold", reason: "Moderator overreach attempt" } })).status === 403);
  check("an admin sees it in their appeal list", (await http("GET", "/api/admin/moderation/appeals", { who: adm })).json.appeals.some((a: any) => a.id === strikeAppeal));
  const upS = await http("POST", `/api/admin/moderation/appeals/${strikeAppeal}/resolve`, { who: adm, body: { decision: "uphold", reason: "Misunderstanding confirmed" } });
  check("upheld strike appeal revokes the strike", upS.status === 200 && (await q(`select revoked_at from user_strikes where id=$1`, [st1.id]))[0].revoked_at !== null);

  console.log("\nreport management");
  const reps = (await http("GET", `/api/admin/moderation/events/${evB}/reports`, { who: mod })).json.reports as any[];
  const rpt0 = reps.find((r) => r.reporter.id === reporters[0]);
  check("dismiss needs a reason", (await http("POST", `/api/admin/moderation/reports/${rpt0.id}/dismiss`, { who: mod, body: {} })).status === 400);
  check("dismiss a report", (await http("POST", `/api/admin/moderation/reports/${rpt0.id}/dismiss`, { who: mod, body: { reason: "Reporter was mistaken" } })).status === 200 && (await q(`select status from content_reports where id=$1`, [rpt0.id]))[0].status === "dismissed");
  const rpt1 = reps.find((r) => r.reporter.id === reporters[1]);
  check("mark a reporter abusive", (await http("POST", `/api/admin/moderation/reports/${rpt1.id}/mark-abusive`, { who: mod, body: { reason: "Reports every event this host runs" } })).status === 200 && (await q(`select abusive_reporter_at from user_trust where user_id=$1`, [reporters[1]]))[0].abusive_reporter_at !== null);
  check("report actions are audit-logged", (await logs("report_dismiss")).length === 1 && (await logs("reporter_marked_abusive")).length === 1);

  // =====================================================================
  console.log("\nhost controls");
  const hs = await http("GET", `/api/admin/hosts?search=${encodeURIComponent("hoststd_" + tag)}`, { who: adm });
  check("admin can search hosts", hs.status === 200 && hs.json.hosts.length === 1 && hs.json.hosts[0].id === hostStd, hs.json);
  const prof = await http("GET", `/api/admin/hosts/${hostStd}`, { who: adm });
  check("host profile: age, verification, trust, strikes, reports, events, no hashes or full phone", prof.status === 200 && prof.json.accountAgeDays >= 119 && prof.json.phone.verified === true && prof.json.phone.last4.length === 4 && prof.json.strikes.length >= 2 && prof.json.reportsReceived.total >= 3 && prof.json.events.length >= 4 && !/\+4477001|value_hash|valueHash|passwordHash/.test(prof.text), prof.json);
  const dv = crypto.randomBytes(8).toString("hex");
  await q(`insert into user_devices (user_id, device_hash) values ($1,$3), ($2,$3)`, [hostStd, hostNew, dv]);
  check("linked accounts (same device) are shown", (await http("GET", `/api/admin/hosts/${hostStd}`, { who: adm })).json.linkedAccounts.some((l: any) => l.userId === hostNew));

  const victim = await mkUser("victim", { ageDays: 90 });
  const sk = (type: string, why?: string) => http("POST", `/api/admin/hosts/${victim}/strikes`, { who: adm, body: why === undefined ? { type } : { type, reason: why } });
  check("strike needs a reason", (await sk("strike")).status === 400);
  check("a moderator can't issue strikes (403)", (await http("POST", `/api/admin/hosts/${victim}/strikes`, { who: mod, body: { type: "strike", reason: "moderator trying it" } })).status === 403);
  const w = await sk("warn", "First warning: keep descriptions accurate");
  check("warn recorded + host notified with reason and appeal path", w.status === 201 && w.json.autoBanned === false && (await notes(victim, "host_sanction")).some((n: any) => n.message.includes("keep descriptions accurate") && /appeal/i.test(n.message)));
  await sk("strike", "Strike one: misleading photos"); await sk("strike", "Strike two: off-platform payment");
  const s3 = await sk("strike", "Strike three: scam listing");
  check("third strike auto-bans (default threshold 3)", s3.status === 201 && s3.json.autoBanned === true, s3.json);
  check("...host told they're banned, with the reason", (await notes(victim, "host_sanction")).some((n: any) => /banned/i.test(n.title) && n.message.includes("scam listing")));
  const vp = await http("GET", `/api/admin/hosts/${victim}`, { who: adm });
  check("profile shows the active ban and 3 active strikes", vp.json.banned === true && vp.json.activeStrikes === 3 && vp.json.bans.some((b: any) => b.kind === "user" && !b.liftedAt), vp.json.bans);
  check("strike/ban actions are all in the audit log with reasons", (await logs("host_strike", victim)).length === 3 && (await logs("host_warn", victim)).length === 1 && (await logs("host_strike", victim)).every((l: any) => l.reason?.length > 5));
  const strikeId = vp.json.strikes.find((s: any) => s.active).id;
  check("revoke a strike (reason needed)", (await http("POST", `/api/admin/strikes/${strikeId}/revoke`, { who: adm, body: {} })).status === 400 && (await http("POST", `/api/admin/strikes/${strikeId}/revoke`, { who: adm, body: { reason: "Strike issued in error" } })).status === 200);
  const banId = vp.json.bans.find((b: any) => b.kind === "user").id;
  check("lift a ban (reason needed)", (await http("POST", `/api/admin/bans/${banId}/lift`, { who: adm, body: { reason: "x" } })).status === 400 && (await http("POST", `/api/admin/bans/${banId}/lift`, { who: adm, body: { reason: "Cleared after review" } })).status === 200);
  const ban2 = await http("POST", `/api/admin/hosts/${victim}/ban`, { who: adm, body: { reason: "Manual ban after investigation" } });
  check("manual ban works and bans account + phone", ban2.status === 200 && (await q(`select kind from bans where user_id=$1 and lifted_at is null`, [victim])).map((r: any) => r.kind).sort().join().includes("phone"), ban2.json);

  const tgt = await mkUser("tiertarget", { ageDays: 10 });
  check("tier override needs a reason", (await http("PUT", `/api/admin/hosts/${tgt}/trust-tier`, { who: adm, body: { tier: "trusted" } })).status === 400);
  const t1 = await http("PUT", `/api/admin/hosts/${tgt}/trust-tier`, { who: adm, body: { tier: "trusted", reason: "Known organiser, vouched for by the team" } });
  const p1 = (await http("GET", `/api/admin/hosts/${tgt}`, { who: adm })).json;
  check("tier override is visible with its reason and wins over account age", t1.status === 200 && p1.trust.tier === "trusted" && p1.trust.override?.reason.includes("vouched"), p1.trust);
  await http("PUT", `/api/admin/hosts/${tgt}/trust-tier`, { who: adm, body: { tier: null, reason: "Override no longer needed" } });
  check("clearing the override returns to the computed tier", (await http("GET", `/api/admin/hosts/${tgt}`, { who: adm })).json.trust.tier === "new");
  check("featured: new host isn't eligible by default", !(await getFeaturableHostIds([tgt])).has(tgt));
  await http("PUT", `/api/admin/hosts/${tgt}/featured`, { who: adm, body: { eligible: true, reason: "Partner venue, approved for featuring" } });
  check("featured override ON makes them eligible, reason visible", (await getFeaturableHostIds([tgt])).has(tgt) && (await http("GET", `/api/admin/hosts/${tgt}`, { who: adm })).json.trust.featuredOverride?.reason.includes("Partner venue"));
  const clean = await mkUser("cleanhost2", { ageDays: 200 });
  await http("PUT", `/api/admin/hosts/${clean}/featured`, { who: adm, body: { eligible: false, reason: "Under informal review" } });
  check("featured override OFF excludes an otherwise clean host", !(await getFeaturableHostIds([clean])).has(clean));
  await http("PUT", `/api/admin/hosts/${clean}/abusive-reporter`, { who: adm, body: { abusive: true, reason: "Pattern of retaliatory reports" } });
  check("abusive-reporter flag set from the host profile", (await http("GET", `/api/admin/hosts/${clean}`, { who: adm })).json.trust.abusiveReporter === true);
  check("admin role can suspend via the existing endpoint", (await http("POST", `/api/admin/users/${clean}/suspend`, { who: adm, body: { reason: "Smoke test suspension", isPermanent: false, suspendedUntil: new Date(Date.now() + 3600_000).toISOString() } })).status === 200);

  // =====================================================================
  console.log("\nconfiguration (admin-editable, audit-logged)");
  const cfg = await http("GET", "/api/admin/moderation/config", { who: adm });
  const keys = (cfg.json.settings as any[]).map((s) => s.key);
  check("all thresholds are listed with defaults", ["report_auto_hide_threshold", "new_account_weekly_public_limit", "min_account_age_days", "guest_data_retention_days", "blocked_patterns", "reveal_grant_default_hours", "reveal_grant_max_hours", "queue_sla_hours"].every((k) => keys.includes(k)) && cfg.json.settings.every((s: any) => "default" in s), keys);
  check("internal bookkeeping keys aren't exposed", !keys.some((k) => k.startsWith("internal_")));
  check("reveal settings are read-only for plain admins", cfg.json.settings.filter((s: any) => /^reveal_/.test(s.key)).every((s: any) => s.editable === false) && (await http("GET", "/api/admin/moderation/config", { who: superA })).json.settings.every((s: any) => s.editable === true));
  const put = (who: Who, key: string, value: unknown, reason?: string) => http("PUT", `/api/admin/moderation/config/${key}`, { who, body: reason === undefined ? { value } : { value, reason } });
  check("config change needs a reason", (await put(adm, "report_auto_hide_threshold", 5)).status === 400);
  check("config values are validated (range)", (await put(adm, "report_auto_hide_threshold", 0, "set it to zero please")).status === 400 && (await put(adm, "report_auto_hide_threshold", 2.5, "fractional value please")).status === 400 && (await put(adm, "report_auto_hide_threshold", "7", "string value please")).status === 400);
  check("unknown key -> 404", (await put(adm, "does_not_exist", 1, "nothing to see here")).status === 404);
  const before = await getConfig("report_auto_hide_threshold");
  const ch = await put(adm, "report_auto_hide_threshold", 5, "Raising the bar after a wave of false reports");
  check("admin changes a threshold; it takes effect immediately", ch.status === 200 && (await getConfig("report_auto_hide_threshold")) === 5 && ch.json.before === before, ch.json);
  const [cl] = await logs("config_changed", "report_auto_hide_threshold");
  const det = JSON.parse(cl.details);
  check("the config change is itself audit-logged: who, when, reason, before and after", cl.admin_id === adm.id && cl.reason.includes("false reports") && det.before === before && det.after === 5 && !!cl.created_at, det);
  await put(adm, "report_auto_hide_threshold", before, "Restoring the default after the test");
  const bp = await put(adm, "blocked_patterns", ["  Venmo ", "CASHAPP", "venmo", "x"], "Adding payment apps to the block list");
  check("blocked-pattern list: entries too short are rejected", bp.status === 400);
  const bp2 = await put(adm, "blocked_patterns", ["  Venmo ", "CASHAPP", "venmo"], "Adding payment apps to the block list");
  check("blocked-pattern list is normalised (trimmed, lower-cased, de-duplicated)", bp2.status === 200 && JSON.stringify(await getConfig("blocked_patterns")) === JSON.stringify(["venmo", "cashapp"]));
  await put(superA, "blocked_patterns", ["whatsapp", "telegram", "t.me/", "wa.me/", "dm me", "contact me on", "http://", "https://", "www."], "Restoring the default list");
  check("reveal expiry settings: a plain admin is refused (403)", (await put(adm, "reveal_grant_max_hours", 720, "trying to extend the window")).status === 403);
  check("...a super-admin may change them", (await put(superA, "reveal_grant_default_hours", 24, "Shorter default for tighter control")).status === 200 && (await getConfig("reveal_grant_default_hours")) === 24);
  check("the hard maximum can't drop below the default", (await put(superA, "reveal_grant_max_hours", 12, "max below default should fail")).json?.code === "MAX_BELOW_DEFAULT");
  await put(superA, "reveal_grant_default_hours", 48, "Back to the 48h default");

  // =====================================================================
  console.log("\nreveal authority: super-admin reveals");
  const evR = await mkEvent(hostStd, { title: "Reveal target", status: "approved", dateDays: 9, sold: 2 });
  const evOther = await mkEvent(hostStd, { title: "Some other event", status: "approved", dateDays: 11 });
  const guestA = await mkUser("guestA"); const guestB = await mkUser("guestB");
  await q(`insert into tickets (user_id, event_id, guest_name, status, plus_one_count, payment_provider, amount_paid) values ($1,$3,'Guest Alpha','confirmed',1,'free',0), ($2,$3,'Guest Beta','confirmed',0,'free',0)`, [guestA, guestB, evR]);
  await q(`insert into content_reports (reporter_id, content_type, content_id, reason) values ($1,'event',$2,'scam')`, [reporters[3], evR]);
  const [repR] = await q(`select id from content_reports where content_id=$1`, [evR]);
  const rv = (who: Who, id: string, body: unknown) => http("POST", `/api/admin/events/${id}/reveal`, { who, body });
  const lst = await http("GET", "/api/admin/events?limit=100", { who: mod });
  check("admin events list: no address, no guest names", lst.status === 200 && !lst.text.includes(ADDRESS) && !lst.text.includes("Guest Alpha"));
  check("reveal needs a reason (>=10 chars)", (await rv(superA, evR, { scope: "address", case: { caseType: "report", caseId: repR.id }, reason: "short" })).json?.code === "REASON_REQUIRED");
  check("reveal needs a linked case", (await rv(superA, evR, { scope: "address", reason: "Investigating a scam report" })).json?.code === "CASE_REQUIRED");
  check("the case must really concern THIS event", (await rv(superA, evOther, { scope: "address", case: { caseType: "report", caseId: repR.id }, reason: "Investigating a scam report" })).json?.code === "CASE_REQUIRED");
  check("a made-up case id is refused", (await rv(superA, evR, { scope: "address", case: { caseType: "moderation_item", caseId: "nope" }, reason: "Investigating a scam report" })).json?.code === "CASE_REQUIRED");
  const beforeAud = (await q(`select count(*)::int n from guest_data_audit where event_id=$1`, [evR]))[0].n;
  const r1 = await rv(superA, evR, { scope: "address", case: { caseType: "report", caseId: repR.id }, reason: "Investigating a scam report" });
  check("super-admin reveals the address for one event", r1.status === 200 && r1.json?.address === ADDRESS && /no-store/.test(r1.headers.get("cache-control") ?? ""), r1.json);
  const aud1 = (await q(`select * from guest_data_audit where event_id=$1 order by created_at desc`, [evR]))[0];
  check("guest_data_audit row: actor, data accessed, case and reason", (await q(`select count(*)::int n from guest_data_audit where event_id=$1`, [evR]))[0].n === beforeAud + 1 && aud1.actor_type === "super_admin" && aud1.actor_admin_id === superA.id && aud1.data_accessed === "exact_address" && aud1.case_type === "report" && aud1.case_id === repR.id && aud1.reason.includes("scam report") && aud1.grant_id === null, aud1);
  const r2 = await rv(superA, evR, { scope: "guests", case: { caseType: "moderation_item", caseId: evR }, reason: "Checking who RSVPed to this event" });
  check("super-admin reveals the guest list as JSON (names, status, plus-ones)", r2.status === 200 && r2.json.guests.length === 2 && r2.json.guests.some((g: any) => g.name === "Guest Alpha" && g.plusOneCount === 1) && /json/.test(r2.headers.get("content-type") ?? ""), r2.json);
  check("guest reveal is logged as guest_list", (await q(`select data_accessed from guest_data_audit where event_id=$1 order by created_at desc limit 1`, [evR]))[0].data_accessed === "guest_list");
  check("the reveal also writes the admin activity log", (await logs("reveal_super_admin", evR)).length === 2);
  check("no guest-data export exists, even for super-admin", (await Promise.all(["/api/admin/events/X/guests.csv", "/api/admin/events/X/export", "/api/admin/events/X/guests/export", "/api/admin/guests/export"].map((p) => http("GET", p.replace("X", evR), { who: superA })))).every((r) => r.status === 404));
  check("a moderator without a grant is refused guest and address data", (await rv(mod, evR, { scope: "address" })).json?.code === "GRANT_REQUIRED" && (await rv(mod, evR, { scope: "guests" })).status === 403);
  check("admin / analytics / finance can't reveal at all", (await Promise.all([adm, viewer, finance].map((w) => rv(w, evR, { scope: "address" })))).every((r) => r.status === 403));

  // =====================================================================
  console.log("\nreveal authority: delegated grants");
  const mk = (who: Who, body: unknown) => http("POST", "/api/admin/reveal-grants", { who, body });
  const gBody = (over: Record<string, unknown> = {}) => ({ granteeId: mod.id, eventId: evR, case: { caseType: "report", caseId: repR.id }, reason: "Moderator needs the address for a welfare check", ...over });
  check("a moderator CANNOT create a grant (nor for themselves)", (await mk(mod, gBody())).status === 403 && (await mk(mod2, gBody({ granteeId: mod2.id }))).status === 403);
  check("admin / analytics can't create grants either", (await mk(adm, gBody())).status === 403 && (await mk(viewer, gBody())).status === 403);
  check("grant needs a reason of 10+ chars", (await mk(superA, gBody({ reason: "short" }))).status === 400);
  check("grant must be scoped to a real case about the event", (await mk(superA, gBody({ case: { caseType: "report", caseId: "nope" } }))).json?.code === "CASE_MISMATCH");
  check("can't grant to yourself", (await mk(superA, gBody({ granteeId: superA.id }))).json?.code === "SELF_GRANT");
  check("can't grant to another super-admin (no laundering authority)", (await mk(superA, gBody({ granteeId: superB.id }))).json?.code === "GRANTEE_NOT_MODERATOR");
  check("can't grant to an analytics viewer / admin / finance", (await Promise.all([viewer, adm, finance].map((w) => mk(superA, gBody({ granteeId: w.id }))))).every((r) => r.json?.code === "GRANTEE_NOT_MODERATOR"));
  check("duration above the hard maximum is refused", (await mk(superA, gBody({ hours: 9999 }))).status === 400 && (await mk(superA, gBody({ hours: 721 }))).status === 400);
  await setCfg("reveal_grant_max_hours", 72);
  check("the hard maximum is config-driven (72h: 100h refused, 72h accepted)", (await mk(superA, gBody({ hours: 100 }))).json?.code === "DURATION_TOO_LONG");
  const g1r = await mk(superA, gBody());
  check("super-admin creates a grant; default expiry is 48h from config", g1r.status === 201 && Math.abs((new Date(g1r.json.expiresAt + "Z").getTime() - Date.now()) / 3600000 - 48) < 2 || Math.abs((new Date(g1r.json.expiresAt).getTime() - Date.now()) / 3600000 - 48) < 26, g1r.json);
  const g1 = g1r.json.id as string;
  check("grant creation is audit-logged with who/what/reason", (await logs("reveal_grant_created", evR)).length >= 1 && (await logs("reveal_grant_created", evR))[0].reason.includes("welfare check"));
  const useG1 = await rv(mod, evR, { scope: "address", grantId: g1 });
  check("the grantee reveals the address using the grant", useG1.status === 200 && useG1.json?.address === ADDRESS, useG1.json);
  const audG = (await q(`select * from guest_data_audit where grant_id=$1`, [g1]))[0];
  check("(e) the use is logged: grantee, grant id, data accessed, case", audG && audG.actor_type === "grantee" && audG.actor_admin_id === mod.id && audG.grant_id === g1 && audG.data_accessed === "exact_address" && audG.case_id === repR.id, audG);
  check("(e) ...and in the admin activity log as reveal_grant_used", (await logs("reveal_grant_used", evR)).length === 1);
  check("grantee can also read the guest list (JSON only)", (await rv(mod, evR, { scope: "guests", grantId: g1 })).json?.guests?.length === 2 && (await q(`select count(*)::int n from guest_data_audit where grant_id=$1`, [g1]))[0].n === 2);
  check("(c) a grant for event A does NOT unlock event B", (await rv(mod, evOther, { scope: "address", grantId: g1 })).json?.code === "GRANT_NOT_VALID");
  check("a different moderator can't use someone else's grant", (await rv(mod2, evR, { scope: "address", grantId: g1 })).json?.code === "GRANT_NOT_VALID");
  check("a made-up grant id is refused", (await rv(mod, evR, { scope: "address", grantId: "00000000-0000-0000-0000-000000000000" })).json?.code === "GRANT_NOT_VALID");
  check("refused attempts are logged as reveal_denied", (await logs("reveal_denied")).length >= 3);
  const mine = await http("GET", "/api/admin/reveal-grants/mine", { who: mod });
  check("moderator UI data: only my live grants, with a countdown", mine.json.grants.length === 1 && mine.json.grants[0].id === g1 && mine.json.grants[0].secondsLeft > 47 * 3600 && !!mine.json.grants[0].eventTitle, mine.json);
  check("another moderator sees none", (await http("GET", "/api/admin/reveal-grants/mine", { who: mod2 })).json.grants.length === 0);
  check("a moderator can't list all grants / revoke / extend / re-delegate", (await http("GET", "/api/admin/reveal-grants", { who: mod })).status === 403 && (await http("POST", `/api/admin/reveal-grants/${g1}/revoke`, { who: mod, body: { reason: "revoking my own grant" } })).status === 403 && (await mk(mod, gBody({ granteeId: mod2.id }))).status === 403);

  console.log("\nreveal authority: revocation and expiry (server-side, every request)");
  const rvk = await http("POST", `/api/admin/reveal-grants/${g1}/revoke`, { who: superA, body: { reason: "Welfare check completed, access no longer needed" } });
  check("super-admin revokes a grant", rvk.status === 200 && (await logs("reveal_grant_revoked", g1)).length === 1);
  check("(b) a revoked grant stops working IMMEDIATELY", (await rv(mod, evR, { scope: "address", grantId: g1 })).json?.code === "GRANT_REVOKED");
  check("revoking twice -> 409", (await http("POST", `/api/admin/reveal-grants/${g1}/revoke`, { who: superA, body: { reason: "revoking again by mistake" } })).status === 409);
  check("a revoked grant disappears from the moderator's list", (await http("GET", "/api/admin/reveal-grants/mine", { who: mod })).json.grants.length === 0);
  const g2 = (await mk(superA, gBody({ hours: 24 }))).json.id as string;
  check("a fresh grant works", (await rv(mod, evR, { scope: "address", grantId: g2 })).status === 200);
  // Test-only: the immutability trigger (deliberately) forbids editing expires_at, so switch it off on the SCRATCH db to simulate time passing.
  await q(`alter table reveal_grants disable trigger reveal_grants_immutable`);
  await q(`update reveal_grants set expires_at = now() - interval '1 minute', created_at = now() - interval '25 hours' where id=$1`, [g2]);
  await q(`alter table reveal_grants enable trigger reveal_grants_immutable`);
  check("(b) an expired grant is refused server-side on the next request", (await rv(mod, evR, { scope: "address", grantId: g2 })).json?.code === "GRANT_EXPIRED");
  check("an expired grant drops out of the moderator's live list", (await http("GET", "/api/admin/reveal-grants/mine", { who: mod })).json.grants.length === 0);
  const sg = await http("GET", "/api/admin/reveal-grants", { who: superA });
  check("super-admin list shows status per grant (active/expired/revoked)", sg.json.grants.find((g: any) => g.id === g2)?.status === "expired" && sg.json.grants.find((g: any) => g.id === g1)?.status === "revoked", sg.json.grants.map((g: any) => g.status));
  check("expiry is audit-logged (once, even after repeated listing)", (await http("GET", "/api/admin/reveal-grants", { who: superA })).status === 200 && (await logs("reveal_grant_expired", g2)).length === 1);
  const g3 = (await mk(superA, gBody({ eventId: evOther, case: { caseType: "moderation_item", caseId: evOther } }))).json.id;
  check("a grant is scoped to its own event only", (await rv(mod, evOther, { scope: "address", grantId: g3 })).status === 200 && (await rv(mod, evR, { scope: "address", grantId: g3 })).json?.code === "GRANT_NOT_VALID");

  console.log("\nreveal authority: enforced in the database too");
  const dbFail = async (sql: string, p: any[] = []) => { try { await q(sql, p); return null; } catch (e) { return (e as Error).message; } };
  check("a grant can't be inserted with a non-super grantor (trigger)", /only be created by an active super_admin/.test((await dbFail(`insert into reveal_grants (grantor_id, grantee_id, event_id, case_type, case_id, reason, expires_at) values ($1,$2,$3,'report','x','sql insert attempt', now() + interval '1 hour')`, [mod2.id, mod.id, evR])) ?? ""));
  check("...nor to a super-admin grantee (trigger)", /non-super admin/.test((await dbFail(`insert into reveal_grants (grantor_id, grantee_id, event_id, case_type, case_id, reason, expires_at) values ($1,$2,$3,'report','x','sql insert attempt', now() + interval '1 hour')`, [superA.id, superB.id, evR])) ?? ""));
  check("a grant's expiry can't be extended in place (trigger)", /immutable/.test((await dbFail(`update reveal_grants set expires_at = now() + interval '999 hours' where id=$1`, [g3])) ?? ""));
  check("a grant's grantee can't be changed (trigger)", /immutable/.test((await dbFail(`update reveal_grants set grantee_id = $2 where id=$1`, [g3, mod2.id])) ?? ""));
  check("a revoked grant can't be un-revoked", /cannot be changed|immutable/.test((await dbFail(`update reveal_grants set revoked_at = null where id=$1`, [g1])) ?? ""));
  check("admin audit log rows can't be edited or deleted", /append-only/.test((await dbFail(`update admin_activity_logs set reason='tampered' where id=$1`, [logA.id])) ?? "") && /append-only/.test((await dbFail(`delete from admin_activity_logs where id=$1`, [logA.id])) ?? ""));
  check("guest-data audit rows can't be edited or deleted", /append-only/.test((await dbFail(`delete from guest_data_audit where id=$1`, [aud1.id])) ?? ""));

  console.log("\nreveal-activity view (super-admin only)");
  const act2 = await http("GET", "/api/admin/reveal-activity", { who: superA });
  const kinds = new Set((act2.json.activity as any[]).map((a) => a.kind));
  check("super-admin sees reveals, grant creation, use, revocation, expiry and denials in one place", act2.status === 200 && ["data_revealed", "reveal_grant_created", "reveal_grant_used", "reveal_grant_revoked", "reveal_grant_expired", "reveal_denied", "reveal_super_admin"].every((k) => kinds.has(k)), Array.from(kinds));
  check("reveal activity says who, which grant, what data", (act2.json.activity as any[]).some((a) => a.kind === "data_revealed" && a.actorType === "grantee" && a.grantId === g1 && a.data === "exact_address" && a.actor === "mod"));
  check("nobody else can open it", (await Promise.all([mod, mod2, adm, viewer].map((w) => http("GET", "/api/admin/reveal-activity", { who: w })))).every((r) => r.status === 403));

  console.log("\nsuper-admin MFA reset");
  check("a super-admin can't reset their own MFA", (await http("POST", `/api/admin/users/admins/${superA.id}/reset-mfa`, { who: superA, body: { reason: "lost my phone, resetting me" } })).status === 400);
  check("a moderator can't reset anyone's MFA", (await http("POST", `/api/admin/users/admins/${superB.id}/reset-mfa`, { who: mod, body: { reason: "pretending to be a super admin" } })).status === 403);
  check("reset needs a reason", (await http("POST", `/api/admin/users/admins/${superB.id}/reset-mfa`, { who: superA, body: {} })).status === 400);
  const rst = await http("POST", `/api/admin/users/admins/${superB.id}/reset-mfa`, { who: superA, body: { reason: "Lost device, identity verified in person" } });
  check("another super-admin resets it, audited", rst.status === 200 && (await q(`select 1 from admin_mfa where admin_id=$1`, [superB.id])).length === 0 && (await logs("mfa_reset", superB.id)).length === 1);

  // =====================================================================
  console.log("\nqueue SLA alerts");
  await q(`delete from moderation_config where key='internal_sla_last_alert_ms'`); invalidateConfigCache();
  const sent: string[] = [];
  setSlaMailerForTests(async (to) => { sent.push(to); });
  const slaEv = await mkEvent(hostStd, { title: "SLA breach", status: "pending", reason: "new_account_review", queuedHoursAgo: 40 });
  const s1 = await checkQueueSla();
  check("items past the SLA trigger an alert", s1.breached >= 1 && s1.alerted === true && s1.recipients >= 5, s1);
  check("alert goes to active moderators, admins and super-admins only", sent.some((e) => e.startsWith("mod-")) && sent.some((e) => e.startsWith("adm-")) && sent.some((e) => e.startsWith("superA-")) && !sent.some((e) => e.startsWith("viewer-") || e.startsWith("fin-") || e.startsWith("dead-") || e.startsWith("modtemp-")), sent);
  const s2 = await checkQueueSla();
  check("no repeat alert inside the cool-down", s2.alerted === false && sent.length === s1.recipients);
  await setCfg("queue_sla_hours", 500);
  check("SLA is config-driven (500h target -> nothing breached)", (await checkQueueSla()).breached === 0);
  await setCfg("queue_sla_hours", 24);
  setSlaMailerForTests(null);
  await q(`update events set moderation_status='approved', queued_at=null where id=$1`, [slaEv]);

  // =====================================================================
  console.log("\ndashboard metrics");
  await q(`insert into content_reports (reporter_id, content_type, content_id, reason) values ($1,'event',$2,'spam'), ($3,'event',$2,'spam')`, [reporters[0], evA, reporters[1]]);
  await q(`update events set auto_flags='{external_link}', flag_outcome='approved' where id=$1`, [evA]);
  const m = await http("GET", "/api/admin/social/metrics?days=30", { who: viewer });
  const mj = m.json;
  check("events created: public and private counted", m.status === 200 && mj.eventsCreated.public >= 10 && mj.eventsCreated.private >= 1, mj.eventsCreated);
  check("queue size + SLA breaches", typeof mj.queue.size === "number" && mj.queue.size >= 1 && mj.queue.slaHours === 24, mj.queue);
  check("median time-to-review is computed from real review actions", mj.reviewedCount >= 3 && mj.medianTimeToReviewHours !== null && mj.medianTimeToReviewHours > 0, { n: mj.reviewedCount, med: mj.medianTimeToReviewHours });
  check("takedowns counted (hide / remove / reject: 3 were done above)", mj.takedowns >= 3, mj.takedowns);
  check("reports per day", mj.reportsPerDay.length >= 1 && mj.reportsPerDay.reduce((s: number, d: any) => s + d.n, 0) >= 5, mj.reportsPerDay);
  check("ban counts", mj.bans.active >= 1, mj.bans);
  check("auto-flag precision: flagged-later-approved vs rejected", mj.autoFlagPrecision.flaggedLaterApproved >= 1 && mj.autoFlagPrecision.flaggedLaterRejected >= 1 && typeof mj.autoFlagPrecision.precision === "number", mj.autoFlagPrecision);
  check("finance managers can't see metrics", (await http("GET", "/api/admin/social/metrics", { who: finance })).status === 403);

  console.log("\nregression: phase 2/3 behaviour and existing admin");
  check("existing admin dashboard stats still work", (await http("GET", "/api/admin/stats", { who: mod })).status === 200);
  check("existing activity log endpoint still works and now carries reasons", (await http("GET", "/api/admin/activity-logs?limit=5", { who: superA })).status === 200);
  check("a host can still create a private event (no admin interference)", (await http("POST", "/api/social-events", { user: hostStd, body: { title: "Private after phase 4", description: "Still works", socialType: "party", visibility: "private", eventDate: new Date(Date.now() + 5 * 86400000).toISOString(), location: "Soho, London", exactAddress: ADDRESS, capacity: 10, maxPlusOnes: 0 } })).status === 201);

  console.log("\nMFA switched off (the shipped default): password-only sign-in");
  delete process.env.ADMIN_MFA_REQUIRED;
  const superC = await mkAdmin("superC", "super_admin");
  const lc = await login(superC);
  check("super-admin signs in with username + password only (no MFA step reported)", lc.status === 200 && lc.json?.mfa === null, lc.json);
  const meC = await http("GET", "/api/admin/me", { who: superC });
  check("/me reports MFA as not required", meC.json?.mfa?.required === false && meC.json?.mfa?.verified === true, meC.json?.mfa);
  check("every super-admin area works straight away", (await Promise.all(["/api/admin/moderation/queue", "/api/admin/moderation/config", "/api/admin/reveal-grants", "/api/admin/reveal-activity", "/api/admin/moderators"].map((u) => http("GET", u, { who: superC })))).every((r) => r.status === 200));
  check("MFA enrolment refuses to start while it's off", (await http("POST", "/api/admin/mfa/setup", { who: superC })).json?.code === "MFA_DISABLED");
  const lA = await login(superA);
  check("an already-enrolled super-admin (superA) signs in without a code", lA.status === 200 && lA.json?.mfa === null && (await http("GET", "/api/admin/reveal-grants", { who: superA })).status === 200, lA.json);
  check("least privilege is unchanged with MFA off (moderator still refused)", (await http("GET", "/api/admin/reveal-grants", { who: mod })).status === 403);
  process.env.ADMIN_MFA_REQUIRED = "true";
  const lD = await login(await mkAdmin("superD", "super_admin"));
  check("switching it back on re-imposes MFA at once (a new session is told to enrol)", lD.json?.mfa === "enroll", lD.json);
  delete process.env.ADMIN_MFA_REQUIRED;
} catch (e) {
  failures++;
  console.error("\nUNEXPECTED ERROR", e);
} finally {
  server.close();
  await pool.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
