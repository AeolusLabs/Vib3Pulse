// Age review guardrail controls and the logger structure test (no database):  npx tsx scripts/test-age-review-unit-controls.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";

delete process.env.AGE_REVIEW;
const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { setPause, emergencyPurge, STALE_EVIDENCE_WHERE } = await import("../server/identity/ageReviewControls");
const { runSweepWith } = await import("../server/identity/ageReviewSweep");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const codeOf = async (p: Promise<unknown>) => { try { await p; return "none"; } catch (e: any) { return e.code as string; } };

async function withApp<T>(role: string, fn: (call: (m: string, p: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<T>): Promise<T> {
  process.env.AGE_REVIEW = "1";
  (storage as any).getAdminUser = async (id: string) => ({ id, role, email: "r@x.test", isActive: true });
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { adminId: "a1", mfaVerified: true, destroy: () => {} }; next(); });
  registerAgeReviewAdminRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/age-reviews`;
  try {
    return await fn(async (m, p, body) => {
      const res = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json: any = null; try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, json };
    });
  } finally { server.close(); delete process.env.AGE_REVIEW; }
}

await test("pause: admin or super can pause, only super resumes, creates refused while paused, decisions still allowed", async () => {
  assert.equal(await codeOf(setPause({ id: "a", role: "admin" }, { on: false, reason: "all clear" })), "NOT_ALLOWED");
  assert.equal(await codeOf(setPause({ id: "a", role: "age_reviewer" }, { on: false, reason: "all clear" })), "NOT_ALLOWED");
  await withApp("age_reviewer", async (call) => {
    assert.equal((await call("POST", "/pause", { on: true, reason: "incident" })).status, 403, "age_reviewer cannot pause");
  });
  await withApp("admin", async (call) => {
    assert.equal((await call("POST", "/pause", { on: true, reason: "x" })).status, 400, "reason is 3..300");
    const resume = await call("POST", "/pause", { on: false, reason: "all clear" });
    assert.equal(resume.status, 403); assert.equal(resume.json.code, "NOT_ALLOWED");
  });
  const svc = src("server/identity/ageReviewService.ts");
  for (const fn of ["createRequest", "putEvidence", "newCode"]) {
    const body = svc.slice(svc.indexOf(`export async function ${fn}`));
    assert.ok(body.slice(0, body.indexOf("\nexport async function", 10) > 0 ? body.indexOf("\nexport async function", 10) : undefined).includes("ageReviewPaused()"), fn);
  }
  assert.ok(src("server/identity/ageReviewLive.ts").slice(src("server/identity/ageReviewLive.ts").indexOf("export async function inviteLiveCheck")).includes("ageReviewPaused()"));
  assert.ok(!src("server/identity/ageReviewAdmin.ts").includes("ageReviewPaused"), "decisions are not paused");
  assert.ok(!svc.slice(svc.indexOf("export async function cancelRequest"), svc.indexOf("export async function newCode")).includes("ageReviewPaused"), "cancel is not paused");
});

await test("emergency purge deletes all evidence in one transaction, super_admin only, reason required", async () => {
  assert.equal(await codeOf(emergencyPurge({ id: "a", role: "admin" }, "incident")), "NOT_ALLOWED");
  await withApp("admin", async (call) => { assert.equal((await call("POST", "/emergency-purge", { reason: "incident" })).status, 403); });
  await withApp("super_admin", async (call) => {
    assert.equal((await call("POST", "/emergency-purge", {})).status, 400);
    assert.equal((await call("POST", "/emergency-purge", { reason: "ab" })).status, 400);
  });
  const s = src("server/identity/ageReviewControls.ts");
  const fn = s.slice(s.indexOf("export async function emergencyPurge"));
  const order = ['client.query("begin")', "delete from age_review_evidence returning request_id", "update age_review_requests set status", 'client.query("commit")'].map((x) => fn.indexOf(x));
  assert.ok(order.every((i) => i >= 0) && order.join() === [...order].sort((a, b) => a - b).join(), "delete and status move in one transaction");
  assert.ok(!/more_requests/.test(fn), "not counted as a more round");
  assert.ok(/deleted=\$\{deleted\}/.test(fn), "audit carries the count only");
  assert.ok(/notifyAgeReview\(id, "update"\)/.test(fn));
});

await test("health counts and stale evidence invariant (structure + roles)", async () => {
  const s = src("server/identity/ageReviewControls.ts");
  assert.ok(STALE_EVIDENCE_WHERE.includes("'approved', 'declined', 'expired', 'cancelled', 'closed_minor'") && STALE_EVIDENCE_WHERE.includes("interval '7 days'"));
  for (const key of ["pendingEvidence", "staleEvidence", "oldestEvidenceAgeHours", "lastSweepAt", "revealsToday", "paused"]) assert.ok(s.includes(key), key);
  assert.ok(/action = 'age_review\.reveal'/.test(s));
  await withApp("age_reviewer", async (call) => { assert.equal((await call("GET", "/health")).status, 403); });
  await withApp("user_support", async (call) => { assert.equal((await call("GET", "/health")).status, 403); });
});

await test("sweep alerts when evidence outlives its request", async () => {
  const lines: string[] = [];
  const orig = console.error; console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    await runSweepWith({ sweep: async () => ({ expired: 0, userIds: [], evidenceDeleted: 3, staleFound: 3 }), notify: async () => {}, closeRooms: async () => {} });
    await runSweepWith({ sweep: async () => ({ expired: 0, userIds: [], evidenceDeleted: 0, staleFound: 0 }), notify: async () => {}, closeRooms: async () => {} });
  } finally { console.error = orig; }
  assert.deepEqual(lines, ["[AGE-REVIEW] ALERT age review evidence outlived its request: 3"]);
  assert.ok(/staleFound/.test(src("server/identity/ageReviewSweep.ts").slice(src("server/identity/ageReviewSweep.ts").indexOf("export async function sweepExpiredAgeReviews"))));
});

await test("raw row redaction", async () => {
  const app = express();
  app.use(redactSensitiveFields);
  const raw = { id: "r1", code: "ABC234", status: "approved", document_fingerprint: "f".repeat(64), documentFingerprint: "f".repeat(64), bytes_enc: Buffer.from("x"), bytesEnc: "x", nested: { items: [{ documentFingerprint: "g", bytesEnc: "y", kind: "document" }] } };
  app.get("/raw", (_req, res) => { res.json(raw); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/raw`);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { id: "r1", code: "ABC234", status: "approved", nested: { items: [{ kind: "document" }] } });
    assert.ok(!/ingerprint|bytes/.test(text));
  } finally { server.close(); }
});

