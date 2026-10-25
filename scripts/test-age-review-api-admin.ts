// Age review reviewer API (throwaway database; written, run by the orchestrator):
//   DATABASE_URL=<scratch db> SESSION_SECRET=x AGE_REVIEW=1 AGE_EVIDENCE_KEY=<base64 32 bytes> npx tsx scripts/test-age-review-api-admin.ts
// Refuses to run unless the database name contains "test", because it creates users and admins.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.AGE_REVIEW = "1";
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.AGE_EVIDENCE_KEY ||= Buffer.alloc(32, 9).toString("base64");

const { storage, ensureSchema } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { setVoiceServiceForTests } = await import("../server/rooms/voice/voiceService");
const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
const { encryptEvidence } = await import("../server/identity/evidenceCrypto");
const { CHECKLIST_KEYS } = await import("../shared/ageReview");
await ensureSchema();
const fake = new FakeVoice();
setVoiceServiceForTests(fake);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req: any, _res, next) => {
  const a = req.header("x-test-admin");
  req.session = a ? { adminId: a, mfaVerified: true, destroy: (cb: any) => cb?.() } : { destroy: (cb: any) => cb?.() };
  next();
});
app.use(redactSensitiveFields);
registerAgeReviewAdminRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function http(method: string, path: string, admin: string | null, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(admin ? { "x-test-admin": admin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number, extraDays = 2) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - extraDays); return d.toISOString().slice(0, 10); };
const mkUser = async (name: string, dob: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth) values ($1,$2,'social',$3,true,true,$4) returning id`,
  [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, dob]))[0].id as string;
const mkAdmin = async (name: string, role: string, email?: string) => (await q(
  `insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A',$4) returning id`,
  [`${name}${stamp}`, email ?? `${name}${stamp}@t.dev`, hash, role]))[0].id as string;
const mkReq = async (userId: string, dob: string, o: { method?: string; status?: string; docType?: string } = {}) => {
  const id = (await q(
    `insert into age_review_requests (user_id, method, status, document_type, registered_dob_snapshot, consent_version, consented_at, submitted_at, code, code_expires_at)
     values ($1,$2,$3,$4,$5,'2026-10-v1',now(),now(),'ABC234', now() + interval '10 minutes') returning id`,
    [userId, o.method ?? "upload", o.status ?? "submitted", o.docType ?? "passport", dob]))[0].id as string;
  for (const kind of ["document", "selfie"]) {
    await q(`insert into age_review_evidence (request_id, kind, mime, bytes_enc) values ($1,$2,'image/png',$3)`, [id, kind, encryptEvidence(Buffer.from("png-bytes-" + kind), `${id}:${kind}`)]);
  }
  return id;
};
const full = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true]));
const evCount = async (id: string) => (await q(`select count(*)::int n from age_review_evidence where request_id = $1`, [id]))[0].n as number;

const rev = await mkAdmin("arv_rev", "age_reviewer");
const adm = await mkAdmin("arv_adm", "admin");
const sup1 = await mkAdmin("arv_sup1", "super_admin");
const sup2 = await mkAdmin("arv_sup2", "super_admin");
const support = await mkAdmin("arv_support", "user_support");
const fin = await mkAdmin("arv_fin", "finance_manager");
const mod = await mkAdmin("arv_mod", "content_moderator");

const dob = yearsAgo(30);
const u1 = await mkUser("arvu1", dob);
const r1 = await mkReq(u1, dob);

for (const [who, id] of [["user_support", support], ["content_moderator", mod], ["finance_manager", fin]] as const) {
  check(`role matrix: ${who} gets 403 on the queue and detail`, (await http("GET", "/api/admin/age-reviews", id)).status === 403 && (await http("GET", `/api/admin/age-reviews/${r1}`, id)).status === 403);
}
for (const [who, id] of [["admin", adm], ["age_reviewer", rev], ["super_admin", sup1]] as const) {
  check(`role matrix: ${who} allowed on the queue`, (await http("GET", "/api/admin/age-reviews", id)).status === 200);
}
const q1 = await http("GET", "/api/admin/age-reviews?limit=1", rev);
check("queue oldest first, keyset cursor, no registered birthdate", q1.json.items.length === 1 && !JSON.stringify(q1.json).includes(dob));

