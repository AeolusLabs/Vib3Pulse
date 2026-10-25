// No-DB unit test for the public privacy policy. Run: npx tsx scripts/test-age-review-unit-privacy.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_POLICY, policyBadge } from "../shared/privacyPolicy";
import { PRIVACY } from "../client/src/lib/ageReview";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const allText = [PRIVACY_POLICY.contactEmail, ...PRIVACY_POLICY.sections.flatMap((s) => [s.title, ...s.paragraphs, ...(s.bullets ?? [])])].join("\n");

test("policy has every required section id", () => {
  const ids = PRIVACY_POLICY.sections.map((s) => s.id);
  for (const id of ["summary", "who-we-are", "what-we-collect", "why-we-use-it", "who-sees-it", "who-we-share-with", "children", "age-review", "your-choices-and-rights", "security", "changes", "contact"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const s of PRIVACY_POLICY.sections) assert.ok(s.title && s.paragraphs.length > 0, s.id);
  assert.equal(PRIVACY_POLICY.version, "2026-10-v1");
});

test("contact email is info@aeoluslabsltd.com everywhere", () => {
  assert.equal(PRIVACY_POLICY.contactEmail, "info@aeoluslabsltd.com");
  const found = allText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
  assert.ok(found.length >= 3);
  for (const e of found) assert.equal(e, "info@aeoluslabsltd.com");
  assert.equal(PRIVACY.askHref, "mailto:info@aeoluslabsltd.com");
  assert.equal(PRIVACY.policyHref, "/privacy");
});

test("no section claims what the code does not do", () => {
  for (const phrase of ["end-to-end", "delete all your data", "download your data", "we never", "100%"]) {
    assert.ok(!allText.toLowerCase().includes(phrase), phrase);
  }
});

test("no em/en dashes or the word cash in policy copy", () => {
  assert.ok(!/[—–]|--/.test(allText));
  assert.ok(!/\bcash\b/i.test(allText));
  assert.ok(!/[—–]/.test(read("client/src/pages/PrivacyPolicyPage.tsx")));
});

test("status draft shows the badge helper", () => {
  assert.equal(PRIVACY_POLICY.status, "draft");
  assert.equal(policyBadge("draft"), "Draft, under legal review");
  assert.equal(policyBadge("final"), null);
  assert.match(read("client/src/pages/PrivacyPolicyPage.tsx"), /policyBadge\(status\)/);
});

test("age review section matches the pop-up facts", () => {
  const t = PRIVACY_POLICY.sections.find((s) => s.id === "age-review")!.paragraphs.join(" ");
  assert.match(t, /7 days/);
  assert.match(t, /not recorded or saved/);
  assert.match(t, /only trained Vib3Pulse age reviewers/i);
});

test("age review section says the one-way code, like the pop-up", () => {
  const t = PRIVACY_POLICY.sections.find((s) => s.id === "age-review")!.paragraphs.join(" ");
  assert.match(t, /one-way code made from your document number/);
  assert.ok(!t.includes("Never your photos"));
});

test("account deletion section states the limits honestly", () => {
  const t = PRIVACY_POLICY.sections.find((s) => s.id === "deleting-your-account")!.paragraphs.join(" ");
  assert.match(t, /Deleted user/);
  assert.match(t, /no tool for exporting/);
});

test("routes: /privacy is registered outside auth", () => {
  const app = read("client/src/App.tsx");
  const i = app.indexOf('path="/privacy"');
  assert.ok(i > 0);
  const publicStart = app.indexOf('path="/login"');
  assert.ok(publicStart > 0 && i - publicStart < 400, "should sit with the public routes");
  const before = app.slice(publicStart, i);
  assert.ok(!/ProtectedRoute|AuthGuard|RequireAuth/.test(before));
  assert.match(app, /<Route path="\/privacy" component=\{PrivacyPolicyPage\}/);
});

test("links to /privacy exist on landing, signup and account settings", () => {
  assert.match(read("client/src/pages/LandingPage.tsx"), /href="\/privacy"/);
  assert.match(read("client/src/pages/SignupPage.tsx"), /href="\/privacy"/);
  assert.match(read("client/src/pages/AccountSettingsPage.tsx"), /href="\/privacy"/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
