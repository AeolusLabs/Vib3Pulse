// Rooms hype checks (no database, no DOM):   npx tsx scripts/test-rooms-unit-hype.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { HYPE, hypeNext, hypeDecay, reactGate, REACT_GATE, splitFresh, createHypeStore } from "../client/src/lib/hype";
import { ROOM_REACTIONS } from "../shared/rooms";
import { TRAY_EMOJIS } from "../client/src/lib/roomShell";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("constants are the brief's values", () => {
  assert.deepEqual({ ...HYPE }, { perReaction: 12, perHeart: 6, decayPerSec: 3, max: 100 });
});
test("one reaction from 0 adds 12", () => assert.deepEqual(hypeNext(0, "reaction"), { value: 12, burst: false }));
test("a heart adds 6", () => assert.deepEqual(hypeNext(0, "heart"), { value: 6, burst: false }));
test("crossing 100 bursts once and resets to 0", () => assert.deepEqual(hypeNext(95, "reaction"), { value: 0, burst: true }));
test("landing exactly on 100 bursts", () => assert.deepEqual(hypeNext(88, "reaction"), { value: 0, burst: true }));
test("99 is not a burst for a heart that stays under", () => assert.deepEqual(hypeNext(90, "heart"), { value: 96, burst: false }));
test("100 and above bursts with a heart", () => assert.deepEqual(hypeNext(94, "heart"), { value: 0, burst: true }));
test("nine reactions from 0 burst on the ninth", () => {
  let v = 0; const bursts: boolean[] = [];
  for (let i = 0; i < 9; i++) { const r = hypeNext(v, "reaction"); v = r.value; bursts.push(r.burst); }
  assert.deepEqual(bursts, [false, false, false, false, false, false, false, false, true]);
  assert.equal(v, 0);
});
test("many events in sequence: value stays in [0, 100) and a burst always leaves 0", () => {
  let v = 0, n = 0;
  for (let i = 0; i < 1000; i++) {
    const r = hypeNext(v, i % 3 ? "reaction" : "heart", i);
    assert.ok(r.value >= 0 && r.value < HYPE.max);
    if (r.burst) { assert.equal(r.value, 0); n++; }
    v = r.value;
  }
  assert.ok(n > 50);
});
test("hypeNext tolerates NaN, Infinity and negative input", () => {
  assert.deepEqual(hypeNext(NaN, "reaction"), { value: 12, burst: false });
  assert.deepEqual(hypeNext(-50, "reaction"), { value: 12, burst: false });
  assert.deepEqual(hypeNext(Infinity, "reaction"), { value: 12, burst: false });
});
test("hypeDecay(10, 2) is 4", () => assert.equal(hypeDecay(10, 2), 4));
test("hypeDecay never goes below 0", () => { assert.equal(hypeDecay(1, 5), 0); assert.equal(hypeDecay(0, 1000), 0); });
test("negative dt does not raise the bar", () => assert.equal(hypeDecay(10, -5), 10));
test("NaN dt or value is safe", () => {
  assert.equal(hypeDecay(10, NaN), 10);
  assert.equal(hypeDecay(NaN, 2), 0);
  assert.equal(hypeDecay(-4, 1), 0);
});
test("decay over many small steps matches one big step and never goes negative", () => {
  let v = 50;
  for (let i = 0; i < 200; i++) { v = hypeDecay(v, 0.05); assert.ok(v >= 0); }
  assert.ok(Math.abs(v - 20) < 1e-6);
  for (let i = 0; i < 1000; i++) v = hypeDecay(v, 0.05);
  assert.equal(v, 0);
});
test("the tray offers exactly the server's reactions, in order", () => {
  assert.deepEqual([...TRAY_EMOJIS], [...ROOM_REACTIONS]);
});
test("reactGate allows the burst then blocks, and never lets through more than the server tolerates", () => {
  let s = { tokens: REACT_GATE.burst, at: 0 };
  let sent = 0;
  // 20 taps in 2 seconds (every 100 ms)
  for (let i = 0; i < 20; i++) { const r = reactGate(s, i * 100); s = r.state; if (r.ok) sent++; }
  assert.ok(sent <= 3 + 2 * 3, `sent ${sent}`);
  assert.ok(sent >= 3);
});
test("reactGate refills over time and ignores a clock that goes backwards", () => {
  let s = { tokens: 0, at: 1000 };
  assert.equal(reactGate(s, 1000).ok, false);
  assert.equal(reactGate(s, 500).ok, false);
  assert.equal(reactGate(s, 2000).ok, true);
  assert.equal(reactGate({ tokens: NaN, at: 0 }, 10).ok, true);
});

test("splitFresh skips ids already seen and rebuilds seen from the current list", () => {
  const r = splitFresh(new Set(["a"]), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(r.fresh, [{ id: "b" }]);
  assert.deepEqual([...r.seen].sort(), ["a", "b"]);
  assert.equal(splitFresh(new Set(["a", "gone"]), [{ id: "a" }]).seen.size, 1);
});
test("seeding seen from the initial list counts nothing", () => {
  const initial = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` }));
  assert.equal(splitFresh(new Set(initial.map((x) => x.id)), initial).fresh.length, 0);
});
test("store: add, decay by timestamp, clock going backwards", () => {
  const s = createHypeStore();
  assert.equal(s.add(2, 1000), false);
  assert.equal(s.read(1000), 24);
  assert.equal(s.read(3000), 18);
  assert.equal(s.read(2000), 18);
  assert.equal(s.read(1e9), 0);
});
test("store: nine in a row burst on the ninth and leave 0", () => {
  const s = createHypeStore();
  assert.equal(s.add(8, 0), false);
  assert.equal(s.add(1, 0), true);
  assert.equal(s.read(0), 0);
});
test("store: a hidden tab needs no timer, reading later decays correctly", () => {
  const s = createHypeStore();
  s.add(5, 0);
  assert.equal(s.read(10_000), 30);
});
test("store notifies subscribers and unsubscribes", () => {
  const s = createHypeStore(); let n = 0;
  const off = s.subscribe(() => n++);
  s.add(1, 0); off(); s.add(1, 0);
  assert.equal(n, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
