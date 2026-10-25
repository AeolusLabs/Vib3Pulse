// Unit tests for the Money section (Paid room + Spray) of the wizard and Controls. No DB, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stepsFor, wizardOptions, type WizardHost, type WizardState } from "../client/src/lib/createRoomRules";
import { buildCreatePayload, defaultWizardState, fieldSelectors } from "../client/src/lib/createRoomWizardUi";
import { moneyAwareStaleTime } from "../client/src/lib/roomsApi";
import { MONEY_COPY, moneyRefusal, moneyView, type MoneyReadiness } from "../client/src/lib/moneySection";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const adult: WizardHost = { age: 30, accountAgeDays: 100, idVerifiedAdult: true };
const teen: WizardHost = { age: 15, accountAgeDays: 100, idVerifiedAdult: false };
const sprayOnly = { paidRooms: false, spray: true };
const both = { paidRooms: true, spray: true };
const none = { paidRooms: false, spray: false };
const ready: MoneyReadiness = { adult: true, idVerified: true, payoutAccount: true };
const state = (o: Partial<WizardState> = {}): WizardState => defaultWizardState({ title: "Friday", ...o });
const BASE = ["basics", "audience", "features", "when", "review"];

test('stepsFor includes "money" when only spray flag on and host/room eligible', () => {
  assert.deepEqual(stepsFor(state({ ageLimit: "18+" }), sprayOnly, adult), ["basics", "audience", "features", "money", "when", "review"]);
});
test("stepsFor excludes it for a teen host or a 13+ room", () => {
  assert.deepEqual(stepsFor(state({ ageLimit: "13+" }), sprayOnly, adult), BASE);
  assert.deepEqual(stepsFor(state({ ageLimit: "18+" }), sprayOnly, teen), BASE);
  assert.deepEqual(stepsFor(state({ ageLimit: "18+" }), none, adult), BASE);
  assert.equal(wizardOptions(adult, sprayOnly, 0, "18+").moneyLocked, null);
});
test("payload sends sprayEnabled only when true and the flag is on", () => {
  const on = state({ ageLimit: "18+", sprayEnabled: true });
  assert.equal((buildCreatePayload(on, { sprayFlag: true }) as any).sprayEnabled, true);
  assert.equal("sprayEnabled" in buildCreatePayload(on, { sprayFlag: false }), false);
  assert.equal("sprayEnabled" in buildCreatePayload(on), false);
  assert.equal("sprayEnabled" in buildCreatePayload(state({ ageLimit: "18+", sprayEnabled: false }), { sprayFlag: true }), false);
  assert.equal(defaultWizardState().sprayEnabled, false);
});
test("checklist lists each missing item with its fix link", () => {
  const v = moneyView({ flags: both, readiness: { adult: true, idVerified: false, payoutAccount: false }, ageLimit: "18+" });
  const byId = Object.fromEntries(v.items.map((i) => [i.id, i]));
  assert.equal(byId.adult.met, true);
  assert.equal(byId.adult.fix, null);
  assert.equal(byId.idVerified.met, false);
  assert.ok(byId.idVerified.why && byId.idVerified.fix?.href === "/account/settings");
  assert.ok(byId.payoutAccount.why && byId.payoutAccount.fix?.href === "/rooms/payouts");
  assert.equal(byId.adultRoom.met, true);
  assert.equal(byId.platform.met, true);
  const nobody = moneyView({ flags: both, readiness: { adult: false, idVerified: false, payoutAccount: false }, ageLimit: "21+" });
  assert.ok(nobody.items.filter((i) => !i.met).every((i) => i.why && i.fix));
});
test("switch is disabled with a reason until readiness is met", () => {
  const miss = moneyView({ flags: both, readiness: { adult: true, idVerified: true, payoutAccount: false }, ageLimit: "18+" });
  assert.equal(miss.spray.available, false);
  assert.match(miss.spray.reason ?? "", /bank account/);
  assert.equal(miss.paid.available, false);
  const ok = moneyView({ flags: both, readiness: ready, ageLimit: "18+" });
  assert.deepEqual([ok.spray, ok.paid], [{ available: true, reason: null }, { available: true, reason: null }]);
});
test("a switch whose platform flag is off is shown disabled as 'Not switched on yet', not hidden", () => {
  const v = moneyView({ flags: sprayOnly, readiness: ready, ageLimit: "18+" });
  assert.equal(v.visible, true);
  assert.deepEqual(v.paid, { available: false, reason: "Not switched on yet" });
  assert.equal(v.spray.available, true);
  assert.equal(v.items.find((i) => i.id === "platform")!.met, false);
});
test("locked section shows the reason for a 13+ room", () => {
  for (const ageLimit of ["all", "13+", "16+"]) {
    const v = moneyView({ flags: both, readiness: ready, ageLimit });
    assert.equal(v.lockedReason, "Change the room to 18+ to sell tickets or take spray");
    assert.equal(v.spray.available, false);
    assert.equal(v.paid.reason, v.lockedReason);
  }
  assert.equal(moneyView({ flags: both, readiness: ready, ageLimit: "18+", minorsRoom: true }).lockedReason, MONEY_COPY.lockedAge);
  assert.equal(moneyView({ flags: both, readiness: ready, ageLimit: "21+" }).lockedReason, null);
});
test("nothing renders with both platform flags off", () => {
  assert.equal(moneyView({ flags: none, readiness: undefined, ageLimit: "18+" }).visible, false);
  assert.equal(moneyView({ flags: undefined, readiness: undefined, ageLimit: "18+" }).visible, false);
  assert.match(src("../client/src/components/rooms/create/StepSpray.tsx"), /if \(!view\.visible\) return null;/);
  assert.match(src("../client/src/components/rooms/host/ControlsMoney.tsx"), /if \(!view\.visible\) return null;/);
});
test("server refusal codes map to inline messages", () => {
  for (const c of ["FEATURE_OFF", "HOST_NOT_ADULT", "HOST_NOT_VERIFIED", "NO_PAYOUT_ACCOUNT", "ROOM_NOT_ADULT"]) assert.ok(moneyRefusal(c), c);
  assert.equal(moneyRefusal("TEEN_PUBLIC"), null);
  assert.equal(moneyRefusal(undefined), null);
});
test("Controls: PATCH sprayEnabled, confirm only when turning off a live room", () => {
  const f = src("../client/src/components/rooms/host/ControlsMoney.tsx");
  assert.ok(f.includes('"PATCH"') && f.includes("{ sprayEnabled: next }"));
  assert.ok(f.includes('!next && room.status === "live"'));
  assert.equal(MONEY_COPY.confirmOffBody, "People can't tip once this is off.");
});
test("placeholder copy no longer used", () => {
  for (const p of [
    "../client/src/lib/createRoomWizardUi.ts", "../client/src/components/rooms/create/StepFeatures.tsx", "../client/src/components/rooms/create/CreateRoomWizard.tsx",
    "../client/src/components/rooms/host/SettingsPanel.tsx", "../client/src/components/rooms/host/ControlsSheet.tsx", "../client/src/lib/hostControls.ts",
  ]) {
    const t = src(p);
    assert.equal(/money-placeholder|moneyPlaceholder\b|not available here yet|moneyNote/.test(t.replace(/moneyPlaceholderVisible/g, "")), false, p);
  }
});

