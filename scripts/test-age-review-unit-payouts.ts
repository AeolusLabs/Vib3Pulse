// No-DB unit tests for the payouts opt-in, the payout page steps and the reviewer name field. Run: npx tsx scripts/test-age-review-unit-payouts.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COPY, ERROR_CODES, PAYOUTS_HREF, PRIVACY, cardView, createBody, errorMessage, keepFor, payoutCta, payoutsAction, payoutsPreselected, startLiveRequest, type AgeReviewMe,
} from "../client/src/lib/ageReview";
import { PAYOUTS_NAME_NOTE, PRIVACY_POLICY, visibleSections } from "../shared/privacyPolicy";
import {
  PAYOUT_COPY, PAYOUT_ERROR, VERIFY_AGE_HREF, VERIFY_NAME_HREF, accountFailureCta, parsePayoutStatus, payoutErrorMessage, payoutLinkVisible, payoutPanel, payoutStage, moneyFlagsOn,
  PAYOUT_LINK_COPY,
} from "../client/src/components/rooms/earnings/earningsUi";
import {
  ADMIN_ERROR_CODES, adminErrorMessage, decisionBody, decisionReady, emptyChecklist, legalNameValid, legalNameProblem, normaliseLegalName, LEGAL_NAME_HINT, type DecisionForm,
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
  assert.match(read("client/src/components/age-review/UploadFlow.tsx"), /consentVersion, wantsPayouts, legalName \}/);
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
  assert.equal(VERIFY_AGE_HREF, "/account/settings?section=verify#verify-age");
  assert.equal(VERIFY_NAME_HREF, "/account/settings?section=verify&payouts=1#verify-age");
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
  assert.match(view, /const canLink = canLinkHere\(status, moneyOn\) && !\(panel === "needs_name" && status.awaitingName\)/);
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
  assert.match(link, /payoutLinkVisible\(q\.data\)\) return null;/);
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
  assert.match(form, /wantsPayouts && isIdOutcome\(f\.outcome\)/);
  assert.match(form, /Full name on the document/);
  assert.match(form, /Used only to check the bank account holder's name\. Stored encrypted\. Not shown anywhere\./);
  assert.match(form, /id="legal-name"[\s\S]{0,200}autoComplete="off"/);
  assert.ok(!/console\.|localStorage|sessionStorage|setQueryData|searchParams|history\.|location\./.test(form));
  assert.match(read("client/src/components/admin/age-review/DetailDrawer.tsx"), /wantsPayouts=\{r\.wantsPayouts === true\}/);
  assert.match(read("client/src/pages/admin/AdminAgeReviews.tsx"), /data-testid="chip-payouts"/);
});

// The same cases the server tests (scripts/test-age-review-unit-payoutname.ts) plus scripts and edge characters, so the form and the server cannot drift.
const NAME_OK: [string, string][] = [
  ["  Adébáyọ̀   Okafor ", "Adébáyọ̀ Okafor"],
  ["Mary O'Neil-Smith Jr.", "Mary O'Neil-Smith Jr."],
  ["a".repeat(120), "a".repeat(120)],
  ["José Muñoz", "José Muñoz"],                       // decomposed accents become composed (NFC)
  ["Zoë O’Brien", "Zoë O’Brien"],                           // typographic apostrophe
  ["Αλέξανδρος Παπαδόπουλος", "Αλέξανδρος Παπαδόπουλος"], // Greek
  ["Иван Петров", "Иван Петров"],       // Cyrillic
  ["محمد علي", "محمد علي"],                                   // Arabic
  ["田中 太郎", "田中 太郎"],                                                                    // CJK
  ["Anne-Marie St. John", "Anne-Marie St. John"],
  ["Nguyễn Văn An", "Nguyễn Văn An"],
];
const NAME_BAD: unknown[] = [
  "ab", "A1 Smith", "x@y.com z", "Robert'); DROP", "<b>Bob</b> Lee", "", "   ", null, 42, "a".repeat(121), "-Smith John", "John \u{1F600} Smith",
  "Ada Obiʼ", "Ada×Obi", "Ada÷Obi", "Ada_Obi", "Ada 123", "Ada\u0000Obi",
];