const det = await http("GET", `/api/admin/age-reviews/${r1}`, rev);
check("detail: opening moves submitted to in_review, lists evidence without bytes", det.json.request.status === "in_review" && det.json.evidence.length === 2 && !JSON.stringify(det.json).match(/bytes_enc|bytesEnc|cG5n/) && det.json.request.registeredDob === dob && det.json.canDecide === true);

check("verify needs a full checklist", (await http("POST", `/api/admin/age-reviews/${r1}/decide`, rev, { outcome: "verify", checklist: { ...full, noEditing: false }, idBirthdate: dob, documentNumber: "P1234567" })).json?.code === "CHECKLIST_INCOMPLETE");
check("verify refuses a birthdate mismatch", (await http("POST", `/api/admin/age-reviews/${r1}/decide`, rev, { outcome: "verify", checklist: full, idBirthdate: yearsAgo(31), documentNumber: "P1234567" })).json?.code === "BIRTHDATE_MISMATCH");
const ok = await http("POST", `/api/admin/age-reviews/${r1}/decide`, rev, { outcome: "verify", checklist: full, idBirthdate: dob, documentNumber: "P1234567" });
const row1 = (await q(`select status, outcome, dob_match, document_fingerprint from age_review_requests where id = $1`, [r1]))[0];
const user1 = (await q(`select age_verified_at, age_verified_method from users where id = $1`, [u1]))[0];
check("verify approves, sets admin_upload, deletes evidence, stores only a fingerprint", ok.status === 200 && row1.status === "approved" && row1.dob_match === true && /^[0-9a-f]{64}$/.test(row1.document_fingerprint) && user1.age_verified_method === "admin_upload" && (await evCount(r1)) === 0);
check("decisions audited without birthdates or numbers", (await q(`select details from admin_activity_logs where target_id = $1 and action = 'age_review.decide'`, [r1])).every((r: any) => !/P1234567|\d{4}-\d{2}-\d{2}/.test(r.details)));
check("a decided request cannot be decided again", (await http("POST", `/api/admin/age-reviews/${r1}/decide`, rev, { outcome: "decline", declineReason: "other" })).json?.code === "WRONG_STATE");

const u2 = await mkUser("arvu2", dob);
const r2 = await mkReq(u2, dob);
const dup = await http("POST", `/api/admin/age-reviews/${r2}/decide`, rev, { outcome: "verify", checklist: full, idBirthdate: dob, documentNumber: "p-1234 567" });
check("same document on a second account is refused", dup.json?.code === "DUPLICATE_DOCUMENT");
check("override needs super_admin", (await http("POST", `/api/admin/age-reviews/${r2}/decide`, rev, { outcome: "verify", checklist: full, idBirthdate: dob, documentNumber: "P1234567", overrideDuplicate: { reason: "same person, new account" } })).json?.code === "NOT_ALLOWED");
check("super_admin override with a reason verifies", (await http("POST", `/api/admin/age-reviews/${r2}/decide`, sup1, { outcome: "verify", checklist: full, idBirthdate: dob, documentNumber: "P1234567", overrideDuplicate: { reason: "same person, new account" } })).status === 200);

const u3 = await mkUser("arvu3", dob);
const r3 = await mkReq(u3, dob);
await q(`update users set age_verified_at = now(), age_verified_method = 'admin' where id = $1`, [u3]);
const teenDob = yearsAgo(15);
check("teen correction moves the account and clears verification", (await http("POST", `/api/admin/age-reviews/${r3}/decide`, rev, { outcome: "teen_correction", idBirthdate: teenDob })).status === 200
  && (await q(`select date_of_birth::text d, age_verified_at from users where id = $1`, [u3]))[0].age_verified_at === null
  && (await q(`select date_of_birth::text d from users where id = $1`, [u3]))[0].d.slice(0, 10) === teenDob && (await evCount(r3)) === 0);

