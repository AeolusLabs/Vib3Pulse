// Who the room:state member list carries (no database):   npx tsx scripts/test-rooms-unit-memberlist.ts
import assert from "node:assert/strict";
import { MEMBER_LIST_CAP, selectStateMembers, wantedMemberIds } from "../server/rooms/memberList";
import { ROOM_LIMITS } from "../shared/rooms";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i + 1}` }));

test("cap: a full free room (capacityMax) is sent whole", () => {
  assert.ok(MEMBER_LIST_CAP >= ROOM_LIMITS.capacityMax);
  assert.equal(selectStateMembers(people(ROOM_LIMITS.capacityMax), MEMBER_LIST_CAP, []).length, ROOM_LIMITS.capacityMax);
});
test("cap: 45 people (over the old 40 cap) are all sent", () => {
  const out = selectStateMembers(people(45), MEMBER_LIST_CAP, []);
  assert.deepEqual(out.map((m) => m.userId), people(45).map((m) => m.userId));
});
test("beyond the cap, wanted people (chat authors, stage, asks) are still sent, once, after the first block", () => {
  const all = people(120);
  const out = selectStateMembers(all, MEMBER_LIST_CAP, ["u100", "u3", "u100", "u119", "nobody"]);
  assert.equal(out.length, MEMBER_LIST_CAP + 2);
  assert.deepEqual(out.slice(-2).map((m) => m.userId), ["u100", "u119"]);
  assert.equal(new Set(out.map((m) => m.userId)).size, out.length);
});
test("wanted ids: stage, hands, asks, holder, recent chat authors and the people they quoted", () => {
  const w = wantedMemberIds({
    stage: ["s1"], hands: ["h1"], asks: ["a1"], holder: "live1",
    chat: [{ userId: "c1", text: "x" }, { userId: "c2", text: "y", replyTo: { userId: "q1", text: "z" } }],
  });
  for (const id of ["s1", "h1", "a1", "live1", "c1", "c2", "q1"]) assert.ok(w.has(id), id);
  assert.equal(wantedMemberIds({ stage: [], hands: [], asks: [], holder: null, chat: [] }).size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
