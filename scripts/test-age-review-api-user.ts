// Age review user API (throwaway database):
//   DATABASE_URL=<scratch db> SESSION_SECRET=x AGE_REVIEW=1 AGE_EVIDENCE_KEY=<base64 32 bytes> npx tsx scripts/test-age-review-api-user.ts
// Refuses to run unless the database name contains "test", because it creates users.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.AGE_REVIEW = "1";
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.AGE_EVIDENCE_KEY ||= Buffer.alloc(32, 7).toString("base64");

const { storage, ensureSchema } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerAgeReviewRoutes } = await import("../server/routes/age-review-routes");
const { sweepExpiredAgeReviews, purgeUserAgeReview } = await import("../server/identity/ageReviewSweep");
const { decryptEvidence } = await import("../server/identity/evidenceCrypto");
const { setAgeReviewPaused } = await import("../server/identity/ageReviewFeatures");
const { CONSENT_VERSION } = await import("../shared/ageReview");
await ensureSchema();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) { const u = await storage.getUser(id); req.user = u ? userToSessionUser(u) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerAgeReviewRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let ipSeq = 1;
async function http(method: string, path: string, user: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "x-forwarded-for": `10.8.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]).toString("base64");
const consent = { consentVersion: CONSENT_VERSION };

const adult = await mk("arv_adult", yearsAgo(30));
const other = await mk("arv_other", yearsAgo(31));
const teen = await mk("arv_teen", yearsAgo(15));
const nodob = await mk("arv_nodob", null);

// consent / eligibility / one open
check("consent version required", (await http("POST", "/api/age-review/requests", adult, { method: "upload", documentType: "passport", consentVersion: "old" })).json?.code === "CONSENT_REQUIRED");
const nOff = await http("POST", "/api/age-review/requests", teen, { method: "upload", documentType: "passport", ...consent });
check("under 18 gets NOT_OFFERED", nOff.status === 403 && nOff.json.code === "NOT_OFFERED");
check("no dob gets NOT_OFFERED", (await http("POST", "/api/age-review/requests", nodob, { method: "live", ...consent })).json?.code === "NOT_OFFERED");
const created = await http("POST", "/api/age-review/requests", adult, { method: "upload", documentType: "passport", ...consent });
check("create returns 201 with a 6 char code", created.status === 201 && /^[A-HJKMNP-Z2-9]{6}$/.test(created.json.request.code ?? ""), JSON.stringify(created.json));
const rid: string = created.json.request.id;
const dup = await http("POST", "/api/age-review/requests", adult, { method: "live", ...consent });
check("one open request per user (409)", dup.status === 409 && dup.json.code === "OPEN_REQUEST_EXISTS");

// evidence
check("evidence: not the owner is refused", (await http("POST", `/api/age-review/requests/${rid}/evidence`, other, { kind: "document", mime: "image/png", data: PNG })).status === 403);
check("evidence: unauthenticated is 401", (await http("POST", `/api/age-review/requests/${rid}/evidence`, null, { kind: "document", mime: "image/png", data: PNG })).status === 401);
check("evidence: mime that disagrees with the magic bytes refused", (await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "document", mime: "image/jpeg", data: PNG })).json?.code === "BAD_FILE");
check("evidence: not an image refused", (await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "document", mime: "image/png", data: Buffer.from("MZ not an image at all").toString("base64") })).json?.code === "BAD_FILE");
const big = Buffer.concat([Buffer.from(JPEG, "base64"), Buffer.alloc(3 * 1024 * 1024 + 10, 2)]).toString("base64");
check("evidence: too large refused", (await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "document", mime: "image/jpeg", data: big })).status === 413);
check("evidence: submit before both items is EVIDENCE_INCOMPLETE", (await http("POST", `/api/age-review/requests/${rid}/submit`, adult)).json?.code === "EVIDENCE_INCOMPLETE");
const up1 = await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "document", mime: "image/png", data: PNG });
check("evidence accepted", up1.status === 200 && up1.json.received === true && !("data" in up1.json), JSON.stringify(up1.json));
await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "document", mime: "image/jpeg", data: JPEG });
const rows = await q(`select kind, mime, bytes_enc from age_review_evidence where request_id = $1`, [rid]);
check("evidence replaced not duplicated", rows.length === 1 && rows[0].mime === "image/jpeg");
check("evidence is encrypted at rest and bound to its row", !rows[0].bytes_enc.includes(Buffer.from(JPEG, "base64").subarray(0, 8)) && decryptEvidence(rows[0].bytes_enc, `${rid}:document`).length > 0);
check("submit needs both items for upload", (await http("POST", `/api/age-review/requests/${rid}/submit`, adult)).json?.code === "EVIDENCE_INCOMPLETE");
await http("POST", `/api/age-review/requests/${rid}/evidence`, adult, { kind: "selfie", mime: "image/png", data: PNG });
const me1 = await http("GET", "/api/age-review/me", adult);
check("me: draft is state none with the request", me1.json.state === "none" && me1.json.request.hasDocument && me1.json.request.hasSelfie);
const sub = await http("POST", `/api/age-review/requests/${rid}/submit`, adult);
check("submit ok", sub.status === 200 && sub.json.request.status === "submitted");
const me2 = await http("GET", "/api/age-review/me", adult);
check("me state per case: in_review", me2.json.state === "in_review" && me2.json.request.canCancel === true);
check("evidence is never returned to the user", !JSON.stringify([me1.json, me2.json, sub.json, up1.json]).match(/bytes|bytesEnc|bytes_enc|iVBOR/));
check("me: other user is none", (await http("GET", "/api/age-review/me", other)).json.state === "none");
check("me: under 18 is not_offered", (await http("GET", "/api/age-review/me", teen)).json.state === "not_offered");

// cancel deletes evidence
const cancel = await http("POST", `/api/age-review/requests/${rid}/cancel`, adult);
check("cancel deletes evidence atomically", cancel.status === 200 && cancel.json.request.status === "cancelled" && (await q(`select 1 from age_review_evidence where request_id = $1`, [rid])).length === 0);

// new code
const c2 = (await http("POST", "/api/age-review/requests", adult, { method: "upload", documentType: "national_id", ...consent })).json.request;
check("new-code refused while the code is live", (await http("POST", `/api/age-review/requests/${c2.id}/new-code`, adult)).json?.code === "WRONG_STATE");
await q(`update age_review_requests set code_expires_at = now() - interval '1 minute' where id = $1`, [c2.id]);
check("selfie with an expired code is CODE_EXPIRED", (await http("POST", `/api/age-review/requests/${c2.id}/evidence`, adult, { kind: "selfie", mime: "image/png", data: PNG })).json?.code === "CODE_EXPIRED");
const nc = await http("POST", `/api/age-review/requests/${c2.id}/new-code`, adult);
check("new-code issues a fresh code", nc.status === 200 && new Date(nc.json.request.codeExpiresAt).getTime() > Date.now());

// expiry sweep
await http("POST", `/api/age-review/requests/${c2.id}/evidence`, adult, { kind: "document", mime: "image/png", data: PNG });
await q(`update age_review_requests set expires_at = now() - interval '1 minute' where id = $1`, [c2.id]);
const sw = await sweepExpiredAgeReviews();
const after = await q(`select status from age_review_requests where id = $1`, [c2.id]);
check("expiry sweep expires and deletes in one transaction", sw.expired >= 1 && after[0].status === "expired" && (await q(`select 1 from age_review_evidence where request_id = $1`, [c2.id])).length === 0);

// pause
await setAgeReviewPaused({ on: true, adminId: adult, reason: "test" });
const pausedRes = await http("POST", "/api/age-review/requests", adult, { method: "live", ...consent });
check("paused: create refused AGE_REVIEW_PAUSED", pausedRes.status === 503 && pausedRes.json.code === "AGE_REVIEW_PAUSED");
await setAgeReviewPaused({ on: false, adminId: adult, reason: "test" });

// me states
await q(`insert into age_review_requests (user_id, method, status, decided_at, decline_reason) values ($1, 'live', 'declined', now() - interval '2 hours', 'unreadable')`, [adult]);
const cool = await http("GET", "/api/age-review/me", adult);
check("me state per case: cooldown after a fresh decline", cool.json.state === "cooldown" && !!cool.json.retryAfter && cool.json.request.declineReason === "unreadable");
await q(`update age_review_requests set decided_at = now() - interval '3 days' where user_id = $1 and status = 'declined'`, [adult]);
check("me state per case: declined once the gap passed", (await http("GET", "/api/age-review/me", adult)).json.state === "declined");
await q(`update users set age_verified_at = now(), age_verified_method = 'admin_upload' where id = $1`, [adult]);
const ver = await http("GET", "/api/age-review/me", adult);
check("me state per case: verified", ver.json.state === "verified" && ver.json.verified.method === "admin_upload");

// race: an upload fired together with a cancel must never leave evidence on the cancelled request
{
  const racer = await mk("arv_racer", yearsAgo(28));
  const rr = (await http("POST", "/api/age-review/requests", racer, { method: "upload", documentType: "passport", ...consent })).json.request;
  const results = await Promise.all([
    http("POST", `/api/age-review/requests/${rr.id}/evidence`, racer, { kind: "document", mime: "image/png", data: PNG }),
    http("POST", `/api/age-review/requests/${rr.id}/cancel`, racer),
    http("POST", `/api/age-review/requests/${rr.id}/evidence`, racer, { kind: "selfie", mime: "image/png", data: PNG }),
  ]);
  const st = (await q(`select status from age_review_requests where id = $1`, [rr.id]))[0].status;
  const left = (await q(`select 1 from age_review_evidence where request_id = $1`, [rr.id])).length;
  check("upload racing cancel never leaves evidence on a cancelled request", st === "cancelled" && left === 0 && results.every((r) => [200, 409].includes(r.status)), `${st} ${left}`);
}

// account deletion purge
const doomed = await mk("arv_doomed", yearsAgo(40));
const d = (await http("POST", "/api/age-review/requests", doomed, { method: "upload", documentType: "passport", ...consent })).json.request;
await http("POST", `/api/age-review/requests/${d.id}/evidence`, doomed, { kind: "document", mime: "image/png", data: PNG });
await storage.softDeleteUser(doomed);
check("account deletion purges evidence", (await q(`select 1 from age_review_evidence where request_id = $1`, [d.id])).length === 0 && (await q(`select 1 from age_review_requests where user_id = $1`, [doomed])).length === 0);
await purgeUserAgeReview(doomed);

await q(`delete from users where username like $1`, [`arv_%${stamp}`]);
server.close();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
