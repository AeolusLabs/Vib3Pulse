// Age review user side, parts that need no database:  npx tsx scripts/test-age-review-unit-user.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";

delete process.env.AGE_REVIEW;
const { registerAgeReviewRoutes } = await import("../server/routes/age-review-routes");
const { logsBody, NO_BODY_LOG_PREFIXES } = await import("../server/identity/ageReviewLogPolicy");
const { toRequestDto } = await import("../server/identity/ageReviewService");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");

await test("flag off: every route 404", async () => {
  const app = express();
  app.use(express.json());
  registerAgeReviewRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const id = "00000000-0000-0000-0000-000000000000";
    const routes: [string, string][] = [
      ["GET", "/me"], ["POST", "/requests"], ["POST", `/requests/${id}/evidence`], ["POST", `/requests/${id}/submit`],
      ["POST", `/requests/${id}/cancel`], ["POST", `/requests/${id}/new-code`], ["POST", `/requests/${id}/live-join`],
    ];
    for (const [m, p] of routes) {
      const res = await fetch(base + "/api/age-review" + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, `${m} ${p}`);
      assert.deepEqual(await res.json(), { message: "Not found" });
    }
  } finally { server.close(); }
});

await test("no age-review body appears in logs (structure test)", () => {
  assert.deepEqual([...NO_BODY_LOG_PREFIXES], ["/api/age-review", "/api/admin/age-reviews"]);
  assert.equal(logsBody("/api/age-review/me"), false);
  assert.equal(logsBody("/api/age-review/requests/abc/evidence"), false);
  assert.equal(logsBody("/api/admin/age-reviews/abc"), false);
  assert.equal(logsBody("/api/users/me"), true);
  assert.ok(/capturedJsonResponse && logsBody\(path\)/.test(src("server/index.ts")), "request logger must use logsBody");
  // Any console call in these files may only carry fixed text, the error class name or a fixed kind label.
  for (const f of ["server/routes/age-review-routes.ts", "server/identity/ageReviewService.ts", "server/identity/ageReviewSweep.ts", "server/identity/ageReviewNotify.ts"]) {
    for (const m of src(f).matchAll(/console\.\w+\(([^;]*)\);/g)) {
      assert.ok(!/req\.body|\.message|\bdata\b|\bbuf\b|\.code\b|\benc\b|\bb64\b/.test(m[1]), `${f}: ${m[0]}`);
    }
  }
});

await test("evidence is never returned to the user", () => {
  const dto = toRequestDto({
    id: "i", user_id: "u", method: "upload", status: "submitted", document_type: "passport", code: "ABC234", code_expires_at: new Date(),
    decline_reason: null, live_invite_expires_at: null, consented_at: new Date(), submitted_at: new Date(), decided_at: null, created_at: new Date(), expires_at: new Date(),
  }, ["document", "selfie"]);
  assert.deepEqual(Object.keys(dto).sort(), ["canCancel", "code", "codeExpiresAt", "consentedAt", "declineReason", "documentType", "hasDocument", "hasSelfie", "id", "liveInviteExpiresAt", "method", "needsMore", "status", "submittedAt"]);
  assert.equal(dto.hasDocument && dto.hasSelfie, true);
  // The user service never selects the encrypted bytes at all.
  assert.ok(!/COLS[^`]*bytes_enc|select\s+(\w+,\s*)*bytes_enc/i.test(src("server/identity/ageReviewService.ts")), "bytes_enc only appears in the insert");
  assert.ok(!/decryptEvidence/.test(src("server/identity/ageReviewService.ts")));
});

await test("expiry sweep expires and deletes in one transaction (structure)", () => {
  const s = src("server/identity/ageReviewSweep.ts");
  const fn = s.slice(s.indexOf("export async function sweepExpiredAgeReviews"), s.indexOf("async function runSweep"));
  const order = ["client.query(\"begin\")", "update age_review_requests set status = 'expired'", "delete from age_review_evidence", "client.query(\"commit\")"].map((x) => fn.indexOf(x));
  assert.ok(order.every((i) => i >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), "begin, update, delete, commit in order on one client");
  assert.ok(/rollback/.test(fn));
  assert.ok(/if \(!ageReviewEnabled\(\) \|\| timer\) return;/.test(s), "sweep starts only when the flag is on");
});

await test("account deletion purges evidence (structure)", () => {
  assert.ok(/purgeUserAgeReview\(userId\)/.test(src("server/storage.ts")), "softDeleteUser calls the purge");
  assert.ok(/delete from age_review_requests where user_id/.test(src("server/identity/ageReviewSweep.ts")));
  assert.ok(/user_id varchar NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(src("server/identity/ageReviewMigration.ts")), "hard delete cascades");
  assert.ok(/request_id uuid NOT NULL REFERENCES age_review_requests\(id\) ON DELETE CASCADE/.test(src("server/identity/ageReviewMigration.ts")));
});

await test("cancel deletes evidence atomically (structure)", () => {
  const s = src("server/identity/ageReviewService.ts");
  const fn = s.slice(s.indexOf("export async function cancelRequest"), s.indexOf("export async function newCode"));
  assert.ok(/inTx\(/.test(fn) && fn.indexOf("delete from age_review_evidence") < fn.indexOf("status = 'cancelled'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
