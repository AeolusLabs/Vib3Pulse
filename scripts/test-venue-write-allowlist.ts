// Regression test: a venue owner must not be able to set server-controlled fields through the
// venue / venue-event write routes (ownership, verification, paid promotion, coordinates,
// moderation status, venue move, sales counters).
//
//   DATABASE_URL=<throwaway db> BASE_URL=http://localhost:5055 npx tsx scripts/test-venue-write-allowlist.ts
//
// Start the server against the same throwaway database first. Refuses to run unless the database
// name contains "test", because it creates users and venues.
import bcrypt from "bcrypt";
import pg from "pg";

const dbUrl = process.env.DATABASE_URL ?? "";
const base = process.env.BASE_URL ?? "http://localhost:5055";
if (!/test/i.test(new URL(dbUrl).pathname)) {
  console.error("Refusing to run: DATABASE_URL must point at a throwaway database whose name contains 'test'.");
  process.exit(2);
}

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];

// ── fixtures ────────────────────────────────────────────────────────────────
const password = `Tp1!${globalThis.crypto.randomUUID().slice(0, 12)}`; // random per run
const hash = await bcrypt.hash(password, 10);
const mkUser = async (username: string, type: string) =>
  (await one(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, can_manage_venues)
     values ($1,$2,$3,$4,true,true,true) returning id`,
    [`${username}@t.dev`, username, type, hash],
  )).id as string;
const me = await mkUser(`al_owner_${Date.now()}`, "organizer");
const other = await mkUser(`al_other_${Date.now()}`, "organizer");
const otherVenue = (await one(
  `insert into venues (owner_id,name,category,location) values ($1,'Someone Else''s Venue','Club','Elsewhere') returning id`, [other],
)).id as string;
const username = (await one(`select username from users where id=$1`, [me])).username as string;

// ── session + CSRF (same flow the browser uses) ─────────────────────────────
const jar = new Map<string, string>();
const absorb = (res: Response) => {
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
let csrf = "";
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie: cookieHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(res);
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};
{
  const r = await fetch(base + "/api/csrf-token", { headers: { cookie: cookieHeader() } });
  absorb(r); csrf = (await r.json()).csrfToken;
  const login = await call("POST", "/api/auth/login", { username, password });
  check("login as venue owner", login.status === 200, JSON.stringify(login.json));
  // Login regenerates the session, which rotates the CSRF token: fetch the new one like the browser does.
  const r2 = await fetch(base + "/api/csrf-token", { headers: { cookie: cookieHeader() } });
  absorb(r2); csrf = (await r2.json()).csrfToken;
}

const venueRow = (id: string) => one(`select * from venues where id=$1`, [id]);

// ── 1. create venue: forged server-controlled fields are ignored ────────────
const created = await call("POST", "/api/venues", {
  name: "Allowlist Club", category: "Club", location: "1 Test St", address: "1 Test St", city: "London", currency: "GBP",
  isPromoted: true, isVerified: true, ownerId: other, latitude: 1.5, longitude: 2.5,
});
check("create venue accepted", created.status === 201, JSON.stringify(created.json));
const vid = created.json?.id as string;
if (!vid) { console.log(`
${passed} passed, ${failed} failed (stopped: venue not created)`); process.exit(1); }
let v = await venueRow(vid);
check("create: owner is the caller, not the forged ownerId", v.owner_id === me);
check("create: forged isPromoted ignored", v.is_promoted === false);
check("create: forged isVerified ignored", v.is_verified === false);
check("create: forged coordinates ignored", v.latitude !== 1.5 && v.longitude !== 2.5);

// ── 2. update venue: legit fields change, forged ones do not ────────────────
const patched = await call("PATCH", `/api/venues/${vid}`, {
  name: "Allowlist Club 2", description: "legit edit",
  isPromoted: true, isVerified: true, ownerId: other, latitude: 9, longitude: 9, id: otherVenue,
});
check("update venue accepted", patched.status === 200, JSON.stringify(patched.json));
v = await venueRow(vid);
check("update: legit fields applied", v.name === "Allowlist Club 2" && v.description === "legit edit");
check("update: ownership not transferable", v.owner_id === me);
check("update: cannot self-promote", v.is_promoted === false);
check("update: cannot self-verify", v.is_verified === false);
check("update: coordinates not client-settable", v.latitude !== 9 && v.longitude !== 9);
check("update: primary key untouched", v.id === vid);

const hoursOk = { timezone: "Europe/London", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), d === 5 ? { open: "22:00", close: "04:00" } : null])) };
const hoursPatch = await call("PATCH", `/api/venues/${vid}`, { openingHours: hoursOk });
check("update: valid openingHours accepted + stored", hoursPatch.status === 200 && (await venueRow(vid)).opening_hours?.timezone === "Europe/London");
const hoursBad = await call("PATCH", `/api/venues/${vid}`, { openingHours: { timezone: "Mars/Base", days: hoursOk.days } });
check("update: bad openingHours rejected with 400", hoursBad.status === 400);
const hoursNull = await call("PATCH", `/api/venues/${vid}`, { openingHours: null });
check("update: openingHours can be cleared", hoursNull.status === 200 && (await venueRow(vid)).opening_hours === null);

// A client that sends back the whole venue object (as the edit form can) must still work.
const whole = await call("PATCH", `/api/venues/${vid}`, { ...(await venueRow(vid)), name: "Allowlist Club 3", created_at: undefined });
check("update: whole-object payload still accepted (extra keys stripped)", whole.status === 200 && (await venueRow(vid)).name === "Allowlist Club 3");

const menuPatch = await call("PATCH", `/api/venues/${vid}`, { menuImageUrls: ["https://x.test/menu-1.jpg", "https://x.test/menu-2.jpg"] });
check("update: owner can set menu pages", menuPatch.status === 200 && (await venueRow(vid)).menu_image_urls?.length === 2);
const menuTooMany = await call("PATCH", `/api/venues/${vid}`, { menuImageUrls: Array.from({ length: 11 }, (_, i) => `https://x.test/${i}.jpg`) });
check("update: more than 10 menu pages rejected with 400", menuTooMany.status === 400);
check("update: rejected menu update left the saved pages untouched", (await venueRow(vid)).menu_image_urls?.length === 2);
const menuHijack = await call("PATCH", `/api/venues/${otherVenue}`, { menuImageUrls: ["https://x.test/evil.jpg"] });
check("update: cannot change another owner's menu", menuHijack.status === 403 && ((await venueRow(otherVenue)).menu_image_urls ?? []).length === 0);

const notMine = await call("PATCH", `/api/venues/${otherVenue}`, { name: "hijack" });
check("update: other owner's venue still 403", notMine.status === 403);

// ── 3. venue events ─────────────────────────────────────────────────────────
const when = new Date(Date.now() + 5 * 864e5).toISOString();
const night = await call("POST", `/api/venues/${vid}/venue-events`, {
  name: "Friday Entry", date: when, coverPriceCents: 1500, capacity: 100,
  moderationStatus: "approved", ticketsSold: 50, venueId: otherVenue, recurrenceParentId: "forged",
});
check("create venue event accepted", night.status === 201, JSON.stringify(night.json));
const nid = night.json?.id as string;
let n = await one(`select * from venue_entry_nights where id=$1`, [nid]);
check("create event: forged moderationStatus ignored (stays pending)", n.moderation_status === "pending");
check("create event: forged ticketsSold ignored", n.tickets_sold === 0);
check("create event: forged venueId ignored", n.venue_id === vid);
check("create event: forged recurrenceParentId ignored", n.recurrence_parent_id === null);

const nPatch = await call("PATCH", `/api/venue-events/${nid}`, {
  name: "Renamed", isActive: false, coverPriceCents: 2000,
  moderationStatus: "approved", ticketsSold: 99, venueId: otherVenue,
});
check("update venue event accepted", nPatch.status === 200, JSON.stringify(nPatch.json));
n = await one(`select * from venue_entry_nights where id=$1`, [nid]);
check("update event: legit fields applied", n.name === "Renamed" && n.is_active === false && n.cover_price_cents === 2000);
check("update event: cannot self-approve", n.moderation_status === "pending");
check("update event: cannot change ticketsSold", n.tickets_sold === 0);
check("update event: cannot move to another venue", n.venue_id === vid);

await db.query(`update venue_entry_nights set moderation_status='removed' where id=$1`, [nid]);
await call("PATCH", `/api/venue-events/${nid}`, { moderationStatus: "approved" });
n = await one(`select * from venue_entry_nights where id=$1`, [nid]);
check("update event: admin-removed night cannot be resurrected by the owner", n.moderation_status === "removed");

const dateStr = await call("PATCH", `/api/venue-events/${nid}`, { date: "", endTime: "" });
check("update event: empty date strings still handled (no 500)", dateStr.status < 500, `status ${dateStr.status}`);

// Recurring nights: the server (not the client) links the generated occurrences to their parent.
const rec = await call("POST", `/api/venues/${vid}/venue-events`, {
  name: "Weekly", date: when, coverPriceCents: 500, recurrence: "weekly",
  recurrenceEndDate: new Date(Date.now() + 25 * 864e5).toISOString(), moderationStatus: "approved",
});
check("recurring venue event accepted", rec.status === 201, JSON.stringify(rec.json));
const kids = (await db.query(`select moderation_status from venue_entry_nights where recurrence_parent_id=$1`, [rec.json?.id])).rows;
check("recurring: occurrences generated and linked by the server", kids.length >= 2, `got ${kids.length}`);
check("recurring: every occurrence is pending (forged approval ignored)", kids.every((k: any) => k.moderation_status === "pending"));

await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
