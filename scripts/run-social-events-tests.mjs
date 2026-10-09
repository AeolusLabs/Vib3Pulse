// One command for every social-events test:   npm run test:social
//   npm run test:social -- --only=4,6     run just some suites (2, 3, 4, 5, 6)
//   npm run test:social -- --keep         keep the scratch databases afterwards (for poking around)
//
// How it stays safe: it NEVER runs a test or a migration against DATABASE_URL itself. For each group of
// suites it creates a brand-new, empty database named vib3_social_test_<random> on the same server, builds the
// schema in it (drizzle-kit push + the migrations/add_social_events*.sql files), runs the suites there, and
// drops it. The only statements it sends to your real database are CREATE DATABASE and DROP DATABASE for a
// name it generated itself, and it refuses to drop anything that doesn't match that exact pattern.
//
// Needs: a Postgres role that may CREATE DATABASE (Railway's default does). Override the server used for
// create/drop with TEST_ADMIN_DATABASE_URL if you'd rather point at a separate server.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("DATABASE_URL is not set. Run with:  npm run test:social");
  process.exit(2);
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",").map((s) => s.trim())) : null;

// Phase 4 and 6 assert on queue-wide state, so each gets its own empty database. Phases 3, 2 and 5 are
// independent of each other's leftovers but 3+2 are cheap to share.
const GROUPS = [
  { name: "private events + public events & abuse controls", suites: ["3", "2"] },
  { name: "admin side (queue, hosts, config, reveal grants)", suites: ["4"] },
  { name: "guest privacy (notice, opt-out, retention, deletion)", suites: ["5"] },
  { name: "cross-cutting (CSRF, auth sweep, leak sweep, price-0 ticket)", suites: ["6"] },
].map((g) => ({ ...g, suites: g.suites.filter((s) => !only || only.has(s)) })).filter((g) => g.suites.length);

const SCRATCH_NAME = /^vib3_social_test_[0-9a-f]{8}$/;
const migrationFiles = readdirSync(join(root, "migrations"))
  .filter((f) => /^add_social_events(_phase\d+)?\.sql$/.test(f))
  .sort((a, b) => (Number(a.match(/phase(\d+)/)?.[1] ?? 0) - Number(b.match(/phase(\d+)/)?.[1] ?? 0)));

const withDb = (url, name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

function run(cmd, cmdArgs, env, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, env: { ...process.env, ...env }, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function admin(sql) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const results = [];
let currentDb = null;
async function dropCurrent() {
  if (!currentDb || keep) { if (currentDb && keep) console.log(`   (kept ${currentDb})`); currentDb = null; return; }
  if (!SCRATCH_NAME.test(currentDb)) { console.error(`refusing to drop unexpected database name "${currentDb}"`); currentDb = null; return; }
  try { await admin(`DROP DATABASE IF EXISTS ${currentDb} WITH (FORCE)`); } catch (e) { console.error(`could not drop ${currentDb}: ${e.message}`); }
  currentDb = null;
}
process.on("SIGINT", async () => { await dropCurrent(); process.exit(130); });

const started = Date.now();
for (const group of GROUPS) {
  console.log(`\n=== ${group.name}`);
  const dbName = `vib3_social_test_${crypto.randomBytes(4).toString("hex")}`;
  const url = withDb(adminUrl, dbName);
  try {
    await admin(`CREATE DATABASE ${dbName}`);
    currentDb = dbName;
    process.stdout.write("   building schema... ");
    const push = await run("npx", ["drizzle-kit", "push", "--force"], { DATABASE_URL: url });
    if (push.code !== 0) throw new Error(`drizzle-kit push failed:\n${push.out.slice(-600)}`);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    for (const f of migrationFiles) await c.query(readFileSync(join(root, "migrations", f), "utf8"));
    await c.end();
    console.log(`done (${migrationFiles.length} migrations)`);

    for (const n of group.suites) {
      const t = Date.now();
      process.stdout.write(`   phase ${n} suite... `);
      const r = await run("npx", ["tsx", `scripts/test-social-events-phase${n}.ts`], { DATABASE_URL: url, SESSION_SECRET: "test", DISABLE_GEOCODING: "1" });
      const m = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
      const passed = m ? Number(m[1]) : 0, failed = m ? Number(m[2]) : 1;
      const secs = Math.round((Date.now() - t) / 1000);
      console.log(m ? `${passed} passed, ${failed} failed (${secs}s)` : `DID NOT FINISH (${secs}s)`);
      for (const line of r.out.split("\n")) if (/^\s+FAIL |UNEXPECTED ERROR/.test(line)) console.log(`     ${line.trim().slice(0, 240)}`);
      if (!m) console.log(r.out.split("\n").slice(-12).map((l) => `     ${l}`).join("\n"));
      results.push({ phase: n, passed, failed, ok: !!m && failed === 0 });
    }
  } catch (e) {
    console.error(`   ERROR: ${e.message}`);
    for (const n of group.suites) results.push({ phase: n, passed: 0, failed: 1, ok: false });
  } finally {
    await dropCurrent();
  }
}

console.log("\n=== summary");
for (const r of results.sort((a, b) => a.phase - b.phase)) console.log(`   phase ${r.phase}: ${r.ok ? "PASS" : "FAIL"}  (${r.passed} passed, ${r.failed} failed)`);
const total = results.reduce((s, r) => s + r.passed, 0);
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${bad === 0 ? "ALL GREEN" : `${bad} SUITE(S) FAILED`}: ${total} checks passed in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(bad === 0 ? 0 : 1);
