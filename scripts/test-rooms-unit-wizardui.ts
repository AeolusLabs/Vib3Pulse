// Pure helpers and copy for the create-a-room wizard UI (no database, no browser): npx tsx scripts/test-rooms-unit-wizardui.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOM_LIMITS, SLOW_MODES } from "../shared/rooms";
import {
  COPY, CREATE_ERROR, DONE_COPY, FIELD_ERROR, GENERIC_CREATE_ERROR, HOST_REFUSAL, OFFLINE_ERROR, PINNED_MAX, SLOW_MODE_CHOICES, WIZARD_UI_COPY,
  buildCreatePayload, createErrorMessage, cutText, defaultRoomTitle, defaultWizardState, doneKind, fieldForFailure, fieldSelectors, isKnownStep,
  linkChoiceOf, localProblem, maxScheduleInput, minScheduleInput, parseLinkChoice, progressLine, progressPrefix, quickStartState,
  quickVisibilityLine, roomShareUrl, ruleMessage, scheduleProblem, stepForFailure, stepOfField, toLocalInput,
} from "../client/src/lib/createRoomWizardUi";
import { normalizeWizard } from "../client/src/lib/createRoomRules";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

const NOW = new Date(2026, 9, 18, 12, 0, 0); // local time, like the datetime-local input
const base = () => defaultWizardState({ title: "Friday pre-party" });

// ---------------------------------------------------------------- payload
test("payload carries the existing contract plus slowModeSec and pinnedMessage", () => {
  const p = buildCreatePayload({ ...base(), slowModeSec: 15, pinned: "  Be kind.  " });
  assert.equal(p.title, "Friday pre-party");
  assert.equal(p.kind, "party");
  assert.equal(p.visibility, "public");
  assert.equal(p.ageLimit, "all");
  assert.equal(p.capacity, ROOM_LIMITS.capacityDefault);
  assert.equal(p.slowModeSec, 15);
  assert.equal(p.pinnedMessage, "Be kind.");
  assert.equal(p.noDirectInteractions, false);
  assert.equal("scheduledFor" in p, false, "go live now sends no schedule");
});
test("payload never sends anonymous, voice or live video fields", () => {
  const p = buildCreatePayload({ ...base(), voice: true, liveVideo: true }) as unknown as Record<string, unknown>;
  for (const k of ["anonymousAllowed", "voice", "liveVideo", "when", "pinned"]) assert.equal(k in p, false, k);
});
test("empty description and pinned message are left out; title is trimmed", () => {
  const p = buildCreatePayload({ ...base(), title: "  Hi  ", description: "   ", pinned: "  " });
  assert.equal(p.title, "Hi");
  assert.equal("description" in p, false);
  assert.equal("pinnedMessage" in p, false);
});
test("pinned message is cut at 200 characters without splitting an emoji", () => {
  const p = buildCreatePayload({ ...base(), pinned: "🎉".repeat(250) });
  assert.equal(Array.from(p.pinnedMessage!).length, PINNED_MAX);
  assert.equal(p.pinnedMessage, "🎉".repeat(200));
  assert.equal(cutText("abc", 2), "ab");
});
test("pinned HTML is sent as typed text (the server stores plain text, the UI renders text nodes)", () => {
  assert.equal(buildCreatePayload({ ...base(), pinned: "<b>hi</b>" }).pinnedMessage, "<b>hi</b>");
});
test("a schedule is sent as ISO only when 'later' is picked", () => {
  const later = buildCreatePayload({ ...base(), when: "later", scheduledFor: "2026-10-20T20:30" });
  assert.equal(later.scheduledFor, new Date(2026, 9, 20, 20, 30).toISOString());
  assert.equal("scheduledFor" in buildCreatePayload({ ...base(), when: "now", scheduledFor: "2026-10-20T20:30" }), false);
});
test("an unreadable schedule is sent as typed so the server names the field", () => {
  assert.equal(buildCreatePayload({ ...base(), when: "later", scheduledFor: "not a date" }).scheduledFor, "not a date");
});
test("link fields: event, venue, never both, none when unlinked", () => {
  assert.equal(buildCreatePayload(base(), {}, { eventId: "e1" }).eventId, "e1");
  assert.equal(buildCreatePayload(base(), {}, { venueId: "v1" }).venueId, "v1");
  const both = buildCreatePayload(base(), {}, { eventId: "e1", venueId: "v1" });
  assert.equal(both.eventId, "e1");
  assert.equal("venueId" in both, false);
  const none = buildCreatePayload(base(), {}, {});
  assert.equal("eventId" in none || "venueId" in none, false);
});
test("extras: direct interactions off and a screen link (only when given)", () => {
  const p = buildCreatePayload(base(), { noDirectInteractions: true, screenUrl: "  https://youtu.be/x  " });
  assert.equal(p.noDirectInteractions, true);
  assert.equal(p.screenUrl, "https://youtu.be/x");
  assert.equal("screenUrl" in buildCreatePayload(base(), { screenUrl: "   " }), false);
});
test("link choice round trip", () => {
  assert.equal(linkChoiceOf({ eventId: "e1" }), "event:e1");
  assert.equal(linkChoiceOf({ venueId: "v1" }), "venue:v1");
  assert.equal(linkChoiceOf(undefined), "none");
  assert.deepEqual(parseLinkChoice("event:e1"), { eventId: "e1" });
  assert.deepEqual(parseLinkChoice("venue:v1"), { venueId: "v1" });
  assert.deepEqual(parseLinkChoice("none"), {});
  assert.deepEqual(parseLinkChoice("event:"), {});
  assert.deepEqual(parseLinkChoice("other:x"), {});
});

