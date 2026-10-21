// Rooms config endpoint checks (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-config.ts
// Refuses to run unless the database name contains "test", because it creates users.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
// The runner loads .env; a ROOMS_* value there must not decide the default-flags-off assertion.
for (const k of ["ROOMS_PAID", "ROOMS_SPRAY", "ROOMS_GAMING", "LIVEKIT_INGRESS"]) delete process.env[k];
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const { roomFeatures } = await import("../server/rooms/features");
const { ROOM_LIMITS } = await import("../shared/rooms");
const { getConfig } = await import("../server/services/moderationConfig");

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
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerRoomRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null) {
  const res = await fetch(base + path, { method, headers: { "x-forwarded-for": `10.8.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) } });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const mk = async (name: string, dob: string | null) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth)
   values ($1,$2,'social',$3,true,true,$4) returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, dob]))[0].id as string;
/** An account created `days` days ago (plus 12 hours, so clock skew between the DB and this process cannot round it down). */
const mkAged = async (name: string, days: number) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at)
   values ($1,$2,'social',$3,true,true,$4, now() - make_interval(days => $5::int, hours => 12)) returning id`,
  [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash, yearsAgo(30), days]))[0].id as string;
const allKeys = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...allKeys(v)]) : []);

try {
  const adult = await mk("cfg_adult", yearsAgo(30));
  const teen = await mk("cfg_teen", yearsAgo(14));
  const noDob = await mk("cfg_nodob", null);

  // The same admin setting roomRoutes uses for ACCOUNT_TOO_NEW (min_account_age_days; default 7 unless set in this DB).
  const minDays = Number(await getConfig("min_account_age_days")) || 0;
  const r = await http("GET", "/api/rooms/config", adult);
  check("config: signed-in adult gets 200", r.status === 200, JSON.stringify(r));
  check("config: exact body shape with default flags off, plus the caller's own host numbers (new account: 0 days)", JSON.stringify(r.json) === JSON.stringify({
    features: { paidRooms: false, spray: false }, limits: ROOM_LIMITS, currency: "NGN", region: "NG",
    rates: { ticketPlatformPct: 15, ticketReservePct: 1 },
    host: { accountAgeDays: 0, minAccountAgeDays: minDays },
  }), JSON.stringify(r.json));
  check("config: host has exactly accountAgeDays and minAccountAgeDays, both whole numbers", JSON.stringify(Object.keys(r.json?.host ?? {})) === JSON.stringify(["accountAgeDays", "minAccountAgeDays"])
    && Number.isInteger(r.json?.host?.accountAgeDays) && Number.isInteger(r.json?.host?.minAccountAgeDays), JSON.stringify(r.json?.host));
  const old = await mkAged("cfg_old", 60);
  const o = await http("GET", "/api/rooms/config", old);
  check("config: host.accountAgeDays is the caller's own account age in whole days (60)", o.status === 200 && o.json?.host?.accountAgeDays === 60 && o.json.host.minAccountAgeDays === minDays, JSON.stringify(o.json?.host));
  check("config: everything else is the same for every caller", JSON.stringify({ ...o.json, host: null }) === JSON.stringify({ ...r.json, host: null }));
  check("config: limits.capacityMax is 50", r.json?.limits?.capacityMax === 50);
  check("config: only the two public flags are exposed (no linkScreens, no anonymousJoin)", Object.keys(r.json?.features ?? {}).sort().join() === "paidRooms,spray");
  check("config: no key matching /secret|key|token/i anywhere in the response", !allKeys(r.json).some((k) => /secret|key|token/i.test(k)), allKeys(r.json).join());
  check("config: no secret-looking text in the body", !/paystack|sk_(live|test)|secret/i.test(JSON.stringify(r.json)));

  const t = await http("GET", "/api/rooms/config", teen);
  check("config: works for a teen (200, same body)", t.status === 200 && JSON.stringify(t.json) === JSON.stringify(r.json), JSON.stringify(t));
  const n = await http("GET", "/api/rooms/config", noDob);
  check("config: works for a user with no birthdate", n.status === 200, JSON.stringify(n));

  const anon = await http("GET", "/api/rooms/config", null);
  check("config: signed out gets 401", anon.status === 401, JSON.stringify(anon));

  const room = await http("GET", "/api/rooms/not-a-real-room", adult);
  check("registered before /:id: other ids still reach the room route (404 Room not found)", room.status === 404 && room.json?.message === "Room not found", JSON.stringify(room));

  const saved = { ...roomFeatures };
  roomFeatures.paidRooms = true; roomFeatures.spray = true;
  const on = await http("GET", "/api/rooms/config", adult);
  Object.assign(roomFeatures, saved);
  check("config: reflects the live flag values", on.json?.features?.paidRooms === true && on.json.features.spray === true, JSON.stringify(on.json));

  // Gaming: the key is absent while ROOMS_GAMING is off (asserted by the exact-shape check above) and true when it is on.
  roomFeatures.gaming = true;
  const g = await http("GET", "/api/rooms/config", adult);
  Object.assign(roomFeatures, saved);
  check("config: features.gaming is true while ROOMS_GAMING is on", g.status === 200 && g.json?.features?.gaming === true, JSON.stringify(g.json?.features));
  check("config: game capabilities appear with the flag, exactly ingest / teamSpray / lanes, all booleans",
    JSON.stringify(Object.keys(g.json?.game ?? {})) === JSON.stringify(["ingest", "teamSpray", "lanes"]) && Object.values(g.json.game).every((x) => typeof x === "boolean"), JSON.stringify(g.json?.game));
  check("config: ingest is off without LIVEKIT_INGRESS (and without a voice service)", g.json?.game?.ingest === false);
  check("config: teamSpray is off while spraying is off", g.json?.game?.teamSpray === false);
  check("config: no game key at all while the flag is off", !("game" in (r.json ?? {})) && !("gaming" in (r.json?.features ?? {})));

  // The two ticket rates the host screens need follow the saved rates (rooms rates plan, task 3); nothing else about rates is exposed.
  const rates = await import("../server/rooms/roomRates");
  await rates.setRate({ key: "ticket_platform", value: 20, adminId: "cfg-test-admin", reason: "config test" });
  await rates.setRate({ key: "ticket_reserve", value: 2.5, adminId: "cfg-test-admin", reason: "config test" });
  const changed = await http("GET", "/api/rooms/config", adult);
  check("config: rates follow the saved ticket rates and expose only those two", JSON.stringify(changed.json?.rates) === JSON.stringify({ ticketPlatformPct: 20, ticketReservePct: 2.5 }), JSON.stringify(changed.json?.rates));
  check("config: no spray rate is exposed", !JSON.stringify(changed.json).includes("spray_platform") && !/spray.*pct/i.test(JSON.stringify(changed.json?.rates)));
  await rates.setRate({ key: "ticket_platform", value: 15, adminId: "cfg-test-admin", reason: "config test restore" });
  await rates.setRate({ key: "ticket_reserve", value: 1, adminId: "cfg-test-admin", reason: "config test restore" });
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
