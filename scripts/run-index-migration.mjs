import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = readFileSync(join(__dirname, "../migrations/add_perf_indexes.sql"), "utf8");

// Strip line comments FIRST (they may contain semicolons), then split
const statements = sql
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map(s => s.trim())
  .filter(s => s.length > 0);

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let ok = 0;
let skipped = 0;

for (const stmt of statements) {
  const name = stmt.match(/idx_\w+/)?.[0] ?? stmt.slice(0, 60).replace(/\s+/g, " ");
  process.stdout.write(`  → ${name} ... `);
  try {
    await client.query(stmt);
    console.log("done");
    ok++;
  } catch (err) {
    if (err.message.includes("already exists")) {
      console.log("already exists, skipped");
      skipped++;
    } else {
      console.error(`FAILED: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

await client.end();
console.log(`\n${ok} created, ${skipped} skipped.`);
