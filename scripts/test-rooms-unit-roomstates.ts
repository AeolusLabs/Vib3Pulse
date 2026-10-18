// Pure rules and copy for the room state screens (no database, no browser): npx tsx scripts/test-rooms-unit-roomstates.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REMINDER_ERROR, STATE_TITLE, countdownTickMs, formatCountdown, initialReminder, kickRemainingMs, kickedBody, msUntil, recapLines, reminderFromResponse, reminderReducer, reminderRequest, stateForCode } from "../client/src/lib/roomStates";
import { DENIED_MESSAGE } from "../client/src/lib/roomsApi";

const DASH = String.fromCharCode(8212);
let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};

test("each server code maps to one state", () => {
  assert.equal(stateForCode("ROOM_FULL"), "full");
  assert.equal(stateForCode("KICKED"), "kicked");
  assert.equal(stateForCode("BANNED"), "banned");
  assert.equal(stateForCode("ROOM_ENDED"), "ended");
  assert.equal(stateForCode("ROOM_LOCKED"), "locked");
  assert.equal(stateForCode("ROOM_NOT_LIVE"), "notlive");
});
test("minors' room, age and unknown codes never get a state screen (they keep their own)", () => {
  for (const c of ["MINORS_ROOM", "MINORS_ROOM_ACK", "AGE_LIMIT", "AGE_UNKNOWN", "NOT_FOUND", "BLOCKED", "", null, undefined, 7, {}]) assert.equal(stateForCode(c), null, String(c));
});
test("every state has a title and its codes have copy in the one DENIED_MESSAGE table", () => {
  for (const code of ["ROOM_FULL", "KICKED", "BANNED", "ROOM_ENDED", "ROOM_LOCKED", "ROOM_NOT_LIVE"]) {
    assert.ok(DENIED_MESSAGE[code], code);
    assert.ok(STATE_TITLE[stateForCode(code)!], code);
  }
  assert.equal(DENIED_MESSAGE.ROOM_LOCKED, "The host has locked this room. Ask them to let you in.");
  assert.equal(DENIED_MESSAGE.ROOM_ENDED, "This room has ended.");
  assert.equal(DENIED_MESSAGE.BANNED, "You can't join this room.");
});
test("entries other tasks use are still there", () => {
  for (const k of ["AGE_LIMIT", "AGE_UNKNOWN", "BLOCKED", "NOT_FOUND", "MINORS_ROOM", "MINORS_ROOM_ACK"]) assert.ok(k in DENIED_MESSAGE, k);
});
test("countdown reads plainly", () => {
  const H = 3600_000, D = 24 * H;
  assert.equal(formatCountdown(2 * D + 3 * H + 5 * 60_000), "2d 3h");
  assert.equal(formatCountdown(3 * H + 5 * 60_000), "3h 5m");
  assert.equal(formatCountdown(12 * 60_000 + 40_000), "12m");
  assert.equal(formatCountdown(45_000), "45s");
  assert.equal(formatCountdown(0), "Starting now");
  assert.equal(formatCountdown(-5), "Starting now");
  assert.equal(formatCountdown(NaN), "Starting now");
});
test("msUntil and tick rate", () => {
  assert.equal(msUntil(null, 0), null);
  assert.equal(msUntil("not a date", 0), null);
  assert.equal(msUntil("2026-10-18T10:00:10.000Z", Date.parse("2026-10-18T10:00:00.000Z")), 10_000);
  assert.equal(countdownTickMs(30_000), 1000);
  assert.equal(countdownTickMs(10 * 60_000), 30_000);
  assert.equal(countdownTickMs(null), 30_000);
});
test("removed copy uses the remaining time when given, else ten minutes", () => {
  assert.match(kickedBody(null), /10 minutes/);
  assert.match(kickedBody(undefined), /10 minutes/);
  assert.match(kickedBody(9 * 60_000), /9 minutes/);
  assert.match(kickedBody(30_000), /1 minute\./);
  assert.match(kickedBody(0), /try again now/);
  assert.equal(kickRemainingMs({ retryAfterSeconds: 120 }, 0), 120_000);
  assert.equal(kickRemainingMs({ until: "2026-10-18T10:05:00.000Z" }, Date.parse("2026-10-18T10:00:00.000Z")), 300_000);
  assert.equal(kickRemainingMs({ ok: false, code: "KICKED" }, 0), null);
  assert.equal(kickRemainingMs(null, 0), null);
});
test("recap shows length and peak only when the room already has them", () => {
  assert.deepEqual(recapLines({}), []);
  assert.deepEqual(recapLines({ startedAt: "2026-10-18T10:00:00Z", endedAt: "2026-10-18T10:43:00Z" }), ["Lasted 43 min"]);
  assert.deepEqual(recapLines({ startedAt: "2026-10-18T10:00:00Z", endedAt: "2026-10-18T11:05:00Z", peakCount: 1 }), ["Lasted 1h 5m", "1 person at the busiest"]);
  assert.deepEqual(recapLines({ startedAt: "2026-10-18T10:00:00Z", endedAt: "2026-10-18T09:00:00Z", peakCount: 0 }), []);
});
test("reminder toggle is optimistic, reverts on failure, ignores taps in flight", () => {
  let s = initialReminder(false);
  s = reminderReducer(s, { type: "tap" });
  assert.deepEqual([s.on, s.pending, s.error], [true, true, null]);
  assert.equal(reminderReducer(s, { type: "tap" }), s);
  const failedS = reminderReducer(s, { type: "fail" });
  assert.deepEqual([failedS.on, failedS.pending, failedS.error], [false, false, REMINDER_ERROR]);
  const okS = reminderReducer(s, { type: "ok", on: true });
  assert.deepEqual([okS.on, okS.pending, okS.error], [true, false, null]);
  const off = reminderReducer(okS, { type: "tap" });
  assert.equal(off.on, false);
  assert.equal(reminderReducer(off, { type: "fail" }).on, true);
  assert.equal(reminderReducer(failedS, { type: "tap" }).error, null);
});
test("reminder requests follow the contract", () => {
  assert.deepEqual(reminderRequest("abc", true), { method: "PUT", url: "/api/rooms/abc/reminder" });
  assert.deepEqual(reminderRequest("abc", false), { method: "DELETE", url: "/api/rooms/abc/reminder" });
  assert.equal(reminderFromResponse({ reminder: false }, true), false);
  assert.equal(reminderFromResponse({}, true), true);
  assert.equal(reminderFromResponse(null, false), false);
});
test("the minors' warning and the age-unknown panel were not touched or rerouted", () => {
  const page = readFileSync("client/src/pages/RoomPage.tsx", "utf8");
  assert.ok(page.includes("MinorsRoomWarning code={minorsCode}"));
  assert.ok(page.includes("DENIED_MESSAGE.AGE_UNKNOWN"));
  assert.ok(page.indexOf("<MinorsRoomWarning") < page.indexOf("<RoomCodePanel"), "warning branches come first");
});
test("copy has no em dash and never the word cash", () => {
  const files = ["client/src/lib/roomStates.ts", "client/src/components/rooms/RoomStatePanels.tsx", "client/src/components/rooms/RoomLobby.tsx"];
  for (const f of files) { const t = readFileSync(f, "utf8"); assert.ok(!t.includes(DASH), f); assert.ok(!/cash/i.test(t), f); }
  for (const v of Object.values(DENIED_MESSAGE)) assert.ok(!v.includes(DASH) && !/cash/i.test(v));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