// ---------------------------------------------------------------- errors
test("host refusals mirror the server's HOST_MESSAGES word for word", () => {
  const src = readFileSync(new URL("../server/rooms/roomRoutes.ts", import.meta.url), "utf8");
  for (const [code, text] of Object.entries(HOST_REFUSAL)) assert.ok(src.includes(`${code}: ${JSON.stringify(text)}`), code);
});
test("every server code maps to plain words", () => {
  for (const code of ["HOST_BELOW_LIMIT", "TEEN_PUBLIC", "ACCOUNT_TOO_NEW", "AGE_UNKNOWN", "RATE_LIMITED", "SCHEDULED_LIMIT", "LIVE_LIMIT", "NOT_OWNER", "HOST_NOT_MINOR", "BAD_STATE"]) {
    assert.equal(createErrorMessage({ status: 403, code }), CREATE_ERROR[code], code);
  }
  assert.equal(createErrorMessage({ status: 403, code: "TEEN_PUBLIC" }), "Public rooms are for adults. Try a friends-only or invite-only room.");
});
test("status-only failures: offline, rate limit, field, unknown", () => {
  assert.equal(createErrorMessage({ status: 0 }), OFFLINE_ERROR);
  assert.equal(createErrorMessage({ status: 429 }), CREATE_ERROR.RATE_LIMITED);
  assert.equal(createErrorMessage({ status: 400, field: "scheduledFor" }), FIELD_ERROR.scheduledFor);
  assert.equal(createErrorMessage({ status: 400, field: "pinnedMessage" }), FIELD_ERROR.pinnedMessage);
  assert.equal(createErrorMessage({ status: 500 }), GENERIC_CREATE_ERROR);
  assert.equal(createErrorMessage({ status: 400, code: "WHATEVER" }), GENERIC_CREATE_ERROR);
});
test("refusals send the host to the step that can fix them", () => {
  assert.equal(stepForFailure({ code: "TEEN_PUBLIC" }), "audience");
  assert.equal(stepForFailure({ code: "ACCOUNT_TOO_NEW" }), "audience");
  assert.equal(stepForFailure({ code: "HOST_BELOW_LIMIT" }), "audience");
  assert.equal(stepForFailure({ code: "NOT_OWNER" }), "basics");
  assert.equal(stepForFailure({ field: "scheduledFor" }), "when");
  assert.equal(stepForFailure({ field: "slowModeSec" }), "features");
  assert.equal(stepForFailure({ code: "RATE_LIMITED" }), null);
  assert.equal(fieldForFailure({ code: "TEEN_PUBLIC" }), "visibility");
  assert.equal(fieldForFailure({ code: "HOST_BELOW_LIMIT" }), "ageLimit");
  assert.equal(fieldForFailure({ field: "title" }), "title");
});
test("field to step", () => {
  assert.equal(stepOfField("title"), "basics");
  assert.equal(stepOfField("capacity"), "basics");
  assert.equal(stepOfField("ageLimit"), "audience");
  assert.equal(stepOfField("visibility"), "audience");
  assert.equal(stepOfField("pinned"), "features");
  assert.equal(stepOfField("liveVideo"), "features");
  assert.equal(stepOfField("scheduledFor"), "when");
  assert.equal(stepOfField("nonsense"), null);
  assert.equal(isKnownStep("price"), false);
  assert.equal(isKnownStep("review"), true);
});
test("a rule failure shows a sentence, never a bare code", () => {
  assert.equal(ruleMessage("scheduledFor", "Pick a time in the future."), "Pick a time in the future.");
  assert.equal(ruleMessage("scheduledFor", "past"), FIELD_ERROR.scheduledFor);
  assert.equal(ruleMessage("mystery", "x"), GENERIC_CREATE_ERROR);
  assert.equal(ruleMessage("title", undefined), FIELD_ERROR.title);
});

