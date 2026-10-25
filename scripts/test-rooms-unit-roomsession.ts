// The persistent room session: pure rules plus source wiring (no database, no browser): npx tsx scripts/test-rooms-unit-roomsession.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST_LEAVE_CONFIRM, initialSession, leaveNeedsConfirm, sessionAction, sessionStep, shouldEnd, type SessionEffect, type SessionEvent, type SessionState } from "../client/src/lib/roomSessionRules";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const A = { roomId: "a", token: null }, B = { roomId: "b", token: "t" };
/** Run events like the provider does, counting the effects it would perform (room:leave = "leave"). */
function run(events: SessionEvent[]) {
  let state: SessionState = initialSession;
  const fx: SessionEffect[] = [];
  const results: (string | undefined)[] = [];
  for (const e of events) { const r = sessionStep(state, e); state = r.state; fx.push(...r.effects); results.push(r.result); }
  return { state, fx, results };
}
const count = (fx: SessionEffect[], k: SessionEffect) => fx.filter((x) => x === k).length;

test("same room re-attaches without a second join", () => {
  assert.equal(sessionAction(A, { roomId: "a", token: "x" }), "attach");
  const r = run([{ type: "open", next: A }, { type: "minimise" }, { type: "open", next: A }]);
  assert.deepEqual(r.results, ["attached", undefined, "attached"]);
  assert.equal(count(r.fx, "join"), 1, "one join in total");
  assert.equal(count(r.fx, "leave"), 0);
  assert.equal(r.state.minimised, false, "re-attaching expands again");
});

test("a different room returns confirm and does not touch the live one", () => {
  assert.equal(sessionAction(A, B), "confirm");
  assert.equal(sessionAction(null, B), "start");
  const r = run([{ type: "open", next: A }, { type: "open", next: B }]);
  assert.equal(r.results[1], "needs-confirm");
  assert.equal(r.state.active?.roomId, "a");
  assert.equal(r.state.wantJoined, true);
  assert.deepEqual(r.fx, ["join"], "no leave, no hangUp, no second join");
  assert.deepEqual(r.state.pendingSwitch && { from: r.state.pendingSwitch.from, to: r.state.pendingSwitch.to }, { from: "a", to: "b" });
  const c = run([{ type: "open", next: A }, { type: "open", next: B }, { type: "cancelSwitch" }]);
  assert.equal(c.state.pendingSwitch, null);
  assert.equal(c.state.active?.roomId, "a");
  assert.deepEqual(c.fx, ["join"]);
  const ok = run([{ type: "open", next: A }, { type: "open", next: B }, { type: "confirmSwitch" }]);
  assert.equal(ok.state.active?.roomId, "b");
  assert.deepEqual(ok.fx, ["join", "leave", "hangUp", "join"], "old room left cleanly, then the new one starts");
});

test("ended/denied/kicked end the session", () => {
  assert.equal(shouldEnd("ended"), true);
  assert.equal(shouldEnd("denied"), true);
  assert.equal(shouldEnd("live", "KICKED"), true);
  for (const p of ["idle", "connecting", "live", "reconnecting"]) assert.equal(shouldEnd(p), false, p);
  for (const p of ["ended", "denied"]) {
    const r = run([{ type: "open", next: A }, { type: "phase", phase: p }]);
    assert.equal(r.state.ended, true);
    assert.equal(r.state.wantJoined, false);
    assert.deepEqual(r.fx, ["join", "hangUp"], "voice hung up; the server already dropped us, so no room:leave");
  }
  const rec = run([{ type: "open", next: A }, { type: "phase", phase: "reconnecting" }]);
  assert.equal(rec.state.ended, false, "reconnecting still counts as live");
  assert.deepEqual(rec.fx, ["join"]);
});

test("sign-out ends it", () => {
  const r = run([{ type: "open", next: A }, { type: "signOut" }]);
  assert.equal(r.state.active, null);
  assert.equal(r.state.wantJoined, false);
  assert.deepEqual(r.fx, ["join", "leave", "hangUp"]);
  assert.deepEqual(run([{ type: "signOut" }]).fx, [], "nothing to end when nothing is joined");
});

test("minimise keeps wantJoined true", () => {
  const r = run([{ type: "open", next: A }, { type: "minimise" }]);
  assert.equal(r.state.wantJoined, true);
  assert.equal(r.state.active?.roomId, "a");
  assert.equal(r.state.minimised, true);
  assert.deepEqual(r.fx, ["join"], "no leave, no hangUp");
});

test("leave sends exactly one room:leave", () => {
  const r = run([{ type: "open", next: A }, { type: "minimise" }, { type: "leave" }, { type: "leave" }]);
  assert.equal(count(r.fx, "leave"), 1);
  assert.equal(count(r.fx, "hangUp"), 1);
  assert.equal(r.state.active, null);
  assert.equal(r.state.wantJoined, false);
});

test("host warning only for a host on a live room", () => {
  assert.equal(leaveNeedsConfirm(true, true), true);
  assert.equal(leaveNeedsConfirm(true, false), false);
  assert.equal(leaveNeedsConfirm(false, true), false);
  assert.equal(HOST_LEAVE_CONFIRM, "You're hosting this live room. Leave and end your seat?");
});

test("wiring: hooks live in the provider, not the page; unmount no longer ends the session", () => {
  const page = src("../client/src/pages/RoomPage.tsx");
  assert.ok(!/useRoomSocket\(|useRoomVoice\(/.test(page), "the page does not call the hooks");
  assert.ok(page.includes("useRoomSession()") && page.includes("session.minimise()") && page.includes("onBack={minimiseAndBack}"));
  assert.ok(!page.includes("sock.leave()"), "Back and retry never leave through the socket directly");
  assert.ok(page.includes("HOST_LEAVE_CONFIRM") && page.includes("min-h-11"));
  const prov = src("../client/src/lib/roomSession.tsx");
  assert.ok(prov.includes("useRoomSocket(") && prov.includes("useRoomVoice(") && prov.includes('"signOut"'));
  assert.ok(src("../client/src/App.tsx").includes("<RoomSessionProvider>"));
  assert.ok(!src("../client/src/hooks/useRoomVoice.ts").includes("useEffect(() => hangUp, [hangUp])"));
  assert.ok(!/useEffect\(\(\) => \(\) => \{ if \(wantJoined\.current\)/.test(src("../client/src/hooks/useRoomSocket.ts")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
