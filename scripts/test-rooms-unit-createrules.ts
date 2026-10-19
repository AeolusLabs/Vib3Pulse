// Unit tests for the create-room wizard rules. Written, not yet run (owner rule: no testing until all phases are done).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountTooNewFor, normalizeWizard, stepsFor, validateWizard, wizardOptions, type WizardHost, type WizardState } from "../client/src/lib/createRoomRules";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const adult: WizardHost = { age: 30, accountAgeDays: 100, idVerifiedAdult: true };
const teen: WizardHost = { age: 15, accountAgeDays: 100, idVerifiedAdult: false };
const off = { paidRooms: false, spray: false };
const on = { paidRooms: true, spray: false };
const state = (o: Partial<WizardState> = {}): WizardState => ({
  title: "Friday listening", description: "", kind: "listening", ageLimit: "all", visibility: "friends", voice: true, liveVideo: false,
  slowModeSec: 0, pinned: "", capacity: 50, when: "now", scheduledFor: null, ...o,
});
const NOW = new Date("2026-10-18T12:00:00Z");
const EM = String.fromCharCode(0x2014);

const ADULT_ONLY = "You need to be 18 to host an adult room.";
const TEEN_PUBLIC = "Public rooms are for adults. Try a friends-only or invite-only room.";
const TOO_NEW = "Your account is too new to host a public room. Try a friends-only or invite-only room.";
const NEED_16 = "You need to be 16 to host a 16+ room.";
const NEED_21 = "You need to be 21 to host a 21+ room.";
const teen17: WizardHost = { age: 17, accountAgeDays: 100, idVerifiedAdult: false };
const young: WizardHost = { age: 19, accountAgeDays: 100, idVerifiedAdult: true };
const reasonOf = (h: WizardHost) => Object.fromEntries(wizardOptions(h, off).ageOptions.map((a) => [a.value, a.disabledReason]));

