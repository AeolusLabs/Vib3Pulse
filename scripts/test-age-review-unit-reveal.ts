// Age review evidence reveal (no database):  npx tsx scripts/test-age-review-unit-reveal.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import express from "express";

process.env.AGE_EVIDENCE_KEY = crypto.randomBytes(32).toString("base64");
delete process.env.AGE_REVIEW;
const { storage } = await import("../server/storage");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { issueRevealToken, consumeRevealToken, evidenceHeaders, sendEvidence, revealLimitReached, revealTestHooks } = await import("../server/identity/ageReviewReveal");
const { encryptEvidence } = await import("../server/identity/evidenceCrypto");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const claims = { adminId: "a1", requestId: "r1", evidenceId: "e1" };
const code = (fn: () => void) => { try { fn(); return "none"; } catch (e: any) { return e.code as string; } };

await test("reveal token is single use", () => {
  revealTestHooks.clear();
  const t = issueRevealToken(claims);
  assert.equal(code(() => consumeRevealToken(t, claims)), "none");
  assert.equal(code(() => consumeRevealToken(t, claims)), "TOKEN_INVALID");
  const t2 = issueRevealToken(claims);
  assert.notEqual(t, t2);
});

await test("reveal token expires at 60 s", () => {
  const t0 = 1_000_000_000_000;
  const t = issueRevealToken(claims, t0);
  assert.equal(code(() => consumeRevealToken(t, claims, t0 + 60_000)), "TOKEN_INVALID");
  const t2 = issueRevealToken(claims, t0);
  assert.equal(code(() => consumeRevealToken(t2, claims, t0 + 59_999)), "none");
});

await test("reveal token for another admin or another evidence id is refused (and not burned)", () => {
  const t = issueRevealToken(claims);
  assert.equal(code(() => consumeRevealToken(t, { ...claims, adminId: "a2" })), "TOKEN_INVALID");
  assert.equal(code(() => consumeRevealToken(t, { ...claims, evidenceId: "e2" })), "TOKEN_INVALID");
  assert.equal(code(() => consumeRevealToken(t, { ...claims, requestId: "r2" })), "TOKEN_INVALID");
  assert.equal(code(() => consumeRevealToken(t, claims)), "none", "a refused attempt does not burn the owner's token");
  const forged = issueRevealToken(claims).split(".")[0] + ".AAAA";
  assert.equal(code(() => consumeRevealToken(forged, claims)), "TOKEN_INVALID");
  for (const junk of [undefined, null, "", "x", "a.b.c", 42, "x".repeat(2000)]) assert.equal(code(() => consumeRevealToken(junk, claims)), "TOKEN_INVALID");
  // A token signed under a different key is refused.
  const t3 = issueRevealToken(claims);
  const keep = process.env.AGE_EVIDENCE_KEY;
  process.env.AGE_EVIDENCE_KEY = crypto.randomBytes(32).toString("base64");
  try { assert.equal(code(() => consumeRevealToken(t3, claims)), "TOKEN_INVALID"); } finally { process.env.AGE_EVIDENCE_KEY = keep; }
});

