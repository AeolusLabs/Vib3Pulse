// Age verification seam (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-ageverification.ts
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
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { registerAgeVerificationAdminRoute } = await import("../server/admin-routes");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
const { correctDateOfBirth } = await import("../server/services/dobCorrection");

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
  // Admin session stand-in: the real gate (adminGate) reads req.session.adminId and re-reads the admin row.
  const adminId = req.header("x-test-admin");
  req.session = adminId ? { adminId, destroy: (cb: any) => cb?.() } : { destroy: (cb: any) => cb?.() };
  req.isAuthenticated = () => !!req.user;
  req.login = (_u: unknown, cb: (e?: unknown) => void) => cb(); // real one regenerates the session; the response still waits for it
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
registerUsersRoutes(app);
registerAgeVerificationAdminRoute(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, h: { user?: string; admin?: string }, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "x-forwarded-for": `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "content-type": "application/json",
      ...(h.user ? { "x-test-user": h.user } : {}), ...(h.admin ? { "x-test-admin": h.admin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); };
const mk = async (name: string, dob: string | null) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth)
   values ($1,$2,'social',$3,true,true,$4) returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, dob]))[0].id as string;
const mkAdmin = async (name: string, role: string) => (await q(
  `insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A',$4) returning id`,
  [`${name}${stamp}`, `${name}${stamp}@t.dev`, hash, role]))[0].id as string;