test("adult host: all five age options, none disabled, no teen option", () => {
  const o = wizardOptions(adult, off);
  assert.deepEqual(o.ageOptions.map((a) => a.value), ["all", "13+", "16+", "18+", "21+"]);
  assert.ok(o.ageOptions.every((a) => a.disabledReason === undefined));
  assert.equal(o.teenHostNote, false);
});
test("teen host under 16: 16+ needs 16, 18+ and 21+ disabled with the exact adult reason, others open", () => {
  const o = wizardOptions(teen, off);
  assert.deepEqual(reasonOf(teen), { all: undefined, "13+": undefined, "16+": NEED_16, "18+": ADULT_ONLY, "21+": ADULT_ONLY });
  assert.equal(o.teenHostNote, true);
});
test("teen host aged 16 or 17: 16+ open, 18+ and 21+ disabled with the adult reason", () => {
  assert.deepEqual(reasonOf(teen17), { all: undefined, "13+": undefined, "16+": undefined, "18+": ADULT_ONLY, "21+": ADULT_ONLY });
});
test("adult host aged 18 to 20: only 21+ disabled, with the 21 reason (the server refuses HOST_BELOW_LIMIT)", () => {
  assert.deepEqual(reasonOf(young), { all: undefined, "13+": undefined, "16+": undefined, "18+": undefined, "21+": NEED_21 });
  assert.equal(reasonOf({ ...young, age: 21 })["21+"], undefined);
  assert.equal(reasonOf({ ...young, age: 18 })["18+"], undefined);
});
test("unknown age: no age option is judged (the whole wizard is blocked instead)", () => {
  assert.ok(wizardOptions({ ...adult, age: null }, off).ageOptions.every((a) => a.disabledReason === undefined));
});
test("visibility: adult open; teen public disabled; new adult account public disabled", () => {
  assert.ok(wizardOptions(adult, off).visibilityOptions.every((v) => !v.disabledReason));
  const t = wizardOptions(teen, off).visibilityOptions;
  assert.equal(t.find((v) => v.value === "public")!.disabledReason, TEEN_PUBLIC);
  assert.equal(t.find((v) => v.value === "friends")!.disabledReason, undefined);
  assert.equal(t.find((v) => v.value === "invite")!.disabledReason, undefined);
  const fresh = wizardOptions({ ...adult, accountAgeDays: 1 }, off, 7).visibilityOptions;
  assert.equal(fresh.find((v) => v.value === "public")!.disabledReason, TOO_NEW);
  assert.equal(wizardOptions({ ...adult, accountAgeDays: 7 }, off, 7).visibilityOptions[0].disabledReason, undefined);
});
test("moneyLocked: other ages and teen hosts get the adult-only reason", () => {
  for (const l of ["all", "13+", "16+"] as const) assert.equal(wizardOptions(adult, on, 0, l).moneyLocked, "Money features are only for adult rooms.");
  assert.equal(wizardOptions(teen, on, 0, "13+").moneyLocked, "Money features are only for adult rooms.");
  assert.equal(wizardOptions(teen, on, 0, "18+").moneyLocked, "Money features are only for adult rooms.");
});
test("moneyLocked: adult at 18+ with flags off is not-available-yet; null when a flag is on", () => {
  assert.equal(wizardOptions(adult, off, 0, "18+").moneyLocked, "Paid rooms and spray are not available yet.");
  assert.equal(wizardOptions(adult, off, 0, "21+").moneyLocked, "Paid rooms and spray are not available yet.");
  assert.equal(wizardOptions(adult, on, 0, "18+").moneyLocked, null);
  assert.equal(wizardOptions(adult, { paidRooms: false, spray: true }, 0, "21+").moneyLocked, null);
});
test("normalizeWizard: teen host 18+/21+ becomes 13+, public becomes friends", () => {
  assert.equal(normalizeWizard(state({ ageLimit: "18+" }), teen).ageLimit, "13+");
  assert.equal(normalizeWizard(state({ ageLimit: "21+" }), teen).ageLimit, "13+");
  assert.equal(normalizeWizard(state({ ageLimit: "18+" }), teen17).ageLimit, "13+", "revisions: a teen's adult limit is 13+, not 16+");
  assert.equal(normalizeWizard(state({ ageLimit: "21+" }), teen17).ageLimit, "13+");
  assert.equal(normalizeWizard(state({ visibility: "public" }), teen).visibility, "friends");
  assert.equal(normalizeWizard(state({ visibility: "invite" }), teen).visibility, "invite");
});
test("normalizeWizard: an age limit above the host steps down to the highest one they may use", () => {
  assert.equal(normalizeWizard(state({ ageLimit: "16+" }), teen).ageLimit, "13+", "13 to 15: 16+ becomes 13+");
  assert.equal(normalizeWizard(state({ ageLimit: "16+" }), { ...teen, age: 13 }).ageLimit, "13+");
  assert.equal(normalizeWizard(state({ ageLimit: "16+" }), teen17).ageLimit, "16+", "16 and 17 keep 16+");
  assert.equal(normalizeWizard(state({ ageLimit: "21+" }), young).ageLimit, "18+", "18 to 20: 21+ becomes 18+");
  assert.equal(normalizeWizard(state({ ageLimit: "21+" }), { ...young, age: 18 }).ageLimit, "18+");
  assert.equal(normalizeWizard(state({ ageLimit: "18+" }), young).ageLimit, "18+");
  assert.equal(normalizeWizard(state({ ageLimit: "21+" }), { ...young, age: 21 }).ageLimit, "21+");
  assert.equal(normalizeWizard(state({ ageLimit: "all" }), teen).ageLimit, "all");
  // whatever it picks is never refused by validateWizard on the age limit
  for (const h of [teen, teen17, young, adult]) for (const l of ["all", "13+", "16+", "18+", "21+"] as const) {
    const r = validateWizard(normalizeWizard(state({ ageLimit: l }), h), h, NOW);
    assert.ok(r.ok || r.field !== "ageLimit", `${h.age} ${l}`);
  }
});
test("normalizeWizard: adult host is left alone", () => {
  const s = state({ ageLimit: "21+", visibility: "public" });
  assert.deepEqual(normalizeWizard(s, adult), s);
});
test("normalizeWizard: slow mode snaps to an allowed value", () => {
  assert.equal(normalizeWizard(state({ slowModeSec: 15 }), adult).slowModeSec, 15);
  assert.equal(normalizeWizard(state({ slowModeSec: 14 }), adult).slowModeSec, 15);
  assert.equal(normalizeWizard(state({ slowModeSec: 999 }), adult).slowModeSec, 30);
  assert.equal(normalizeWizard(state({ slowModeSec: -4 }), adult).slowModeSec, 0);
  assert.equal(normalizeWizard(state({ slowModeSec: NaN }), adult).slowModeSec, 0);
});
test("normalizeWizard: pinned trimmed to 200, capacity clamped", () => {
  assert.equal(normalizeWizard(state({ pinned: "  hi  " }), adult).pinned, "hi");
  assert.equal(normalizeWizard(state({ pinned: "x".repeat(500) }), adult).pinned.length, 200);
  assert.equal(normalizeWizard(state({ capacity: 9999 }), adult).capacity, 50);
  assert.equal(normalizeWizard(state({ capacity: 0 }), adult).capacity, 2);
  assert.equal(normalizeWizard(state({ capacity: 20.4 }), adult).capacity, 20);
});
test("normalizeWizard: when now clears scheduledFor; later keeps it", () => {
  assert.equal(normalizeWizard(state({ when: "now", scheduledFor: "2026-12-01T10:00" }), adult).scheduledFor, null);
  assert.equal(normalizeWizard(state({ when: "later", scheduledFor: "2026-12-01T10:00" }), adult).scheduledFor, "2026-12-01T10:00");
});
test("validateWizard: dates", () => {
  assert.deepEqual(validateWizard(state(), adult, NOW), { ok: true });
  const past = validateWizard(state({ when: "later", scheduledFor: "2026-10-01T10:00:00Z" }), adult, NOW);
  assert.equal(past.ok, false);
  assert.equal((past as any).field, "scheduledFor");
  const none = validateWizard(state({ when: "later", scheduledFor: null }), adult, NOW);
  assert.equal(none.ok, false);
  assert.deepEqual(validateWizard(state({ when: "later", scheduledFor: "2026-12-01T10:00:00Z" }), adult, NOW), { ok: true });
  // a past date stays invalid after normalizing
  const n = normalizeWizard(state({ when: "later", scheduledFor: "2026-10-01T10:00:00Z" }), adult);
  assert.equal(validateWizard(n, adult, NOW).ok, false);
});
test("validateWizard: title, unknown age, teen combos", () => {
  assert.equal((validateWizard(state({ title: "   " }), adult, NOW) as any).field, "title");
  assert.equal((validateWizard(state({ title: "x".repeat(81) }), adult, NOW) as any).field, "title");
  assert.equal((validateWizard(state(), { ...adult, age: null }, NOW) as any).field, "ageLimit");
  assert.equal((validateWizard(state({ ageLimit: "18+" }), teen, NOW) as any).reason, ADULT_ONLY);
  assert.equal((validateWizard(state({ visibility: "public" }), teen, NOW) as any).reason, TEEN_PUBLIC);
});
test("validateWizard: age limit above the host is refused with the same words the option shows", () => {
  assert.equal((validateWizard(state({ ageLimit: "16+" }), teen, NOW) as any).reason, NEED_16);
  assert.equal((validateWizard(state({ ageLimit: "16+" }), teen, NOW) as any).field, "ageLimit");
  assert.equal((validateWizard(state({ ageLimit: "21+" }), young, NOW) as any).reason, NEED_21);
  assert.equal((validateWizard(state({ ageLimit: "21+" }), teen17, NOW) as any).reason, ADULT_ONLY);
  assert.deepEqual(validateWizard(state({ ageLimit: "16+" }), teen17, NOW), { ok: true });
  assert.deepEqual(validateWizard(state({ ageLimit: "18+" }), young, NOW), { ok: true });
});
test("validateWizard: a public room from an account younger than the minimum is refused", () => {
  const fresh: WizardHost = { ...adult, accountAgeDays: 2 };
  const r = validateWizard(state({ visibility: "public" }), fresh, NOW, 7);
  assert.equal(r.ok, false);
  assert.equal((r as any).field, "visibility");
  assert.equal((r as any).reason, TOO_NEW);
  assert.deepEqual(validateWizard(state({ visibility: "friends" }), fresh, NOW, 7), { ok: true }, "friends is fine");
  assert.deepEqual(validateWizard(state({ visibility: "invite" }), fresh, NOW, 7), { ok: true }, "invite is fine");
  assert.deepEqual(validateWizard(state({ visibility: "public" }), { ...adult, accountAgeDays: 7 }, NOW, 7), { ok: true }, "exactly the minimum is old enough");
  assert.deepEqual(validateWizard(state({ visibility: "public" }), fresh, NOW), { ok: true }, "minimum unknown (0): the server decides");
  assert.equal((validateWizard(state({ visibility: "public" }), { ...teen, accountAgeDays: 2 }, NOW, 7) as any).reason, TEEN_PUBLIC, "a teen hears the teen reason");
});
test("accountTooNewFor: below the minimum only", () => {
  assert.equal(accountTooNewFor({ ...adult, accountAgeDays: 6.9 }, 7), true);
  assert.equal(accountTooNewFor({ ...adult, accountAgeDays: 7 }, 7), false);
  assert.equal(accountTooNewFor({ ...adult, accountAgeDays: 0 }, 0), false);
});
test("module source: slow modes and the pinned limit come from @shared/rooms, not hand copies", () => {
  const src = readFileSync(new URL("../client/src/lib/createRoomRules.ts", import.meta.url), "utf8");
  assert.ok(/SLOW_MODES/.test(src) && /ROOM_LIMITS\.pinned/.test(src));
  assert.ok(!/\[0, 5, 15, 30\]/.test(src));
  assert.ok(!/=\s*200\b/.test(src));
});
test("stepsFor: money step only when unlocked and a flag is on", () => {
  const base = ["basics", "audience", "features", "when", "review"];
  assert.deepEqual(stepsFor(state(), off, adult), base);
  assert.deepEqual(stepsFor(state({ ageLimit: "18+" }), off, adult), base);
  assert.deepEqual(stepsFor(state({ ageLimit: "18+" }), on, adult), ["basics", "audience", "features", "money", "when", "review"]);
  assert.deepEqual(stepsFor(state({ ageLimit: "13+" }), on, adult), base);
  assert.deepEqual(stepsFor(state({ ageLimit: "13+" }), on, teen), base);
});
test("module source: no anonymous wording, no em dash, no cash", () => {
  const src = readFileSync(new URL("../client/src/lib/createRoomRules.ts", import.meta.url), "utf8");
  assert.ok(!/anonymous/i.test(src));
  assert.ok(!src.includes(EM));
  assert.ok(!/cash/i.test(src));
});
test("every user-facing string: no em dash, no cash", () => {
  const o = wizardOptions(teen, off);
  const strings = [
    ...o.ageOptions.flatMap((a) => [a.label, a.sub, a.disabledReason ?? ""]),
    ...o.visibilityOptions.map((v) => v.disabledReason ?? ""),
    o.moneyLocked ?? "",
    wizardOptions(adult, off, 99, "18+").visibilityOptions[0].disabledReason ?? "",
    wizardOptions(adult, off, 0, "18+").moneyLocked ?? "",
    ...wizardOptions(young, off).ageOptions.map((a) => a.disabledReason ?? ""),
    (validateWizard(state({ title: "" }), adult, NOW) as any).reason,
    (validateWizard(state({ when: "later" }), adult, NOW) as any).reason,
  ];
  for (const s of strings) { assert.ok(!s.includes(EM)); assert.ok(!/cash/i.test(s)); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
