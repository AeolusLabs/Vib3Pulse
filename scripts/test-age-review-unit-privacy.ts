// No-DB unit test for the public privacy policy. Run: npx tsx scripts/test-age-review-unit-privacy.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_POLICY, policyBadge, visibleSections } from "../shared/privacyPolicy";
import { PRIVACY, whatHappens } from "../client/src/lib/ageReview";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const allText = [PRIVACY_POLICY.contactEmail, ...PRIVACY_POLICY.sections.flatMap((s) => [s.title, ...s.paragraphs, ...(s.bullets ?? []), ...(s.afterBullets ?? []), ...(s.whenAgeReview?.paragraphs ?? []), ...(s.whenAgeReview?.bullets ?? [])])].join("\n");

test("policy has every required section id", () => {
  const ids = PRIVACY_POLICY.sections.map((s) => s.id);
  for (const id of ["summary", "who-we-are", "what-we-collect", "why-we-use-it", "who-sees-it", "who-we-share-with", "children", "age-review", "your-choices-and-rights", "security", "changes", "contact"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const s of PRIVACY_POLICY.sections) assert.ok(s.title && s.paragraphs.length > 0, s.id);
  assert.equal(PRIVACY_POLICY.version, "2026-10-v4");
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

test("age review section matches the pop-up wording", () => {
  const t = PRIVACY_POLICY.sections.find((x) => x.id === "age-review")!.paragraphs.join(" ");
  assert.match(t, /7 days/);
  assert.match(t, /Nothing is recorded or saved/);
  assert.ok(t.includes(PRIVACY.who.p), "who sees it");
  assert.ok(t.includes(PRIVACY.whoLive.replace("A reviewer sees you", "a reviewer sees you")), "live who sees it");
  assert.ok(t.includes(PRIVACY.keep.p), "what we keep, same words as the pop-up");
  assert.ok(t.includes(PRIVACY.choices.p) && t.includes(PRIVACY.safety.p));
  assert.ok(t.includes("one-way code") && t.includes("record of the decision"));
  assert.ok(!/never/i.test(t));
  assert.ok(t.includes("super administrators and age reviewers") && t.includes("staff audit log"));
  assert.equal(PRIVACY_POLICY.lastUpdated, "2026-10-26");
  assert.ok(whatHappens("upload").includes("after the final decision, or after 7 days from when you started, whichever comes first"));
  assert.ok(t.includes("after the final decision, or after 7 days from when you started, whichever comes first"));
});

test("the age review section and its sentences appear only when age review is on", () => {
  const off = visibleSections(PRIVACY_POLICY, false);
  const on = visibleSections(PRIVACY_POLICY, true);
  assert.ok(!off.some((x) => x.id === "age-review"));
  assert.ok(on.some((x) => x.id === "age-review"));
  const offText = off.flatMap((x) => [x.title, ...x.paragraphs, ...(x.bullets ?? []), ...(x.afterBullets ?? [])]).join("\n").toLowerCase();
  for (const w of ["age review", "age verification", "id photos", "age reviewer", "selfie", "proving you are an adult", "check that people who tip"]) assert.ok(!offText.includes(w), w);
  const onText = on.flatMap((x) => [...x.paragraphs, ...(x.bullets ?? [])]).join("\n").toLowerCase();
  assert.ok(onText.includes("proving you are an adult") && onText.includes("id photos"));
  assert.equal(off.length, PRIVACY_POLICY.sections.length - 1);
  for (const x of off) assert.ok(x.paragraphs.length > 0, x.id);
  const page = read("client/src/pages/PrivacyPolicyPage.tsx");
  assert.match(page, /\/api\/age-review\/enabled/);
  assert.match(page, /useState\(false\)/);
  assert.match(page, /visibleSections\(PRIVACY_POLICY, ageReviewOn\)/);
  assert.match(page, /catch\(\(\) => \{ if \(live\) setAgeReviewOn\(false\)/);
});

test("data claims: Nominatim and Sentry wording", () => {
  assert.match(allText, /Nominatim/);
  assert.match(allText, /if we have switched error monitoring on/);
  assert.ok(!/we use sentry|sentry is/i.test(allText));
});

test("account deletion section lists what stays, honestly", () => {
  const sec = PRIVACY_POLICY.sections.find((x) => x.id === "deleting-your-account")!;
  const t = [...sec.paragraphs, ...(sec.bullets ?? []), ...(sec.afterBullets ?? [])].join(" ");
  assert.match(t, /Deleted user/);
  assert.match(t, /no tool for exporting/);
  assert.match(t, /ask us to remove more by emailing info@aeoluslabsltd\.com/);
  for (const w of ["posts, comments and stories", "direct messages and group messages", "uploaded photos and videos", "followed or blocked", "notifications and browser push", "Safety Buddy contacts", "phone numbers", "location coordinates", "delivery records", "reports", "saved card", "connected social accounts", "money records"]) assert.ok(t.includes(w), w);
  assert.ok(!/removes (all|everything)/i.test(t));
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
