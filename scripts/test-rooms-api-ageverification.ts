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
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
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

  const self = await http("POST", `/api/admin/users/${user}/age-verification`, { user }, { verified: true });
  check("a normal user cannot set it on themself (401/403)", self.status === 401 || self.status === 403, JSON.stringify(self));
  const selfAdminHeader = await http("POST", `/api/admin/users/${user}/age-verification`, { user, admin: user }, { verified: true });
  check("a normal user id presented as an admin id is refused (no admin row)", selfAdminHeader.status === 401 || selfAdminHeader.status === 403, JSON.stringify(selfAdminHeader));
  const noAuth = await http("POST", `/api/admin/users/${user}/age-verification`, {}, { verified: true });
  check("unauthenticated POST is 401", noAuth.status === 401, JSON.stringify(noAuth));
  const wrongRole = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: moderator }, { verified: true });
  check("an admin without a permitted role gets 403", wrongRole.status === 403, JSON.stringify(wrongRole));
  check("none of those refusals changed anything", (await q(`select age_verified_at from users where id=$1`, [user]))[0].age_verified_at === null);

  const bad = await http("POST", `/api/admin/users/${user}/age-verification`, { admin }, { verified: "yes" });
  check("non-boolean body is 400", bad.status === 400, JSON.stringify(bad));
  const missing = await http("POST", `/api/admin/users/00000000-0000-0000-0000-000000000000/age-verification`, { admin }, { verified: true });
  check("unknown user is 404", missing.status === 404, JSON.stringify(missing));

  const set = await http("POST", `/api/admin/users/${user}/age-verification`, { admin }, { verified: true });
  check("admin sets it: 200 with the AgeVerification shape", set.status === 200 && set.json?.verified === true && set.json.band === "adult" && set.json.method === "admin" && typeof set.json.at === "string", JSON.stringify(set));
  const after = await http("GET", "/api/users/me/age-verification", { user });
  check("user GET now returns verified true, band adult", after.status === 200 && after.json?.verified === true && after.json.band === "adult" && after.json.method === "admin", JSON.stringify(after));
  check("read route returns only the four shape keys, no birthdate", Object.keys(after.json ?? {}).sort().join() === "at,band,method,verified" && !JSON.stringify(after.json).includes(yearsAgo(30)), JSON.stringify(after.json));
  const otherView = await http("GET", "/api/users/me/age-verification", { user: other });
  check("another user is unaffected", otherView.json?.verified === false, JSON.stringify(otherView));
  check("audit log written for the admin", (await q(`select 1 from admin_activity_logs where admin_id=$1 and action='user.age_verified' and target_id=$2`, [admin, user])).length === 1);

  const supportClear = await http("POST", `/api/admin/users/${user}/age-verification`, { admin: support }, { verified: false });
  check("user_support can clear it", supportClear.status === 200 && supportClear.json?.verified === false, JSON.stringify(supportClear));
  await http("POST", `/api/admin/users/${user}/age-verification`, { admin: support }, { verified: true });
  check("user_support can set it again", (await http("GET", "/api/users/me/age-verification", { user })).json?.verified === true);

  // DOB correction clears it (the service behind PUT /api/admin/users/:id/date-of-birth)
  const fix = await correctDateOfBirth({ adminId: admin, userId: user, dateOfBirth: yearsAgo(31), reason: "typo" });
  check("DOB correction succeeds", fix.ok, JSON.stringify(fix));
  const cleared = await http("GET", "/api/users/me/age-verification", { user });
  check("after the DOB is corrected the flag is cleared", cleared.json?.verified === false && cleared.json.band === null && cleared.json.method === null, JSON.stringify(cleared));
  const row = (await q(`select age_verified_at, age_verified_method from users where id=$1`, [user]))[0];
  check("both columns are null in the database", row.age_verified_at === null && row.age_verified_method === null, JSON.stringify(row));
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
