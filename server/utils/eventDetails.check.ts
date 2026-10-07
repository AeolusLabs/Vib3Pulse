// Run: npx tsx server/utils/eventDetails.check.ts   (read-only against DATABASE_URL, no writes)
import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eventCreateDto, eventUpdateDto, events, ticketTiers } from "../../shared/schema";

const base = {
  title: "T", description: "D", location: "L", category: "Music", ticketsAvailable: 10,
  eventDate: "2026-11-01T22:00:00.000Z",
};

// defaults + accepted details
const ok = eventCreateDto.omit({ organizerId: true }).parse({
  ...base, doorsOpenAt: "2026-11-01T21:00:00.000Z", ageRestriction: "18+", parentalGuidance: "advised",
  lineup: [{ name: "DJ A", time: "11pm" }], dressCode: "Smart", refundPolicy: "None",
});
assert.equal(ok.ageRestriction, "18+");
assert.ok(ok.doorsOpenAt instanceof Date);
assert.equal(eventCreateDto.omit({ organizerId: true }).parse(base).ageRestriction, "all"); // default
// bad input rejected
assert.throws(() => eventCreateDto.omit({ organizerId: true }).parse({ ...base, ageRestriction: "12+" }));
assert.throws(() => eventCreateDto.omit({ organizerId: true }).parse({ ...base, lineup: [{ name: "" }] }));
// partial update must NOT reset age back to the default
assert.equal(eventUpdateDto.parse({ title: "x" }).ageRestriction, undefined);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool);
  const ev = await db.select().from(events).limit(1);   // selects every declared column
  const tiers = await db.select().from(ticketTiers).limit(1);
  console.log("live DB read ok:", ev.length, "event row(s),", tiers.length, "tier row(s); ageRestriction =", ev[0]?.ageRestriction);
  await pool.end();
  console.log("eventDetails: ok");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