// ---------------------------------------------------------------- defaults and quick start
test("default state: voice on, nothing scheduled, no anonymous field", () => {
  const s = defaultWizardState() as unknown as Record<string, unknown>;
  assert.equal(s.voice, true);
  assert.equal(s.liveVideo, false);
  assert.equal(s.when, "now");
  assert.equal(s.scheduledFor, null);
  assert.equal(s.slowModeSec, 0);
  assert.equal("anonymousAllowed" in s, false);
  assert.equal(defaultWizardState({ when: "later" }).when, "later");
});
test("quick start: a teen always gets Friends, whatever they used before", () => {
  assert.equal(quickStartState({ age: 15 }, { lastVisibility: "public" }).visibility, "friends");
  assert.equal(quickStartState({ age: 17 }).visibility, "friends");
});
test("quick start: an adult gets public only when they used it last; otherwise Friends", () => {
  assert.equal(quickStartState({ age: 25 }, { lastVisibility: "public" }).visibility, "public");
  assert.equal(quickStartState({ age: 25 }, { lastVisibility: "friends" }).visibility, "friends");
  assert.equal(quickStartState({ age: 25 }).visibility, "friends");
  assert.equal(quickStartState({ age: 25 }, { lastVisibility: "nonsense" }).visibility, "friends");
  // The invite link is shown once; one tap goes straight in, so it would never be seen.
  assert.equal(quickStartState({ age: 25 }, { lastVisibility: "invite" }).visibility, "friends");
  assert.equal(quickStartState({ age: null }, { lastVisibility: "public" }).visibility, "friends");
});
test("quick start: goes live now, voice on, video only when asked, valid title", () => {
  const s = quickStartState({ age: 25 }, { name: "Mara", liveVideo: true });
  assert.equal(s.when, "now");
  assert.equal(s.voice, true);
  assert.equal(s.liveVideo, true);
  assert.equal(s.title, "Mara's room");
  assert.equal(quickStartState({ age: 25 }).liveVideo, false);
  assert.equal(localProblem(s, NOW), null);
});
test("default titles", () => {
  assert.equal(defaultRoomTitle(null), "My room");
  assert.equal(defaultRoomTitle("   "), "My room");
  assert.ok(Array.from(defaultRoomTitle("x".repeat(200))).length <= ROOM_LIMITS.title);
});
test("quick start says where the room shows", () => {
  assert.equal(quickVisibilityLine("friends"), COPY.quickFriends);
  assert.equal(quickVisibilityLine("public"), COPY.quickPublic);
});

