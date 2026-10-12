// One command for the avatar tests:   npm run test:avatar
//
// Same safety model as run-social-events-tests.mjs: never touches DATABASE_URL itself. It creates a
// scratch database named vib3_avatar_test_<random> on the same server, builds the schema there with
// drizzle-kit push, runs the unit and API suites, and drops it (refusing any other name).
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) { console.error("DATABASE_URL is not set. Run with:  npm run test:avatar"); process.exit(2); }

const SCRATCH = /^vib3_avatar_test_[0-9a-f]{8}$/;
const withDb = (url, name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
const run = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, shell: process.platform === "win32" });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});
const admin = async (sql) => { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const dbName = `vib3_avatar_test_${crypto.randomBytes(4).toString("hex")}`;
const url = withDb(adminUrl, dbName);
let ok = true;
let created = false;
try {
  console.log("unit (no database):");
  if (!only || only === "unit") {
    for (const f of ["scripts/test-avatar.ts", "scripts/test-building.ts"]) {
      const u = await run("npx", ["tsx", f], {});
      console.log(u.out.trim().split("\n").filter((l) => !/DEP0190|trace-deprecation/.test(l)).map((l) => `  ${l}`).join("\n"));
      if (u.code !== 0) ok = false;
    }
  }
  if (!only || only === "api") {
    await admin(`CREATE DATABASE ${dbName}`); created = true;
    process.stdout.write("\napi: building scratch schema... ");
    const push = await run("npx", ["drizzle-kit", "push", "--force"], { DATABASE_URL: url });
    if (push.code !== 0) throw new Error(`drizzle-kit push failed:\n${push.out.slice(-600)}`);
    console.log("done");
    for (const f of ["scripts/test-avatar-api.ts", "scripts/test-building-api.ts"]) {
      const r = await run("npx", ["tsx", f], { DATABASE_URL: url, SESSION_SECRET: "test", DISABLE_GEOCODING: "1" });
      console.log(`  -- ${f}`);
      console.log(r.out.trim().split("\n").filter((l) => !/DEP0190|trace-deprecation/.test(l)).map((l) => `  ${l}`).join("\n"));
      if (r.code !== 0) ok = false;
    }
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
