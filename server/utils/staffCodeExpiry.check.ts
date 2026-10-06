// Run: npx tsx server/utils/staffCodeExpiry.check.ts  (exits non-zero on failure)
import assert from "node:assert/strict";
import { staffCodeExpiry } from "./staffCodeExpiry";

const H = 3600_000;
const now = new Date("2026-10-06T15:00:00Z");

// Event starting right now must NOT yield a code that is already dead (the reported bug).
const atStart = staffCodeExpiry(now, null, now)!;
assert.ok(atStart.getTime() - now.getTime() >= 8 * H, "code must outlive the event");

// Explicit end date wins, plus grace.
const end = new Date(now.getTime() + 5 * H);
assert.equal(staffCodeExpiry(now, end, now)!.getTime(), end.getTime() + 2 * H);

// Future event: code valid until after it ends.
const future = new Date(now.getTime() + 72 * H);
assert.ok(staffCodeExpiry(future, null, now)!.getTime() > future.getTime());

// Long-finished event: no code.
assert.equal(staffCodeExpiry(new Date(now.getTime() - 48 * H), null, now), null);
console.log("staffCodeExpiry: ok");
