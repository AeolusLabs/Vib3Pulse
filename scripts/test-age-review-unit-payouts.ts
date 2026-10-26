// No-DB unit tests for the payouts opt-in, the payout page steps and the reviewer name field. Run: npx tsx scripts/test-age-review-unit-payouts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COPY, ERROR_CODES, PAYOUTS_HREF, PRIVACY, createBody, errorMessage, keepFor, payoutsAction, payoutsPreselected, startLiveRequest, type AgeReviewMe,
} from "../client/src/lib/ageReview";
import { PAYOUTS_NAME_NOTE, PRIVACY_POLICY, visibleSections } from "../shared/privacyPolicy";
import {
  PAYOUT_COPY, PAYOUT_ERROR, VERIFY_AGE_HREF, VERIFY_NAME_HREF, accountFailureCta, parsePayoutStatus, payoutErrorMessage, payoutLinkVisible, payoutPanel, payoutStage,
  PAYOUT_LINK_COPY,
} from "../client/src/components/rooms/earnings/earningsUi";
import {
  ADMIN_ERROR_CODES, adminErrorMessage, decisionBody, decisionReady, emptyChecklist, legalNameValid, type DecisionForm,
} from "../client/src/lib/adminAgeReviewUi";

let passed = 0, failed = 0;
const pending: Promise<void>[] = [];
const test = (name: string, fn: () => void | Promise<void>) => {
  const ok = () => { passed++; console.log(`PASS ${name}`); };
  const bad = (e: any) => { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); };
  try { const r = fn(); if (r) pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const BAD = /[—–]|--|\bnever\b|\bcash\b/i;
const me = (extra: Partial<AgeReviewMe> = {}): AgeReviewMe => ({
  enabled: true, paused: false, consentVersion: "2026-10-v2", state: "none", verified: null, request: null, retryAfter: null, attemptsLeft: 3, ...extra,
});
const verified = { method: "admin_upload" as const, at: "2026-10-20T10:00:00Z" };
const status = (o: Record<string, unknown> = {}) => parsePayoutStatus({ verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: true, hasVerifiedName: true, ...o })!;

test("wantsPayouts sent only when ticked", async () => {
  assert.ok(!("wantsPayouts" in createBody({ method: "upload", documentType: "passport", consentVersion: "v" })));
  assert.ok(!("wantsPayouts" in createBody({ method: "upload", consentVersion: "v", wantsPayouts: false })));
  assert.equal(createBody({ method: "upload", documentType: "passport", consentVersion: "v", wantsPayouts: true }).wantsPayouts, true);
  const sent: Record<string, unknown>[] = [];
  const deps = { create: async (v: Record<string, unknown>) => { sent.push(v); return { request: { id: "x" } }; }, submit: async () => {} };
  await startLiveRequest(deps as never, "v");
  await startLiveRequest(deps as never, "v", true);
  assert.ok(!("wantsPayouts" in sent[0]));
  assert.equal(sent[1].wantsPayouts, true);
  const card = read("client/src/components/age-review/VerifyAgeCard.tsx");
  assert.match(card, /useState\(\(\) => \(typeof window !== "undefined" \? payoutsPreselected\(window\.location\.search\) : false\)\)/);
  assert.match(card, /wantsPayouts=\{wantsPayouts\}/);
  assert.match(read("client/src/components/age-review/UploadFlow.tsx"), /consentVersion, wantsPayouts \}/);
  assert.equal(COPY.wantsPayoutsLabel, "I also want to receive money (tips and ticket sales)");
  assert.equal(COPY.wantsPayoutsHelp, "We will also note the name on your ID to check your bank account later.");
});

test("payouts variant copy contains the name sentence and the plain variant does not", () => {
  const sentence = "Because you chose to receive money, we also keep the full name on your document, encrypted. It is used only to check that your bank account is in your name. We delete it if you delete your account or an administrator removes your verification.";
  assert.equal(PRIVACY.keepPayouts, sentence);
  assert.ok(keepFor(true).endsWith(sentence));
  assert.ok(keepFor(true).startsWith(PRIVACY.keep.p));
  assert.equal(keepFor(false), PRIVACY.keep.p);
  assert.ok(!keepFor(false).includes("receive money"));
  assert.match(read("client/src/components/age-review/PrivacyNotice.tsx"), /keepFor\(wantsPayouts\)/);
});