await test("GET without a token never returns the image", async () => {
  process.env.AGE_REVIEW = "1";
  (storage as any).getAdminUser = async (id: string) => ({ id, role: "age_reviewer", email: "r@x.test", isActive: true });
  const app = express();
  app.use((req: any, _res, next) => { req.session = { adminId: "a1", mfaVerified: true, destroy: () => {} }; next(); });
  registerAgeReviewAdminRoutes(app);
  const server = app.listen(0);
  const id = "11111111-1111-1111-1111-111111111111", ev = "22222222-2222-2222-2222-222222222222";
  try {
    for (const q of ["", "?token=", "?token=garbage", "?token=a.b"]) {
      const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/admin/age-reviews/${id}/evidence/${ev}${q}`);
      assert.equal(res.status, 403, q);
      assert.equal((await res.json()).code, "TOKEN_INVALID");
      assert.ok(!(res.headers.get("content-type") ?? "").startsWith("image/"));
    }
  } finally { server.close(); delete process.env.AGE_REVIEW; }
});

function fakeRes() {
  const r: any = { code: 200, headers: {} as Record<string, string>, body: undefined as unknown, ended: undefined as Buffer | undefined };
  r.status = (c: number) => { r.code = c; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  r.removeHeader = (k: string) => { delete r.headers[k.toLowerCase()]; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.end = (b?: Buffer) => { r.ended = b; return r; };
  return r;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

await test("evidence response headers (no-store, nosniff, sandbox, forced image type, no etag)", () => {
  const res = fakeRes();
  res.setHeader("ETag", "W/\"x\"");
  sendEvidence(res, { id: "e", request_id: "r", kind: "document", mime: "image/png", bytes_enc: encryptEvidence(PNG, "r:document") });
  assert.equal(res.code, 200);
  assert.deepEqual(res.ended, PNG);
  const h = res.headers;
  assert.equal(h["content-type"], "image/png"); assert.equal(h["cache-control"], "no-store"); assert.equal(h["pragma"], "no-cache");
  assert.equal(h["x-content-type-options"], "nosniff"); assert.equal(h["content-disposition"], 'inline; filename="evidence"');
  assert.equal(h["content-security-policy"], "sandbox"); assert.equal(h["cross-origin-resource-policy"], "same-origin");
  assert.ok(!("etag" in h) && !("last-modified" in h));
  for (const bad of ["text/html", "image/svg+xml", "application/pdf", "image/gif", ""]) assert.equal(evidenceHeaders(bad), null, bad);
  const refused = fakeRes();
  sendEvidence(refused, { id: "e", request_id: "r", kind: "document", mime: "text/html", bytes_enc: encryptEvidence(PNG, "r:document") });
  assert.equal(refused.code, 500); assert.equal(refused.ended, undefined);
});

await test("decrypt failure fails closed", () => {
  const wrongRow = fakeRes();
  sendEvidence(wrongRow, { id: "e", request_id: "r", kind: "selfie", mime: "image/png", bytes_enc: encryptEvidence(PNG, "r:document") });
  assert.equal(wrongRow.code, 500); assert.deepEqual(wrongRow.body, { message: "Evidence unavailable", code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(wrongRow.ended, undefined); assert.deepEqual(wrongRow.headers, {});
  const tampered = encryptEvidence(PNG, "r:document"); tampered[tampered.length - 1] ^= 1;
  const t = fakeRes();
  const orig = console.error; console.error = () => {};
  try { sendEvidence(t, { id: "e", request_id: "r", kind: "document", mime: "image/png", bytes_enc: tampered }); } finally { console.error = orig; }
  assert.equal(t.code, 500); assert.equal(t.ended, undefined);
});

await test("missing evidence row after a cancel race is a clean 404 (structure)", () => {
  const r = src("server/routes/age-review-admin-routes.ts");
  assert.equal((r.match(/new AgeReviewError\(404, "WRONG_STATE", "That photo is no longer available\."\)/g) ?? []).length, 2, "both reveal and fetch");
});

await test("reveal limit 60 per hour per reviewer and ALERT", () => {
  assert.equal(revealLimitReached(59), false); assert.equal(revealLimitReached(60), true);
  const r = src("server/routes/age-review-admin-routes.ts");
  assert.ok(/ALERT reveal limit reached/.test(r) && /age_review\.reveal_limit/.test(r) && /"REVEAL_LIMIT"/.test(r));
  assert.ok(/interval '1 hour'/.test(r), "counted from the audit log, so it holds across processes");
});

await test("every reveal is audited without content (structure)", () => {
  const r = src("server/routes/age-review-admin-routes.ts");
  const i = r.indexOf('await auditReveal(req, "age_review.reveal"');
  assert.ok(i > 0 && i < r.indexOf("issueRevealToken({"), "audit row first, then the token");
  const details = [...r.matchAll(/auditReveal\(req, "[^"]+", requestId, `([^`]*)`/g)].map((m) => m[1]);
  assert.equal(details.length, 2);
  for (const d of details) assert.ok(!/bytes|plain|decrypt|token|data|mime|documentNumber|fingerprint/i.test(d), d);
});

await test("flag off: reveal routes 404", async () => {
  delete process.env.AGE_REVIEW;
  const app = express();
  app.use(express.json());
  registerAgeReviewAdminRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/age-reviews`;
  const id = "11111111-1111-1111-1111-111111111111", ev = "22222222-2222-2222-2222-222222222222";
  try {
    for (const [m, p] of [["POST", `/${id}/evidence/${ev}/reveal`], ["GET", `/${id}/evidence/${ev}?token=x`]] as const) {
      const res = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, p);
    }
  } finally { server.close(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
