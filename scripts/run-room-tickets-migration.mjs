import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
// usage: node --env-file=.env scripts/run-room-tickets-migration.mjs [file]   (default add_room_tickets.sql)
const file = process.argv[2] ?? "add_room_tickets.sql";
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../migrations", file), "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql); // file is one BEGIN/COMMIT transaction
  console.log(`${file} applied`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Migration failed, rolled back:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
