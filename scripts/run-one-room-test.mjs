// Run one or more rooms test files against their OWN scratch database:
//   node --env-file=.env scripts/run-one-room-test.mjs scripts/test-rooms-api-settlement.ts [more files]
// Unit files (test-rooms-unit*.ts) need no database and run directly. Everything else gets a fresh scratch DB named
// vib3_rooms_test_<hex> (schema from drizzle-kit push, same as run-rooms-tests.mjs), dropped afterwards. Never touches DATABASE_URL's database.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) { console.error("DATABASE_URL is not set"); process.exit(2); }
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) { console.error("usage: run-one-room-test.mjs <scripts/test-rooms-*.ts> [...]"); process.exit(2); }
for (const f of files) if (!/^scripts\/test-rooms-[a-z0-9-]+\.ts$/.test(f.replaceAll("\\", "/"))) { console.error(`refusing ${f}`); process.exit(2); }

const SCRATCH = /^vib3_rooms_test_[0-9a-f]{8}$/;
const withDb = (url, name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
const run = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, shell: process.platform === "win32" });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});
const admin = async (sql) => { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const clean = (s) => s.trim().split("\n").filter((l) => !/DEP0190|trace-deprecation/.test(l)).join("\n");

let ok = true;
const dbName = `vib3_rooms_test_${crypto.randomBytes(4).toString("hex")}`;
let created = false;
try {
  const needDb = files.filter((f) => !/test-rooms-unit/.test(f));
  let url = null;
  if (needDb.length) {
    await admin(`CREATE DATABASE ${dbName}`); created = true;
    url = withDb(adminUrl, dbName);
    const push = await run("npx", ["drizzle-kit", "push", "--force"], { DATABASE_URL: url });
    if (push.code !== 0) throw new Error(`drizzle-kit push failed:\n${push.out.slice(-600)}`);
  }
  for (const f of files) {
    const env = /test-rooms-unit/.test(f) ? {} : { DATABASE_URL: url, SESSION_SECRET: "test", DISABLE_GEOCODING: "1", RESEND_API_KEY: "re_dummy_not_real", LIVEKIT_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" };
    const r = await run("npx", ["tsx", f], env);
    console.log(`-- ${f}`);
    console.log(clean(r.out));
    if (r.code !== 0) ok = false;
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`); ok = false;
} finally {
  if (created) {
    if (!SCRATCH.test(dbName)) console.error(`refusing to drop unexpected database "${dbName}"`);
    else await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error(`could not drop ${dbName}: ${e.message}`));
  }
}
console.log(ok ? "\nALL GREEN" : "\nFAILED");
process.exit(ok ? 0 : 1);
