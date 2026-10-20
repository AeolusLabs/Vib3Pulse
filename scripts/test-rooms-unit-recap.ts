// Room recap shaping, the peak migration, and the notifyFriendsLive privacy setting (no database):
//   npx tsx scripts/test-rooms-unit-recap.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveMinutes, minutesInRoom, shapeRecap } from "../shared/roomRecap";
import { DEFAULT_ROOM_PRIVACY, resolveRoomPrivacy, validateRoomPrivacy } from "../shared/rooms";
import { ROOM_PEAK_SCHEMA_SQL } from "../server/rooms/roomPeakMigration";
import { RoomHub } from "../server/rooms/RoomHub";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const all = {
  minutesIn: 42, messages: 7, next: { roomId: "r2", scheduledFor: "2026-10-21T20:00:00.000Z" }, follow: true,
  minutes: 90, peak: 33, ticketsSold: 21, followersGained: 4, earnedKobo: 1234500,
};
const HOST_KEYS = ["minutes", "peak", "ticketsSold", "followersGained", "earnedKobo"];

test("a guest gets exactly the four guest fields, never a host-only one", () => {
  const g = shapeRecap(all, false);
  assert.deepEqual(Object.keys(g).sort(), ["follow", "messages", "minutesIn", "next"]);
  for (const k of HOST_KEYS) assert.ok(!(k in g), k);
  assert.ok(!JSON.stringify(g).includes("1234500"));
});

test("a guest never gets an extra field added to the input by mistake", () => {
  const g = shapeRecap({ ...all, payerIds: ["x"], email: "a@b" } as any, false);
  assert.deepEqual(Object.keys(g).sort(), ["follow", "messages", "minutesIn", "next"]);
});

test("the host gets the guest fields plus the host numbers (follow is always false for the host)", () => {
  const h = shapeRecap(all, true);
  for (const k of HOST_KEYS) assert.ok(k in h, k);
  assert.equal(h.follow, false);
  assert.equal(h.earnedKobo, 1234500);
  assert.equal(shapeRecap({ ...all, peak: null, followersGained: null }, true).peak, null);
});

test("numbers are whole and never negative", () => {
  const h = shapeRecap({ ...all, minutesIn: -3, messages: 2.7, earnedKobo: -1, ticketsSold: NaN as any }, true);
  assert.equal(h.minutesIn, 0); assert.equal(h.messages, 2); assert.equal(h.earnedKobo, 0); assert.equal(h.ticketsSold, 0);
});

test("minutesInRoom: stored seconds plus an open visit, capped at the room's length", () => {
  assert.equal(minutesInRoom({ secondsIn: 600, joinedAtMs: null, leftAtMs: 1, untilMs: 0, roomMinutes: 60 }), 10);
  assert.equal(minutesInRoom({ secondsIn: 60, joinedAtMs: 0, leftAtMs: null, untilMs: 120_000, roomMinutes: 60 }), 3);
  assert.equal(minutesInRoom({ secondsIn: 999_999, joinedAtMs: null, leftAtMs: 1, untilMs: 0, roomMinutes: 45 }), 45);
});

test("liveMinutes: whole minutes, 0 when a time is missing or out of order", () => {
  assert.equal(liveMinutes(0, 90 * 60_000 + 59_000), 90);
  assert.equal(liveMinutes(null, 5), 0);
  assert.equal(liveMinutes(10, 5), 0);
});

test("RoomHub peak: raised only by a join that beats it, forgotten on end", () => {
  const hub = new RoomHub();
  const m = (id: string) => ({ userId: id, role: "guest" as const, muted: false, joinedAt: 0, send: () => {} });
  hub.join("r", m("a")); assert.equal(hub.recordPeak("r"), 1);
  hub.join("r", m("b")); assert.equal(hub.recordPeak("r"), 2);
  hub.leave("r", "b"); hub.join("r", m("c")); assert.equal(hub.recordPeak("r"), null); // back to 2, not a new peak
  assert.equal(hub.peakOf("r"), 2);
  hub.end("r"); assert.equal(hub.peakOf("r"), 0);
});

