// Pure rules for opening a profile from a room (no database): npx tsx scripts/test-rooms-unit-profilesafety.ts
import assert from "node:assert/strict";
import { showViewProfile, profilePath, leavesRoomHint } from "../client/src/lib/profilePath";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

test("View profile shows for yourself whatever the server said or hasn't said yet", () => {
  assert.equal(showViewProfile({ self: true, canViewProfile: true, profileAllowed: undefined }), true);
  assert.equal(showViewProfile({ self: true, canViewProfile: true, profileAllowed: false }), true);
});
test("View profile shows for someone else only when the server said the profile is allowed", () => {
  assert.equal(showViewProfile({ self: false, canViewProfile: true, profileAllowed: true }), true);
});
test("hidden while the answer is still loading or failed (undefined), never guessed", () => {
  assert.equal(showViewProfile({ self: false, canViewProfile: true, profileAllowed: undefined }), false);
});
test("hidden when either side has blocked the other (server says profile:false)", () => {
  assert.equal(showViewProfile({ self: false, canViewProfile: true, profileAllowed: false }), false);
});
test("the caller's own canViewProfile=false always wins", () => {
  assert.equal(showViewProfile({ self: false, canViewProfile: false, profileAllowed: true }), false);
  assert.equal(showViewProfile({ self: true, canViewProfile: false, profileAllowed: true }), false);
});
test("canViewProfile defaults to true when the caller does not pass it", () => {
  assert.equal(showViewProfile({ self: false, profileAllowed: true }), true);
});
test("hint: guests just leave; a host is told the room ends after the grace (2 minutes)", () => {
  assert.equal(leavesRoomHint(false), "This leaves the room.");
  assert.equal(leavesRoomHint(true), "This leaves the room. It ends if you're not back in 2 minutes.");
  assert.doesNotMatch(leavesRoomHint(true) + leavesRoomHint(false), /—|cash/i);
});
test("username gives /profile/<username>", () => assert.equal(profilePath({ username: "ada", userId: "1" }), "/profile/ada"));
test("no username gives /user/<id>", () => assert.equal(profilePath({ userId: "1" }), "/user/1"));
test("null or empty or blank username falls back to id", () => {
  assert.equal(profilePath({ username: null, userId: "1" }), "/user/1");
  assert.equal(profilePath({ username: "", userId: "1" }), "/user/1");
  assert.equal(profilePath({ username: "   ", userId: "1" }), "/user/1");
});
test("slash and spaces are encoded", () => {
  assert.equal(profilePath({ username: "a/b c", userId: "1" }), "/profile/a%2Fb%20c");
});
test("unsafe characters cannot escape the path", () => {
  const p = profilePath({ username: "../x?y#z", userId: "1" });
  assert.ok(p.startsWith("/profile/") && !p.slice(9).match(/[\/?#]/), p);
  assert.ok(!profilePath({ userId: "a/../b" }).slice(6).includes("/"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
