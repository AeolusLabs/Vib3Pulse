// Age review reviewer side, parts that need no database:  npx tsx scripts/test-age-review-unit-admin.ts
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";

delete process.env.AGE_REVIEW;
const { storage } = await import("../server/storage");
const { adminGate, mfaRequiredFor } = await import("../server/services/adminSecurity");
const { registerAgeReviewAdminRoutes, decideSchema } = await import("../server/routes/age-review-admin-routes");
const { isInviteLive, ageCheckRoomName } = await import("../server/identity/ageReviewLive");
const { FakeVoice } = await import("../server/rooms/voice/fakeVoice");
const { LIVE_INVITE_TTL_MS, LIVE_ROOM_MAX_MS, LIVE_ROOM_MAX_PARTICIPANTS } = await import("../shared/ageReview");

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = (p: string) => readFileSync(join(root, p), "utf8");

let role = "age_reviewer";
(storage as any).getAdminUser = async (id: string) => ({ id, role, isActive: true });
async function run(gate: any) {
  const req: any = { session: { adminId: "a1", mfaVerified: true, destroy: () => {} } };
  let status = 200, nexted = false;
  const res: any = { status(c: number) { status = c; return res; }, json() { return res; } };
  await gate(req, res, () => { nexted = true; });
  return nexted ? 200 : status;
}

await test("queue and detail: role matrix (user_support, content_moderator, finance_manager get 403; admin, age_reviewer, super_admin allowed)", async () => {
  const gate = adminGate({ roles: ["super_admin", "admin", "age_reviewer"] });
  for (const r of ["user_support", "content_moderator", "finance_manager", "event_reviewer", "analytics_viewer"]) { role = r; assert.equal(await run(gate), 403, r); }
  for (const r of ["admin", "age_reviewer", "super_admin"]) { role = r; assert.equal(await run(gate), 200, r); }
  const s = src("server/routes/age-review-admin-routes.ts");
  assert.ok(/const REVIEWERS = \["super_admin", "admin", "age_reviewer"\] as const;/.test(s));
  assert.equal((s.match(/requireRole\(\.\.\.REVIEWERS\)/g) ?? []).length, 5);
  assert.ok(/second-approve`, requireRole\("super_admin"\)/.test(s));
});

await test("flag off: every admin route 404", async () => {
  const app = express();
  app.use(express.json());
  registerAgeReviewAdminRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/age-reviews`;
  const id = "00000000-0000-0000-0000-000000000000";
  try {
    const routes: [string, string][] = [["GET", ""], ["GET", `/${id}`], ["POST", `/${id}/decide`], ["POST", `/${id}/second-approve`], ["POST", `/${id}/invite-live`], ["POST", `/${id}/live-join`], ["GET", "/health"]];
    for (const [m, p] of routes) {
      const res = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, `${m} ${p}`);
      assert.deepEqual(await res.json(), { message: "Not found" });
    }
  } finally { server.close(); }
});

await test("detail never contains evidence bytes (structure)", () => {
  const s = src("server/identity/ageReviewAdmin.ts");
  assert.ok(!/decryptEvidence/.test(s) && !/select[^`]*\bbytes_enc\b[^`]*from age_review_evidence/.test(s.replace(/octet_length\(bytes_enc\)/g, "")));
  assert.ok(/select id, kind, mime, greatest\(octet_length\(bytes_enc\) - 31, 0\) as bytes from age_review_evidence/.test(s));
});

await test("decide body validation: outcome list, checklist keys, override reason 3..300", () => {
  assert.equal(decideSchema.safeParse({ outcome: "verify" }).success, true);
  assert.equal(decideSchema.safeParse({ outcome: "delete_everything" }).success, false);
  assert.equal(decideSchema.safeParse({ outcome: "verify", overrideDuplicate: { reason: "x" } }).success, false);
  assert.equal(decideSchema.safeParse({ outcome: "verify", overrideDuplicate: { reason: "same person new account" } }).success, true);
  assert.equal(decideSchema.safeParse({ outcome: "decline", declineReason: "because" }).success, false);
});

