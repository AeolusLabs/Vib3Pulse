// Room money notifications: copy, links and the spray batching rule (no database):
//   npx tsx scripts/test-rooms-unit-notify.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EARNINGS_LINK, ROOM_MONEY_NOTIFICATION_TYPES, SPRAY_BATCH_WINDOW_MS, notificationLinkFor, payoutPaidNotice, refundIssuedNotice,
  safeRoomMoneyLink, sprayBatchDecision, sprayBatchKey, sprayReceivedNotice, ticketIssuedNotice,
} from "../shared/roomNotifications";
import { notificationTypes } from "../shared/schema";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

const ROOM = "3f0c1d2e-0000-4000-8000-000000000001";
const copies = () => [
  sprayReceivedNotice(500000, "Friday Pre-Drinks"),
  ticketIssuedNotice("Friday Pre-Drinks"),
  refundIssuedNotice(250000, "Friday Pre-Drinks"),
  payoutPaidNotice(1234567, "Friday Pre-Drinks"),
];

test("every new type is declared in notificationTypes", () => {
  for (const t of ["room_ticket", "room_refund", "spray_received", "payout_paid", "spray_reversed"]) {
    assert.ok((notificationTypes as readonly string[]).includes(t), t);
  }
});

test("each room money type has a link: earnings for money received, the room otherwise", () => {
  for (const t of ROOM_MONEY_NOTIFICATION_TYPES) {
    const l = notificationLinkFor(t, ROOM);
    assert.ok(l === EARNINGS_LINK || l === `/rooms/${ROOM}`, `${t} -> ${l}`);
    assert.equal(safeRoomMoneyLink(l), l, `${t} link must pass the bell's check`);
  }
  assert.equal(notificationLinkFor("spray_received", ROOM), "/rooms/earnings");
  assert.equal(notificationLinkFor("payout_paid", ROOM), "/rooms/earnings");
  assert.equal(notificationLinkFor("room_ticket", ROOM), `/rooms/${ROOM}`);
});

test("the bell follows only in-app room or earnings paths", () => {
  for (const bad of ["https://evil.example/rooms/x", "//evil.example", "/rooms/a/b", "/rooms/", "javascript:alert(1)", "/rooms/%2F..%2F", null, undefined, "/rooms/earnings/x", "/settings"]) {
    assert.equal(safeRoomMoneyLink(bad as any), null, String(bad));
  }
  assert.equal(safeRoomMoneyLink("/rooms/earnings"), "/rooms/earnings");
});

test("copy: plain words, amounts in naira, no em dash, never 'cash' or 'anonymous'", () => {
  for (const c of copies()) {
    const all = `${c.title} ${c.message}`;
    assert.ok(!all.includes("—"), all);
    assert.ok(!/cash|anonymous/i.test(all), all);
    assert.ok(c.title.length > 0 && c.message.length > 0);
  }
  assert.equal(sprayReceivedNotice(500000, "Friday Pre-Drinks").title, "You received ₦5,000 in Friday Pre-Drinks");
  assert.match(payoutPaidNotice(1234567, "R").message, /₦12,345\.67/);
});

test("spray copy never names a payer (it takes only an amount and the room title)", () => {
  assert.equal(sprayReceivedNotice.length, 2);
  const n = sprayReceivedNotice(100000, "Room");
  assert.ok(!/from @|sprayed you|by /i.test(`${n.title} ${n.message}`));
});

test("payout copy says sent only (it is only used after Paystack confirmed the transfer)", () => {
  assert.match(payoutPaidNotice(100, "R").title, /sent/);
  assert.match(refundIssuedNotice(100, "R").title, /on its way/); // never "refunded" before the provider says so
});

test("room titles in copy are one line and cut to 80 characters", () => {
  const t = sprayReceivedNotice(100, `a\n\n${"x".repeat(200)}`).title;
  assert.ok(!t.includes("\n"));
  assert.ok(t.length <= "You received ₦1 in ".length + 80, String(t.length));
});

