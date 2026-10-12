// One command for the social plan checks:   node --env-file=.env scripts/run-social-plans-test.mjs
// Same safety model as run-social-events-tests.mjs: never touches DATABASE_URL's own database. It creates
// a brand-new vib3_plans_test_<random> database on the same server, builds the schema with drizzle-kit
// push, runs scripts/test-social-plans.ts there, and drops it (only if the name matches that pattern).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) { console.error("DATABASE_URL is not set."); process.exit(2); }

const name = `vib3_plans_test_${crypto.randomBytes(4).toString("hex")}`;
const withDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const run = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, shell: process.platform === "win32" });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ code, out }));
});
const admin = async (sql) => { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };

let code = 1;
try {
  await admin(`CREATE DATABASE ${name}`);
  const url = withDb(adminUrl, name);
  process.stdout.write("building schema... ");
  const push = await run("npx", ["drizzle-kit", "push", "--force"], { DATABASE_URL: url });
  if (push.code !== 0) throw new Error(`drizzle-kit push failed:\n${push.out.slice(-600)}`);
  console.log("done");
  const r = await run("npx", ["tsx", "scripts/test-social-plans.ts"], { DATABASE_URL: url, SESSION_SECRET: "test", DISABLE_GEOCODING: "1" });
  console.log(r.out);
  code = r.code ?? 1;
} catch (e) {
  console.error(`ERROR: ${e.message}`);
} finally {
  if (/^vib3_plans_test_[0-9a-f]{8}$/.test(name)) {
    try { await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch (e) { console.error(`could not drop ${name}: ${e.message}`); }
  }
}
process.exit(code);
