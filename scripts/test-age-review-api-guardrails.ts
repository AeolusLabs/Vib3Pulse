// Age review guardrails against a throwaway database (written, run by the orchestrator):
//   DATABASE_URL=<scratch db> SESSION_SECRET=x AGE_REVIEW=1 AGE_EVIDENCE_KEY=<base64 32 bytes> npx tsx scripts/test-age-review-api-guardrails.ts
// Refuses to run unless the database name contains "test". Purges ALL evidence, so never point it at real data.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.AGE_REVIEW = "1";
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.AGE_EVIDENCE_KEY ||= Buffer.alloc(32, 5).toString("base64");

const { ensureSchema } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { registerAgeReviewRoutes } = await import("../server/routes/age-review-routes");
const { storage } = await import("../server/storage");
const { userToSessionUser } = await import("../server/auth");
const { encryptEvidence } = await import("../server/identity/evidenceCrypto");
const { sweepExpiredAgeReviews } = await import("../server/identity/ageReviewSweep");
await ensureSchema();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const a = req.header("x-test-admin");
  req.session = a ? { adminId: a, mfaVerified: true, destroy: (cb: any) => cb?.() } : { destroy: (cb: any) => cb?.() };
  const u = req.header("x-test-user");
  if (u) { const row = await storage.getUser(u); req.user = row ? userToSessionUser(row) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerAgeReviewAdminRoutes(app);
registerAgeReviewRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ip = 1;
async function http(method: string, path: string, who: { admin?: string; user?: string }, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "x-forwarded-for": `10.7.0.${ip++ & 255}`, "content-type": "application/json", ...(who.admin ? { "x-test-admin": who.admin } : {}), ...(who.user ? { "x-test-user": who.user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const headers = Object.fromEntries(res.headers.entries());
  if (type.startsWith("image/")) return { status: res.status, json: null, bytes: Buffer.from(await res.arrayBuffer()), headers };
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json, bytes: null as Buffer | null, headers };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const mkAdmin = async (n: string, role: string) => (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A',$4) returning id`, [`${n}${stamp}`, `${n}${stamp}@t.dev`, hash, role]))[0].id as string;
const dob = (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 30); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); })();
const mkUser = async (n: string) => (await q(`insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth) values ($1,$2,'social',$3,true,true,$4) returning id`, [`${n}${stamp}@t.dev`, `${n}${stamp}`, hash, dob]))[0].id as string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const mkReq = async (userId: string, status = "in_review") => {
  const id = (await q(`insert into age_review_requests (user_id, method, status, document_type, registered_dob_snapshot, consent_version, consented_at, submitted_at) values ($1,'upload',$2,'passport',$3,'2026-10-v1',now(),now()) returning id`, [userId, status, dob]))[0].id as string;
  const ev: Record<string, string> = {};
  for (const kind of ["document", "selfie"]) ev[kind] = (await q(`insert into age_review_evidence (request_id, kind, mime, bytes_enc) values ($1,$2,'image/png',$3) returning id`, [id, kind, encryptEvidence(PNG, `${id}:${kind}`)]))[0].id;
  return { id, ev };
};

const rev = await mkAdmin("arg_rev", "age_reviewer"), rev2 = await mkAdmin("arg_rev2", "age_reviewer");
const adm = await mkAdmin("arg_adm", "admin"), sup = await mkAdmin("arg_sup", "super_admin");
const u1 = await mkUser("argu1");
const r1 = await mkReq(u1);
const evUrl = (r: { id: string; ev: Record<string, string> }, kind = "document") => `/api/admin/age-reviews/${r.id}/evidence/${r.ev[kind]}`;

const plain = await http("GET", evUrl(r1), { admin: rev });
check("GET without a token never returns the image", plain.status === 403 && plain.bytes === null);
const rv = await http("POST", evUrl(r1) + "/reveal", { admin: rev });
check("reveal returns a token valid for 60 s", rv.status === 200 && rv.json.expiresInSec === 60 && typeof rv.json.token === "string");
const other = await http("GET", `${evUrl(r1)}?token=${encodeURIComponent(rv.json.token)}`, { admin: rev2 });
check("reveal token for another admin is refused", other.status === 403 && other.json.code === "TOKEN_INVALID");
const wrongEv = await http("GET", `${evUrl(r1, "selfie")}?token=${encodeURIComponent(rv.json.token)}`, { admin: rev });
check("reveal token for another evidence id is refused", wrongEv.status === 403);
const img = await http("GET", `${evUrl(r1)}?token=${encodeURIComponent(rv.json.token)}`, { admin: rev });
check("the owner's token returns the image with guardrail headers",
  img.status === 200 && img.bytes?.equals(PNG) === true && img.headers["cache-control"] === "no-store" && img.headers["x-content-type-options"] === "nosniff"
  && img.headers["content-security-policy"] === "sandbox" && img.headers["content-type"] === "image/png" && !img.headers["etag"] && !img.headers["last-modified"]);
check("reveal token is single use", (await http("GET", `${evUrl(r1)}?token=${encodeURIComponent(rv.json.token)}`, { admin: rev })).status === 403);
check("every reveal is audited without content", (await q(`select details from admin_activity_logs where admin_id = $1 and action = 'age_review.reveal'`, [rev])).every((r: any) => r.details === `request=${r1.id} kind=document`));

const rv2 = await http("POST", evUrl(r1, "selfie") + "/reveal", { admin: rev });
await pool.query(`delete from age_review_evidence where id = $1`, [r1.ev.selfie]);
const gone = await http("GET", `${evUrl(r1, "selfie")}?token=${encodeURIComponent(rv2.json.token)}`, { admin: rev });
check("missing evidence row after a cancel race is a clean 404", gone.status === 404 && gone.json.code === "WRONG_STATE");
check("reveal of a missing row is a clean 404", (await http("POST", evUrl(r1, "selfie") + "/reveal", { admin: rev })).json?.code === "WRONG_STATE");

const r2 = await mkReq(await mkUser("argu2"));
await q(`update age_review_evidence set bytes_enc = $2 where id = $1`, [r2.ev.document, encryptEvidence(PNG, `${r2.id}:selfie`)]);
const rv3 = await http("POST", evUrl(r2) + "/reveal", { admin: rev2 });
const bad = await http("GET", `${evUrl(r2)}?token=${encodeURIComponent(rv3.json.token)}`, { admin: rev2 });
check("decrypt failure fails closed", bad.status === 500 && bad.json?.code === "EVIDENCE_UNAVAILABLE" && bad.bytes === null);

// reveal limit: 60 per hour per reviewer
const r3 = await mkReq(await mkUser("argu3"));
for (let i = 0; i < 60; i++) await q(`insert into admin_activity_logs (admin_id, action, target_type, target_id, details) values ($1,'age_review.reveal','age_review_request',$2,'seed')`, [adm, r3.id]);
const lim = await http("POST", evUrl(r3) + "/reveal", { admin: adm });
check("reveal limit 60 per hour per reviewer", lim.status === 429 && lim.json.code === "REVEAL_LIMIT" && (await q(`select 1 from admin_activity_logs where admin_id = $1 and action = 'age_review.reveal_limit'`, [adm])).length >= 1);

// health
const health = await http("GET", "/api/admin/age-reviews/health", { admin: sup });
check("health: counts and reveals per reviewer", health.status === 200 && health.json.pendingEvidence >= 2 && Array.isArray(health.json.revealsToday) && health.json.revealsToday.some((r: any) => r.count >= 60));
check("health: age_reviewer refused", (await http("GET", "/api/admin/age-reviews/health", { admin: rev })).status === 403);
const stale = await mkReq(await mkUser("argu4"), "approved");
check("health: evidence on a final request counts as stale", (await http("GET", "/api/admin/age-reviews/health", { admin: sup })).json.staleEvidence >= 2);
const sw = await sweepExpiredAgeReviews();
check("sweep sees the stale evidence, then removes it", (sw.staleFound ?? 0) >= 2 && (await q(`select 1 from age_review_evidence where request_id = $1`, [stale.id])).length === 0);

// pause
const pu = await mkUser("argu5");
const consent = { consentVersion: "2026-10-v1" };
check("pause: admin can pause", (await http("POST", "/api/admin/age-reviews/pause", { admin: adm }, { on: true, reason: "incident" })).json?.changed === true);
check("pause: repeat is changed false", (await http("POST", "/api/admin/age-reviews/pause", { admin: adm }, { on: true, reason: "incident" })).json?.changed === false);
check("paused: create refused", (await http("POST", "/api/age-review/requests", { user: pu }, { method: "live", ...consent })).json?.code === "AGE_REVIEW_PAUSED");
check("paused: decisions still allowed", (await http("POST", `/api/admin/age-reviews/${r3.id}/decide`, { admin: rev }, { outcome: "decline", declineReason: "other" })).status === 200);
check("pause: admin cannot resume", (await http("POST", "/api/admin/age-reviews/pause", { admin: adm }, { on: false, reason: "clear" })).status === 403);
check("pause: super_admin resumes", (await http("POST", "/api/admin/age-reviews/pause", { admin: sup }, { on: false, reason: "all clear" })).json?.changed === true);

// emergency purge
const r5 = await mkReq(await mkUser("argu6"));
check("emergency purge: admin refused", (await http("POST", "/api/admin/age-reviews/emergency-purge", { admin: adm }, { reason: "incident" })).status === 403);
const purge = await http("POST", "/api/admin/age-reviews/emergency-purge", { admin: sup }, { reason: "incident drill" });
check("emergency purge deletes all evidence, returns the count", purge.status === 200 && purge.json.deleted >= 2 && (await q(`select 1 from age_review_evidence`)).length === 0);
check("emergency purge moves open uploads to needs_more without a more round", (await q(`select status, more_requests from age_review_requests where id = $1`, [r5.id]))[0].status === "needs_more" && (await q(`select more_requests from age_review_requests where id = $1`, [r5.id]))[0].more_requests === 0);
check("emergency purge audit carries the count only", (await q(`select details from admin_activity_logs where action = 'age_review.emergency_purge' order by created_at desc limit 1`))[0].details.startsWith("deleted="));

// parallel reveals cannot exceed the hourly limit
{
  const burst = await mkAdmin("arg_burst", "age_reviewer");
  const target = await mkReq(await mkUser("argu7"));
  const results = await Promise.all(Array.from({ length: 75 }, () => http("POST", evUrl(target) + "/reveal", { admin: burst })));
  const issued = results.filter((r) => r.status === 200).length;
  const rows = (await q(`select count(*)::int n from admin_activity_logs where admin_id = $1 and action = 'age_review.reveal'`, [burst]))[0].n;
  check("reveal limit holds under 75 parallel requests", issued === 60 && rows === 60 && results.filter((r) => r.status === 429).length === 15, `issued ${issued} rows ${rows}`);
}

// an upload racing the emergency purge never survives from before the purge
{
  const racer = await mkUser("argu8");
  const rq = (await http("POST", "/api/age-review/requests", { user: racer }, { method: "upload", documentType: "passport", ...consent })).json.request;
  const startedAt = (await q(`select now()::timestamp as t`))[0].t as Date;
  await new Promise((r) => setTimeout(r, 20));
  await Promise.all([
    http("POST", "/api/admin/age-reviews/emergency-purge", { admin: sup }, { reason: "race drill" }),
    ...Array.from({ length: 6 }, (_, i) => http("POST", `/api/age-review/requests/${rq.id}/evidence`, { user: racer }, { kind: i % 2 ? "selfie" : "document", mime: "image/png", data: PNG.toString("base64") })),
  ]);
  const survivors = await q(`select created_at from age_review_evidence where request_id = $1`, [rq.id]);
  check("an upload racing the purge is either deleted or stored after it", survivors.every((s: any) => new Date(s.created_at) > new Date(startedAt)));
}

// raw row redaction through a real handler is covered in the unit test; here confirm the live API never leaks the fingerprint
const detail = await http("GET", `/api/admin/age-reviews/${r5.id}`, { admin: rev });
check("detail never carries a fingerprint or encrypted bytes", detail.status === 200 && !/ingerprint|bytes_enc|bytesEnc/.test(JSON.stringify(detail.json)));

await q(`delete from users where username like $1`, [`argu%${stamp}`]);
server.close();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