const u4 = await mkUser("arvu4", dob);
const r4 = await mkReq(u4, dob);
const newDob = yearsAgo(33);
const bc = await http("POST", `/api/admin/age-reviews/${r4}/decide`, rev, { outcome: "birthdate_change", checklist: full, documentNumber: "BC" + stamp, idBirthdate: newDob });
check("birthdate change waits, nothing changes, evidence kept", bc.status === 200 && (await q(`select status from age_review_requests where id = $1`, [r4]))[0].status === "pending_second_approval" && (await evCount(r4)) === 2 && (await q(`select date_of_birth::text d from users where id = $1`, [u4]))[0].d.slice(0, 10) === dob);
check("second approve: not super_admin refused", (await http("POST", `/api/admin/age-reviews/${r4}/second-approve`, rev, { approve: true, reason: "ok" })).status === 403);
await q(`update age_review_requests set reviewer_id = $2 where id = $1`, [r4, sup1]);
check("second approver must differ", (await http("POST", `/api/admin/age-reviews/${r4}/second-approve`, sup1, { approve: true, reason: "looks right" })).json?.code === "SECOND_APPROVER_MUST_DIFFER");
check("approve applies the correction then verifies", (await http("POST", `/api/admin/age-reviews/${r4}/second-approve`, sup2, { approve: true, reason: "looks right" })).status === 200
  && (await q(`select date_of_birth::text d, age_verified_at from users where id = $1`, [u4]))[0].d.slice(0, 10) === newDob && (await q(`select age_verified_at from users where id = $1`, [u4]))[0].age_verified_at !== null && (await evCount(r4)) === 0);

const u5 = await mkUser("arvu5", dob);
const r5 = await mkReq(u5, dob);
await http("POST", `/api/admin/age-reviews/${r5}/decide`, rev, { outcome: "birthdate_change", checklist: full, documentNumber: "BC" + stamp, idBirthdate: newDob });
await q(`update age_review_requests set reviewer_id = $2 where id = $1`, [r5, sup1]);
check("reject leaves the account unchanged", (await http("POST", `/api/admin/age-reviews/${r5}/second-approve`, sup2, { approve: false, reason: "not convincing" })).status === 200
  && (await q(`select date_of_birth::text d from users where id = $1`, [u5]))[0].d.slice(0, 10) === dob && (await q(`select status from age_review_requests where id = $1`, [r5]))[0].status === "declined");

const u6 = await mkUser("arvu6", dob);
const r6 = await mkReq(u6, dob);
await http("POST", `/api/admin/age-reviews/${r6}/decide`, rev, { outcome: "needs_more" });
await q(`update age_review_requests set status = 'submitted' where id = $1`, [r6]);
await http("POST", `/api/admin/age-reviews/${r6}/decide`, rev, { outcome: "needs_more" });
await q(`update age_review_requests set status = 'submitted' where id = $1`, [r6]);
check("needs_more max 2", (await http("POST", `/api/admin/age-reviews/${r6}/decide`, rev, { outcome: "needs_more" })).json?.code === "WRONG_STATE");
check("decline requires a reason code", (await http("POST", `/api/admin/age-reviews/${r6}/decide`, rev, { outcome: "decline" })).json?.code === "REASON_REQUIRED");
check("decline deletes evidence", (await http("POST", `/api/admin/age-reviews/${r6}/decide`, rev, { outcome: "decline", declineReason: "unreadable" })).status === 200 && (await evCount(r6)) === 0);

const selfAdmin = await mkAdmin("arv_self", "age_reviewer", `arvu7${stamp}@t.dev`);
const u7 = await mkUser("arvu7", dob);
const r7 = await mkReq(u7, dob);
check("self review refused", (await http("POST", `/api/admin/age-reviews/${r7}/decide`, selfAdmin, { outcome: "decline", declineReason: "other" })).json?.code === "SELF_REVIEW");

const u8 = await mkUser("arvu8", dob);
const r8 = await mkReq(u8, dob, { method: "live" });
const inv = await http("POST", `/api/admin/age-reviews/${r8}/invite-live`, rev);
check("live invite is about 15 minutes", inv.status === 200 && Math.abs(new Date(inv.json.expiresAt).getTime() - Date.now() - 15 * 60_000) < 5000);
const rj = await http("POST", `/api/admin/age-reviews/${r8}/live-join`, rev);
check("reviewer live join mints a token for agecheck-<id>", rj.status === 200 && rj.json.roomName === `agecheck-${r8}` && fake.calls.some((c) => c.op === "ensureAgeCheckRoom" && c.maxParticipants === 2));
await q(`update age_review_requests set live_invite_expires_at = now() - interval '1 minute' where id = $1`, [r8]);
check("live join only while the invite is valid", (await http("POST", `/api/admin/age-reviews/${r8}/live-join`, rev)).json?.code === "WRONG_STATE");

await q(`delete from users where username like $1`, [`arvu%${stamp}`]);
server.close();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
