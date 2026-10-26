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
const { issueRevealToken, consumeRevealToken, evidenceHeaders, sendEvidence, revealLimitReached, claimReveal, setNonceStoreForTests } = await import("../server/identity/ageReviewReveal");
const { encryptEvidence } = await import("../server/identity/evidenceCrypto");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const claims = { adminId: "a1", requestId: "r1", evidenceId: "e1" };
// The database store is replaced by one that behaves like "insert ... on conflict do nothing returning nonce".
let taken = new Set<string>();
setNonceStoreForTests({ claim: async (n) => { if (taken.has(n)) return false; taken.add(n); return true; } });
const code = async (fn: () => Promise<void>) => { try { await fn(); return "none"; } catch (e: any) { return e.code as string; } };

await test("reveal token is single use (and a restart does not reset it: the claim is in the database)", async () => {
  taken = new Set();
  const t = issueRevealToken(claims);
  assert.equal(await code(() => consumeRevealToken(t, claims)), "none");
  assert.equal(await code(() => consumeRevealToken(t, claims)), "TOKEN_INVALID");
  const t2 = issueRevealToken(claims);
  assert.notEqual(t, t2);
});

await test("reveal token expires at 60 s", async () => {
  const t0 = 1_000_000_000_000;
  const t = issueRevealToken(claims, t0);
  assert.equal(await code(() => consumeRevealToken(t, claims, t0 + 60_000)), "TOKEN_INVALID");
  const t2 = issueRevealToken(claims, t0);
  assert.equal(await code(() => consumeRevealToken(t2, claims, t0 + 59_999)), "none");
});

await test("reveal token for another admin or another evidence id is refused (and not burned)", async () => {
  const t = issueRevealToken(claims);
  assert.equal(await code(() => consumeRevealToken(t, { ...claims, adminId: "a2" })), "TOKEN_INVALID");
  assert.equal(await code(() => consumeRevealToken(t, { ...claims, evidenceId: "e2" })), "TOKEN_INVALID");
  assert.equal(await code(() => consumeRevealToken(t, { ...claims, requestId: "r2" })), "TOKEN_INVALID");
  assert.equal(await code(() => consumeRevealToken(t, claims)), "none", "a refused attempt does not burn the owner's token");
  const forged = issueRevealToken(claims).split(".")[0] + ".AAAA";
  assert.equal(await code(() => consumeRevealToken(forged, claims)), "TOKEN_INVALID");
  for (const junk of [undefined, null, "", "x", "a.b.c", 42, "x".repeat(2000)]) assert.equal(await code(() => consumeRevealToken(junk, claims)), "TOKEN_INVALID");
  // A token signed under a different key is refused.
  const t3 = issueRevealToken(claims);
  const keep = process.env.AGE_EVIDENCE_KEY;
  process.env.AGE_EVIDENCE_KEY = crypto.randomBytes(32).toString("base64");
  try { assert.equal(await code(() => consumeRevealToken(t3, claims)), "TOKEN_INVALID"); } finally { process.env.AGE_EVIDENCE_KEY = keep; }
});

await test("GET without a token never returns the image", async () => {
  process.env.AGE_REVIEW = "1";
  (storage as any).getAdminUser = async (id: string) => ({ id, role: "age_reviewer", email: "r@x.test", isActive: true });
  const app = express();
  app.use((req: any, _res, next) => { req.session = { adminId: "a1", mfaVerified: true, mfaPassed: true, destroy: () => {} }; next(); });
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
  assert.ok(/interval '1 hour'/.test(src("server/identity/ageReviewReveal.ts")), "counted from the audit log, so it holds across processes");
  assert.ok(r.includes('.catch(() => console.error("[AGE-REVIEW] ALERT the reveal limit audit row could not be written"))'), "a failed limit audit is shouted, not swallowed");
});

await test("every reveal is audited without content (structure)", () => {
  const r = src("server/routes/age-review-admin-routes.ts");
  const i = r.indexOf("await claimReveal(pool");
  assert.ok(i > 0 && i < r.indexOf("issueRevealToken({"), "audit row first, then the token");
  const rv = src("server/identity/ageReviewReveal.ts");
  const details = [...rv.matchAll(/const details = `([^`]*)`/g), ...[...r.matchAll(/auditReveal\(req, "[^"]+", requestId, `([^`]*)`/g)]].map((m) => m[1]);
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

await test("reveal limit is atomic: lock, count, insert, commit in one transaction; at 60 nothing is inserted", async () => {
  const run = async (count: number) => {
    const log: string[] = [];
    const client = {
      release: () => log.push("release"),
      query: async (q: string) => {
        log.push(q.trim().split(/\s+/).slice(0, 3).join(" "));
        return { rows: q.includes("count(*)") ? [{ n: count }] : [] };
      },
    };
    const ok = await claimReveal({ connect: async () => client }, { adminId: "a1", requestId: "r1", kind: "document" });
    return { ok, log };
  };
  const fine = await run(59);
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.log, ["begin", "select pg_advisory_xact_lock(hashtext($1))", "select count(*)::int as", "insert into admin_activity_logs", "commit", "release"]);
  const full = await run(60);
  assert.equal(full.ok, false);
  assert.ok(!full.log.some((l) => l.startsWith("insert")) && full.log.includes("rollback") && full.log.at(-1) === "release");
  assert.ok(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(src("server/identity/ageReviewReveal.ts")) && src("server/identity/ageReviewReveal.ts").includes("age-review-reveal:${a.adminId}"));
});

await test("nonce claim is a database insert; expired nonces are swept; migration v3 matches its file", async () => {
  const r = src("server/identity/ageReviewReveal.ts");
  assert.ok(r.includes("insert into age_review_reveal_nonces (nonce, expires_at) values ($1, $2) on conflict do nothing returning nonce"));
  assert.ok(!/new Map|new Set/.test(r), "no in-memory used-nonce state is left");
  assert.ok(src("server/identity/ageReviewSweep.ts").includes("delete from age_review_reveal_nonces where expires_at < now()"));
  const { AGE_REVIEW_V3_SCHEMA_SQL } = await import("../server/identity/ageReviewMigrationV3");
  const file = src("migrations/add_age_review_v3.sql").replace(/\r\n/g, "\n");
  assert.equal(file.slice(file.indexOf("BEGIN;") + 6, file.lastIndexOf("COMMIT;")).trim(), AGE_REVIEW_V3_SCHEMA_SQL.trim());
  assert.ok(src("server/storage.ts").includes("AGE_REVIEW_V3_SCHEMA_SQL"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
