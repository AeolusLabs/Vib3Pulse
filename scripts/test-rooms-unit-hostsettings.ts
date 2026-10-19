// Host settings: pinned message, slow mode, room lock (no database):   npx tsx scripts/test-rooms-unit-hostsettings.ts
// (also run by npm run test:rooms)
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_LIMITS, SLOW_MODES, PINNED_INPUT_MAX, cutPinned, graphemes, stripInvisible, validateRoomInput } from "../shared/rooms";
import { lockAdmits, isRecentMember, NEVER_JOINED, SESSION_CLOCK_SKEW_MS } from "../server/rooms/roomLock";
import { roomReducer, initialRoomState } from "../client/src/lib/roomReducer";

// Same import style as test-rooms-unit-redaction.ts: server modules load without touching the database.
const { pinnedPlainText, plainText, publicRoom, viewerRoom } = await import("../server/rooms/roomAccess");

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

// ---- cut by grapheme (what a person sees as one character), not by code point
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // one family emoji: 5 code points, 8 UTF-16 units
const FLAG = "\u{1F1F3}\u{1F1EC}";                         // one flag: 2 regional indicators
const ACCENT = "e\u0301";                                  // e + combining acute: one letter
const THUMB = "\u{1F44D}\u{1F3FD}";                        // thumbs up + skin tone
const loneSurrogate = (x: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
t("graphemes counts a family, a flag, an accented letter and a skin-toned emoji as one each", () => {
  assert.deepEqual(graphemes(`${FAMILY}${FLAG}${ACCENT}${THUMB}`), [FAMILY, FLAG, ACCENT, THUMB]);
});
t("cutPinned keeps 200 whole family emoji (never cuts inside one)", () => assert.equal(cutPinned(FAMILY.repeat(250)), FAMILY.repeat(200)));
t("cutPinned keeps 200 whole flags", () => assert.equal(cutPinned(FLAG.repeat(201)), FLAG.repeat(200)));
t("cutPinned keeps an accent on the 200th letter", () => assert.equal(cutPinned("a".repeat(199) + ACCENT + "zzz"), "a".repeat(199) + ACCENT));
t("cutPinned without Intl.Segmenter falls back to code points (no broken surrogate)", () => {
  const saved = (Intl as any).Segmenter;
  try {
    (Intl as any).Segmenter = undefined;
    const out = cutPinned("\u{1F600}".repeat(250))!;
    assert.equal(Array.from(out).length, 200);
    assert.ok(!loneSurrogate(out));
    const fam = cutPinned(FAMILY.repeat(250))!;
    assert.equal(Array.from(fam).length, 200); // 40 families of 5 code points
    assert.ok(!loneSurrogate(fam));
  } finally { (Intl as any).Segmenter = saved; }
  assert.equal(cutPinned(FAMILY.repeat(250)), FAMILY.repeat(200)); // and back to graphemes once it is there again
});

// ---- invisible and control characters (one shared helper: stripInvisible, run by plainText)
const INVISIBLES: Array<[string, string]> = [
  ["U+202A LRE", "\u202A"], ["U+202B RLE", "\u202B"], ["U+202C PDF", "\u202C"], ["U+202D LRO", "\u202D"], ["U+202E RLO", "\u202E"],
  ["U+2066 LRI", "\u2066"], ["U+2067 RLI", "\u2067"], ["U+2068 FSI", "\u2068"], ["U+2069 PDI", "\u2069"],
  ["U+200B ZWSP", "\u200B"], ["U+200C ZWNJ", "\u200C"], ["U+200D ZWJ (not in an emoji)", "\u200D"], ["U+200E LRM", "\u200E"], ["U+200F RLM", "\u200F"],
  ["U+2060 WJ", "\u2060"], ["U+FEFF BOM", "\uFEFF"],
  ["U+0000 NUL", "\u0000"], ["U+0007 BEL", "\u0007"], ["U+0008 BS", "\b"], ["U+000B VT", "\u000B"], ["U+000C FF", "\f"], ["U+000D CR", "\r"], ["U+001B ESC", "\u001B"], ["U+001F US", "\u001F"],
  ["U+007F DEL", "\u007F"], ["U+0080 C1", "\u0080"], ["U+0085 NEL", "\u0085"], ["U+009F C1", "\u009F"],
];
for (const [label, ch] of INVISIBLES) t(`stripInvisible removes ${label}`, () => assert.equal(stripInvisible(`ab${ch}cd`), "abcd"));
t("stripInvisible keeps tab and newline", () => assert.equal(stripInvisible("a\tb\nc"), "a\tb\nc"));
t("stripInvisible keeps the ZWJ inside emoji sequences (family, rainbow flag, skin tone)", () => {
  const rainbow = "\u{1F3F3}\uFE0F\u200D\u{1F308}";
  const woman = "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
  assert.equal(stripInvisible(`${FAMILY} ${rainbow} ${woman}`), `${FAMILY} ${rainbow} ${woman}`);
});
t("stripInvisible removes a ZWJ next to only one emoji, or between letters", () => {
  assert.equal(stripInvisible("\u{1F600}\u200Dx"), "\u{1F600}x");
  assert.equal(stripInvisible("x\u200D\u{1F600}"), "x\u{1F600}");
  assert.equal(stripInvisible("a\u200Db"), "ab");
});
t("stripInvisible leaves ordinary text, emoji and accents alone", () => {
  const s0 = `Hello, R&B night ${FLAG} ${ACCENT} ${THUMB} 100%`;
  assert.equal(stripInvisible(s0), s0);
});
t("plainText (titles, descriptions, chat) strips an RLO reversal and zero-width padding", () => {
  assert.equal(plainText("Party \u202Etxt.exe"), "Party txt.exe");
  assert.equal(plainText("\u200B\uFEFF Room \u2066one\u2069 \u200B"), "Room one");
});
t("plainText keeps the newline in a description", () => assert.equal(plainText("line one\nline two"), "line one\nline two"));
t("pinnedPlainText strips bidi and zero-width characters before cutting", () => {
  assert.equal(pinnedPlainText("\u202E<b>pin</b>\u200B"), "pin");
  assert.equal(pinnedPlainText("\u200B\u200B"), null); // nothing visible left
  assert.equal(pinnedPlainText("\u200B".repeat(150) + "x".repeat(250)), "x".repeat(200)); // invisibles never count
});
t("pinnedPlainText keeps 200 whole family emoji", () => assert.equal(pinnedPlainText(FAMILY.repeat(250)), FAMILY.repeat(200)));

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

// ---- room lock: who a locked room still lets in (roomLock.ts, pure)
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const STARTED = new Date(NOW - 3600_000); // the room went live an hour ago
const BOOT = NOW - 3 * 3600_000;          // this process started before that
const lk = (over: Partial<Parameters<typeof lockAdmits>[0]> = {}) => lockAdmits({
  userId: "u", room: { hostId: "h", startedAt: STARTED }, member: null, minorsRoom: false, age: 30,
  invite: { invited: false, acknowledged: false }, now: NOW, rejoinMs: 120_000, bootAt: BOOT, ...over,
});
const mem = (over: Record<string, unknown> = {}) => ({ role: "guest", banned: false, joinedAt: new Date(NOW - 600_000), leftAt: null as Date | null, ...over }) as any;
t("lock: the host is admitted", () => assert.equal(lk({ userId: "h" }), true));
t("lock: a newcomer with no member row is refused", () => assert.equal(lk(), false));
t("lock: a co-host is admitted; a banned co-host is not", () => {
  assert.equal(lk({ member: mem({ role: "cohost", leftAt: new Date(NOW - 3600_000) }) }), true);
  assert.equal(lk({ member: mem({ role: "cohost", banned: true }) }), false);
});
t("lock: a co-host reset to guest by a kick has no co-host pass", () => assert.equal(lk({ member: mem({ role: "guest", leftAt: new Date(NOW - 600_000) }) }), false));
t("lock: an adult with an acknowledged invite to a minors' room is admitted", () => assert.equal(lk({ minorsRoom: true, age: 30, invite: { invited: true, acknowledged: true } }), true));
t("lock: invited but not acknowledged, a teen with an invite row, or not a minors' room: no invite pass", () => {
  assert.equal(lk({ minorsRoom: true, age: 30, invite: { invited: true, acknowledged: false } }), false);
  assert.equal(lk({ minorsRoom: true, age: 15, invite: { invited: true, acknowledged: true } }), false);
  assert.equal(lk({ minorsRoom: false, age: 30, invite: { invited: true, acknowledged: true } }), false);
});
t("lock: holding the invite link is not an input at all (a token holder is just a newcomer)", () => {
  assert.equal(lk({ inviteToken: "anything" } as any), false);
});
t("lock: left 30 s ago (window 120 s): admitted; left 121 s ago: refused", () => {
  assert.equal(lk({ member: mem({ leftAt: new Date(NOW - 30_000) }) }), true);
  assert.equal(lk({ member: mem({ leftAt: new Date(NOW - 121_000) }) }), false);
});
t("lock: window 0 lets nobody back by the window", () => assert.equal(lk({ rejoinMs: 0, member: mem({ leftAt: new Date(NOW - 1) }) }), false));
t("lock: a banned member inside the window is refused", () => assert.equal(lk({ member: mem({ banned: true, leftAt: new Date(NOW - 1000) }) }), false));
t("lock: a row made for someone who never joined (ban/unban/mute before arrival) never counts", () => {
  assert.equal(lk({ member: mem({ joinedAt: NEVER_JOINED, leftAt: NEVER_JOINED }) }), false);
  assert.equal(lk({ member: mem({ joinedAt: NEVER_JOINED, leftAt: new Date(NOW - 1000) }) }), false); // even with a fresh left_at
});
t("lock: a row joined before this live session started does not count (1 s of clock slack is fine)", () => {
  assert.equal(lk({ member: mem({ joinedAt: new Date(STARTED.getTime() - SESSION_CLOCK_SKEW_MS - 1000), leftAt: new Date(NOW - 1000) }) }), false);
  assert.equal(lk({ member: mem({ joinedAt: new Date(STARTED.getTime() - 1000), leftAt: new Date(NOW - 1000) }) }), true);
});
t("lock: a room with no started_at gives no rejoin pass", () => assert.equal(lk({ room: { hostId: "h", startedAt: null }, member: mem({ leftAt: new Date(NOW - 1000) }) }), false));
t("lock: left_at still null (crash / failed write) is NOT a permanent pass", () => {
  assert.equal(lk({ member: mem({ joinedAt: new Date(NOW - 600_000), leftAt: null }) }), false); // joined 10 min ago, process up for hours
});
t("lock: left_at null right after a restart counts from process start (reconnect inside the window)", () => {
  assert.equal(lk({ bootAt: NOW - 30_000, member: mem({ joinedAt: new Date(NOW - 600_000), leftAt: null }) }), true);
  assert.equal(lk({ bootAt: NOW - 200_000, member: mem({ joinedAt: new Date(NOW - 600_000), leftAt: null }) }), false);
});
t("lock: left_at null and joined 30 s ago counts from the join", () => assert.equal(lk({ member: mem({ joinedAt: new Date(NOW - 30_000), leftAt: null }) }), true));
t("isRecentMember accepts ISO strings as well as Dates", () => {
  assert.equal(isRecentMember({ room: { hostId: "h", startedAt: STARTED.toISOString() }, member: { role: "guest", banned: false, joinedAt: new Date(NOW - 600_000).toISOString(), leftAt: new Date(NOW - 5000).toISOString() }, now: NOW, rejoinMs: 120_000, bootAt: BOOT }), true);
});

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
