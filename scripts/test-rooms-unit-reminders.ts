// Reminder window math (no database, no DOM):   npx tsx scripts/test-rooms-unit-reminders.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { reminderWindow } from "../shared/roomReminders";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const now = new Date("2026-10-20T12:00:00.000Z");
const inWindow = (start: Date, at: Date) => { const w = reminderWindow(at); return start >= w.from && start <= w.to; };

test("the window is 14 to 15 minutes after now", () => {
  const w = reminderWindow(now);
  assert.equal(w.from.toISOString(), "2026-10-20T12:14:00.000Z");
  assert.equal(w.to.toISOString(), "2026-10-20T12:15:00.000Z");
});
test("it does not change the date it was given", () => {
  const d = new Date(now); reminderWindow(d); assert.equal(d.getTime(), now.getTime());
});
test("a room 14.5 minutes away is in the window; 13 and 16 minutes are not", () => {
  assert.equal(inWindow(new Date(now.getTime() + 14.5 * 60_000), now), true);
  assert.equal(inWindow(new Date(now.getTime() + 13 * 60_000), now), false);
  assert.equal(inWindow(new Date(now.getTime() + 16 * 60_000), now), false);
});
test("ticks 60 seconds apart cover a start time exactly once", () => {
  const start = new Date(now.getTime() + 20 * 60_000 + 17_000); // 20m17s ahead
  let hits = 0;
  for (let i = 0; i < 40; i++) if (inWindow(start, new Date(now.getTime() + i * 60_000))) hits++;
  assert.equal(hits, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