// ---------------------------------------------------------------- local checks and time
test("local checks: empty title, bad capacity, odd slow mode, long pin", () => {
  assert.equal(localProblem({ ...base(), title: "  " }, NOW)?.field, "title");
  assert.equal(localProblem({ ...base(), capacity: Number.NaN }, NOW)?.field, "capacity");
  assert.equal(localProblem({ ...base(), capacity: 1 }, NOW)?.field, "capacity");
  assert.equal(localProblem({ ...base(), capacity: ROOM_LIMITS.capacityMax + 1 }, NOW)?.field, "capacity");
  assert.equal(localProblem({ ...base(), slowModeSec: 7 }, NOW)?.field, "slowModeSec");
  assert.equal(localProblem({ ...base(), pinned: "a".repeat(201) }, NOW)?.field, "pinned");
  assert.equal(localProblem(base(), NOW), null);
});
test("scheduled in the past, empty, or too far is refused; the future is fine", () => {
  assert.equal(localProblem({ ...base(), when: "later", scheduledFor: toLocalInput(new Date(NOW.getTime() - 60_000)) }, NOW)?.field, "scheduledFor");
  assert.equal(localProblem({ ...base(), when: "later", scheduledFor: null }, NOW)?.field, "scheduledFor");
  assert.equal(scheduleProblem(toLocalInput(NOW), NOW), true, "now itself is not the future");
  assert.equal(scheduleProblem(toLocalInput(new Date(NOW.getTime() + 91 * 86_400_000)), NOW), true);
  assert.equal(scheduleProblem(toLocalInput(new Date(NOW.getTime() + 3_600_000)), NOW), false);
  assert.equal(localProblem({ ...base(), when: "now", scheduledFor: null }, NOW), null);
});
test("the time input's bounds start after now and end at 90 days", () => {
  assert.equal(minScheduleInput(NOW), "2026-10-18T12:01");
  assert.equal(toLocalInput(NOW), "2026-10-18T12:00");
  assert.equal(maxScheduleInput(NOW), toLocalInput(new Date(NOW.getTime() + 90 * 86_400_000)));
});

// ---------------------------------------------------------------- done screen and progress
test("done link: the invite link when there is one, else the room page", () => {
  assert.equal(roomShareUrl("https://vib3pulse.app", "r1", "/rooms/r1?token=abc"), "https://vib3pulse.app/rooms/r1?token=abc");
  assert.equal(roomShareUrl("https://vib3pulse.app", "r1", null), "https://vib3pulse.app/rooms/r1");
});
test("progress line", () => {
  assert.equal(progressLine(1, 5, "Who can join?"), "Step 2 of 5: Who can join?");
  assert.equal(progressPrefix(0, 5), "Step 1 of 5: ");
});

