// No-DB unit tests for the age review user screens (pure helpers + source checks). Run: npx tsx scripts/test-age-review-unit-ui.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COPY, ERROR_CODES, PRIVACY, cardView, consentRequired, continueEnabled, documentTypeLabel, errorMessage, fitWithin, formatCode,
  minutesLeft, whatHappens, whoSees, cardMode, cancelOffered, startLiveRequest, openRequest, DOCUMENT_TYPES, type AgeReviewMe, type AgeReviewState,
} from "../client/src/lib/ageReview";

let passed = 0, failed = 0;
const pending: Promise<void>[] = [];
const test = (name: string, fn: () => void | Promise<void>) => {
  const ok = () => { passed++; console.log(`PASS ${name}`); };
  const bad = (e: any) => { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); };
  try { const r = fn(); if (r) pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NOW = new Date("2026-10-25T12:00:00Z");
const me = (state: AgeReviewState, extra: Partial<AgeReviewMe> = {}): AgeReviewMe => ({
  enabled: true, paused: false, consentVersion: "2026-10-v1", state, verified: null, request: null, retryAfter: null, attemptsLeft: 3, ...extra,
});
const BAD = /[—–]|--|\bcash\b/i;

test("cardView covers every state", () => {
  const states: AgeReviewState[] = ["none", "in_review", "needs_more", "verified", "declined", "cooldown", "not_offered"];
  for (const s of states) {
    const v = cardView(me(s, { verified: s === "verified" ? { method: "admin_upload", at: "2026-10-20T10:00:00Z" } : null, retryAfter: "2026-10-26T12:00:00Z" }), NOW);
    assert.ok(v.title && v.body && v.tone, s);
  }
  assert.equal(cardView(me("none"), NOW).action?.id, "start");
  assert.equal(cardView(me("needs_more"), NOW).action?.id, "continue");
  assert.equal(cardView(me("in_review"), NOW).action, null);
  assert.equal(cardView(me("verified"), NOW).tone, "success");
  assert.match(cardView(me("cooldown", { retryAfter: "2026-10-25T17:00:00Z" }), NOW).body, /about 5 hours/);
  assert.equal(cardView(me("none", { paused: true }), NOW).action, null);
  assert.equal(cardView(me("declined", { attemptsLeft: 0 }), NOW).action, null);
});

test("errorMessage covers every contract error code", () => {
  const generic = errorMessage("NOPE");
  for (const c of ERROR_CODES) {
    const m = errorMessage(c);
    assert.ok(m.length > 10, c);
    if (["CONSENT_REQUIRED", "BAD_FILE", "TOO_LARGE", "CODE_EXPIRED", "AGE_REVIEW_PAUSED", "OPEN_REQUEST_EXISTS"].includes(c)) assert.notEqual(m, generic, c);
  }
  assert.equal(ERROR_CODES.length, 19);
  assert.match(errorMessage("ALREADY_VERIFIED"), /^You are already verified\. To receive money, choose 'Start your Name and Age review'.$/);
  assert.match(errorMessage("RATE_LIMITED", { retryAfter: "2026-10-25T14:00:00Z", now: NOW }), /about 2 hours/);
  assert.equal(errorMessage(undefined), generic);
});

test("fitWithin keeps aspect ratio and never upsizes", () => {
  assert.deepEqual(fitWithin(4000, 3000), { w: 1600, h: 1200 });
  assert.deepEqual(fitWithin(3000, 4000), { w: 1200, h: 1600 });
  assert.deepEqual(fitWithin(800, 600), { w: 800, h: 600 });
  assert.deepEqual(fitWithin(1600, 1600), { w: 1600, h: 1600 });
  assert.deepEqual(fitWithin(0, 10), { w: 0, h: 0 });
  const r = fitWithin(5000, 1000);
  assert.ok(Math.abs(r.w / r.h - 5) < 0.05);
});

test("consent gating blocks Continue until ticked", () => {
  assert.equal(continueEnabled(false), false);
  assert.equal(continueEnabled(true), true);
  assert.equal(continueEnabled(true, true), false);
  assert.equal(consentRequired(me("none"), null), true);
  assert.equal(consentRequired(me("none"), "2026-09-v0"), true);
  assert.equal(consentRequired(me("none"), "2026-10-v1"), false);
});

test("copy has no dashes or the word cash", () => {
  const all = [
    JSON.stringify(COPY), JSON.stringify(PRIVACY), whatHappens("upload"), whatHappens("live"),
    ...ERROR_CODES.map((c) => errorMessage(c)),
    ...DOCUMENT_TYPES.map(documentTypeLabel),
    ...(["none", "in_review", "needs_more", "verified", "declined", "cooldown", "not_offered"] as AgeReviewState[]).flatMap((s) => {
      const v = cardView(me(s, { paused: s === "none", verified: s === "verified" ? { method: "admin_live", at: "2026-10-20T10:00:00Z" } : null, retryAfter: "2026-10-25T17:00:00Z" }), NOW);
      return [v.title, v.body, v.action?.label ?? ""];
    }),
  ];
  for (const t of all) assert.ok(!BAD.test(t), t.slice(0, 60));
  const components = readdirSync(join(root, "client/src/components/age-review")).filter((f) => f.endsWith(".tsx"));
  for (const f of components) {
    const src = readFileSync(join(root, "client/src/components/age-review", f), "utf8");
    assert.ok(!/[—–]/.test(src), `${f} has an em or en dash`);
    assert.ok(!/\bcash\b/i.test(src), `${f} says cash`);
  }
});

test("privacy copy matches the spec wording", () => {
  assert.equal(PRIVACY.title, "Before your Name and Age review");
  assert.equal(PRIVACY.tick, "I understand how my information is used");
  assert.match(whatHappens("upload"), /7 days/);
  assert.match(whatHappens("live"), /Nothing is recorded or saved/);
  assert.equal(PRIVACY.askHref, "mailto:info@aeoluslabsltd.com");
  assert.equal(PRIVACY.policyHref, "/privacy");
});

const reqOf = (o: Partial<NonNullable<AgeReviewMe["request"]>>): NonNullable<AgeReviewMe["request"]> => ({
  id: "r1", method: "upload", status: "draft", documentType: null, canCancel: true, needsMore: false, hasDocument: false, hasSelfie: false,
  code: null, codeExpiresAt: null, liveInviteExpiresAt: null, submittedAt: null, declineReason: null, consentedAt: null, ...o,
});

test("What we keep is honest: record of the decision, one-way code, no old sentence", () => {
  const k = PRIVACY.keep.p;
  assert.ok(k.startsWith("We keep a record of the decision:"));
  assert.match(k, /one-way code/);
  assert.match(k, /A reviewer may also write a short note about the decision \(up to 300 characters\), which is kept in our staff audit log\./);
  assert.match(k, /without our secret key/);
  assert.match(k, /Notifications and emails about the result do not contain your documents\.$/);
  assert.ok(!/never/i.test(k));
  assert.ok(!k.includes("Never your photos, the name on the document or the document number"));
  assert.ok(!BAD.test(k));
  assert.equal(PRIVACY.who.p, "Only Vib3Pulse staff who review ages (administrators, super administrators and age reviewers). Your images are encrypted in our database and are opened one at a time, with every viewing logged.");
  assert.equal(PRIVACY.whoLive, "A reviewer sees you on a private call. Nothing is recorded or saved.");
  assert.equal(whoSees("live"), PRIVACY.whoLive);
  assert.equal(whoSees("upload"), PRIVACY.who.p);
  assert.match(whatHappens("upload"), /after the final decision, or after 7 days from when you started, whichever comes first\. If a second approval is needed, they are kept until that is decided, within the 7 days\./);
  assert.ok(!/as soon as a decision is made/.test(JSON.stringify(COPY) + whatHappens("upload")));
  assert.match(COPY.choiceUploadHint, /after the final decision/);
  assert.match(cardView(me("in_review", { request: reqOf({ status: "in_review" }) }), NOW).body, /cancel at any time before the final decision/);
});

test("live create then submit", async () => {
  const calls: string[] = [];
  await startLiveRequest({
    create: async (v) => { calls.push(`create:${v.method}:${v.consentVersion}`); return { request: { id: "abc" } }; },
    submit: async (id) => { calls.push(`submit:${id}`); },
  }, "2026-10-v1");
  assert.deepEqual(calls, ["create:live:2026-10-v1", "submit:abc"]);
  const seen: string[] = [];
  await assert.rejects(startLiveRequest({ create: async () => { throw new Error("x"); }, submit: async () => { seen.push("submit"); } }, "v"));
  assert.deepEqual(seen, []);
});

test("card with state none and a draft shows the resume flow, never the choice buttons", () => {
  assert.equal(cardMode(me("none")), "choose");
  assert.equal(cardMode(me("none", { request: reqOf({ status: "draft", method: "upload" }) })), "resume_upload");
  assert.equal(cardMode(me("none", { request: reqOf({ status: "draft", method: "live" }) })), "live");
  assert.equal(cardMode(me("in_review", { request: reqOf({ status: "in_review", method: "live" }) })), "live");
  assert.equal(cardMode(me("in_review", { request: reqOf({ status: "submitted" }) })), "waiting");
  assert.equal(cardMode(me("needs_more", { request: reqOf({ status: "needs_more", needsMore: true }) })), "resume_upload");
  for (const status of ["draft", "submitted", "in_review", "needs_more", "pending_second_approval"]) {
    for (const method of ["upload", "live"] as const) {
      assert.notEqual(cardMode(me("none", { request: reqOf({ status, method }) })), "choose", `${status}/${method}`);
    }
  }
  assert.equal(cardMode(me("declined", { request: reqOf({ status: "declined" }) })), "choose");
  assert.equal(openRequest(me("verified", { request: reqOf({ status: "approved" }) })), null);
});

test("cancel offered when canCancel", () => {
  for (const status of ["draft", "needs_more", "submitted", "in_review", "pending_second_approval"]) assert.equal(cancelOffered(me("none", { request: reqOf({ status }) })), true, status);
  assert.equal(cancelOffered(me("none", { request: reqOf({ status: "draft", canCancel: false }) })), false);
  assert.equal(cancelOffered(me("none")), false);
  assert.equal(cancelOffered(me("declined", { request: reqOf({ status: "declined" }) })), false);
});

test("payload not retained", () => {
  const hook = readFileSync(join(root, "client/src/hooks/useAgeReview.ts"), "utf8");
  assert.ok(!/uploadEvidence:\s*useMutation/.test(hook));
  assert.ok(!/useMutation\(\{[^}]*\.data/s.test(hook));
  const flow = readFileSync(join(root, "client/src/components/age-review/UploadFlow.tsx"), "utf8");
  assert.ok(!/uploadEvidence\.mutate/.test(flow));
  const card = readFileSync(join(root, "client/src/components/age-review/VerifyAgeCard.tsx"), "utf8");
  assert.ok(!/\.variables/.test(card));
});

test("formatCode groups six characters", () => {
  assert.equal(formatCode("K7M29P"), "K7 M2 9P");
  assert.equal(formatCode("k7 m2 9p"), "K7 M2 9P");
  assert.equal(formatCode(null), "");
});

test("minutesLeft clamps at zero", () => {
  assert.equal(minutesLeft("2026-10-25T12:30:00Z", NOW), 30);
  assert.equal(minutesLeft("2026-10-25T12:00:30Z", NOW), 1);
  assert.equal(minutesLeft("2026-10-25T11:00:00Z", NOW), 0);
  assert.equal(minutesLeft(null, NOW), 0);
  assert.equal(minutesLeft("garbage", NOW), 0);
});

test("no code path logs image data", () => {
  const dirs = ["client/src/components/age-review", "client/src/hooks", "client/src/lib"];
  const files = [
    ...readdirSync(join(root, dirs[0])).map((f) => join(dirs[0], f)),
    "client/src/hooks/useAgeReview.ts", "client/src/lib/ageReview.ts", "client/src/lib/ageReviewImage.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    assert.ok(!/console\.\w+\(/.test(src), `${f} logs`);
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(src), `${f} stores data`);
  }
  const img = readFileSync(join(root, "client/src/lib/ageReviewImage.ts"), "utf8");
  assert.ok(/revokeObjectURL/.test(img) || /revokeObjectURL/.test(readFileSync(join(root, "client/src/components/age-review/UploadFlow.tsx"), "utf8")));
  assert.ok(/image\/jpeg/.test(img) && /0\.85/.test(img) && /fitWithin/.test(img));
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