test("legal name rule mirrors the server (NFC, char-code ranges, no unicode flag)", () => {
  for (const [input, want] of NAME_OK) assert.equal(normaliseLegalName(input), want, JSON.stringify(input));
  for (const bad of NAME_BAD) assert.equal(normaliseLegalName(bad), null, String(bad));
  assert.equal(legalNameValid("  Ada   Obi "), true);
  assert.equal(legalNameValid("Ada"), true);
  assert.equal(legalNameValid("Al"), false);
  // Same function body as the server's: the ranges are copied, so compare the source of both.
  const client = read("client/src/lib/adminAgeReviewUi.ts");
  const server = read("server/identity/verifiedName.ts");
  for (const part of ["c >= 0xc0 && c <= 0x2af && c !== 0xd7 && c !== 0xf7", "c >= 0x300 && c <= 0x36f", "c >= 0x370 && c <= 0x1fff", "c >= 0x3040 && c <= 0x9fff", 'raw.normalize("NFC").replace(/\\s+/g, " ").trim()', "n.length < 3 || n.length > 120"]) {
    assert.ok(client.includes(part) && server.includes(part), part);
  }
  const rule = client.slice(client.indexOf("export function normaliseLegalName"), client.indexOf("export const legalNameValid"));
  assert.ok(!/\/[a-z]*u[a-z]*[.,;)\s]/.test(rule.replace(/\/\[A-Za-z\]\//, "")), "no regex with the u flag");
});

test("inline reason when the name is not usable", () => {
  assert.equal(legalNameProblem(""), null);
  assert.equal(legalNameProblem("Ada Obi"), null);
  assert.equal(legalNameProblem("Ada 1"), LEGAL_NAME_HINT);
  assert.equal(LEGAL_NAME_HINT, "Letters, spaces, hyphens, apostrophes and dots, 3 to 120 characters");
  const form = read("client/src/components/admin/age-review/DecisionForm.tsx");
  assert.match(form, /aria-describedby="legal-name-help legal-name-problem"/);
  assert.match(form, /id="legal-name-problem" role="status"/);
  const body = decisionBody({ outcome: "verify", checklist: emptyChecklist(), idBirthdate: "2000-05-01", documentNumber: "A1234567", documentType: "passport", legalName: "José  Muñoz", declineReason: "", note: "", overrideReason: "" }, { overrideAllowed: false, wantsPayouts: true });
  assert.equal(body.legalName, "José Muñoz", "the server's normal form is sent");
});

test("payout account link needs the money flags on, and asks nothing when they are off", () => {
  assert.equal(moneyFlagsOn({ paidRooms: true, spray: false }), true);
  assert.equal(moneyFlagsOn({ spray: true }), true);
  assert.equal(moneyFlagsOn({ paidRooms: false, spray: false }), false);
  assert.equal(moneyFlagsOn(undefined), false);
  const link = read("client/src/components/rooms/earnings/PayoutAccountLink.tsx");
  assert.match(link, /useRoomsConfig\(\)/);
  assert.match(link, /enabled: moneyOn/);
  assert.match(link, /if \(!moneyOn \|\| !payoutLinkVisible\(q\.data\)\) return null;/);
  assert.ok(read("client/src/components/rooms/earnings/PayoutAccountView.tsx").includes("config.data?.features.paidRooms === true || config.data?.features.spray === true"), "same check as the payout page");
});

test("mid-draft payouts check is not the generic age card", () => {
  const req = { id: "r", method: "upload" as const, status: "draft", documentType: null, canCancel: true, needsMore: false, hasDocument: false, hasSelfie: false, code: null, codeExpiresAt: null, liveInviteExpiresAt: null, submittedAt: null, declineReason: null, consentedAt: null, wantsPayouts: true };
  const v = cardView(me({ state: "none", request: req }));
  assert.equal(v.title, "Continue your payouts check");
  assert.ok(!/adults only/i.test(v.body) && !/Verify your age/.test(v.title));
  assert.equal(cardView(me({ state: "none", request: { ...req, wantsPayouts: false } })).title, "Verify your age");
  assert.equal(cardView(me({ state: "none" })).title, "Verify your age");
  assert.match(read("client/src/components/age-review/VerifyAgeCard.tsx"), /COPY\.payoutsContinueButton/);
});

test("payout page CTA: paused notice, and no second check while one is in review", () => {
  const r = (status: string, wantsPayouts = true) => ({ id: "r", method: "upload" as const, status, documentType: null, canCancel: true, needsMore: false, hasDocument: false, hasSelfie: false, code: null, codeExpiresAt: null, liveInviteExpiresAt: null, submittedAt: null, declineReason: null, consentedAt: null, wantsPayouts });
  assert.equal(payoutCta(null), "link");
  assert.equal(payoutCta(me({ state: "verified", verified })), "link");
  assert.equal(payoutCta(me({ state: "verified", verified, paused: true })), "paused");
  assert.equal(payoutCta(me({ state: "in_review", request: r("in_review") })), "in_review");
  assert.equal(payoutCta(me({ state: "in_review", request: r("submitted") })), "in_review");
  assert.equal(payoutCta(me({ state: "in_review", request: r("pending_second_approval") })), "in_review");
  assert.equal(payoutCta(me({ state: "in_review", request: r("in_review"), paused: true })), "in_review");
  assert.equal(payoutCta(me({ state: "none", request: r("draft") })), "link", "a draft can be continued");
  assert.equal(payoutCta(me({ state: "in_review", request: r("in_review", false) })), "link", "an age check is not a payouts check");
  assert.equal(COPY.payoutsInReview, "Your payouts check is being reviewed");
  const view = read("client/src/components/rooms/earnings/PayoutAccountView.tsx");
  assert.match(view, /cta === "paused"/);
  assert.match(view, /cta === "in_review"/);
  assert.match(view, /cta === "link" && <Button asChild/);
});

test("card status paragraph renders empty first, then fills", () => {
  const card = read("client/src/components/age-review/VerifyAgeCard.tsx");
  assert.match(card, /setAnnounce\(""\);\s*const t = window\.setTimeout\(\(\) => setAnnounce\(summary\)/);
  assert.match(card, /role="status" className="sr-only" data-testid="age-live-status">\{announce\}/);
  assert.ok(!/<CardDescription aria-live/.test(card));
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
    PAYOUT_ERROR.noVerifiedName, COPY.payoutsDraftTitle, COPY.payoutsDraftBody, COPY.payoutsContinueButton, COPY.payoutsPaused, COPY.agePaused, COPY.payoutsInReview, COPY.payoutsInReviewBody, LEGAL_NAME_HINT, PAYOUT_LINK_COPY.title, PAYOUT_LINK_COPY.help,
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

test("every verify link opens the focused verify screen, not the whole Account Settings page; Back returns to Get paid", () => {
  for (const href of [VERIFY_AGE_HREF, VERIFY_NAME_HREF]) assert.ok(href.includes("section=verify"), href);
  const page = readFileSync("client/src/pages/AccountSettingsPage.tsx", "utf8");
  assert.ok(page.includes('backToPay ? "/rooms/payouts" : "/settings"'));
  assert.ok(page.includes('{show("verify") && (<>'));
});
test("a passed payouts check tells the person what is next and opens the page where the bank account is added", () => {
  const admin = readFileSync("server/identity/ageReviewAdmin.ts", "utf8");
  assert.ok(admin.includes('const payoutsDone = result.payouts && result.plan.notify === "approved"'));
  assert.ok(admin.includes('{ detail: "Next, add your bank account to get paid.", link: "/rooms/payouts" }'));
});

test("a verified person in a decline cooldown is told up front and offered no buttons that cannot work", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const base: any = { enabled: true, paused: false, consentVersion: "v", state: "verified", verified: { method: "admin", at: "2026-10-01T00:00:00Z" }, request: null, attemptsLeft: 2, hasPayoutName: false };
  const waiting = { ...base, retryAfter: "2026-10-29T12:00:00Z" };
  assert.equal(payoutsAction(base, now), "verify_name");
  assert.equal(payoutsAction(waiting, now), null);
  assert.ok(/declined, so you can start a new one/.test(cardView(waiting, now).body));
  assert.ok(!/declined/.test(cardView(base, now).body));
  assert.equal(payoutsAction({ ...base, retryAfter: "2026-10-27T12:00:00Z" }, now), "verify_name", "a wait that has ended offers the action again");
  const src = readFileSync("server/identity/ageReviewService.ts", "utf8");
  assert.ok(src.includes('retryAfter: retryAfter && retryAfter > now ? retryAfter.toISOString() : null };'));
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