test("policy and pop-up carry the same sentence", () => {
  assert.equal(PAYOUTS_NAME_NOTE, PRIVACY.keepPayouts);
  assert.equal(PRIVACY_POLICY.version, "2026-10-v4");
  assert.equal(PRIVACY_POLICY.lastUpdated, "2026-10-26");
  const age = PRIVACY_POLICY.sections.find((s) => s.id === "age-review")!;
  assert.ok(age.paragraphs.some((p) => p.includes(PRIVACY.keepPayouts)));
  const collect = PRIVACY_POLICY.sections.find((s) => s.id === "what-we-collect")!;
  assert.ok((collect.whenAgeReview?.bullets ?? []).some((b) => b.includes(PRIVACY.keepPayouts)));
  const off = visibleSections(PRIVACY_POLICY, false).flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])]).join("\n");
  assert.ok(!off.includes("receive money"), "the payouts note is inside the age review gate");
  const on = visibleSections(PRIVACY_POLICY, true).flatMap((s) => [...s.paragraphs, ...(s.bullets ?? [])]).join("\n");
  assert.ok(on.includes(PRIVACY.keepPayouts));
});

test("payout page state per status (not verified, no name, has name)", () => {
  assert.equal(payoutPanel(status({ verifiedAdult: false, canLinkAccount: false, hasVerifiedName: false })), "needs_age");
  assert.equal(payoutPanel(status({ verifiedAdult: false })), "needs_age");
  assert.equal(payoutPanel(status({ canLinkAccount: false, hasVerifiedName: false })), "needs_name");
  assert.equal(payoutPanel(status({ hasVerifiedName: false })), "needs_name");
  assert.equal(payoutPanel(status({ hasVerifiedName: true })), "none", "has a name: the bank form as before");
  assert.equal(payoutPanel(status({ canLinkAccount: false, hasVerifiedName: true })), "soon");
  assert.equal(payoutPanel(status({ hasVerifiedName: false }), false), "soon", "money flags off: linking is not open, no name step");
  const acct = { bankName: "GTBank", last4: "4821", nameMatches: false };
  assert.equal(payoutPanel(status({ account: acct, hasVerifiedName: true })), "mismatch");
  assert.equal(payoutPanel(status({ account: { ...acct, nameMatches: true }, subaccountReady: true, hasVerifiedName: true })), "ready");
  assert.equal(payoutStage(status({ hasVerifiedName: false })), "none", "payoutStage itself is unchanged");
  assert.equal(VERIFY_AGE_HREF, "/account/settings#verify-age");
  assert.equal(VERIFY_NAME_HREF, "/account/settings?payouts=1#verify-age");
  assert.equal(PAYOUTS_HREF, VERIFY_NAME_HREF);
  const view = read("client/src/components/rooms/earnings/PayoutAccountView.tsx");
  assert.match(view, /href=\{VERIFY_AGE_HREF\}/);
  assert.match(view, /panel === "needs_name"/);
  assert.match(view, /PAYOUT_COPY\.needNameTitle/);
  assert.equal(PAYOUT_COPY.needAgeTitle, "Verify your age first");
  assert.equal(PAYOUT_COPY.needNameTitle, "Verify your name for payouts");
});

