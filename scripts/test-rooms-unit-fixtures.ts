// Room fixture checks (no database):   npx tsx scripts/test-rooms-unit-fixtures.ts
import assert from "node:assert/strict";
import { FIXTURE_NAMES, fixtureState, type FixtureScene } from "../client/src/lib/roomFixtures";
import { roomReducer } from "../client/src/lib/roomReducer";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const SCENES: FixtureScene[] = ["voice", "live", "immersive", "weak", "dropped"];

for (const scene of SCENES) {
  test(`fixture ${scene}: 11 people, 9 chat lines, valid for the reducer`, () => {
    const s = fixtureState(scene);
    assert.equal(s.members.length, 11);
    assert.equal(s.memberCount, 11);
    assert.ok(s.chat.length >= 6);
    assert.equal(s.chat.length, 9);
    assert.equal(s.phase, "live");
    assert.equal(s.members.filter((m) => m.role === "host").length, 1);
    assert.equal(s.members.filter((m) => m.role === "cohost").length, 1);
    assert.ok(s.stage.length >= 1 && s.stage.every((id) => s.members.some((m) => m.userId === id)));
    assert.ok(s.selfId && s.members.some((m) => m.userId === s.selfId));
    assert.doesNotThrow(() => roomReducer(s, { type: "client:self", userId: s.selfId }));
    assert.equal(new Set(s.members.map((m) => m.userId)).size, 11);
  });
  test(`fixture ${scene}: every member and chat author has a name`, () => {
    const s = fixtureState(scene);
    for (const m of s.members) assert.ok(FIXTURE_NAMES[m.userId], m.userId);
    for (const c of s.chat) assert.ok(FIXTURE_NAMES[c.userId], c.userId);
  });
}
for (const scene of ["live", "immersive", "weak", "dropped"] as FixtureScene[]) {
  test(`fixture ${scene}: live video on, holder is a member`, () => {
    const s = fixtureState(scene);
    assert.equal(s.liveVideo, true);
    assert.ok(s.holder && s.members.some((m) => m.userId === s.holder));
  });
}
test("fixture voice: no live video, no holder", () => {
  const s = fixtureState("voice");
  assert.equal(s.liveVideo, false);
  assert.equal(s.holder, null);
});
test("fixture dropped: holder is away with a deadline", () => {
  assert.ok(fixtureState("dropped").holderAwayUntil !== null);
  assert.equal(fixtureState("live").holderAwayUntil, null);
});
test("fixture: one anonymous-looking guest labelled by name only", () => {
  const s = fixtureState("voice");
  const anon = s.members.filter((m) => !m.username && !m.avatarUrl);
  assert.equal(anon.length, 1);
  assert.ok(anon[0].displayName);
});
test("fixture: copy has no em dashes and no banned word", () => {
  const s = fixtureState("voice");
  const all = [...s.chat.map((c) => c.text), ...Object.values(FIXTURE_NAMES)].join(" ");
  assert.ok(!/—/.test(all));
  assert.ok(!/cash/i.test(all));
});
test("fixture: each call returns an independent state", () => {
  const a = fixtureState("voice"); a.chat.pop();
  assert.equal(fixtureState("voice").chat.length, 9);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
