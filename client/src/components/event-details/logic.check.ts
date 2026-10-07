// Run: npx tsx client/src/components/event-details/logic.check.ts
import assert from "node:assert/strict";
import { tierStatus } from "./TicketPicker";
import { googleCalendarUrl, directionsUrl } from "../../lib/eventLinks";

const now = Date.parse("2026-10-07T12:00:00Z");
const base = { id: "t", name: "GA", priceSmallestUnit: 1000, quantity: 20, sold: 0 };

assert.equal(tierStatus(base, now).label, "Available");
assert.equal(tierStatus({ ...base, sold: 20 }, now).label, "Sold out");
assert.equal(tierStatus({ ...base, sold: 17 }, now).label, "Only 3 left");
assert.equal(tierStatus({ ...base, salesEndDate: "2026-10-01T00:00:00Z" }, now).available, false);
// the reported bug: 2 tickets, 1 sold -> 1 left, still purchasable
{
  const st = tierStatus({ ...base, quantity: 2, sold: 1 }, now);
  assert.deepEqual([st.label, st.available, st.urgent], ["Only 1 left", true, true]);
}

const url = googleCalendarUrl({ title: "Night", location: "Club", start: new Date("2026-10-10T22:00:00Z") });
assert.ok(url.includes("20261010T220000Z%2F20261011T010000Z"), url); // default 3h duration
assert.ok(directionsUrl("Club, London", 51.5, -0.1).includes("destination=51.5%2C-0.1"));
console.log("event-details logic: ok");

// sales-end note: ends 20 Oct, viewed 7 Oct (local) -> "13 days left", still purchasable
{
  const viewer = new Date(2026, 9, 7, 15, 0).getTime();
  const st = tierStatus({ ...base, salesEndDate: "2026-10-20T00:00:00.000Z" }, viewer);
  assert.ok(st.salesNote?.includes("13 days left"), st.salesNote);
  assert.equal(st.available, true);
  assert.equal(tierStatus({ ...base, salesEndDate: "2026-10-09T00:00:00.000Z" }, viewer).salesUrgent, true);
  assert.equal(tierStatus({ ...base, salesEndDate: "2026-10-06T00:00:00.000Z" }, viewer).label, "Sales ended");
  console.log("sales-end note: ok");
}
