// Live spray state on the client (no database, no browser):
//   npx tsx scripts/test-rooms-unit-spraylive.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialRoomState, roomReducer, type RoomState } from "../client/src/lib/roomReducer";
import { IDLE, holdsSprayBlock, sprayFlow } from "../client/src/lib/sprayUi";
import {
  SPRAY_LIVE_COPY, hostSprayLine, jitterMs, nextSprayRefetchDelay, sprayFlags, sprayOffMessage, sprayToastDecision, sprayToggleRefusal, sprayTransition, sprayVisible,
} from "../client/src/lib/sprayLive";

const src = (rel: string) => readFileSync(new URL(`../client/src/${rel}`, import.meta.url), "utf8");
let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

function live(extraRoom: Record<string, unknown> = {}): RoomState {
  let s = roomReducer(initialRoomState("me"), { type: "client:connecting" });
  s = roomReducer(s, { type: "room:state", room: { id: "r1", ...extraRoom }, members: [], memberCount: 0, screen: null, you: { role: "guest", muted: false } });
  return s;
}
const settings = (s: RoomState, extra: Record<string, unknown>) =>
  roomReducer(s, { type: "room:settings", pinnedMessage: null, slowModeSec: 0, locked: false, ...extra } as any);

test("reducer stores sprayOn and sprayBlockedByAdmin, ignores non-booleans", () => {
  let s = settings(live(), { sprayOn: true, sprayBlockedByAdmin: false });
  assert.equal(s.room?.sprayOn, true);
  assert.equal(s.room?.sprayBlockedByAdmin, false);
  s = settings(s, { sprayOn: "yes", sprayBlockedByAdmin: 1 });
  assert.equal(s.room?.sprayOn, true, "non-boolean is absent: left unchanged");
  assert.equal(s.room?.sprayBlockedByAdmin, false);
  s = settings(s, {});
  assert.equal(s.room?.sprayOn, true, "absent leaves the value");
  assert.equal("sprayOn" in (settings(live(), {}).room ?? {}), false, "a flag-off server adds nothing");
  const late = live({ sprayOn: false, sprayBlockedByAdmin: true });
  assert.equal(late.room?.sprayOn, false);
  assert.equal(late.room?.sprayBlockedByAdmin, true);
  const junk = live({ sprayOn: "x", sprayBlockedByAdmin: null });
  assert.equal("sprayOn" in (junk.room ?? {}), false);
  assert.equal("sprayBlockedByAdmin" in (junk.room ?? {}), false);
});

test("off hides the spray block immediately", () => {
  const block = { enabled: true };
  assert.equal(sprayVisible({ sprayOn: false }, block), null);
  assert.equal(sprayVisible({ sprayOn: true }, block), block);
  assert.equal(sprayVisible({}, block), block, "absent flag: unchanged");
  assert.equal(sprayVisible(null, block), block);
  assert.equal(sprayVisible({ sprayOn: true }, null), null);
  assert.equal(sprayTransition(true, false), "off");
  assert.equal(sprayOffMessage(false), "The host turned spray off");
  assert.equal(sprayOffMessage(true), "Spray was turned off for this room");
  assert.ok(src("pages/RoomPage.tsx").includes("sprayVisible(state.room, parsedSprayBlock)"));
});