test("existing account without a name shows the name step", () => {
  const acct = { bankName: "GTBank", last4: "4821", nameMatches: false };
  assert.equal(payoutPanel(status({ account: acct, canLinkAccount: false, hasVerifiedName: false })), "needs_name");
  assert.equal(payoutPanel(status({ account: { ...acct, nameMatches: true }, subaccountReady: true, hasVerifiedName: false })), "needs_name");
  assert.equal(payoutPanel(status({ account: null, subaccountReady: true, hasVerifiedName: false })), "needs_name", "setup without details too");
  assert.equal(payoutPanel(status({ account: { ...acct, nameMatches: true }, subaccountReady: true, hasVerifiedName: true })), "ready", "with a name: the old stages");
  assert.equal(payoutPanel(status({ account: acct, hasVerifiedName: false }), false), "mismatch", "payouts off: no name step");
  assert.equal(payoutPanel(status({ verifiedAdult: false, account: acct, hasVerifiedName: false })), "needs_age");
  const view = read("client/src/components/rooms/earnings/PayoutAccountView.tsx");
  assert.match(view, /panel === "needs_name"\s*\?\s*<CheckRow ok=\{false\}[^>]*notCheckedLine/);
  for (const stageName of ["mismatch", "pending", "ready", "setup"]) assert.match(view, new RegExp(`stage === "${stageName}"[^\\n]*panel !== "needs_name"`), stageName);
  assert.match(view, /const canLink = canLinkHere\(status, moneyOn\) && panel !== "needs_name"/);
  assert.equal(PAYOUT_COPY.notChecked, "Not checked yet");
  assert.ok(!BAD.test(PAYOUT_COPY.notCheckedLine("GTBank", "4821")));
  const fx = read("client/src/components/rooms/earnings/earningsFixtures.ts");
  assert.match(fx, /case "oldaccount"[^\n]*hasVerifiedName: false/);
});

test("NO_VERIFIED_NAME maps to the verify-name CTA", () => {
  assert.equal(accountFailureCta({ status: 422, code: "NO_VERIFIED_NAME" }), "verify_name");
  assert.equal(accountFailureCta({ status: 409, code: "NO_VERIFIED_NAME" }), "verify_name");
  assert.equal(payoutErrorMessage({ status: 422, code: "NO_VERIFIED_NAME" }), PAYOUT_ERROR.noVerifiedName);
  assert.equal(PAYOUT_ERROR.noVerifiedName, "To add a bank account we need to check your name on your ID. Start a payouts check from this page.");
  assert.equal(accountFailureCta({ status: 422, code: "NAME_MISMATCH" }), "recheck");
  assert.equal(accountFailureCta({ status: 422 }), "recheck");
  assert.equal(payoutErrorMessage({ status: 422, code: "NAME_MISMATCH" }), PAYOUT_ERROR.nameMismatch);
  assert.equal(accountFailureCta({ status: 500 }), null);
  assert.equal(accountFailureCta({ status: 429, code: "RATE_LIMITED" }), null);
  assert.equal(PAYOUT_COPY.recheckCta, "Ask for a name recheck");
  const view = read("client/src/components/rooms/earnings/PayoutAccountView.tsx");
  assert.match(view, /accountFailureCta\(r\)/);
  assert.match(view, /data-testid="payout-recheck-cta"/);
});

test("status parser defaults hasVerifiedName to false", () => {
  assert.equal(parsePayoutStatus({ verifiedAdult: true, account: null, subaccountReady: false })!.hasVerifiedName, false);
  assert.equal(parsePayoutStatus({ verifiedAdult: true, account: null, subaccountReady: false, hasVerifiedName: "yes" })!.hasVerifiedName, false);
  assert.equal(parsePayoutStatus({ verifiedAdult: true, account: null, subaccountReady: false, hasVerifiedName: true })!.hasVerifiedName, true);
  assert.equal(parsePayoutStatus({ verifiedAdult: true, account: null })?.hasVerifiedName, undefined);
});

test("account settings payout link hidden unless status answers 200", () => {
  assert.equal(payoutLinkVisible({ ok: true }), true);
  assert.equal(payoutLinkVisible({ ok: false }), false);
  assert.equal(payoutLinkVisible(undefined), false);
  assert.equal(payoutLinkVisible(null), false);
  const link = read("client/src/components/rooms/earnings/PayoutAccountLink.tsx");
  assert.match(link, /if \(!payoutLinkVisible\(q\.data\)\) return null;/);
  assert.match(link, /from "wouter"/);
  assert.match(link, /href="\/rooms\/payouts"/);
  assert.match(link, /min-h-\[56px\]/);
  assert.match(read("client/src/pages/AccountSettingsPage.tsx"), /<PayoutAccountLink \/>/);
  assert.equal(PAYOUT_LINK_COPY.title, "Payout account");
});

