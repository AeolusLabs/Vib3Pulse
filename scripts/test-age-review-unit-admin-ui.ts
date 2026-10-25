// No-DB unit tests for the age reviewer screens (pure helpers + source checks). Run: npx tsx scripts/test-age-review-unit-admin-ui.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_ERROR_CODES, AGE_REVIEW_PATH, CHECKLIST_KEYS, CHECKLIST_LABEL, CONFIRM_TEXT, OUTCOME_HELP, OUTCOME_LABEL, REBLUR_MS, STALE_TEXT, STATUS_META,
  adminErrorMessage, ageText, canOverrideDuplicate, canPurge, canSetPause, decisionBody, decisionReady, emptyChecklist, navAllowed, pauseDisabledReason,
  purgeReady, registeredAge, startReblur, statusMeta, watermarkText, type DecisionForm,
} from "../client/src/lib/adminAgeReviewUi";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dir = "client/src/components/admin/age-review";
const files = [...readdirSync(join(root, dir)).map((f) => `${dir}/${f}`), "client/src/pages/admin/AdminAgeReviews.tsx", "client/src/lib/adminAgeReviewApi.ts", "client/src/lib/adminAgeReviewUi.ts"];

const form = (o: Partial<DecisionForm> = {}): DecisionForm => ({ outcome: "verify", checklist: emptyChecklist(), idBirthdate: "2000-05-01", documentNumber: "A1234567", declineReason: "", note: "", overrideReason: "", ...o });
const allTicked = () => Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true])) as DecisionForm["checklist"];

test("status labels have a non-colour cue", () => {
  for (const [s, m] of Object.entries(STATUS_META)) { assert.ok(m.label.length > 3, s); assert.ok(m.icon, s); }
  for (const s of ["draft", "submitted", "in_review", "needs_more", "pending_second_approval", "approved", "declined", "expired", "cancelled", "closed_minor"]) assert.ok(STATUS_META[s], s);
  assert.ok(statusMeta("weird_status").label.length > 0);
  const chip = read(`${dir}/StatusChip.tsx`);
  assert.ok(/\{m\.label\}/.test(chip) && /<Icon/.test(chip));
});

