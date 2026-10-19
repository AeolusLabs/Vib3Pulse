// Host settings: pinned message, slow mode, room lock (no database):   npx tsx scripts/test-rooms-unit-hostsettings.ts
// (also run by npm run test:rooms)
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_LIMITS, SLOW_MODES, PINNED_INPUT_MAX, cutPinned, validateRoomInput } from "../shared/rooms";
import { roomReducer, initialRoomState } from "../client/src/lib/roomReducer";

// Same import style as test-rooms-unit-redaction.ts: server modules load without touching the database.
const { pinnedPlainText, publicRoom, viewerRoom } = await import("../server/rooms/roomAccess");

let passed = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e.message).split("\n")[0]}`); }
};
const base = { title: "Room", kind: "party", visibility: "public" };
const v = (extra: Record<string, unknown>) => validateRoomInput({ ...base, ...extra });

// ---- limits
t("ROOM_LIMITS.pinned is 200", () => assert.equal(ROOM_LIMITS.pinned, 200));
t("SLOW_MODES is [0, 5, 15, 30]", () => assert.deepEqual([...SLOW_MODES], [0, 5, 15, 30]));

// ---- slow mode vectors
for (const s of [0, 5, 15, 30]) {
  t(`slowModeSec ${s} accepted`, () => { const r = v({ slowModeSec: s }); assert.ok(r.ok); assert.equal((r as any).value.slowModeSec, s); });
}
for (const [label, bad] of [["7", 7], ['the string "5"', "5"], ["-5", -5], ["5.5", 5.5], ["null", null], ["NaN", NaN], ["true", true], ["60", 60], ["[5]", [5]]] as const) {
  t(`slowModeSec ${label} rejected (field slowModeSec)`, () => assert.deepEqual(v({ slowModeSec: bad }), { ok: false, field: "slowModeSec" }));
}
t("slowModeSec absent: no key in the value", () => { const r = v({}); assert.ok(r.ok); assert.ok(!("slowModeSec" in (r as any).value)); });

// ---- pinned message input
t("pinnedMessage absent: no key in the value", () => { const r = v({}); assert.ok(r.ok); assert.ok(!("pinnedMessage" in (r as any).value)); });
t("pinnedMessage null clears", () => assert.equal((v({ pinnedMessage: null }) as any).value.pinnedMessage, null));
t('pinnedMessage "" clears', () => assert.equal((v({ pinnedMessage: "" }) as any).value.pinnedMessage, null));
t("pinnedMessage whitespace clears", () => assert.equal((v({ pinnedMessage: "   " }) as any).value.pinnedMessage, null));
t("pinnedMessage is trimmed", () => assert.equal((v({ pinnedMessage: "  hi  " }) as any).value.pinnedMessage, "hi"));
t("pinnedMessage up to PINNED_INPUT_MAX accepted (the server cuts it)", () => assert.ok(v({ pinnedMessage: "a".repeat(PINNED_INPUT_MAX) }).ok));
t("pinnedMessage over PINNED_INPUT_MAX rejected", () => assert.deepEqual(v({ pinnedMessage: "a".repeat(PINNED_INPUT_MAX + 1) }), { ok: false, field: "pinnedMessage" }));
for (const [label, bad] of [["number", 5], ["object", { text: "x" }], ["array", ["x"]], ["boolean", true]] as const) {
  t(`pinnedMessage ${label} rejected`, () => assert.deepEqual(v({ pinnedMessage: bad }), { ok: false, field: "pinnedMessage" }));
}
t("locked is not part of validateRoomInput (the PATCH route checks it)", () => { const r = v({ locked: true }); assert.ok(r.ok); assert.ok(!("locked" in (r as any).value)); });

// ---- cut at 200
t("cutPinned cuts 300 chars to 200", () => assert.equal(cutPinned("a".repeat(300)), "a".repeat(200)));
t("cutPinned never splits an emoji", () => { const out = cutPinned("😀".repeat(250))!; assert.equal(Array.from(out).length, 200); assert.equal(out, "😀".repeat(200)); });
t("cutPinned empty / whitespace gives null", () => { assert.equal(cutPinned(""), null); assert.equal(cutPinned("   "), null); });

// ---- plain text (server)
t("pinnedPlainText strips tags", () => assert.equal(pinnedPlainText("<b>Hi</b> there"), "Hi there"));
t("pinnedPlainText drops script content", () => assert.equal(pinnedPlainText("<script>alert(1)</script>ok"), "ok"));
t("pinnedPlainText: HTML + 300 chars is plain and cut at 200 (tags do not count)", () => {
  const out = pinnedPlainText(`<i>${"x".repeat(300)}</i>`)!;
  assert.equal(out, "x".repeat(200));
  assert.ok(!/[<>]/.test(out));
});
t("pinnedPlainText keeps R&B readable", () => assert.equal(pinnedPlainText("R&B night"), "R&B night"));
t("pinnedPlainText: only tags gives null", () => { assert.equal(pinnedPlainText("<p></p>"), null); assert.equal(pinnedPlainText('<img src=x onerror="alert(1)">'), null); });
t("pinnedPlainText null / undefined gives null", () => { assert.equal(pinnedPlainText(null), null); assert.equal(pinnedPlainText(undefined), null); });

// ---- exposure: lists never carry the pinned message, viewers do
const row: any = { id: "r1", title: "R", inviteTokenHash: "h", pinnedMessage: "secret plan", slowModeSec: 5, locked: true };
t("publicRoom (lists) has no pinnedMessage and no invite hash", () => { const p: any = publicRoom(row); assert.ok(!("pinnedMessage" in p)); assert.ok(!("inviteTokenHash" in p)); assert.equal(p.slowModeSec, 5); assert.equal(p.locked, true); });
t("viewerRoom has the pinnedMessage, never the invite hash", () => { const p: any = viewerRoom(row); assert.equal(p.pinnedMessage, "secret plan"); assert.ok(!("inviteTokenHash" in p)); });
t("viewerRoom gives null when unset", () => assert.equal((viewerRoom({ ...row, pinnedMessage: null }) as any).pinnedMessage, null));

// ---- reducer
const live = roomReducer(initialRoomState("me"), {
  type: "room:state", room: { id: "r1", pinnedMessage: "hello", slowModeSec: 5, locked: false } as any, members: [], memberCount: 1, screen: null, you: { role: "guest", muted: false },
});
t("room:state carries the settings on room", () => { const r: any = live.room; assert.equal(r.pinnedMessage, "hello"); assert.equal(r.slowModeSec, 5); assert.equal(r.locked, false); });
t("room:settings updates the room", () => {
  const s = roomReducer(live, { type: "room:settings", pinnedMessage: "new", slowModeSec: 15, locked: true });
  const r: any = s.room; assert.equal(r.pinnedMessage, "new"); assert.equal(r.slowModeSec, 15); assert.equal(r.locked, true); assert.equal(r.id, "r1");
});
t("room:settings with empty pinned clears it", () => assert.equal((roomReducer(live, { type: "room:settings", pinnedMessage: "", slowModeSec: 0, locked: false }).room as any).pinnedMessage, null));
t("room:settings before room:state is ignored (no room yet)", () => {
  const s0 = roomReducer(initialRoomState("me"), { type: "client:connecting" });
  assert.equal(roomReducer(s0, { type: "room:settings", pinnedMessage: "x", slowModeSec: 5, locked: true }).room, null);
});
t("room:settings after ended is ignored", () => {
  const ended = roomReducer(live, { type: "room:ended" });
  assert.equal(roomReducer(ended, { type: "room:settings", pinnedMessage: "x", slowModeSec: 5, locked: true }), ended);
});
t("SLOW_MODE notice keeps retryMs", () => {
  const s = roomReducer(live, { type: "room:notice", code: "SLOW_MODE", retryMs: 4200 });
  assert.deepEqual(s.notice, { code: "SLOW_MODE", n: 1, retryMs: 4200 });
});
t("a notice without retryMs has none", () => assert.ok(!("retryMs" in roomReducer(live, { type: "room:notice", code: "MUTED" }).notice!)));
t("ROOM_LOCKED join refusal is terminal (denied)", () => { const s = roomReducer(initialRoomState("me"), { type: "room:error", code: "ROOM_LOCKED" }); assert.equal(s.phase, "denied"); assert.equal(s.error, "ROOM_LOCKED"); });

// ---- migration file and ensureSchema mirror say the same thing
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlFile = readFileSync(join(root, "migrations/add_rooms_host_settings.sql"), "utf8");
const storageSrc = readFileSync(join(root, "server/storage.ts"), "utf8");
const stmts = [
  "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pinned_message text;",
  "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slow_mode_sec integer NOT NULL DEFAULT 0;",
  "ALTER TABLE rooms ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;",
];
t("migration is one transaction with the three additive statements", () => {
  assert.match(sqlFile, /^BEGIN;$/m); assert.match(sqlFile, /^COMMIT;$/m);
  for (const s of stmts) assert.ok(sqlFile.includes(s), s);
});
t("ensureSchema mirrors the three statements", () => { for (const s of stmts) assert.ok(storageSrc.includes(s), s); });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
