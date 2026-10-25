// spray_events: migration text and the "every status change writes an event" structure test (no database):
//   npx tsx scripts/test-rooms-unit-sprayevents.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { SPRAY_EVENTS_SCHEMA_SQL } from "../server/rooms/sprayEventsMigration";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("spray_events migration SQL equals the .sql file", () => {
  const file = readFileSync(join(root, "migrations/add_spray_events.sql"), "utf8").replace(/\r\n/g, "\n");
  const body = file.slice(file.indexOf("BEGIN;") + "BEGIN;".length, file.lastIndexOf("COMMIT;")).trim();
  assert.equal(body, SPRAY_EVENTS_SCHEMA_SQL.trim());
});

test("spray_events migration is additive, idempotent and has the required shape", () => {
  const sql = SPRAY_EVENTS_SCHEMA_SQL;
  assert.ok(!/\bdrop\b|\bdelete\b|\btruncate\b|\brename\b|alter column/i.test(sql));
  assert.ok(/CREATE TABLE IF NOT EXISTS spray_events/.test(sql));
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 4);
  assert.ok(/source IN \('api', 'callback', 'sweep', 'admin', 'system'\)/.test(sql));
  assert.ok(/spray_id IS NOT NULL OR batch_id IS NOT NULL/.test(sql));
  assert.ok(/char_length\(detail\) <= 300/.test(sql));
});

// ---- structure test: every write of a status to spray_payments / spray_batches lives in a listed function that also logs.
// Allowed = file -> functions. Adding a new status writer means adding it here AND calling recordSprayEvent/recordBatchTransition in it.
const ALLOWED: Record<string, string[]> = {
  "server/rooms/sprayStorage.ts": ["markSprayStatus"],
  "server/rooms/sprayBatchStorage.ts": ["markBatchStatus"],
  "server/rooms/spray.ts": ["deliverOrReverse", "confirmReversed"],
  "server/rooms/teamSpray.ts": ["deliverBatch", "confirmBatchReversed", "disputeBatchLocked"],
  "server/rooms/clawbacks.ts": ["disputeLocked"],
};
const LOGS = /recordSprayEvent|recordBatchTransition/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p, out); }
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}
/** The text of the function that contains index i (from its `function name` to the next top-level `function`). */
function enclosing(src: string, i: number): { name: string; body: string } | null {
  const re = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  let m: RegExpExecArray | null, last: { name: string; start: number } | null = null;
  while ((m = re.exec(src)) && m.index <= i) last = { name: m[1], start: m.index };
  if (!last) return null;
  const next = src.indexOf("\nfunction ", i), nextA = src.indexOf("\nasync function ", i), nextE = src.indexOf("\nexport ", i);
  const ends = [next, nextA, nextE].filter((n) => n > 0);
  return { name: last.name, body: src.slice(last.start, ends.length ? Math.min(...ends) : src.length) };
}

test("every status change writes an event (structure test)", () => {
  const writes: Array<{ file: string; fn: string; ok: boolean }> = [];
  for (const abs of walk(join(root, "server"))) {
    const file = abs.slice(root.length).split(sep).join("/").replace(/^\//, "");
    if (/Migration\.ts$/.test(file)) continue;
    const src = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    const patterns = [
      /update\s+spray_(?:payments|batches)\s+set\s+status/gi,
      /\.update\((?:sprayPayments|sprayBatches)\)\s*\.set\(\s*(?:set\b|\{[^}]*\bstatus\b)/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const fn = enclosing(src, m.index);
        writes.push({ file, fn: fn?.name ?? "?", ok: !!fn && (ALLOWED[file] ?? []).includes(fn.name) && LOGS.test(fn.body) });
      }
    }
  }
  assert.ok(writes.length >= 8, `expected to find the known status writers, found ${writes.length}`);
  const bad = writes.filter((w) => !w.ok).map((w) => `${w.file}:${w.fn}`);
  assert.deepEqual(bad, [], `status write outside an allowed, event-logging function: ${bad.join(", ")}`);
  // and every allowed function is actually still present (a rename must update this list)
  for (const [file, fns] of Object.entries(ALLOWED)) for (const f of fns) assert.ok(writes.some((w) => w.file === file && w.fn === f), `${file}:${f} no longer writes a status`);
});

test("inserts of new sprays and batches are logged too", () => {
  assert.ok(/recordSprayEvent/.test(readFileSync(join(root, "server/rooms/sprayStorage.ts"), "utf8").split("export async function markSprayStatus")[0]));
  assert.ok(/recordSprayEvent/.test(readFileSync(join(root, "server/rooms/sprayBatchStorage.ts"), "utf8").split("export async function markBatchStatus")[0]));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
