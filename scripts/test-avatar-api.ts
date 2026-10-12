// Avatar API checks: PUT /api/users/me/avatar stores only a validated avatar, and the map payload carries it.
//
//   npm run test:avatar            (builds a scratch database, runs this, drops it)
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-avatar-api.ts
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
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
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

// ---- app: fake auth via header, req.login recorded so we can assert what the session is refreshed with ----
let lastLogin: any = null;
const app = express();
app.set("trust proxy", 1); // so X-Forwarded-For picks the rate-limit bucket
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  req.login = (u: unknown, cb: (e?: Error) => void) => { lastLogin = u; cb(); };
  next();
});
app.use(redactSensitiveFields);
registerUsersRoutes(app);
registerMapRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
/** Each call gets its own client IP unless `ip` is given (used to test the per-IP rate limit honestly). */
async function http(method: string, path: string, as: string | null, body?: unknown, ip?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": ip ?? `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function raw(path: string) {
  const res = await fetch(base + path, { headers: { "x-forwarded-for": `10.8.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` } });
  return { status: res.status, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", sniff: res.headers.get("x-content-type-options") ?? "", csp: res.headers.get("content-security-policy") ?? "", text: await res.text() };
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- fixtures ----
const hash = await bcrypt.hash("Passw0rd!avatar", 4);
const stamp = Date.now();
const mk = async (name: string) => (await q(
  `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete)
   values ($1,$2,'social',$3,true,true) returning id`, [`${name}${stamp}@t.dev`, `${name}${stamp}`, hash]))[0].id as string;
const A = await mk("av_a");
const B = await mk("av_b");
const Cc = await mk("av_c"); // friend with no avatar
const stored = async (id: string) => (await q(`select avatar from users where id=$1`, [id]))[0].avatar;
const KEYS = ["v", "type", "skin", "hair", "hairColor", "expression", "facial", "outfit", "outfitColor", "eyewear", "headwear", "hoops"].sort();
const male = { v: 1, type: "male", skin: 5, hair: "mohawk", hairColor: 0, expression: "grin", facial: "beard", outfit: "bomber", outfitColor: 2, eyewear: "none", headwear: "none", hoops: false };
const PUT = "/api/users/me/avatar";

try {
  // 1. valid avatar is stored, returned in session shape, and refreshed into the session
  let r = await http("PUT", PUT, A, { avatar: male });
  check("valid avatar: 200", r.status === 200, JSON.stringify(r.json));
  const s1 = await stored(A);
  check("valid avatar: stored", s1?.type === "male" && s1?.hair === "mohawk" && s1?.skin === 5 && s1?.v === 1, JSON.stringify(s1));
  check("valid avatar: response carries it", r.json?.avatar?.hair === "mohawk");
  check("valid avatar: response keeps session fields (hasPassword)", r.json?.hasPassword === true, JSON.stringify(Object.keys(r.json ?? {})));
  check("valid avatar: session refreshed with avatar", lastLogin?.avatar?.hair === "mohawk");
  check("valid avatar: no sensitive fields leak", !!r.json && !/passwordHash|passwordResetToken|verifiedPhone/.test(JSON.stringify(r.json)));

  // 2. extra and hostile keys are dropped; only the 12 known keys are stored
  r = await http("PUT", PUT, A, { avatar: JSON.parse(JSON.stringify({ ...male, hair: "punk", evil: "<script>" }).replace("{", '{"__proto__":{"x":1},')) });
  const s2 = await stored(A);
  check("extra keys: accepted", r.status === 200, JSON.stringify(r.json));
  check("extra keys: only known keys stored", JSON.stringify(Object.keys(s2 ?? {}).sort()) === JSON.stringify(KEYS), JSON.stringify(Object.keys(s2 ?? {})));
  check("extra keys: no prototype pollution", ({} as any).x === undefined);

  // 3. invalid values are rejected with the failing field, nothing changes
  const before = JSON.stringify(await stored(A));
  const bad: Array<[string, unknown, string]> = [
    ["string", "nope", "avatar"], ["number", 7, "avatar"], ["array", [], "avatar"], ["empty object", {}, "type"],
    ["bad type", { ...male, type: "robot" }, "type"], ["hair not for type", { ...male, type: "female", facial: "none", hair: "mohawk" }, "hair"],
    ["skin out of range", { ...male, skin: 99 }, "skin"], ["female facial hair", { ...male, type: "female", hair: "long", facial: "beard" }, "facial"],
    ["hoops not boolean", { ...male, hoops: "yes" }, "hoops"],
  ];
  for (const [name, body, field] of bad) {
    r = await http("PUT", PUT, A, { avatar: body });
    check(`invalid (${name}): 400 naming "${field}"`, r.status === 400 && r.json?.field === field, `${r.status} ${JSON.stringify(r.json)}`);
  }
  r = await http("PUT", PUT, A, {});
  check("missing avatar key: 400", r.status === 400, `${r.status}`);
  check("invalid: stored value unchanged", JSON.stringify(await stored(A)) === before);

  // 4. the general profile PATCH no longer touches avatar, and unrelated edits leave it alone
  r = await http("PATCH", "/api/users/me", A, { avatar: { ...male, hair: "fade" }, bio: "hello" });
  check("PATCH with avatar key: 200 (bio saved)", r.status === 200, JSON.stringify(r.json));
  check("PATCH with avatar key: avatar not changed", JSON.stringify(await stored(A)) === before);

  // 5. null clears it
  r = await http("PUT", PUT, A, { avatar: null });
  check("null: 200", r.status === 200);
  check("null: cleared", (await stored(A)) === null);

  // 6. auth is required
  r = await http("PUT", PUT, null, { avatar: male });
  check("unauthenticated: 401", r.status === 401, `${r.status}`);

  // 7. rate limit: someone iterating on their look from one IP is not throttled at 5 saves (the profile limiter's cap)
  let all200 = true;
  for (let n = 0; n < 12; n++) { const x = await http("PUT", PUT, A, { avatar: { ...male, skin: n % 8 } }, "10.77.0.1"); if (x.status !== 200) { all200 = false; console.log("   save", n + 1, "->", x.status, JSON.stringify(x.json)); break; } }
  check("12 saves from one IP all succeed", all200);

  // 8. map: friends sharing their location carry their avatar (or null) in /api/map/nearby
  await q(`update users set avatar = $2, avatar_url = null where id = $1`, [B, JSON.stringify({ ...male, hair: "dreads", facial: "full", outfit: "sweater" })]);
  await q(`update users set avatar_url = 'https://example.test/c.png' where id = $1`, [Cc]);
  for (const [x, y] of [[A, B], [B, A], [A, Cc], [Cc, A]]) await q(`insert into follows (follower_id, following_id) values ($1,$2) on conflict do nothing`, [x, y]);
  for (const u of [B, Cc]) { const pr = await http("PUT", "/api/map/location", u, { latitude: 51.5, longitude: -0.12 }); check(`map: ${u === B ? "B" : "C"} starts sharing`, pr.status === 200, JSON.stringify(pr.json)); }
  r = await http("GET", "/api/map/nearby?lat=51.5&lng=-0.12&radiusKm=5", A);
  check("map: nearby 200", r.status === 200, JSON.stringify(r.json));
  const fB = r.json?.friends?.find((f: any) => f.id === B), fC = r.json?.friends?.find((f: any) => f.id === Cc);
  check("map: friend with avatar carries it", fB?.avatar?.hair === "dreads" && fB?.avatar?.facial === "full", JSON.stringify(fB));
  check("map: friend without avatar has avatar null and keeps photo url", fC && fC.avatar === null && fC.avatarUrl === "https://example.test/c.png", JSON.stringify(fC));
  check("map: no sensitive fields on friends", !JSON.stringify(r.json?.friends ?? []).match(/passwordHash|"email"|verifiedPhone/));

  // 9. avatar as profile picture: avatarUrl swap
  const col = async (id: string, c: string) => (await q(`select ${c} as v from users where id=$1`, [id]))[0].v;
  await q(`update users set avatar_url = '/api/media/photo-A', profile_photo_url = null, avatar = null where id = $1`, [A]);
  r = await http("PUT", PUT, A, { avatar: male, usePicture: true });
  check("picture on: 200", r.status === 200, JSON.stringify(r.json));
  const urlOn: string = r.json?.avatarUrl ?? "";
  check("picture on: avatarUrl is the avatar image url", urlOn.startsWith(`/api/avatar-img/${A}.svg?v=`), urlOn);
  check("picture on: photo parked", (await col(A, "profile_photo_url")) === "/api/media/photo-A");
  check("picture on: session refreshed with the new avatarUrl", lastLogin?.avatarUrl === urlOn);

  const img = await raw(urlOn);
  check("image route: 200 svg", img.status === 200 && /image\/svg\+xml/.test(img.type) && img.text.startsWith("<svg"), `${img.status} ${img.type}`);
  check("image route: public immutable cache when versioned", /public/.test(img.cache) && /immutable/.test(img.cache) && /max-age=31536000/.test(img.cache), img.cache);
  check("image route: nosniff and locked-down CSP", /nosniff/i.test(img.sniff) && /default-src 'none'/.test(img.csp), `${img.sniff} | ${img.csp}`);
  check("image route: contains no script", !/<script|onload|javascript:/i.test(img.text));
  const noV = await raw(`/api/avatar-img/${A}.svg`);
  check("image route: unversioned url is revalidated, not immutable", noV.status === 200 && !/immutable/.test(noV.cache), noV.cache);
  check("image route: unknown user 404", (await raw(`/api/avatar-img/00000000-0000-0000-0000-000000000000.svg`)).status === 404);
  check("image route: user without avatar 404", (await raw(`/api/avatar-img/${Cc}.svg`)).status === 404);
  check("image route: odd ids 404", (await raw(`/api/avatar-img/..%2F..%2Fetc.svg`)).status === 404 && (await raw(`/api/avatar-img/x.png`)).status === 404);
  await q(`update users set avatar = '"junk"'::jsonb where id = $1`, [A]);
  check("image route: junk stored config 404 (no crash)", (await raw(`/api/avatar-img/${A}.svg`)).status === 404);
  await q(`update users set avatar = $2 where id = $1`, [A, JSON.stringify(male)]);

  r = await http("PUT", PUT, A, { avatar: { ...male, hair: "punk" } });
  check("re-save keeps picture on and bumps the version", r.json?.avatarUrl?.startsWith(`/api/avatar-img/${A}.svg?v=`) && r.json.avatarUrl !== urlOn, JSON.stringify(r.json?.avatarUrl));
  check("re-save keeps the parked photo", (await col(A, "profile_photo_url")) === "/api/media/photo-A");

  r = await http("PUT", PUT, A, { avatar: { ...male, hair: "punk" }, usePicture: false });
  check("picture off: photo restored", r.json?.avatarUrl === "/api/media/photo-A" && (await col(A, "avatar_url")) === "/api/media/photo-A" && (await col(A, "profile_photo_url")) === null, JSON.stringify(r.json?.avatarUrl));
  r = await http("PUT", PUT, A, { avatar: male, usePicture: "yes" });
  check("usePicture must be a boolean: 400", r.status === 400 && r.json?.field === "usePicture", `${r.status} ${JSON.stringify(r.json)}`);

  // upload a photo while the avatar is the picture: picture goes off, new photo shown, parked photo dropped
  await http("PUT", PUT, A, { avatar: male, usePicture: true });
  r = await http("POST", "/api/users/me/avatar", A, { imageData: PNG });
  check("photo upload while on: 200", r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  const afterUpload = (await q(`select avatar_url, profile_photo_url, avatar from users where id=$1`, [A]))[0];
  check("photo upload while on: avatarUrl is the new photo, mode off, avatar kept", !!afterUpload.avatar_url && !afterUpload.avatar_url.startsWith("/api/avatar-img/") && afterUpload.profile_photo_url === null && afterUpload.avatar?.type === "male", JSON.stringify(afterUpload));

  // choosing a photo path (second photo setter) while on behaves the same
  await http("PUT", PUT, A, { avatar: male, usePicture: true });
  r = await http("PATCH", "/api/users/me/avatar", A, { avatarPath: "/api/media/chosen" });
  check("photo path while on: picture off", (await col(A, "avatar_url")) === "/api/media/chosen" && (await col(A, "profile_photo_url")) === null, `${r.status}`);

  // deleting the photo while on removes only the parked photo
  await q(`update users set avatar_url = '/api/media/photo-A', profile_photo_url = null where id = $1`, [A]);
  await http("PUT", PUT, A, { avatar: male, usePicture: true });
  r = await http("DELETE", "/api/users/me/avatar", A);
  check("photo delete while on: avatar stays the picture, parked photo gone", String(await col(A, "avatar_url")).startsWith("/api/avatar-img/") && (await col(A, "profile_photo_url")) === null, `${r.status}`);
  r = await http("PUT", PUT, A, { avatar: male, usePicture: false });
  check("then turning it off leaves no picture (photo was deleted)", (await col(A, "avatar_url")) === null);

  // clearing the avatar restores the photo
  await q(`update users set avatar_url = '/api/media/photo-A', profile_photo_url = null where id = $1`, [A]);
  await http("PUT", PUT, A, { avatar: male, usePicture: true });
  r = await http("PUT", PUT, A, { avatar: null });
  check("clearing avatar restores the photo", (await col(A, "avatar_url")) === "/api/media/photo-A" && (await col(A, "avatar")) === null && (await col(A, "profile_photo_url")) === null);

  // friends see the avatar as the picture everywhere (map list, feed, chat all read avatarUrl)
  await http("PUT", PUT, B, { avatar: male, usePicture: true });
  r = await http("GET", "/api/map/nearby?lat=51.5&lng=-0.12&radiusKm=5", A);
  const fB2 = r.json?.friends?.find((f: any) => f.id === B);
  check("friend payload carries the avatar image as avatarUrl", fB2?.avatarUrl?.startsWith(`/api/avatar-img/${B}.svg?v=`), JSON.stringify(fB2));

  // general profile PATCH: avatar image urls cannot be set by hand; choosing a photo while on turns the mode off
  await q(`update users set avatar_url = null, profile_photo_url = null where id = $1`, [A]);
  await http("PUT", PUT, A, { avatar: male, usePicture: true });
  r = await http("PATCH", "/api/users/me", A, { avatarUrl: `/api/avatar-img/${B}.svg?v=deadbeef` });
  check("profile PATCH ignores avatar image urls (and answers 200, not 500)", r.status === 200 && String(await col(A, "avatar_url")).startsWith(`/api/avatar-img/${A}.svg`), `${r.status} ${String(await col(A, "avatar_url"))}`);
  await http("PATCH", "/api/users/me", A, { avatarUrl: "/api/media/x" });
  check("profile PATCH photo while on: mode off, parked photo cleared", (await col(A, "avatar_url")) === "/api/media/x" && (await col(A, "profile_photo_url")) === null);

  // account deletion scrubs the avatar and the parked photo
  await storage.softDeleteUser(B);
  const del = (await q(`select avatar, avatar_url, profile_photo_url from users where id=$1`, [B]))[0];
  check("account deletion clears avatar, avatarUrl and parked photo", del.avatar === null && del.avatar_url === null && del.profile_photo_url === null, JSON.stringify(del));
  check("deleted user's image route 404s", (await raw(`/api/avatar-img/${B}.svg`)).status === 404);
} finally {
  await q(`delete from users where id = any($1)`, [[A, B, Cc]]).catch(() => {});
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