test("migration: add_room_peak.sql holds exactly ROOM_PEAK_SCHEMA_SQL inside BEGIN/COMMIT, additive only", () => {
  const file = readFileSync(new URL("../migrations/add_room_peak.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const body = file.slice(file.indexOf("BEGIN;") + "BEGIN;".length, file.lastIndexOf("COMMIT;")).trim();
  assert.equal(body, ROOM_PEAK_SCHEMA_SQL.trim());
  assert.ok(!/\bdrop\b|\bdelete\b|\btruncate\b|\brename\b|alter column/i.test(ROOM_PEAK_SCHEMA_SQL));
  for (const stmt of ROOM_PEAK_SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) assert.match(stmt, /ADD COLUMN IF NOT EXISTS/);
});

test("migration runner reads add_room_peak.sql and rolls back on failure", () => {
  const r = readFileSync(new URL("./run-room-peak-migration.mjs", import.meta.url), "utf8");
  assert.match(r, /"add_room_peak\.sql"/);
  assert.match(r, /ROLLBACK/);
});

test("privacy: resolveRoomPrivacy({}) has notifyFriendsLive === true", () => {
  assert.equal(resolveRoomPrivacy({}).notifyFriendsLive, true);
  assert.equal(DEFAULT_ROOM_PRIVACY.notifyFriendsLive, true);
});

test("privacy: an old stored value without the field resolves with the default; a stored false is kept", () => {
  const old = { v: 1, interactions: "none", appearInLists: false, allowInvites: true, allowCrossAgeDm: false };
  const r = resolveRoomPrivacy(old);
  assert.equal(r.notifyFriendsLive, true);
  assert.equal(r.interactions, "none");
  assert.equal(resolveRoomPrivacy({ ...old, notifyFriendsLive: false }).notifyFriendsLive, false);
  assert.equal(resolveRoomPrivacy({ ...old, notifyFriendsLive: "no" }).notifyFriendsLive, true); // junk -> default (reader is tolerant)
});

test("privacy: the strict validator rejects a non-boolean notifyFriendsLive", () => {
  const good = { interactions: "mutuals", appearInLists: true, allowInvites: true };
  for (const bad of ["false", 0, 1, null, {}, []]) {
    assert.deepEqual(validateRoomPrivacy({ ...good, notifyFriendsLive: bad }), { ok: false, field: "notifyFriendsLive" }, String(bad));
  }
  const ok = validateRoomPrivacy({ ...good, notifyFriendsLive: false });
  assert.ok(ok.ok && ok.value.notifyFriendsLive === false);
});

test("privacy: an omitted notifyFriendsLive keeps the stored choice (an old client never turns it back on)", () => {
  const good = { interactions: "mutuals", appearInLists: true, allowInvites: true };
  const kept = validateRoomPrivacy(good, { notifyFriendsLive: false });
  assert.ok(kept.ok && kept.value.notifyFriendsLive === false);
  const dflt = validateRoomPrivacy(good);
  assert.ok(dflt.ok && dflt.value.notifyFriendsLive === true);
});

test("privacy: the room_live followers job reads the host's notifyFriendsLive", () => {
  // Fix round: the job moved to liveNotify.ts (all followers, chunked, in the background).
  const src = readFileSync(new URL("../server/rooms/liveNotify.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function notifyFollowersLive"), src.indexOf("const runs = new Map"));
  assert.match(fn, /resolveRoomPrivacy\(host\.roomPrivacy\)\.notifyFriendsLive\) return 0/);
  assert.match(fn, /room\.visibility === "invite"\) return 0/);
  assert.doesNotMatch(fn, /MAX_NOTIFY|\.slice\(0, \d+\)/); // never capped
  const routes = readFileSync(new URL("../server/rooms/roomRoutes.ts", import.meta.url), "utf8");
  assert.match(routes, /notifyFollowers\(live, host\); \/\/ background/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