await test("flag off: all of these 404", async () => {
  delete process.env.AGE_REVIEW;
  const app = express();
  app.use(express.json());
  registerAgeReviewAdminRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/age-reviews`;
  try {
    for (const [m, p] of [["GET", "/health"], ["POST", "/pause"], ["POST", "/emergency-purge"]] as const) {
      const res = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, p);
    }
  } finally { server.close(); }
});

// ----------------------------------------------------------------------------------------------------------------
// Logger structure test: no log line, error message, audit string or JSON response may be built from evidence content.
const SENSITIVE = /\b(bytes|bytesEnc|bytes_enc|buf|plain|plaintext|decrypted|base64|b64|documentNumber|document_number|document_?[fF]ingerprint|fingerprint|idBirthdate|data|enc)\b/;
// Each entry: "<file>|<exact call text>" -> why it is safe.
const ALLOW: Record<string, string> = {
  "server/routes/age-review-routes.ts|res.json(await putEvidence(uid(req), idParam(req), b))": "returns only { kind, received: true }; `b` is the upload body but never reaches the output",
  "server/routes/age-review-routes.ts|res.json(await getMe(uid(req)))": "the owner's own state; no evidence fields exist in it",
};
function sinks(text: string): string[] {
  const out: string[] = [];
  const re = /(console\.(?:log|error|warn|info|debug)|\bres\.json|\.json|new AgeReviewError|logAdminActivity|\baudit|\bauditReveal)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    while (i < text.length && depth > 0) { const ch = text[i++]; if (ch === "(") depth++; else if (ch === ")") depth--; }
    out.push(text.slice(m.index, i));
  }
  return out;
}

await test("logger structure test", () => {
  const files = [
    ...readdirSync(join(root, "server/identity")).filter((f) => /^ageReview.*\.ts$|^evidenceCrypto\.ts$/.test(f)).map((f) => `server/identity/${f}`),
    ...readdirSync(join(root, "server/routes")).filter((f) => /^age-review.*\.ts$/.test(f)).map((f) => `server/routes/${f}`),
  ];
  assert.ok(files.length >= 10, `scanned ${files.length} files`);
  const hits: string[] = [];
  for (const f of files) {
    for (const call of sinks(src(f))) {
      const flat = call.replace(/\s+/g, " ");
      // Strip string literals' words ("... data ...") and comments before looking for identifiers.
      const code = flat.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`[^`$]*`/g, "``").replace(/\/\/.*$/g, "");
      if (SENSITIVE.test(code) && !ALLOW[`${f}|${flat}`]) hits.push(`${f}: ${flat.slice(0, 160)}`);
    }
  }
  assert.deepEqual(hits, [], "unlisted sinks reference evidence-like identifiers");
  // Every allow-list entry must still exist (a stale entry would hide a future leak).
  for (const key of Object.keys(ALLOW)) {
    const [f, call] = key.split("|");
    assert.ok(sinks(src(f)).some((c) => c.replace(/\s+/g, " ") === call), `stale allow-list entry: ${key}`);
  }
  // The detail endpoint lists metadata and a size, never content.
  assert.ok(!src("server/identity/ageReviewAdmin.ts").includes("decryptEvidence"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