await test("live invite 15 min, live join only while valid, 2 participant cap, no recording config", async () => {
  assert.equal(LIVE_INVITE_TTL_MS, 15 * 60_000); assert.equal(LIVE_ROOM_MAX_MS, 20 * 60_000); assert.equal(LIVE_ROOM_MAX_PARTICIPANTS, 2);
  const now = new Date();
  const live = (ms: number, status = "in_review") => ({ live_invite_expires_at: new Date(now.getTime() + ms), status });
  assert.equal(isInviteLive(live(60_000), now), true);
  assert.equal(isInviteLive(live(-1), now), false);
  assert.equal(isInviteLive({ live_invite_expires_at: null, status: "in_review" }, now), false);
  assert.equal(isInviteLive(live(60_000, "approved"), now), false);
  const v = new FakeVoice();
  await v.ensureAgeCheckRoom(ageCheckRoomName("req1"));
  await v.mintAgeCheckToken({ roomName: ageCheckRoomName("req1"), identity: "reviewer:a1", name: "Age reviewer" });
  await v.mintAgeCheckToken({ roomName: ageCheckRoomName("req1"), identity: "user:u1", name: "U" });
  assert.deepEqual(v.calls.map((c) => [c.op, c.roomId, c.userId ?? null]), [["ensureAgeCheckRoom", "agecheck-req1", null], ["mintAgeCheck", "agecheck-req1", "reviewer:a1"], ["mintAgeCheck", "agecheck-req1", "user:u1"]]);
  assert.equal(v.calls[0].maxParticipants, 2); assert.equal(v.calls[0].egress, false);
  assert.equal(v.calls[1].ttlSeconds, 1200); assert.deepEqual(v.calls[1].sources, ["microphone", "camera"]);
  const lk = src("server/rooms/voice/livekitVoice.ts");
  const a = lk.slice(lk.indexOf("async mintAgeCheckToken"), lk.indexOf("async removeParticipant"));
  assert.ok(/maxParticipants: 2/.test(a) && /canPublishSources: MIC_AND_CAMERA/.test(a) && /canPublishData: false/.test(a) && /AGE_CHECK_TTL_SECONDS/.test(lk));
  const live2 = src("server/identity/ageReviewLive.ts") + a;
  assert.ok(!/egress|record|composite|startTrack/i.test(live2.replace(/no egress, recording or composite call/i, "").replace(/never recorded/i, "")), "no recording or egress anywhere");
  assert.ok(/scheduleClose/.test(src("server/identity/ageReviewLive.ts")) && /closeStaleAgeCheckRooms/.test(src("server/identity/ageReviewSweep.ts")));
});

await test("override requires reason and the new roles; revoke clears verification (structure)", () => {
  const s = src("server/admin-routes.ts");
  const o = s.slice(s.indexOf('app.post("/api/admin/users/:id/age-verification"'), s.indexOf('app.post("/api/admin/users/:id/age-verification/revoke"'));
  assert.ok(/requireRole\("super_admin", "admin", "age_reviewer"\)/.test(o) && !/user_support/.test(o) && /REASON_REQUIRED/.test(o));
  const r = s.slice(s.indexOf('app.post("/api/admin/users/:id/age-verification/revoke"'), s.indexOf("PAID ROOMS FINANCE"));
  assert.ok(/requireRole\("super_admin", "admin", "age_reviewer"\)/.test(r) && /REASON_REQUIRED/.test(r) && /age_review\.revoke/.test(r) && /setAgeVerification\(user\.id, \{ verified: false \}\)/.test(r));
  assert.ok(/ageReviewEnabled\(\)\) return res\.status\(404\)/.test(r));
});

await test("age_reviewer and admin need MFA when the flag is on", () => {
  const on = { AGE_REVIEW: "1" } as NodeJS.ProcessEnv, off = {} as NodeJS.ProcessEnv;
  for (const r of ["admin", "age_reviewer"]) { assert.equal(mfaRequiredFor(r, on), true, r); assert.equal(mfaRequiredFor(r, off), false, r); }
  for (const r of ["content_moderator", "user_support", "finance_manager"]) assert.equal(mfaRequiredFor(r, on), false, r);
  assert.equal(mfaRequiredFor("super_admin", off), false);
  assert.equal(mfaRequiredFor("super_admin", { ADMIN_MFA_REQUIRED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(mfaRequiredFor("super_admin", on), false, "super_admin rule unchanged");
  assert.ok(/mfaRequiredFor\(admin\.role\) && !opts\.allowPendingMfa/.test(src("server/services/adminSecurity.ts")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
