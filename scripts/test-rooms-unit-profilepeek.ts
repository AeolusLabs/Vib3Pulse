import assert from "node:assert/strict";
import { profilePath } from "../client/src/lib/profilePath";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

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
