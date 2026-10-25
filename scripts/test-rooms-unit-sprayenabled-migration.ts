// rooms.spray_enabled migration text (no database):   npx tsx scripts/test-rooms-unit-sprayenabled-migration.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOM_SPRAY_ENABLED_SCHEMA_SQL } from "../server/rooms/roomSprayEnabledMigration";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

test("add_rooms_spray_enabled.sql holds exactly ROOM_SPRAY_ENABLED_SCHEMA_SQL inside BEGIN/COMMIT", () => {
  const file = readFileSync(new URL("../migrations/add_rooms_spray_enabled.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const body = file.slice(file.indexOf("BEGIN;") + "BEGIN;".length, file.lastIndexOf("COMMIT;")).trim();
  assert.equal(body, ROOM_SPRAY_ENABLED_SCHEMA_SQL.trim());
});

test("adds spray_enabled boolean NOT NULL DEFAULT false", () => {
  assert.ok(ROOM_SPRAY_ENABLED_SCHEMA_SQL.includes("ADD COLUMN IF NOT EXISTS spray_enabled boolean NOT NULL DEFAULT false"));
});

test("idempotent and additive: no drop, delete, truncate or rename", () => {
  assert.ok(!/\bdrop\b|\bdelete\b|\btruncate\b|\brename\b|alter column/i.test(ROOM_SPRAY_ENABLED_SCHEMA_SQL));
  for (const stmt of ROOM_SPRAY_ENABLED_SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) assert.match(stmt, /IF NOT EXISTS/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