try {
  const user = await mk("av_user", yearsAgo(30));
  const other = await mk("av_other", yearsAgo(30));
  const admin = await mkAdmin("av_adm", "super_admin");
  const support = await mkAdmin("av_sup", "user_support");
  const moderator = await mkAdmin("av_mod", "content_moderator");

  const anon = await http("GET", "/api/users/me/age-verification", {});
  check("GET without a session is 401", anon.status === 401, JSON.stringify(anon));

  const before = await http("GET", "/api/users/me/age-verification", { user });
  check("GET before verification: verified false, band null", before.status === 200 && JSON.stringify(before.json) === JSON.stringify({ verified: false, band: null, at: null, method: null }), JSON.stringify(before));

  const self = await http("POST", `/api/admin/users/${user}/age-verification`, { user }, { verified: true, reason: "test reason" });
  check("a normal user cannot set it on themself (401/403)", self.status === 401 || self.status === 403, JSON.stringify(self));
  const selfAdminHeader = await http("POST", `/api/admin/users/${user}/age-verification`, { user, admin: user }, { verified: true, reason: "test reason" });
  check("a normal user id presented as an admin id is refused (no admin row)", selfAdminHeader.status === 401 || selfAdminHeader.status === 403, JSON.stringify(selfAdminHeader));
  const noAuth = await http("POST", `/api/admin/users/${user}/age-verification`, {}, { verified: true, reason: "test reason" });
  check("unauthenticated POST is 401", noAuth.status === 401, JSON.stringify(noAuth));
  const wrongRole = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: moderator }, { verified: true, reason: "test reason" });
  check("an admin without a permitted role gets 403", wrongRole.status === 403, JSON.stringify(wrongRole));
  check("none of those refusals changed anything", (await q(`select age_verified_at from users where id=$1`, [user]))[0].age_verified_at === null);

  const bad = await http("POST", `/api/admin/users/${user}/age-verification`, { admin }, { verified: "yes", reason: "test reason" });
  check("non-boolean body is 400", bad.status === 400, JSON.stringify(bad));
  const missing = await http("POST", `/api/admin/users/00000000-0000-0000-0000-000000000000/age-verification`, { admin }, { verified: true, reason: "test reason" });
  check("unknown user is 404", missing.status === 404, JSON.stringify(missing));

  const set = await http("POST", `/api/admin/users/${user}/age-verification`, { admin }, { verified: true, reason: "test reason" });
  check("admin sets it: 200 with the AgeVerification shape", set.status === 200 && set.json?.verified === true && set.json.band === "adult" && set.json.method === "admin" && typeof set.json.at === "string", JSON.stringify(set));
  const after = await http("GET", "/api/users/me/age-verification", { user });
  check("user GET now returns verified true, band adult", after.status === 200 && after.json?.verified === true && after.json.band === "adult" && after.json.method === "admin", JSON.stringify(after));
  check("read route returns only the four shape keys, no birthdate", Object.keys(after.json ?? {}).sort().join() === "at,band,method,verified" && !JSON.stringify(after.json).includes(yearsAgo(30)), JSON.stringify(after.json));
  const otherView = await http("GET", "/api/users/me/age-verification", { user: other });
  check("another user is unaffected", otherView.json?.verified === false, JSON.stringify(otherView));
  check("audit log written for the admin", (await q(`select 1 from admin_activity_logs where admin_id=$1 and action='user.age_verified' and target_id=$2`, [admin, user])).length === 1);
  const au = (await q(`select reason, details from admin_activity_logs where admin_id=$1 and action='user.age_verified' and target_id=$2`, [admin, user]))[0];
  check("audit entry has the reason and previous -> new state", au?.reason === "test reason" && /not verified -> verified \(admin\)/.test(au.details) && au.details.includes("test reason"), JSON.stringify(au));
  for (const [label, body] of [["missing", { verified: true }], ["empty", { verified: true, reason: "" }], ["too short", { verified: true, reason: "ab" }], ["too long", { verified: true, reason: "x".repeat(301) }], ["whitespace", { verified: true, reason: "    " }]] as const) {
    const r = await http("POST", `/api/admin/users/${other}/age-verification`, { admin }, body);
    check(`reason ${label}: 400 and nothing changed`, r.status === 400 && (await q(`select age_verified_at from users where id=$1`, [other]))[0].age_verified_at === null, JSON.stringify(r));
  }

  // user_support was removed from this route (age review): refused for both directions, nothing changes.
  const supportClear = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: support }, { verified: false, reason: "test reason" });
  check("user_support is refused (403) when clearing, and the verification is unchanged", supportClear.status === 403 && (await http("GET", "/api/users/me/age-verification", { user })).json?.verified === true, JSON.stringify(supportClear));
  const supportSet = await http("POST", `/api/admin/users/${other}/age-verification`, { admin: support }, { verified: true, reason: "test reason" });
  check("user_support is refused (403) when setting, and nothing changes", supportSet.status === 403 && (await q(`select age_verified_at from users where id=$1`, [other]))[0].age_verified_at === null, JSON.stringify(supportSet));
  const regularAdmin = await mkAdmin("av_adm2", "admin");
  const reviewer = await mkAdmin("av_rev", "age_reviewer");
  const adminClear = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: regularAdmin }, { verified: false, reason: "test reason" });
  check("admin can clear it", adminClear.status === 200 && adminClear.json?.verified === false, JSON.stringify(adminClear));
  const reviewerSet = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: reviewer }, { verified: true, reason: "test reason" });
  check("age_reviewer can set it again", reviewerSet.status === 200 && (await http("GET", "/api/users/me/age-verification", { user })).json?.verified === true, JSON.stringify(reviewerSet));

  // DOB correction clears it (the service behind PUT /api/admin/users/:id/date-of-birth)
  const fix = await correctDateOfBirth({ adminId: admin, userId: user, dateOfBirth: yearsAgo(31), reason: "typo" });
  check("DOB correction succeeds", fix.ok, JSON.stringify(fix));
  const cleared = await http("GET", "/api/users/me/age-verification", { user });
  check("after the DOB is corrected the flag is cleared", cleared.json?.verified === false && cleared.json.band === null && cleared.json.method === null, JSON.stringify(cleared));
  const row = (await q(`select age_verified_at, age_verified_method from users where id=$1`, [user]))[0];
  check("both columns are null in the database", row.age_verified_at === null && row.age_verified_method === null, JSON.stringify(row));

  // --- a user must never be able to pick the birthdate that sits behind a verification
  const noDob = await mk("av_nodob", null);
  const refuse = await http("POST", `/api/admin/users/${noDob}/age-verification`, { admin }, { verified: true, reason: "test reason" });
  check("admin cannot verify a user with no birthdate (409)", refuse.status === 409, JSON.stringify(refuse));
  check("...and nothing was stored", (await q(`select age_verified_at from users where id=$1`, [noDob]))[0].age_verified_at === null);
  const clearNoDob = await http("POST", `/api/admin/users/${noDob}/age-verification`, { admin }, { verified: false, reason: "test reason" });
  check("clearing (verified:false) on a no-birthdate user is still allowed", clearNoDob.status === 200, JSON.stringify(clearNoDob));

  // Force the bad state directly (verified, no birthdate), then let the user set one through each path.
  const forceVerified = (id: string) => q(`update users set age_verified_at=now(), age_verified_method='admin', date_of_birth=null where id=$1`, [id]);
  const state = async (id: string) => (await q(`select age_verified_at, age_verified_method, date_of_birth from users where id=$1`, [id]))[0];

  const viaEdit = await mk("av_edit", null); await forceVerified(viaEdit);
  const e = await http("PATCH", "/api/users/me", { user: viaEdit }, { dateOfBirth: yearsAgo(30) });
  const es = await state(viaEdit);
  check("PATCH /api/users/me first-time DOB: saved and verification cleared", e.status === 200 && es.date_of_birth === yearsAgo(30) && es.age_verified_at === null && es.age_verified_method === null, JSON.stringify({ e, es }));

  const viaComplete = await mk("av_cp", null); await forceVerified(viaComplete);
  await q(`update users set onboarding_complete=false where id=$1`, [viaComplete]);
  const c = await http("PATCH", "/api/auth/complete-profile", { user: viaComplete }, { userType: "social", displayName: "CP", dateOfBirth: yearsAgo(30), gender: "Male", interests: ["music"] });
  const cs = await state(viaComplete);
  check("PATCH /api/auth/complete-profile first-time DOB: saved and verification cleared", c.status === 200 && cs.date_of_birth === yearsAgo(30) && cs.age_verified_at === null && cs.age_verified_method === null, JSON.stringify({ c, cs }));

  const locked = await mk("av_locked", yearsAgo(30));
  await http("POST", `/api/admin/users/${locked}/age-verification`, { admin }, { verified: true, reason: "test reason" });
  await http("PATCH", "/api/users/me", { user: locked }, { dateOfBirth: yearsAgo(40), bio: "hi" });
  check("an already-set (locked) birthdate edit is ignored and verification stays", (await state(locked)).age_verified_at !== null && (await state(locked)).date_of_birth === yearsAgo(30));

  // --- other people never see the two columns
  const pub = await http("GET", `/api/users/${locked}`, { user: other });
  const keys = JSON.stringify(pub.json ?? {});
  check("another user's view of a verified user has neither age-verification key", pub.status === 200 && !/ageVerified/.test(keys), keys.slice(0, 200));
  const prof = await http("GET", `/api/users/${locked}/profile`, { user: other });
  check("...nor the /profile view", !/ageVerified/.test(JSON.stringify(prof.json ?? {})), JSON.stringify(prof.json ?? {}).slice(0, 200));
  const { toPublicUser } = await import("../server/auth");
  const raw = await storage.getUser(locked);
  check("toPublicUser omits both columns", !!raw && !("ageVerifiedAt" in toPublicUser(raw)) && !("ageVerifiedMethod" in toPublicUser(raw)));

  // --- deleting the account clears them
  await storage.softDeleteUser(locked);
  const del = await state(locked);
  check("softDeleteUser clears verification", del.age_verified_at === null && del.age_verified_method === null, JSON.stringify(del));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