test("payouts action: only for verified users, never for people who did not ask", () => {
  assert.equal(payoutsAction(me({ state: "verified", verified, hasPayoutName: false })), "verify_name");
  assert.equal(payoutsAction(me({ state: "verified", verified, hasPayoutName: true })), "recheck");
  assert.equal(payoutsAction(me({ state: "none" })), null);
  assert.equal(payoutsAction(me({ state: "declined", hasPayoutName: false })), null);
  assert.equal(payoutsAction(me({ state: "verified", verified })), null, "an older server sends no hasPayoutName");
  assert.equal(payoutsAction(me({ state: "verified", verified, hasPayoutName: false, paused: true })), null);
  assert.equal(payoutsPreselected("?payouts=1"), true);
  assert.equal(payoutsPreselected("?payouts=0"), false);
  assert.equal(payoutsPreselected(""), false);
  assert.equal(COPY.verifyNameAction, "Verify your name for payouts");
  assert.equal(COPY.recheckLink, "Redo my payouts check");
  const card = read("client/src/components/age-review/VerifyAgeCard.tsx");
  assert.match(card, /pAction === "recheck" && !payoutChoices/);
  assert.match(card, /text-xs text-muted-foreground underline/);
});

test("reviewer legalName required only when wantsPayouts and cleared after submit (source check)", () => {
  const f = (o: Partial<DecisionForm> = {}): DecisionForm => ({
    outcome: "verify", checklist: { ...emptyChecklist(), faceMatches: true, codeMatches: true, documentTypeMatches: true, notExpired: true, birthdateReadable: true, noEditing: true },
    idBirthdate: "2000-05-01", documentNumber: "A1234567", documentType: "passport", legalName: "", declineReason: "", note: "", overrideReason: "", ...o,
  });
  assert.equal(decisionReady(f(), "upload", false), true, "no payouts: no name needed");
  assert.equal(decisionReady(f(), "upload", true), false, "payouts: the name is required");
  assert.equal(decisionReady(f({ legalName: "Ada Obi-Nwosu" }), "upload", true), true);
  assert.equal(decisionReady(f({ outcome: "birthdate_change" }), "upload", true), false);
  assert.equal(decisionReady(f({ outcome: "birthdate_change", legalName: "Ada Obi" }), "upload", true), true);
  assert.equal(decisionReady(f({ outcome: "teen_correction" }), "upload", true), true, "teen_correction never stores a name");
  assert.equal(decisionReady(f({ outcome: "decline", declineReason: "unreadable" }), "upload", true), true);
  for (const bad of ["Ab", "  ", "Ada 123", "Ada@Obi", "<b>Ada</b>", "x".repeat(121)]) assert.equal(legalNameValid(bad), false, bad);
  for (const ok of ["Ada Obi", "Ngozi O'Neil", "Anne-Marie St. John", "Chidi  Eze"]) assert.equal(legalNameValid(ok), true, ok);
  const withName = decisionBody(f({ legalName: "  Ada   Obi " }), { overrideAllowed: false, wantsPayouts: true });
  assert.equal(withName.legalName, "Ada Obi");
  assert.ok(!("legalName" in decisionBody(f({ legalName: "Ada Obi" }), { overrideAllowed: false, wantsPayouts: false })), "never sent when not requested");
  assert.ok(!("legalName" in decisionBody(f({ legalName: "Ada Obi" }), { overrideAllowed: false })));
  assert.ok(!("legalName" in decisionBody(f({ outcome: "decline", declineReason: "other", legalName: "Ada Obi" }), { overrideAllowed: false, wantsPayouts: true })));
  const form = read("client/src/components/admin/age-review/DecisionForm.tsx");
  assert.match(form, /finally \{[^}]*set\(\{ documentNumber: "", legalName: "" \}\)/s);
  assert.match(form, /wantsPayouts && needsDocumentNumber\(f\.outcome\)/);
  assert.match(form, /Full name on the document/);
  assert.match(form, /Used only to check the bank account holder's name\. Stored encrypted\. Not shown anywhere\./);
  assert.match(form, /id="legal-name"[\s\S]{0,200}autoComplete="off"/);
  assert.ok(!/console\.|localStorage|sessionStorage|setQueryData|searchParams|history\.|location\./.test(form));
  assert.match(read("client/src/components/admin/age-review/DetailDrawer.tsx"), /wantsPayouts=\{r\.wantsPayouts === true\}/);
  assert.match(read("client/src/pages/admin/AdminAgeReviews.tsx"), /data-testid="chip-payouts"/);
});

test("legal name check has no unicode flag and mirrors the server length rule", () => {
  const src = read("client/src/lib/adminAgeReviewUi.ts");
  assert.ok(!/\\p\{/.test(src) && !/\/[a-z]*u[a-z]*[,;)\s]/.test(src.split("\n").filter((l) => l.includes("NAME_RE")).join("\n")));
  for (const ok of ["Ada", "Chioma Okafor", "Jos\u00E9 Mu\u00F1oz", "Zo\u00EB O\u2019Brien", "Anne-Marie St. John", "Nguy\u1EC5n V\u0103n An"]) assert.equal(legalNameValid(ok), true, ok);
  for (const bad of ["Al", "A\u00D7B", "Ada1", "Ada_Obi", "-Ada", "Ada\nObi\u0000", "x".repeat(121)]) assert.equal(legalNameValid(bad), false, JSON.stringify(bad));
  assert.equal(legalNameValid("x".repeat(120)), true);
  assert.equal(legalNameValid("   Ada  Obi   "), true);
});

test("reviewer note helper warns against names and document numbers", () => {
  const form = read("client/src/components/admin/age-review/DecisionForm.tsx");
  assert.match(form, /Do not write names or document numbers here\./);
  assert.match(form, /aria-describedby="decision-note-help"/);
});

test("errors: NAME_REQUIRED, NAME_NOT_REQUESTED and ALREADY_VERIFIED have plain messages", () => {
  const generic = adminErrorMessage("NOPE");
  for (const c of ["NAME_REQUIRED", "NAME_NOT_REQUESTED", "ALREADY_VERIFIED"]) {
    assert.ok((ADMIN_ERROR_CODES as readonly string[]).includes(c), c);
    assert.notEqual(adminErrorMessage(c), generic, c);
  }
  assert.ok(!/ada|obi/i.test(adminErrorMessage("NAME_REQUIRED")), "error text never carries a name");
  assert.ok((ERROR_CODES as readonly string[]).includes("ALREADY_VERIFIED"));
  assert.equal(errorMessage("ALREADY_VERIFIED"), "You are already verified. To receive money, choose 'Verify your name for payouts'.");
});

test("copy has no dashes, 'never' or 'cash' in the new strings and components", () => {
  const strings = [
    PRIVACY.keepPayouts, keepFor(true), PAYOUTS_NAME_NOTE, COPY.wantsPayoutsLabel, COPY.wantsPayoutsHelp, COPY.verifyNameAction, COPY.verifyNameHelp, COPY.recheckLink,
    PAYOUT_COPY.needAgeTitle, PAYOUT_COPY.needAgeBody, PAYOUT_COPY.needAgeCta, PAYOUT_COPY.needNameTitle, PAYOUT_COPY.needNameBody, PAYOUT_COPY.needNameCta, PAYOUT_COPY.recheckCta,
    PAYOUT_ERROR.noVerifiedName, PAYOUT_LINK_COPY.title, PAYOUT_LINK_COPY.help,
    ...["NAME_REQUIRED", "NAME_NOT_REQUESTED", "ALREADY_VERIFIED"].map((c) => adminErrorMessage(c)), errorMessage("ALREADY_VERIFIED"),
  ];
  for (const s of strings) assert.ok(!BAD.test(s.replace("choose 'Verify", "choose 'Verify")), s.slice(0, 60));
  for (const f of ["client/src/components/age-review/VerifyAgeCard.tsx", "client/src/components/rooms/earnings/PayoutAccountLink.tsx", "client/src/components/admin/age-review/DecisionForm.tsx"]) {
    const src = read(f);
    assert.ok(!/[—–]/.test(src), `${f} has a dash`);
    assert.ok(!/\bcash\b/i.test(src), `${f} says cash`);
  }
  const section = PRIVACY_POLICY.sections.find((s) => s.id === "age-review")!.paragraphs.join(" ");
  assert.ok(!/[—–]/.test(section));
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
