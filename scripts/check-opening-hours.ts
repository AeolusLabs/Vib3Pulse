// Run: npx tsx scripts/check-opening-hours.ts
import { getOpenStatus } from "../client/src/lib/openingHours";
import { openingHoursSchema, type OpeningHours } from "../shared/schema";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
}

const day = (open: string, close: string) => ({ open, close });
// Thu-Sun 22:00 -> 04:00 (Thu=4 .. Sun=0), London
const club: OpeningHours = {
  timezone: "Europe/London",
  days: { "0": day("22:00", "04:00"), "1": null, "2": null, "3": null, "4": day("22:00", "04:00"), "5": day("22:00", "04:00"), "6": day("22:00", "04:00") },
};
// Dates in Oct 2026 (BST until Oct 25): Fri 9 Oct, Sat 10 Oct.
const at = (iso: string) => new Date(iso);

eq("Fri 23:00 BST open, closes 4am", getOpenStatus(club, at("2026-10-09T22:00:00Z")), { state: "open", label: "Open now", detail: "closes 4:00 am" });
eq("Sat 01:00 BST: Friday session still open", getOpenStatus(club, at("2026-10-10T00:00:00Z")).state, "open");
eq("Sat 04:00 BST: session just ended", getOpenStatus(club, at("2026-10-10T03:00:00Z")), { state: "closed", label: "Closed", detail: "opens 10:00 pm" });
eq("Sat 03:59 BST still open", getOpenStatus(club, at("2026-10-10T02:59:00Z")).state, "open");
eq("Mon 12:00 closed day -> next Thu", getOpenStatus(club, at("2026-10-12T11:00:00Z")), { state: "closed", label: "Closed", detail: "opens Thu 10:00 pm" });
eq("Mon 01:00: Sunday session still open", getOpenStatus(club, at("2026-10-12T00:00:00Z")).state, "open");
eq("Tue 03:00: Mon closed, Sun session over", getOpenStatus(club, at("2026-10-13T02:00:00Z")).state, "closed");
eq("Fri 15:00 -> opens tonight", getOpenStatus(club, at("2026-10-09T14:00:00Z")).detail, "opens 10:00 pm");
// Timezone: same instant, venue in New York (EDT, UTC-4). 2026-10-10T02:00Z = Fri 22:00 NY
const ny = { ...club, timezone: "America/New_York" };
eq("tz: Fri 22:00 New York open", getOpenStatus(ny, at("2026-10-10T02:00:00Z")).state, "open");
eq("tz: same instant London Sat 03:00 -> Fri session still open", getOpenStatus(club, at("2026-10-10T02:00:00Z")).state, "open");
// DST end Sun 25 Oct 2026 01:00Z: Sun 00:30 BST = Sat 23:30Z; Sat session open either way
eq("DST: Sun 00:30 (BST) open", getOpenStatus(club, at("2026-10-24T23:30:00Z")).state, "open");
eq("DST: Sun 01:30 after clocks back (GMT, 01:30Z)", getOpenStatus(club, at("2026-10-25T01:30:00Z")).state, "open");
eq("DST: Sun 04:30 GMT closed", getOpenStatus(club, at("2026-10-25T04:30:00Z")).detail, "opens 10:00 pm");
// 12-hour formatting
const daytime: OpeningHours = { timezone: "UTC", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), day("00:00", "12:00")])) as OpeningHours["days"] };
eq("12am/12pm formatting", getOpenStatus(daytime, at("2026-10-12T05:00:00Z")).detail, "closes 12:00 pm");
// Always-closed / null / bad tz
eq("all days closed", getOpenStatus({ timezone: "UTC", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), null])) as OpeningHours["days"] }, at("2026-10-12T05:00:00Z")), { state: "closed", label: "Closed", detail: "" });
eq("null => unknown", getOpenStatus(null, at("2026-10-12T05:00:00Z")).state, "unknown");
eq("undefined => unknown", getOpenStatus(undefined).state, "unknown");
eq("bad tz => unknown", getOpenStatus({ ...club, timezone: "Not/AZone" }, at("2026-10-12T05:00:00Z")).state, "unknown");
// Zod schema
eq("zod accepts valid", openingHoursSchema.safeParse(club).success, true);
eq("zod rejects bad time", openingHoursSchema.safeParse({ ...club, days: { ...club.days, "1": day("25:00", "04:00") } }).success, false);
eq("zod rejects bad tz", openingHoursSchema.safeParse({ ...club, timezone: "Mars/Base" }).success, false);
eq("zod rejects missing day", openingHoursSchema.safeParse({ timezone: "UTC", days: { "0": null } }).success, false);
eq("zod rejects extra key", openingHoursSchema.safeParse({ ...club, evil: 1 }).success, false);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("all passed");
