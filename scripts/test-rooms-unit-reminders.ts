// Reminder window and copy (no database, no DOM):   npx tsx scripts/test-rooms-unit-reminders.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { minutesUntil, reminderTitle, reminderWindow, REMINDER_LEAD_MIN } from "../shared/roomReminders";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const MIN = 60_000;
const now = new Date("2026-10-20T12:00:00.000Z");
const inWindow = (start: Date, at: Date) => { const w = reminderWindow(at); return start >= w.from && start <= w.to; };
const after = (ms: number, from = now) => new Date(from.getTime() + ms);

test("the window is from now to 15 minutes after now", () => {
  const w = reminderWindow(now);
  assert.equal(REMINDER_LEAD_MIN, 15);
  assert.equal(w.from.toISOString(), "2026-10-20T12:00:00.000Z");
  assert.equal(w.to.toISOString(), "2026-10-20T12:15:00.000Z");
});
test("it does not change the date it was given", () => {
  const d = new Date(now); reminderWindow(d); assert.equal(d.getTime(), now.getTime());
});
test("rooms 14.5, 9 and 1 minutes away are in the window; 16 minutes and a start already past are not", () => {
  assert.equal(inWindow(after(14.5 * MIN), now), true);
  assert.equal(inWindow(after(9 * MIN), now), true);
  assert.equal(inWindow(after(1 * MIN), now), true);
  assert.equal(inWindow(after(16 * MIN), now), false);
  assert.equal(inWindow(after(-1000), now), false);
});
test("a late tick still catches a room (ticks 60 s apart, one of them 3 minutes late)", () => {
  const start = after(20 * MIN + 17_000); // 20m17s ahead
  // On time the first tick inside the window is at +6 min; here the ticks between +5 and +8 min never happened.
  const ticks = [0, 1, 2, 3, 4, 5, 8, 9, 10].map((i) => after(i * MIN));
  const first = ticks.find((t) => inWindow(start, t));
  assert.ok(first, "no tick caught it");
  assert.equal(first!.getTime(), after(8 * MIN).getTime());
});
test("ticks 60 seconds apart see a start time on several ticks (the claim, not the window, makes it once)", () => {
  const start = after(20 * MIN + 17_000);
  let hits = 0;
  for (let i = 0; i < 40; i++) if (inWindow(start, after(i * MIN))) hits++;
  assert.ok(hits >= 15, `hits ${hits}`);
});
test("minutesUntil rounds to the nearest minute and is never below 1", () => {
  assert.equal(minutesUntil(after(15 * MIN), now), 15);
  assert.equal(minutesUntil(after(14.4 * MIN), now), 14);
  assert.equal(minutesUntil(after(9 * MIN + 10_000), now), 9);
  assert.equal(minutesUntil(after(20_000), now), 1);
  assert.equal(minutesUntil(after(-5000), now), 1);
});
test("reminderTitle says the real time left, never a fixed 15", () => {
  assert.equal(reminderTitle("Friday vibes", after(9 * MIN), now), "Friday vibes starts in 9 minutes");
  assert.equal(reminderTitle("Friday vibes", after(15 * MIN), now), "Friday vibes starts in 15 minutes");
  assert.equal(reminderTitle("Friday vibes", after(50_000), now), "Friday vibes starts in 1 minute");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
