// Building avatar API checks: venues and events accept only a validated building, the allow-list still holds,
// and the map payload carries building + verified/promoted flags.
//
//   npm run test:avatar            (builds a scratch database, runs this, drops it)
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-building-api.ts
// Refuses to run unless the database name contains "test", because it creates users, venues and events.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerVenueRoutes } = await import("../server/routes/venue-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");
const { registerMapRoutes } = await import("../server/routes/map-routes");
const { userToSessionUser } = await import("../server/auth");

await storage.ensureLoginAttemptsTable();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) { const u = await storage.getUser(id); req.user = u ? userToSessionUser(u) : undefined; }
  req.isAuthenticated = () => !!req.user;
  req.login = (_u: unknown, cb: (e?: Error) => void) => cb();
  next();
});
app.use(redactSensitiveFields);
registerVenueRoutes(app);
registerEventsRoutes(app);
registerMapRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.6.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

// ---- fixtures ----
const hash = await bcrypt.hash("Passw0rd!building", 4);
const stamp = Date.now();
const mkUser = async (name: string, type: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, can_manage_venues, date_of_birth)
   values ($1,$2,$3,$4,true,true,true,'1990-01-01') returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, type, hash]))[0].id as string;
const ORG = await mkUser("bld_org", "organizer");
const VIEW = await mkUser("bld_view", "social");
const venueRow = async (id: string) => (await q(`select * from venues where id=$1`, [id]))[0];
const eventRow = async (id: string) => (await q(`select * from events where id=$1`, [id]))[0];
const stadium = { v: 1, style: "stadium", accent: 2 };
const venueBody = (extra: Record<string, unknown> = {}) => ({ name: "Building Club", category: "Club", location: "1 Test St", address: "1 Test St", city: "London", currency: "GBP", ...extra });
const createdVenues: string[] = [], createdEvents: string[] = [];