test("batching: no unread batch -> insert; same total -> unchanged", () => {
  assert.deepEqual(sprayBatchDecision(null, "A", 0), { action: "insert" });
  assert.deepEqual(sprayBatchDecision({ lastAtMs: 0, title: "A" }, "A", 10 * SPRAY_BATCH_WINDOW_MS), { action: "unchanged" });
});

test("batching: a change inside the window waits until it opens; after it, updates", () => {
  assert.deepEqual(sprayBatchDecision({ lastAtMs: 1000, title: "A" }, "B", 1000 + 15_000), { action: "wait", retryInMs: SPRAY_BATCH_WINDOW_MS - 15_000 });
  assert.deepEqual(sprayBatchDecision({ lastAtMs: 1000, title: "A" }, "B", 1000 + SPRAY_BATCH_WINDOW_MS), { action: "update" });
  // A clock that went backwards waits a full window, never updates early.
  assert.deepEqual(sprayBatchDecision({ lastAtMs: 5000, title: "A" }, "B", 1000), { action: "wait", retryInMs: SPRAY_BATCH_WINDOW_MS });
});

test("storm: 300 sprays in one minute make ONE notification and no update inside that minute (injected clock)", () => {
  // Simulates the stored row the way notify.ts writes it: insert/update set lastAtMs = now.
  let row: { lastAtMs: number; title: string } | null = null;
  let inserts = 0, updates = 0;
  let total = 0;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 300; i++) {
    const now = t0 + i * 200; // 300 sprays over 60 s minus one step
    total += 40000;
    const title = sprayReceivedNotice(total, "Room").title;
    const d = sprayBatchDecision(row, title, now);
    if (d.action === "insert") { inserts++; row = { lastAtMs: now, title }; }
    if (d.action === "update") { updates++; row = { lastAtMs: now, title }; }
  }
  assert.equal(inserts, 1);
  assert.equal(updates, 0);
  // The trailing pass when the window opens brings the total up to date, once.
  const late = sprayBatchDecision(row, sprayReceivedNotice(total, "Room").title, t0 + SPRAY_BATCH_WINDOW_MS);
  assert.equal(late.action, "update");
});

test("at most one update a minute over a long burst (10 minutes, a spray a second)", () => {
  let row: { lastAtMs: number; title: string } | null = null;
  let writes = 0;
  const t0 = 0;
  for (let s = 0; s < 600; s++) {
    const title = sprayReceivedNotice((s + 1) * 1000, "Room").title;
    const d = sprayBatchDecision(row, title, t0 + s * 1000);
    if (d.action === "insert" || d.action === "update") { writes++; row = { lastAtMs: t0 + s * 1000, title }; }
  }
  assert.ok(writes <= 11, String(writes)); // the insert + one per full minute
});

test("the batch key is per room (the recipient is the notification's user)", () => {
  assert.equal(sprayBatchKey(ROOM), `spray-received:${ROOM}`);
});

test("notify.ts: spray_received rows never carry a related user, and every hook site uses void (fire-and-forget)", () => {
  const src = readFileSync(new URL("../server/rooms/notify.ts", import.meta.url), "utf8");
  const insert = src.slice(src.indexOf("insert into notifications"), src.indexOf("insert into notifications") + 200);
  assert.ok(!/related_user_id/.test(insert), "spray_received insert must not set related_user_id");
  for (const [file, call] of [["tickets.ts", "notifyTicketIssued("], ["settlement.ts", "notifyPayoutPaid("], ["spray.ts", "notifySprayReceived("]] as const) {
    const s = readFileSync(new URL(`../server/rooms/${file}`, import.meta.url), "utf8");
    const lines = s.split("\n").filter((l) => l.includes(call) && !l.trim().startsWith("import"));
    assert.ok(lines.length > 0, `${file} calls ${call}`);
    for (const l of lines) assert.match(l, /void notify/, `${file}: ${l.trim()}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