test("role visibility: age_reviewer sees only the age reviews page", () => {
  assert.equal(navAllowed("age_reviewer", AGE_REVIEW_PATH, ["super_admin", "admin", "age_reviewer"]), true);
  assert.equal(navAllowed("age_reviewer", "/admin/dashboard", ["super_admin", "age_reviewer"]), false);
  assert.equal(navAllowed("age_reviewer", "/admin/settings", ["super_admin", "admin"]), false);
  assert.equal(navAllowed("user_support", AGE_REVIEW_PATH, ["super_admin", "admin", "age_reviewer"]), false);
  assert.equal(navAllowed("admin", AGE_REVIEW_PATH, ["super_admin", "admin", "age_reviewer"]), true);
  const layout = read("client/src/pages/admin/AdminLayout.tsx");
  const withRole = layout.split("\n").filter((l) => /roles:\s*\[/.test(l) && l.includes("age_reviewer"));
  assert.equal(withRole.length, 1);
  assert.ok(/label: "Age reviews"[\s\S]{0,200}roles: \["super_admin", "admin", "age_reviewer"\]/.test(layout));
  assert.ok(/age_reviewer: "Age reviewer"/.test(layout));
  const staff = read("client/src/pages/admin/AdminStaff.tsx");
  assert.ok(/value="age_reviewer"/.test(staff) && /age_reviewer: "Age reviewer"/.test(staff));
});

test("verify disabled until all six checks are ticked", () => {
  assert.equal(decisionReady(form()), false);
  for (const k of CHECKLIST_KEYS) {
    const c = allTicked(); c[k] = false;
    assert.equal(decisionReady(form({ checklist: c })), false, k);
  }
  assert.equal(decisionReady(form({ checklist: allTicked() })), true);
  assert.equal(decisionReady(form({ checklist: allTicked(), documentNumber: "" })), false);
  assert.equal(decisionReady(form({ checklist: allTicked(), idBirthdate: "2000-13-40" })), false);
  assert.equal(decisionReady(form({ outcome: "decline" })), false);
  assert.equal(decisionReady(form({ outcome: "decline", declineReason: "unreadable" })), true);
  assert.equal(decisionReady(form({ outcome: "teen_correction", idBirthdate: "" })), false);
  assert.equal(decisionReady(form({ outcome: null })), false);
  const body = decisionBody(form({ checklist: allTicked() }), { overrideAllowed: false });
  assert.equal(body.documentNumber, "A1234567");
  assert.ok(!("overrideDuplicate" in body));
  assert.deepEqual(decisionBody(form({ checklist: allTicked(), overrideReason: "same person, two accounts" }), { overrideAllowed: true }).overrideDuplicate, { reason: "same person, two accounts" });
  assert.ok(!("overrideDuplicate" in decisionBody(form({ checklist: allTicked(), overrideReason: "same person" }), { overrideAllowed: false })));
  assert.equal(canOverrideDuplicate("admin"), false);
  assert.equal(canOverrideDuplicate("super_admin"), true);
  for (const o of ["teen_correction", "birthdate_change"] as const) assert.ok(CONFIRM_TEXT[o]);
  for (const o of Object.keys(OUTCOME_LABEL)) assert.ok(OUTCOME_HELP[o as keyof typeof OUTCOME_HELP]);
  assert.equal(Object.keys(CHECKLIST_LABEL).length, 6);
});

test("errorMessage covers every contract error code", () => {
  const generic = adminErrorMessage("NOPE");
  const contract = ["CONSENT_REQUIRED", "AGE_REVIEW_PAUSED", "OPEN_REQUEST_EXISTS", "RATE_LIMITED", "NOT_OFFERED", "BAD_FILE", "TOO_LARGE", "EVIDENCE_INCOMPLETE", "WRONG_STATE", "CODE_EXPIRED", "NOT_ALLOWED", "SECOND_APPROVER_MUST_DIFFER", "SELF_REVIEW", "CHECKLIST_INCOMPLETE", "DUPLICATE_DOCUMENT", "REVEAL_LIMIT", "TOKEN_INVALID", "REASON_REQUIRED"];
  for (const c of contract) assert.ok((ADMIN_ERROR_CODES as readonly string[]).includes(c), c);
  for (const c of [...ADMIN_ERROR_CODES, "BIRTHDATE_MISMATCH", "EVIDENCE_UNAVAILABLE"]) assert.notEqual(adminErrorMessage(c), generic, c);
  assert.match(adminErrorMessage("WRONG_STATE"), /cancelled or it expired/);
  assert.equal(adminErrorMessage(undefined), generic);
});

test("watermark text", () => {
  const t = watermarkText("maya", "0f3a9c1e-1111-4222-8333-944455556666", new Date("2026-10-25T14:03:09Z"));
  assert.equal(t, "maya · 0f3a9c1e · 14:03:09 UTC");
  assert.ok(!/[—–]/.test(t));
  assert.match(read(`${dir}/EvidenceTile.tsx`), /watermarkText\(reviewer, requestId\)/);
});

test("re-blur timer drops the image source", () => {
  let fire: (() => void) | null = null, cleared = false, delay = -1;
  let dropped = 0;
  const h = startReblur(() => { dropped++; }, REBLUR_MS, { set: (fn, ms) => { fire = fn; delay = ms; return 1; }, clear: () => { cleared = true; } });
  assert.equal(delay, 30_000);
  assert.equal(dropped, 0);
  fire!();
  assert.equal(dropped, 1);
  h.cancel();
  assert.equal(cleared, true);
  const tile = read(`${dir}/EvidenceTile.tsx`);
  assert.match(tile, /startReblur\(\(\) => \{ drop\(\);/);
  assert.match(tile, /URL\.revokeObjectURL/);
  assert.match(tile, /setSrc\(null\)/);
});

test("resume/pause permissions by role", () => {
  assert.equal(canSetPause("admin", true), true);
  assert.equal(canSetPause("super_admin", true), true);
  assert.equal(canSetPause("age_reviewer", true), false);
  assert.equal(canSetPause("admin", false), false);
  assert.equal(canSetPause("super_admin", false), true);
  assert.equal(pauseDisabledReason("admin", false), "Only a super admin can switch age checks back on.");
  assert.equal(pauseDisabledReason("super_admin", false), null);
  assert.equal(canPurge("super_admin"), true);
  assert.equal(canPurge("admin"), false);
  const strip = read(`${dir}/HealthStrip.tsx`);
  assert.match(strip, /canPurge\(role\) &&/);
  assert.match(strip, /disabled=\{!canSetPause\(role, next\)\}/);
});

test("emergency purge needs the typed word and a reason", () => {
  assert.equal(purgeReady("PURGE", "storage incident"), true);
  assert.equal(purgeReady("purge", "storage incident"), false);
  assert.equal(purgeReady("PURGE", "  "), false);
  assert.equal(purgeReady("PURGE", "ab"), false);
  assert.equal(purgeReady("", "storage incident"), false);
  assert.match(read(`${dir}/HealthStrip.tsx`), /disabled=\{!purgeReady\(typed, reason\)/);
});

test("stale evidence shows the red warning text", () => {
  assert.equal(STALE_TEXT, "Evidence older than its request: investigate");
  assert.match(read(`${dir}/HealthStrip.tsx`), /\{STALE_TEXT\}/);
  assert.equal(ageText(null), "None held");
  assert.equal(ageText(72), "3 days");
  assert.equal(registeredAge("2000-05-01", new Date("2026-10-25T00:00:00Z")), 26);
  assert.equal(registeredAge("nope"), null);
});

test("document number is cleared after submit (source check)", () => {
  const f = read(`${dir}/DecisionForm.tsx`);
  assert.match(f, /finally \{[^}]*set\(\{ documentNumber: "" \}\)/s);
  assert.match(f, /autoComplete="off"/);
  for (const file of files) {
    const src = read(file);
    assert.ok(!/console\.\w+\(/.test(src), `${file} logs`);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), `${file} stores data`);
  }
});

test("no image data in query cache (source check)", () => {
  const tile = read(`${dir}/EvidenceTile.tsx`);
  assert.ok(!/react-query|useQuery|useMutation|setQueryData|queryClient/.test(tile));
  const api = read("client/src/lib/adminAgeReviewApi.ts");
  assert.ok(/URL\.createObjectURL/.test(api) && /cache: "no-store"/.test(api));
  assert.ok(!/<img[^>]*src=\{[^}]*token/.test(tile));
  const drawer = read(`${dir}/DetailDrawer.tsx`);
  assert.ok(!/revealEvidence/.test(drawer));
  assert.match(drawer, /gcTime: 0/);
  const all = files.map(read).join("\n");
  assert.ok(!/queryFn:[^\n]*revealEvidence/.test(all));
});

test("copy has no em or en dashes or the word cash", () => {
  for (const file of files) {
    const src = read(file);
    assert.ok(!/[—–]/.test(src), `${file} has a dash`);
    assert.ok(!/\bcash\b/i.test(src), `${file} says cash`);
  }
  for (const c of ADMIN_ERROR_CODES) assert.ok(!/[—–]|\bcash\b/i.test(adminErrorMessage(c)));
});

test("route and nav are wired", () => {
  assert.match(read("client/src/App.tsx"), /path="\/admin\/age-reviews" component=\{AdminAgeReviews\}/);
  assert.match(read("client/src/pages/admin/AdminUsers.tsx"), /<AgeVerificationActions/);
  const act = read(`${dir}/AgeVerificationActions.tsx`);
  assert.match(act, /minLength=\{3\} maxLength=\{300\}/);
  assert.match(act, /canMarkVerified\(me\.role\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