try {
  // ---- venues ----
  let r = await http("POST", "/api/venues", ORG, venueBody({ building: stadium }));
  check("venue create with building: 201", r.status === 201, JSON.stringify(r.json));
  const vid = r.json?.id as string; if (vid) createdVenues.push(vid);
  check("venue create: building stored", JSON.stringify((await venueRow(vid))?.building) === JSON.stringify(stadium), JSON.stringify((await venueRow(vid))?.building));

  r = await http("POST", "/api/venues", ORG, venueBody({ name: "No Building" }));
  check("venue create without building: 201 and building null (map will use the category default)", r.status === 201 && (await venueRow(r.json?.id))?.building === null, JSON.stringify(r.json));
  if (r.json?.id) createdVenues.push(r.json.id);

  for (const [label, bad] of [["unknown style", { v: 1, style: "castle", accent: 1 }], ["accent out of range", { v: 1, style: "club", accent: 9 }], ["string", "tent"], ["array", []]] as const) {
    const before = (await q(`select count(*)::int c from venues where owner_id=$1`, [ORG]))[0].c;
    r = await http("POST", "/api/venues", ORG, venueBody({ name: `Bad ${label}`, building: bad }));
    const after = (await q(`select count(*)::int c from venues where owner_id=$1`, [ORG]))[0].c;
    check(`venue create (${label}): 400 and nothing created`, r.status === 400 && before === after, `${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  }

  r = await http("POST", "/api/venues", ORG, venueBody({ name: "Extra Keys", building: JSON.parse('{"v":9,"style":"tent","accent":4,"evil":"<script>","__proto__":{"x":1}}') }));
  const ek = r.json?.id ? await venueRow(r.json.id) : null; if (r.json?.id) createdVenues.push(r.json.id);
  check("venue create: extra keys dropped, v forced to 1", r.status === 201 && JSON.stringify(Object.keys(ek?.building ?? {}).sort()) === JSON.stringify(["accent", "style", "v"]) && ek?.building?.v === 1, JSON.stringify(ek?.building));
  check("no prototype pollution", ({} as any).x === undefined);

  r = await http("PATCH", `/api/venues/${vid}`, ORG, { building: { v: 1, style: "rooftop", accent: 5 } });
  check("venue update building: 200 and stored", r.status === 200 && (await venueRow(vid))?.building?.style === "rooftop" && (await venueRow(vid))?.building?.accent === 5, `${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  const kept = JSON.stringify((await venueRow(vid))?.building);
  r = await http("PATCH", `/api/venues/${vid}`, ORG, { building: { v: 1, style: "castle", accent: 0 } });
  check("venue update invalid building: 400, unchanged", r.status === 400 && JSON.stringify((await venueRow(vid))?.building) === kept, `${r.status}`);
  r = await http("PATCH", `/api/venues/${vid}`, ORG, { name: "Renamed" });
  check("venue update without building leaves it alone", r.status === 200 && JSON.stringify((await venueRow(vid))?.building) === kept);
  r = await http("PATCH", `/api/venues/${vid}`, ORG, { building: null });
  check("venue update building null clears it", r.status === 200 && (await venueRow(vid))?.building === null, `${r.status}`);

  // the write allow-list still holds when a building rides along
  r = await http("POST", "/api/venues", ORG, venueBody({ name: "Forger", building: stadium, isVerified: true, isPromoted: true, ownerId: VIEW }));
  const fg = r.json?.id ? await venueRow(r.json.id) : null; if (r.json?.id) createdVenues.push(r.json.id);
  check("forged isVerified/isPromoted/ownerId still ignored alongside a building", !!fg && fg.is_verified === false && fg.is_promoted === false && fg.owner_id === ORG && fg.building?.style === "stadium", JSON.stringify(fg && { v: fg.is_verified, p: fg.is_promoted, o: fg.owner_id }));

  // ---- events ----
  const eventBody = (extra: Record<string, unknown> = {}) => ({
    title: "Building Night", description: "A night", eventDate: new Date(Date.now() + 5 * 86400000).toISOString(), location: "Shoreditch, London",
    category: "Music", ticketPrice: 0, ticketsAvailable: 50, ...extra,
  });
  r = await http("POST", "/api/events", ORG, eventBody({ building: { v: 1, style: "stage", accent: 3 } }));
  check("event create with building: 2xx", r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  const eid = r.json?.id as string; if (eid) createdEvents.push(eid);
  check("event create: building stored", (await eventRow(eid))?.building?.style === "stage" && (await eventRow(eid))?.building?.accent === 3);
  r = await http("POST", "/api/events", ORG, eventBody({ title: "Bad building", building: { v: 1, style: "castle", accent: 3 } }));
  check("event create invalid building: 400", r.status === 400, `${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  r = await http("PUT", `/api/events/${eid}`, ORG, { building: { v: 1, style: "tent", accent: 6 } });
  check("event update building: stored", (r.status === 200 || r.status === 201) && (await eventRow(eid))?.building?.style === "tent", `${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  r = await http("PUT", `/api/events/${eid}`, ORG, { building: { v: 1, style: "castle", accent: 6 } });
  check("event update invalid building: 400, unchanged", r.status === 400 && (await eventRow(eid))?.building?.style === "tent", `${r.status}`);

  // ---- map payload ----
  const lat = 51.5072, lng = -0.1276;
  const mkMapVenue = async (name: string, building: unknown, verified: boolean, promoted: boolean) => (await q(
    `insert into venues (owner_id, name, category, location, latitude, longitude, building, is_verified, is_promoted)
     values ($1,$2,'Pub','London',$3,$4,$5,$6,$7) returning id`, [ORG, name, lat, lng, building ? JSON.stringify(building) : null, verified, promoted]))[0].id as string;
  const v1 = await mkMapVenue("Map Verified", { v: 1, style: "stadium", accent: 1 }, true, false); createdVenues.push(v1);
  const v2 = await mkMapVenue("Map Plain", null, false, false); createdVenues.push(v2);
  const e1 = (await q(
    `insert into events (organizer_id, title, description, event_date, location, category, ticket_price, tickets_available, latitude, longitude, building, is_promoted, moderation_status, visibility)
     values ($1,'Map Event','x',now() + interval '2 days','London','Sports',0,10,$2,$3,$4,true,'approved','public') returning id`, [ORG, lat, lng, JSON.stringify({ v: 1, style: "tent", accent: 7 })]))[0].id as string; createdEvents.push(e1);
  r = await http("GET", `/api/map/nearby?lat=${lat}&lng=${lng}&radiusKm=5`, VIEW);
  check("map: 200", r.status === 200, JSON.stringify(r.json)?.slice(0, 160));
  const mv1 = r.json?.venues?.find((v: any) => v.id === v1), mv2 = r.json?.venues?.find((v: any) => v.id === v2), me1 = r.json?.events?.find((e: any) => e.id === e1);
  check("map: venue carries building and isVerified", mv1?.building?.style === "stadium" && mv1?.isVerified === true && mv1?.isPromoted === false, JSON.stringify(mv1));
  check("map: venue without a building has building null (client uses the category default)", mv2 && mv2.building === null && mv2.category === "Pub", JSON.stringify(mv2));
  check("map: event carries building and isPromoted", me1?.building?.style === "tent" && me1?.isPromoted === true && me1?.category === "Sports", JSON.stringify(me1));
  check("map: no sensitive fields", !JSON.stringify(r.json).match(/passwordHash|"email"|verifiedPhone|exactAddress|inviteToken/));
} finally {
  if (createdEvents.length) await q(`delete from events where id = any($1)`, [createdEvents]).catch(() => {});
  if (createdVenues.length) await q(`delete from venues where id = any($1)`, [createdVenues]).catch(() => {});
  await q(`delete from users where id = any($1)`, [[ORG, VIEW]]).catch(() => {});
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
