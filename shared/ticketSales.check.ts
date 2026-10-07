// Run: npx tsx shared/ticketSales.check.ts
import assert from "node:assert/strict";
import { daysLeftLabel, salesDaysLeft, salesEndInstant, salesHaveEnded } from "./ticketSales";

const viewer = new Date(2026, 9, 7, 15, 30); // 7 Oct 2026, local afternoon
// the user's own example: ends 20 Oct, viewed 7 Oct -> 13 days left
assert.equal(salesDaysLeft("2026-10-20T00:00:00.000Z", viewer), 13);
assert.equal(daysLeftLabel(13), "13 days left");
assert.equal(daysLeftLabel(1), "1 day left");
assert.equal(daysLeftLabel(0), "Last day");
assert.equal(salesDaysLeft("2026-10-07T00:00:00.000Z", viewer), 0);
assert.equal(salesDaysLeft("2026-10-06T00:00:00.000Z", viewer), -1);

// "through the 20th": still on sale late on the 20th, closed on the 21st
const end = "2026-10-20T00:00:00.000Z";
assert.equal(salesHaveEnded(end, Date.parse("2026-10-20T23:00:00Z")), false);
assert.equal(salesHaveEnded(end, Date.parse("2026-10-21T00:00:01Z")), true);
// timed values are exact
assert.equal(salesEndInstant("2026-10-20T18:30:00.000Z"), Date.parse("2026-10-20T18:30:00Z"));
assert.equal(salesEndInstant(null), null);
assert.equal(salesHaveEnded(null), false);
console.log("ticketSales: ok");