// ---------------------------------------------------------------- fix round (3.3 review)
test("constants come from @shared/rooms", () => {
  assert.equal(PINNED_MAX, ROOM_LIMITS.pinned);
  assert.deepEqual([...SLOW_MODE_CHOICES], [...SLOW_MODES]);
  const ui = src("../client/src/lib/createRoomWizardUi.ts");
  assert.ok(!/PINNED_MAX = 200/.test(ui) && !/\[0, 5, 15, 30\]/.test(ui), "no hand copies");
  // StepFeatures takes the limit from one place only
  const features = src("../client/src/components/rooms/create/StepFeatures.tsx");
  assert.equal((features.match(/PINNED_MAX/g) ?? []).length >= 1, true);
  assert.ok(!/PINNED_MAX\s*=/.test(features));
  assert.ok(/import \{[^}]*PINNED_MAX[^}]*\} from "@\/lib\/createRoomWizardUi"/.test(features), "imported from createRoomWizardUi");
});
test("done screen: its own words for live, made but not live, scheduled and scheduled invite rooms", () => {
  assert.equal(doneKind({ when: "now", live: true, invite: false }), "live");
  assert.equal(doneKind({ when: "now", live: true, invite: true }), "live");
  assert.equal(doneKind({ when: "now", live: false, invite: true }), "notLive");
  assert.equal(doneKind({ when: "now", live: false, invite: false }), "notLive");
  assert.equal(doneKind({ when: "later", live: false, invite: false }), "scheduled");
  assert.equal(doneKind({ when: "later", live: false, invite: true }), "scheduledInvite");
  assert.equal(DONE_COPY.notLive.title, COPY.startedLate);
  assert.ok(!/upcoming/i.test(DONE_COPY.scheduledInvite.body), "an invite room never shows under Upcoming");
  assert.ok(!/upcoming/i.test(DONE_COPY.notLive.body));
  assert.notEqual(DONE_COPY.notLive.body, DONE_COPY.scheduled.body);
  for (const k of Object.values(DONE_COPY)) { assert.ok(!/[—–]/.test(k.title + k.body)); assert.ok(!/cash/i.test(k.title + k.body)); }
});
test("field to focus after a refusal: every field a refusal can name has a control", () => {
  for (const f of ["title", "description", "capacity", "eventId", "venueId", "ageLimit", "visibility", "slowModeSec", "pinned", "pinnedMessage", "screenUrl", "scheduledFor"]) {
    assert.ok(fieldSelectors(f).length > 0, f);
  }
  assert.deepEqual(fieldSelectors("title"), ["#wiz-title"]);
  assert.equal(fieldSelectors("visibility")[0], 'input[name="wiz-visibility"]:checked:not(:disabled)');
  assert.deepEqual(fieldSelectors(fieldForFailure({ code: "ACCOUNT_TOO_NEW" })), fieldSelectors("visibility"));
  assert.deepEqual(fieldSelectors(fieldForFailure({ code: "HOST_BELOW_LIMIT" })), fieldSelectors("ageLimit"));
  assert.deepEqual(fieldSelectors("nonsense"), []);
  // the ids and radio names are the ones the steps render
  const steps = ["StepBasics", "StepAudience", "StepFeatures", "StepWhen"].map((f) => src(`../client/src/components/rooms/create/${f}.tsx`)).join("\n");
  for (const id of ["wiz-title", "wiz-desc", "wiz-capacity", "wiz-link", "wiz-pinned", "wiz-schedule"]) assert.ok(steps.includes(`id="${id}"`), id);
  for (const name of ["wiz-age", "wiz-visibility", "wiz-slow", "wiz-when"]) assert.ok(steps.includes(`name="${name}"`), name);
});
test("capacity typed out of range is reported, not silently corrected (the wizard checks the raw state first)", () => {
  const host = { age: 30, accountAgeDays: 400, idVerifiedAdult: false };
  for (const capacity of [Number.NaN, 0, 1, ROOM_LIMITS.capacityMax + 1, 20.5]) {
    const raw = { ...base(), capacity };
    assert.equal(localProblem(raw, NOW)?.field, "capacity", String(capacity));
    assert.equal(localProblem(normalizeWizard(raw, host), NOW), null, "normalizing first would hide it");
  }
  const wiz = src("../client/src/components/rooms/create/CreateRoomWizard.tsx");
  assert.ok(/firstProblem\(state, s, now\)/.test(wiz), "goNext passes the raw state to the local checks");
  assert.ok(/localProblem\(raw, now\)/.test(wiz));
});
test("wizard: reopening refits the fresh state, steps are announced once, spinner has a status, focus goes back", () => {
  const wiz = src("../client/src/components/rooms/create/CreateRoomWizard.tsx");
  assert.ok(/setState\(host \? fit\(fresh\) : fresh\)/.test(wiz), "open effect fits a fresh state when the host is known");
  assert.ok(!/aria-live/.test(wiz), "no live region on top of the heading focus");
  assert.ok(/role="status" aria-label="Loading"/.test(wiz));
  assert.ok(/onCloseAutoFocus/.test(wiz) && /returnFocusTo/.test(wiz));
  assert.ok(/minAccountAgeDays, state\.ageLimit/.test(wiz), "wizardOptions gets the real minimum account age");
  assert.ok(/validateWizard\(s, host, now, minAccountAgeDays\)/.test(wiz));
  const flow = src("../client/src/components/rooms/create/StartRoomFlow.tsx");
  assert.ok((flow.match(/returnFocusTo=\{returnFocusTo\}/g) ?? []).length === 2, "sheet and wizard both get it");
  assert.ok(/returnFocusTo=\{\(\) => btn\.current\}/.test(src("../client/src/components/rooms/home/StartRoomButton.tsx")));
});
test("wizard host: config fetched only while open, account age read as optional", () => {
  const api = src("../client/src/components/rooms/create/createRoomApi.ts");
  assert.ok(/queryKey: \["\/api\/rooms\/config"\][^\n]*enabled: open/.test(api));
  assert.ok(!/useRoomsConfig\(\)/.test(api), "the ungated hook would fetch on every feed (StoriesBar)");
  assert.ok(/host\?: HostConfig/.test(api));
});
test("features step: the scheduled note shows when the room is scheduled", () => {
  const f = src("../client/src/components/rooms/create/StepFeatures.tsx");
  assert.ok(/state\.when === "later" && [^\n]*COPY\.scheduledFeatures/.test(f));
});
test("quick start: ACCOUNT_TOO_NEW forgets public as the last pick and never retries it", () => {
  const q = src("../client/src/components/rooms/create/QuickStartSheet.tsx");
  assert.ok(/ACCOUNT_TOO_NEW/.test(q) && /removeItem\(LAST_VISIBILITY_KEY\)/.test(q));
  assert.ok(/publicBlocked && s\.visibility === "public"/.test(q));
});
test("fixture: the wizard scene answers requests before the children's first fetch", () => {
  const fx = src("../client/src/pages/dev/RoomFixture.tsx");
  const wizard = fx.slice(fx.indexOf("function WizardFixture"), fx.indexOf("const STATE_SCENES"));
  assert.ok(/useLayoutEffect\(\(\) => \{\s*const real = window\.fetch/.test(wizard));
  assert.ok(/minAccountAgeDays/.test(wizard));
});

// ---------------------------------------------------------------- copy rules
test("no em or en dashes and never the word 'cash' in any wizard copy", () => {
  assert.ok(WIZARD_UI_COPY.length > 40);
  for (const line of WIZARD_UI_COPY) {
    assert.equal(/[—–]/.test(line), false, `dash in: ${line}`);
    assert.equal(/cash/i.test(line), false, `cash in: ${line}`);
  }
});
test("no anonymous and no Teens only anywhere in the wizard copy", () => {
  for (const line of WIZARD_UI_COPY) {
    assert.equal(/anonymous/i.test(line), false, line);
    assert.equal(/teens only/i.test(line), false, line);
  }
});
test("the wizard's component files hold no em dashes or 'cash' either", () => {
  const dir = new URL("../client/src/components/rooms/create/", import.meta.url);
  for (const f of ["CreateRoomWizard.tsx", "StepBasics.tsx", "StepAudience.tsx", "StepFeatures.tsx", "StepWhen.tsx", "StepReview.tsx", "StepDone.tsx", "QuickStartSheet.tsx", "StartRoomFlow.tsx", "parts.tsx", "createRoomApi.ts"]) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.equal(/—/.test(src), false, `em dash in ${f}`);
    assert.equal(/\bcash\b/i.test(src), false, `cash in ${f}`);
    assert.equal(/anonymous/i.test(src), false, `anonymous in ${f}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