test("off closes an open tray, not a submitted payment", () => {
  assert.match(src("components/rooms/shell/RoomShell.tsx"), /if \(!sprayBlock && !sprayHold\) \{ setSprayOpen\(false\)/);
  // The shell keeps the flow only while money is in motion or an outcome is unread; a confirm sheet is neither.
  let f = sprayFlow(IDLE, { type: "start", tier: "bundle" as any, targetId: "host", key: "11111111-1111-4111-8111-111111111111" });
  assert.equal(f.kind, "confirming");
  assert.equal(holdsSprayBlock(f), false);
  f = sprayFlow(f, { type: "pay", now: 1 });
  assert.equal(holdsSprayBlock(f), true, "a submitted payment keeps its flow and status screen");
});

test("on schedules exactly one jittered refetch", () => {
  assert.equal(sprayTransition(false, true), "on");
  assert.equal(sprayTransition(undefined, true), "on");
  assert.equal(sprayTransition(true, true), "none");
  assert.equal(sprayTransition(true, undefined), "none");
  assert.equal(jitterMs(0), 0);
  assert.equal(jitterMs(0.5), 1500);
  assert.equal(jitterMs(1), 3000);
  assert.equal(jitterMs(-1), 0);
  assert.equal(jitterMs(NaN), 0);
  assert.equal(nextSprayRefetchDelay(10_000, null, false, 1234), 1234);
  assert.equal(nextSprayRefetchDelay(10_000, null, true, 1234), null, "already scheduled");
  const hook = src("hooks/useSprayLive.ts");
  assert.equal((hook.match(/setTimeout\(/g) ?? []).length, 1);
  assert.match(hook, /jitterMs\(Math\.random\(\)\)/);
});

test("ON within 2 s of the last refetch is deferred, not dropped", () => {
  assert.equal(nextSprayRefetchDelay(11_000, 10_000, false, 0), 1000);
  assert.equal(nextSprayRefetchDelay(11_000, 10_000, false, 1500), 1500, "jitter wins when longer");
  assert.equal(nextSprayRefetchDelay(12_000, 10_000, false, 0), 0);
});

test("OFF then ON at 3.0 s after a refetch at 2.9 s schedules at lastAt+2000", () => {
  assert.equal(nextSprayRefetchDelay(3000, 2900, false, 0), 1900, "runs at 4.9 s = lastAt + 2000");
});

test("pending timer is not pushed later", () => {
  assert.equal(nextSprayRefetchDelay(3000, 2900, true, 2500), null);
});

test("first state of a session never toasts", () => {
  const hook = src("hooks/useSprayLive.ts");
  assert.match(hook, /if \(sprayOn === undefined\) return;/);
  for (const next of [true, false]) assert.deepEqual(sprayToastDecision(undefined, next, { blockedByAdmin: false, isHost: false }), { toast: null, schedule: false, cancel: false });
});

test("admin-blocked off toast text", () => {
  assert.equal(sprayToastDecision(true, false, { blockedByAdmin: true, isHost: false }).toast, "Spray was turned off for this room");
  assert.equal(sprayToastDecision(true, false, { blockedByAdmin: true, isHost: true }).toast, "Spray was turned off for this room");
});

test("host OFF toast text", () => {
  assert.equal(sprayToastDecision(true, false, { blockedByAdmin: false, isHost: false }).toast, "The host turned spray off");
  assert.equal(sprayToastDecision(true, false, { blockedByAdmin: false, isHost: true }).toast, null, "the host switched it themselves");
  assert.equal(sprayToastDecision(false, true, { blockedByAdmin: false, isHost: false }).schedule, true);
});

test("host is told when the platform switched spray off under their setting", () => {
  assert.equal(hostSprayLine({ sprayOn: false, sprayEnabled: true }), "Spray is switched off by the platform right now. Your setting is kept.");
  assert.equal(hostSprayLine({ sprayOn: false, sprayEnabled: true, sprayBlockedByAdmin: true }), null);
  assert.equal(hostSprayLine({ sprayOn: false, sprayEnabled: false }), null);
  assert.equal(hostSprayLine({ sprayOn: true, sprayEnabled: true }), null);
  assert.equal(hostSprayLine({ sprayEnabled: true }), null);
  assert.match(src("components/rooms/host/ControlsMoney.tsx"), /setOverride\(next\)/, "a saved change shows until the next settings event");
});

test("host sees the admin-block message and a disabled switch", () => {
  assert.equal(SPRAY_LIVE_COPY.adminBlocked, "Spray is turned off by the platform for this room. Only an admin can turn it back on.");
  assert.match(src("components/rooms/host/ControlsMoney.tsx"), /blocked: blocked \? SPRAY_LIVE_COPY\.adminBlocked : undefined/);
  const step = src("components/rooms/create/StepSpray.tsx");
  assert.match(step, /spray\.blocked \? spray\.blocked/, "the blocked line is the switch's disabledReason, so the switch is disabled");
  assert.match(step, /checked=\{spray\.on && !locked && !spray\.blocked\}/);
  assert.deepEqual(sprayFlags({ sprayOn: false, sprayBlockedByAdmin: true }), { sprayOn: false, sprayBlockedByAdmin: true });
});

test("429 cooldown and 403 admin-block messages", () => {
  assert.equal(sprayToggleRefusal({ status: 429, code: "SPRAY_TOGGLE_COOLDOWN", retryMs: 2400 })?.text, "Wait 3 seconds before switching again");
  assert.equal(sprayToggleRefusal({ status: 429, code: "SPRAY_TOGGLE_COOLDOWN" })?.text, "Wait a few seconds before switching again");
  const blocked = sprayToggleRefusal({ status: 403, code: "SPRAY_ADMIN_BLOCKED" });
  assert.equal(blocked?.adminBlocked, true);
  assert.equal(blocked?.text, SPRAY_LIVE_COPY.adminBlocked);
  assert.equal(sprayToggleRefusal({ status: 409, code: "NOT_SCHEDULED" }), null);
  const money = src("components/rooms/host/ControlsMoney.tsx");
  assert.match(money, /if \(res\.ok\) \{ setOn\(next\)/, "the switch only moves on success: no optimistic update across a refusal");
  assert.match(money, /if \(live\?\.adminBlocked\) \{ setBlockSeen\(true\); onChanged\?\.\(\)/);
  assert.match(src("components/rooms/create/createRoomApi.ts"), /retryMs/);
});

test("flag off: no new requests", () => {
  const s = settings(live(), {});
  assert.equal(sprayFlags(s.room).sprayOn, undefined);
  assert.match(src("hooks/useSprayLive.ts"), /if \(sprayOn === undefined\) return;/, "no flag, no timer, no refetch, no toast");
  assert.equal(sprayVisible(s.room, "block"), "block");
  assert.match(src("components/rooms/shell/RoomShell.tsx"), /spraySlot=\{sprayPossible && sprayFlags\(state\.room\)\.sprayOn === true && !sprayBlock\}/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
