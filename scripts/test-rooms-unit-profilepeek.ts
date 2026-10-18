import assert from "node:assert/strict";
import { profilePath, shouldFetchProfile, fillMissing } from "../client/src/lib/profilePath";

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

test("shouldFetchProfile: default true, false when disabled or anonymous or missing", () => {
  assert.equal(shouldFetchProfile({ userId: "1" }), true);
  assert.equal(shouldFetchProfile({ userId: "1" }, true), true);
  assert.equal(shouldFetchProfile({ userId: "1" }, false), false);
  assert.equal(shouldFetchProfile({ userId: "1", anonymous: true }, true), false);
  assert.equal(shouldFetchProfile(null, true), false);
});
test("fillMissing keeps known avatar and fills gaps", () => {
  const m = { userId: "1", avatar: { a: 1 }, displayName: null as string | null, avatarUrl: undefined as string | undefined };
  const r = fillMissing(m, { avatar: null, displayName: "Ada", avatarUrl: "u.png", bio: "hi" });
  assert.deepEqual(r.avatar, { a: 1 });
  assert.equal(r.displayName, "Ada");
  assert.equal(r.avatarUrl, "u.png");
  assert.equal((r as any).bio, "hi");
  assert.equal(fillMissing({ userId: "1", displayName: "Zed" }, { displayName: "Ada" }).displayName, "Zed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
