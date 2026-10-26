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
  assert.ok(/if \(timer\) return;/.test(s), "the clean-up sweep runs whether or not the flag is on (notices are the flagged part)");
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

await test("upload racing cancel never leaves evidence on a cancelled request (structure)", () => {
  const s = src("server/identity/ageReviewService.ts");
  const fn = s.slice(s.indexOf("export async function putEvidence"), s.indexOf("export async function submitRequest"));
  const tx = fn.slice(fn.indexOf("await inTx("));
  const lock = tx.indexOf("loadOwned(userId, id, c, true)");
  assert.ok(lock >= 0 && lock < tx.indexOf("insert into age_review_evidence"), "lock the request row, then insert");
  assert.ok(/WRONG_STATE/.test(tx.slice(0, tx.indexOf("insert into"))), "status re-checked under the lock");
  assert.ok(/for update/.test(s.slice(s.indexOf("async function loadOwned"), s.indexOf("async function kindsOf"))));
});

await test("sweep: a failing room close never skips the expiry notices, and runs after them", async () => {
  const { runSweepWith } = await import("../server/identity/ageReviewSweep");
  const log: string[] = [];
  const origErr = console.error; console.error = () => {};
  process.env.AGE_REVIEW = "1"; // notices and room closing only happen while the feature is on
  try {
    await runSweepWith({
      sweep: async () => ({ expired: 2, userIds: ["u1", "u2"], evidenceDeleted: 3 }),
      notify: async (id) => { log.push("notify:" + id); },
      closeRooms: async () => { log.push("close"); throw new Error("livekit down"); },
    });
    assert.deepEqual(log, ["notify:u1", "notify:u2", "close"]);
    log.length = 0;
    await runSweepWith({ sweep: async () => { throw new Error("db"); }, notify: async () => { log.push("n"); }, closeRooms: async () => { log.push("close"); } });
    assert.deepEqual(log, ["close"], "housekeeping still runs when the sweep itself failed");
  } finally { console.error = origErr; delete process.env.AGE_REVIEW; }
});

await test("notices: neutral push, escaped email, no relative link, purge before soft delete (structure)", () => {
  const n = src("server/identity/ageReviewNotify.ts");
  assert.ok(n.includes('push: { title: "Vib3Pulse", body: "Your age review has an update" }'));
  assert.ok(n.includes("link: base ? base + link : undefined"));
  const e = src("server/emailService.ts");
  const em = e.slice(e.indexOf("export async function sendAgeReviewEmail"), e.indexOf("export async function sendSocialPlansNoticeEmail"));
  assert.ok(em.includes("esc(userName)") && em.includes("${esc(body)}") && em.includes("link ? "));
  const st = src("server/storage.ts");
  const fn = st.slice(st.indexOf("async softDeleteUser"), st.indexOf("async softDeleteUser") + 700);
  assert.ok(fn.indexOf("purgeUserAgeReview") > 0 && fn.indexOf("purgeUserAgeReview") < fn.indexOf("db.update(users)"));
  assert.ok(src("server/notifications.ts").includes("push?.title ?? params.title"));
});

await test("decide and second-approve lock the row and recheck the status inside the transaction (structure)", () => {
  const a = src("server/identity/ageReviewAdmin.ts");
  assert.equal((a.match(/loadLocked\(c, id, true\)/g) ?? []).length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