test("controls reflects the saved spray value after a PATCH", () => {
  const f = src("../client/src/components/rooms/host/ControlsMoney.tsx");
  assert.ok(f.includes("if (res.ok) { setOn(next); onChanged?.(); }"), "saved value kept and the room refetched");
  assert.ok(f.includes('if (on && !next && room.status === "live")'), "confirm only when the saved value is on");
  assert.ok(src("../client/src/components/rooms/host/ControlsSheet.tsx").includes("<ControlsMoney roomId={roomId} onChanged={onSprayChanged}"));
  assert.ok(src("../client/src/components/rooms/shell/RoomShell.tsx").includes("onSprayChanged={onSprayChanged}"), "RoomShell passes the room refetch");
});
test("readiness refetches on open", () => {
  const on = { state: { data: { features: { paidRooms: false, spray: true } } as any } };
  const off = { state: { data: { features: { paidRooms: false, spray: false } } as any } };
  assert.equal(moneyAwareStaleTime(on), 0, "a money flag is on: always stale, so open/mount refetches");
  assert.equal(moneyAwareStaleTime(off), 5 * 60 * 1000, "both flags off: no extra requests");
  assert.equal(moneyAwareStaleTime({ state: { data: undefined } }), 5 * 60 * 1000);
  assert.match(src("../client/src/components/rooms/create/createRoomApi.ts"), /staleTime: moneyAwareStaleTime, enabled: open/);
  assert.match(src("../client/src/components/rooms/host/ControlsMoney.tsx"), /useRoomsConfig\(true\)/);
});

test("a sprayEnabled error focuses the Money spray switch (id matches StepSpray)", () => {
  assert.deepEqual(fieldSelectors("sprayEnabled"), ["#money-spray"]);
  assert.match(readFileSync(new URL("../client/src/components/rooms/create/StepSpray.tsx", import.meta.url), "utf8"), /id=\{`\$\{testPrefix\}-spray`\}/);
});
test("readiness fix links open in a new tab with a hint, and the config refetches on focus", () => {
  const step = readFileSync(new URL("../client/src/components/rooms/create/StepSpray.tsx", import.meta.url), "utf8");
  assert.match(step, /target="_blank" rel="noopener noreferrer"/);
  assert.match(step, /MONEY_COPY\.opensNewTab/);
  assert.equal(MONEY_COPY.opensNewTab, "opens in a new tab");
  assert.match(readFileSync(new URL("../client/src/lib/roomsApi.ts", import.meta.url), "utf8"), /refetchOnWindowFocus: fresh/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
