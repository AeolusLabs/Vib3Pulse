// Rooms phase 6 (tasks 6.1 to 6.3), no database:   npx tsx scripts/test-rooms-unit-earnings.ts
// computeEarnings (cases + a generated-history property test with a deterministic seeded generator, no new dependency), the
// range starts, the strict name match, item ids and the payments cursor, the receipt HTML (escaping, no script, no external
// resource), the migration text, the redaction keys, and source checks that every "can be paid" read goes through
// hostPayoutReady and that the money-read routes are registered before any /api/rooms/:id route.
process.env.DISABLE_GEOCODING = "1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeEarnings, rangeStartMs, namesMatch, personNameTokens, parseItemId, decodePaymentsCursor, encodePaymentsCursor,
  receiptNumberOf, escapeHtml, renderReceiptHtml, nairaLabel, last4Of, EarningsDataError, BY_ROOM_MAX,
  type EarningsInput, type EarningsTicketRow, type EarningsSprayRow, type EarningsPayoutRow, type EarningsClawbackRow,
  type EarningsRange, type RoomEarnings, type ReceiptData,
} from "../shared/roomEarnings";
import { sprayBreakdown, ticketBreakdown, SPRAY_TIERS, type SprayTier } from "../shared/money";
import { PAYOUT_HOLD_SENTINEL_MS } from "../shared/roomRefunds";
import { ROOM_PAYOUT_ACCOUNT_SCHEMA_SQL as SQL } from "../server/rooms/payoutsMigration"; // a plain string module, no database

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${String(e?.message ?? e).split("\n")[0]}`); }
};
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const H = 3_600_000, D = 24 * H;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0); // Wednesday 21 Oct 2026, 12:00 UTC
const empty = (viewerId = "v"): EarningsInput => ({ viewerId, rooms: [], tickets: [], sprays: [], payouts: [], clawbacks: [] });
const all = (i: EarningsInput) => computeEarnings(i, { range: "all", nowMs: NOW });
const tk = (id: string, roomId: string, hostId: string, hostKobo: number, at: number, status = "paid"): EarningsTicketRow =>
  ({ id, roomId, hostId, hostKobo, status, createdAtMs: at });
const balanced = (e: RoomEarnings) =>
  e.settledKobo + e.onItsWayKobo + e.needsAttentionKobo + e.heldTicketKobo + e.sprayReturnedKobo
    === e.totals.sprayKobo + e.totals.ticketKobo + e.sprayReturnedKobo - e.clawbackAppliedKobo
  && e.onItsWayKobo === e.sprayDirectKobo + e.ticketSendingKobo;

// ---------------------------------------------------------------- ranges
test("rangeStartMs: week starts Monday 00:00 UTC, month on the 1st, all is null", () => {
  assert.equal(rangeStartMs("week", NOW), Date.UTC(2026, 9, 19));
  assert.equal(rangeStartMs("week", Date.UTC(2026, 9, 19, 0, 0, 0)), Date.UTC(2026, 9, 19));
  assert.equal(rangeStartMs("week", Date.UTC(2026, 9, 25, 23, 59)), Date.UTC(2026, 9, 19)); // Sunday
  assert.equal(rangeStartMs("week", Date.UTC(2026, 10, 1, 8)), Date.UTC(2026, 9, 26)); // Sunday 1 Nov -> Monday 26 Oct
  assert.equal(rangeStartMs("month", NOW), Date.UTC(2026, 9, 1));
  assert.equal(rangeStartMs("all", NOW), null);
});

// ---------------------------------------------------------------- computeEarnings: cases
test("empty: all zero, no rooms, no release", () => {
  const e = all(empty());
  assert.deepEqual(e, {
    totals: { sprayKobo: 0, ticketKobo: 0 }, settledKobo: 0, onItsWayKobo: 0, sprayDirectKobo: 0, ticketSendingKobo: 0, needsAttentionKobo: 0,
    sprayReturnedKobo: 0, heldTicketKobo: 0, clawbackOpenKobo: 0, clawbackAppliedKobo: 0, byRoom: [], nextTicketReleaseAt: null,
  });
});

test("tickets: no payout = held; refunded tickets never count", () => {
  const i = empty();
  i.rooms.push({ id: "r1", title: "Room one" });
  i.tickets.push(tk("a", "r1", "v", 1000, NOW - D), tk("b", "r1", "v", 2000, NOW - D + 1), tk("c", "r1", "v", 5000, NOW - D + 2, "refunded"));
  const e = all(i);
  assert.equal(e.totals.ticketKobo, 3000);
  assert.equal(e.heldTicketKobo, 3000);
  assert.equal(e.settledKobo, 0);
  assert.equal(e.byRoom.length, 1);
  assert.equal(e.byRoom[0].title, "Room one");
  assert.ok(balanced(e));
});

test("tickets: payout paid = settled, queued = on its way, failed = needs attention (never settled, never on its way)", () => {
  for (const [status, bucket] of [["paid", "settledKobo"], ["queued", "onItsWayKobo"], ["failed", "needsAttentionKobo"], ["held", "heldTicketKobo"]] as const) {
    const i = empty();
    i.tickets.push(tk("a", "r1", "v", 4000, NOW - D));
    i.payouts.push({ roomId: "r1", hostId: "v", status, amountKobo: 4000, releaseAtMs: NOW + D });
    const e = all(i);
    assert.equal(e[bucket], 4000, status);
    assert.equal(e.settledKobo + e.onItsWayKobo + e.needsAttentionKobo + e.heldTicketKobo, 4000, status);
  }
});

test("clawbacks applied to a payout come off settled; open clawbacks are reported, not double counted", () => {
  const i = empty();
  i.tickets.push(tk("a", "r1", "v", 3000, NOW - 3 * H), tk("b", "r1", "v", 3000, NOW - 2 * H));
  i.payouts.push({ roomId: "r1", hostId: "v", status: "paid", amountKobo: 3500, releaseAtMs: NOW - H }); // 2500 taken
  i.clawbacks.push({ beneficiaryId: "v", amountKobo: 4000, recoveredKobo: 2500, status: "open" }, { beneficiaryId: "v", amountKobo: 900, recoveredKobo: 900, status: "recovered" }, { beneficiaryId: "v", amountKobo: 700, recoveredKobo: 0, status: "written_off" });
  const e = all(i);
  assert.equal(e.totals.ticketKobo, 6000);
  assert.equal(e.settledKobo, 3500);
  assert.equal(e.clawbackAppliedKobo, 2500);
  assert.equal(e.clawbackOpenKobo, 1500);
  assert.ok(balanced(e));
});

test("payout fully clawed back (paid, amount 0): settled 0, applied = gross", () => {
  const i = empty();
  i.tickets.push(tk("a", "r1", "v", 3000, NOW - H));
  i.payouts.push({ roomId: "r1", hostId: "v", status: "paid", amountKobo: 0, releaseAtMs: NOW - H });
  const e = all(i);
  assert.equal(e.settledKobo, 0);
  assert.equal(e.clawbackAppliedKobo, 3000);
  assert.ok(balanced(e));
});

test("the clawback deduction is spread newest first, so a range sees an exact part", () => {
  const i = empty();
  const lastWeek = Date.UTC(2026, 9, 14), thisWeek = Date.UTC(2026, 9, 20);
  i.tickets.push(tk("old", "r1", "v", 3000, lastWeek), tk("new", "r1", "v", 3000, thisWeek));
  i.payouts.push({ roomId: "r1", hostId: "v", status: "paid", amountKobo: 2000, releaseAtMs: NOW }); // 4000 taken
  const w = computeEarnings(i, { range: "week", nowMs: NOW });
  assert.equal(w.totals.ticketKobo, 3000);
  assert.equal(w.clawbackAppliedKobo, 3000); // the newest ticket absorbs 3000 first
  assert.equal(w.settledKobo, 0);
  const a = all(i);
  assert.equal(a.settledKobo, 2000);
  assert.ok(balanced(w) && balanced(a));
});

test("sprays: host share and stage-guest share only for the viewer; reversed / failed / undelivered never count", () => {
  const i = empty();
  const s = (o: Partial<EarningsSprayRow>): EarningsSprayRow => ({ id: "s", roomId: "r1", hostId: "v", recipientId: "v", hostKobo: 1000, guestKobo: null, status: "delivered", deliveredAtMs: NOW - H, ...o });
  i.sprays.push(
    s({ id: "1" }),                                                              // host spray: 1000
    s({ id: "2", recipientId: "g", hostKobo: 150, guestKobo: 700 }),             // viewer hosts, guest sprayed: 150
    s({ id: "3", roomId: "r2", hostId: "o", recipientId: "v", hostKobo: 150, guestKobo: 700 }), // viewer is the guest: 700
    s({ id: "4", status: "reversed", deliveredAtMs: null }),
    s({ id: "5", status: "reversing", deliveredAtMs: null }),
    s({ id: "6", status: "failed", deliveredAtMs: null }),
    s({ id: "7", status: "disputed", deliveredAtMs: null }),                     // disputed before delivery: never earned
    s({ id: "8", status: "disputed", deliveredAtMs: NOW - 2 * H }),              // delivered then disputed: earned (clawback separate)
    s({ id: "9", status: "paid", deliveredAtMs: null }),
    s({ id: "10", roomId: "r3", hostId: "o", recipientId: "o" }),                // someone else's
  );
  const e = all(i);
  assert.equal(e.totals.sprayKobo, 1000 + 150 + 700 + 1000);
  assert.equal(e.onItsWayKobo, e.totals.sprayKobo); // never "settled"
  assert.equal(e.settledKobo, 0);
  assert.deepEqual(e.byRoom.map((r) => r.roomId).sort(), ["r1", "r2"]);
});

test("fix round I2: a reversed spray's split share is received AND clawed back, never counted against the host twice", () => {
  // Review r1 I2 scenario: N10,000 of ticket host share; a N2,000 host share split to the subaccount from a spray that was
  // then reversed; settlement recovered the N2,000 clawback from the ticket payout (paid N8,000).
  const i = empty();
  i.tickets.push(tk("a", "r1", "v", 1_000_000, NOW - 3 * H));
  i.payouts.push({ roomId: "r1", hostId: "v", status: "paid", amountKobo: 800_000, releaseAtMs: NOW - H });
  i.sprays.push({ id: "s1", roomId: "r1", hostId: "v", recipientId: "v", hostKobo: 200_000, guestKobo: null, status: "reversed", deliveredAtMs: null, paidAtMs: NOW - 4 * H });
  i.clawbacks.push({ beneficiaryId: "v", amountKobo: 200_000, recoveredKobo: 200_000, status: "recovered" });
  const e = all(i);
  assert.equal(e.totals.sprayKobo, 0, "a reversed spray is not earnings");
  assert.equal(e.sprayReturnedKobo, 200_000, "but its split share did reach the bank");
  assert.equal(e.settledKobo, 800_000);
  assert.equal(e.clawbackAppliedKobo, 200_000);
  // What reached the bank (8,000 payout + 2,000 split) equals what was earned (10,000 tickets): nothing counted twice.
  assert.equal(e.settledKobo + e.sprayDirectKobo + e.sprayReturnedKobo, e.totals.ticketKobo + e.totals.sprayKobo);
  assert.equal(e.onItsWayKobo, 0, "a share being clawed back is never 'on its way' (review r3 m2)");
  assert.ok(balanced(e));
  // The same while the clawback is still open: owed 2,000 against 2,000 received.
  const j = empty();
  j.sprays.push({ id: "s2", roomId: "r1", hostId: "v", recipientId: "v", hostKobo: 200_000, guestKobo: null, status: "disputed", deliveredAtMs: null, paidAtMs: NOW - H });
  j.clawbacks.push({ beneficiaryId: "v", amountKobo: 200_000, recoveredKobo: 0, status: "open" });
  const f = all(j);
  assert.equal(f.sprayReturnedKobo - f.clawbackOpenKobo, 0, "received and owed back cancel out");
  assert.ok(balanced(f));
});

test("fix round: queued payouts are 'sending', failed ones 'need attention', sprays are 'paid out by Paystack'", () => {
  const i = empty();
  i.tickets.push(tk("a", "r1", "v", 1000, NOW - H), tk("b", "r2", "v", 2000, NOW - H));
  i.payouts.push({ roomId: "r1", hostId: "v", status: "queued", amountKobo: 1000, releaseAtMs: NOW }, { roomId: "r2", hostId: "v", status: "failed", amountKobo: 2000, releaseAtMs: NOW });
  i.sprays.push({ id: "s", roomId: "r1", hostId: "v", recipientId: "v", hostKobo: 500, guestKobo: null, status: "delivered", deliveredAtMs: NOW - H });
  const e = all(i);
  assert.equal(e.ticketSendingKobo, 1000);
  assert.equal(e.needsAttentionKobo, 2000);
  assert.equal(e.sprayDirectKobo, 500);
  assert.equal(e.onItsWayKobo, 1500, "on its way = sprays + payouts being sent; the failed payout is not in it (review r3 m2)");
});

test("rows of other people are ignored even when passed in", () => {
  const i = empty();
  i.tickets.push(tk("x", "r9", "other", 9999, NOW - H));
  i.payouts.push({ roomId: "r9", hostId: "other", status: "paid", amountKobo: 9999, releaseAtMs: NOW });
  i.clawbacks.push({ beneficiaryId: "other", amountKobo: 5000, recoveredKobo: 0, status: "open" });
  assert.deepEqual(all(i), all(empty()));
});

test("nextTicketReleaseAt: earliest held release, admin holds left out", () => {
  const i = empty();
  i.payouts.push(
    { roomId: "a", hostId: "v", status: "held", amountKobo: 1, releaseAtMs: PAYOUT_HOLD_SENTINEL_MS },
    { roomId: "b", hostId: "v", status: "held", amountKobo: 1, releaseAtMs: NOW + 5 * H },
    { roomId: "c", hostId: "v", status: "held", amountKobo: 1, releaseAtMs: NOW + 2 * H },
    { roomId: "d", hostId: "v", status: "queued", amountKobo: 1, releaseAtMs: NOW - H },
  );
  assert.equal(all(i).nextTicketReleaseAt, new Date(NOW + 2 * H).toISOString());
});

test("unusable stored rows throw (never a total that might be wrong)", () => {
  const bad = (f: (i: EarningsInput) => void) => { const i = empty(); f(i); assert.throws(() => all(i), EarningsDataError); };
  bad((i) => i.tickets.push(tk("a", "r", "v", 1.5, NOW)));
  bad((i) => i.tickets.push(tk("a", "r", "v", -1, NOW)));
  bad((i) => i.payouts.push({ roomId: "r", hostId: "v", status: "sent", amountKobo: 1, releaseAtMs: NOW }));
  bad((i) => i.payouts.push({ roomId: "r", hostId: "v", status: "paid", amountKobo: NaN, releaseAtMs: NOW }));
  bad((i) => i.clawbacks.push({ beneficiaryId: "v", amountKobo: 10, recoveredKobo: Number.MAX_SAFE_INTEGER + 2, status: "open" }));
});

test("byRoom is capped and newest first", () => {
  const i = empty();
  for (let n = 0; n < BY_ROOM_MAX + 20; n++) i.tickets.push(tk(`t${n}`, `r${n}`, "v", 100, NOW - n * H));
  const e = all(i);
  assert.equal(e.byRoom.length, BY_ROOM_MAX);
  assert.equal(e.byRoom[0].roomId, "r0");
});

// ---------------------------------------------------------------- the generated-history property test
/** mulberry32: a small deterministic PRNG (no dependency). */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}

type RoomState = "open" | "closed" | "held" | "queued" | "paid" | "failed";
type Claw = EarningsClawbackRow & { seq: number; sprayId: string; origin: "dispute" | "reversal" };
interface Truth { sprays: Array<{ share: number; at: number }>; returned: Array<{ share: number; at: number }>; applied: number }
interface History {
  input: Omit<EarningsInput, "viewerId">;
  nowMs: number;
  truth: Record<string, Truth>;
  roomState: Map<string, RoomState>;
  claws: Claw[];
}

const USERS = ["v", "o", "g"] as const;

/**
 * A random but realistic history of the money tables, written the way the phase 4 and 5 code writes them (tickets sold
 * while open, refunds only before the payout leaves the hold, payouts queued with applyClawbacks' oldest-first partial
 * recovery, sprays delivered / reversed / failed / disputed with their clawbacks, dispute outcomes, write-offs), and an
 * independent "truth" of what each person earned and had taken back.
 */
function generate(seed: number, steps: number): History {
  const r = prng(seed);
  const rooms = [
    { id: "r1", hostId: "v", title: "Viewer room one" },
    { id: "r2", hostId: "v", title: "Viewer room two" },
    { id: "r3", hostId: "o", title: "Other host room" },
    { id: "r4", hostId: "o", title: "Other host room two" },
  ];
  const roomState = new Map<string, RoomState>(rooms.map((x) => [x.id, "open"]));
  const tickets: EarningsTicketRow[] = [];
  const sprays: EarningsSprayRow[] = [];
  const payouts = new Map<string, EarningsPayoutRow>();
  const claws: Claw[] = [];
  const truth: Record<string, Truth> = Object.fromEntries(USERS.map((u) => [u, { sprays: [], returned: [], applied: 0 }]));
  let t = NOW - 70 * D;
  let seq = 0;

  const openClaw = (beneficiaryId: string, amountKobo: number, sprayId: string, origin: "dispute" | "reversal") => {
    if (amountKobo > 0) claws.push({ beneficiaryId, amountKobo, recoveredKobo: 0, status: "open", seq: ++seq, sprayId, origin });
  };
  const paidTicketsOf = (roomId: string) => tickets.filter((x) => x.roomId === roomId && x.status === "paid");

  for (let step = 0; step < steps; step++) {
    t += 1 + r.int(30 * H);
    const ev = r.int(100);
    if (ev < 30) {
      // buy a ticket in an open room
      const room = r.pick(rooms);
      if (roomState.get(room.id) !== "open") continue;
      const price = r.pick([100000, 250000, 500000, 1234500]);
      tickets.push({ id: `t${++seq}`, roomId: room.id, hostId: room.hostId, hostKobo: ticketBreakdown(price).host, status: "paid", createdAtMs: t });
    } else if (ev < 38) {
      // refund a paid ticket while its room is open or its payout still held
      const cands = tickets.filter((x) => x.status === "paid" && (roomState.get(x.roomId) === "open" || roomState.get(x.roomId) === "held"));
      if (!cands.length) continue;
      const x = r.pick(cands);
      x.status = "refunded";
      const p = payouts.get(x.roomId);
      if (p && p.status === "held") {
        p.amountKobo = paidTicketsOf(x.roomId).reduce((n, y) => n + y.hostKobo, 0);
        if (p.amountKobo === 0) { payouts.delete(x.roomId); roomState.set(x.roomId, "closed"); }
      }
    } else if (ev < 65) {
      // a spray
      const room = r.pick(rooms);
      const host = room.hostId;
      const guest = host === "v" ? r.pick(["g", "o"]) : r.pick(["v", "g"]);
      const stage = r.next() < 0.45;
      const recipient = stage ? guest : host;
      const tier = r.pick(SPRAY_TIERS) as SprayTier;
      const b = sprayBreakdown(tier, stage);
      const id = `s${++seq}`;
      const roll = r.int(100);
      const status = roll < 55 ? "delivered" : roll < 72 ? "reversed" : roll < 80 ? "reversing" : roll < 88 ? "failed" : roll < 96 ? "disputed_d" : "disputed_u";
      const delivered = status === "delivered" || status === "disputed_d";
      sprays.push({
        id, roomId: room.id, hostId: host, recipientId: recipient, hostKobo: b.host, guestKobo: stage ? b.guest : null,
        status: status.startsWith("disputed") ? "disputed" : status, deliveredAtMs: delivered ? t : null,
        paidAtMs: status === "failed" ? null : t, // every other outcome was charged and split at t
      });
      if (status === "reversed" || status === "reversing" || status === "disputed_u") {
        // Fix round I2: split to the subaccount, then refunded / charged back before delivery: received, and clawed back.
        truth[host].returned.push({ share: b.host, at: t });
        if (stage) truth[recipient].returned.push({ share: b.guest as number, at: t });
      }
      if (delivered) {
        truth[host].sprays.push({ share: b.host, at: t });
        if (stage) truth[recipient].sprays.push({ share: b.guest as number, at: t });
      }
      if (status === "reversed" || status === "reversing") {
        openClaw(host, b.host, id, "reversal");
        if (stage) openClaw(recipient, b.guest as number, id, "reversal");
      }
      if (status.startsWith("disputed")) {
        openClaw(host, b.host, id, "dispute");
        if (stage) openClaw(recipient, b.guest as number, id, "dispute");
      }
    } else if (ev < 73) {
      // a room ends: payout held (48 h, sometimes an admin hold), or nothing to pay
      const room = r.pick(rooms);
      if (roomState.get(room.id) !== "open") continue;
      const gross = paidTicketsOf(room.id).reduce((n, y) => n + y.hostKobo, 0);
      if (gross === 0) { roomState.set(room.id, "closed"); continue; }
      payouts.set(room.id, { roomId: room.id, hostId: room.hostId, status: "held", amountKobo: gross, releaseAtMs: r.next() < 0.15 ? PAYOUT_HOLD_SENTINEL_MS : t + 48 * H });
      roomState.set(room.id, "held");
    } else if (ev < 82) {
      // held -> queued: applyClawbacks (oldest first, partial), then queued with the net, or paid with 0
      const held = Array.from(payouts.values()).filter((p) => p.status === "held");
      if (!held.length) continue;
      const p = r.pick(held);
      const gross = paidTicketsOf(p.roomId).reduce((n, y) => n + y.hostKobo, 0);
      let left = gross, applied = 0;
      for (const c of claws.filter((c) => c.beneficiaryId === p.hostId && c.status === "open").sort((a, b) => a.seq - b.seq)) {
        if (left <= 0) break;
        const take = Math.min(c.amountKobo - c.recoveredKobo, left);
        c.recoveredKobo += take; left -= take; applied += take;
        if (c.recoveredKobo === c.amountKobo) c.status = "recovered";
      }
      truth[p.hostId].applied += applied;
      const net = gross - applied;
      p.amountKobo = net;
      p.status = net === 0 ? "paid" : "queued";
      roomState.set(p.roomId, p.status);
    } else if (ev < 90) {
      // queued -> paid (Paystack verified) or failed; failed -> requeued
      const moving = Array.from(payouts.values()).filter((p) => p.status === "queued" || p.status === "failed");
      if (!moving.length) continue;
      const p = r.pick(moving);
      p.status = p.status === "failed" ? "queued" : r.next() < 0.85 ? "paid" : "failed";
      roomState.set(p.roomId, p.status);
    } else if (ev < 95) {
      // dispute resolved: merchant won on a delivered spray settles its dispute clawbacks; payer won keeps them open
      const disputed = sprays.filter((s) => s.status === "disputed" && s.deliveredAtMs !== null);
      if (!disputed.length || r.next() < 0.4) continue;
      const s = r.pick(disputed);
      for (const c of claws) if (c.sprayId === s.id && c.origin === "dispute" && c.status === "open") { c.status = "recovered"; c.recoveredKobo = c.amountKobo; }
    } else {
      // admin writes off an open clawback
      const open = claws.filter((c) => c.status === "open");
      if (!open.length) continue;
      r.pick(open).status = "written_off";
    }
  }
  return {
    input: { rooms: rooms.map(({ id, title }) => ({ id, title })), tickets, sprays, payouts: Array.from(payouts.values()), clawbacks: claws.map(({ beneficiaryId, amountKobo, recoveredKobo, status }) => ({ beneficiaryId, amountKobo, recoveredKobo, status })) },
    nowMs: t + H,
    truth,
    roomState,
    claws,
  };
}

/** Fisher-Yates with the same PRNG: input order must never change the answer. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = prng(seed);
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = r.int(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test("property: generated histories add up for every person and every range (400 seeds)", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const h = generate(seed, 60 + (seed % 90));
    const hostOfRoom = new Map(h.input.rooms.map((x) => [x.id, x.id === "r1" || x.id === "r2" ? "v" : "o"]));
    for (const u of USERS) {
      const input: EarningsInput = { viewerId: u, ...h.input };
      const e = computeEarnings(input, { range: "all", nowMs: h.nowMs });
      const ctx = `seed ${seed} user ${u}`;
      const myTickets = h.input.tickets.filter((x) => x.status === "paid" && hostOfRoom.get(x.roomId) === u);
      const truthTicket = myTickets.reduce((n, x) => n + x.hostKobo, 0);
      const truthSpray = h.truth[u].sprays.reduce((n, x) => n + x.share, 0);
      const truthApplied = h.truth[u].applied;
      const truthReturned = h.truth[u].returned.reduce((n, x) => n + x.share, 0);
      const truthFailed = h.input.payouts.filter((p) => p.hostId === u && p.status === "failed").reduce((n, p) => n + p.amountKobo, 0);
      const truthSending = h.input.payouts.filter((p) => p.hostId === u && p.status === "queued").reduce((n, p) => n + p.amountKobo, 0);
      const truthOpen = h.claws.filter((c) => c.beneficiaryId === u && c.status === "open").reduce((n, c) => n + c.amountKobo - c.recoveredKobo, 0);
      const truthPaid = h.input.payouts.filter((p) => p.hostId === u && p.status === "paid").reduce((n, p) => n + p.amountKobo, 0);
      const truthHeld = myTickets.filter((x) => { const s = h.roomState.get(x.roomId); return s === "open" || s === "held"; }).reduce((n, x) => n + x.hostKobo, 0);

      assert.equal(e.totals.sprayKobo, truthSpray, `${ctx} spray total`);
      assert.equal(e.totals.ticketKobo, truthTicket, `${ctx} ticket total (refunds excluded)`);
      assert.equal(e.settledKobo, truthPaid, `${ctx} settled = what Paystack confirmed transferred`);
      assert.equal(e.heldTicketKobo, truthHeld, `${ctx} held`);
      assert.equal(e.clawbackAppliedKobo, truthApplied, `${ctx} clawbacks taken from payouts`);
      assert.equal(e.clawbackOpenKobo, truthOpen, `${ctx} clawbacks still owed`);
      assert.equal(e.sprayReturnedKobo, truthReturned, `${ctx} returned split shares (fix round I2)`);
      assert.equal(e.needsAttentionKobo, truthFailed, `${ctx} failed payouts need attention`);
      assert.equal(e.ticketSendingKobo, truthSending, `${ctx} queued payouts are being sent`);
      assert.equal(e.sprayDirectKobo, truthSpray, `${ctx} earned spray money paid straight to the bank`);
      assert.equal(e.onItsWayKobo, truthSpray + truthSending, `${ctx} on its way excludes failed payouts and returned shares (r3 m2)`);
      // The identity: settled + on its way + held - open clawbacks = earned (refunds and reversals out of the totals)
      // + the returned split shares (they did reach the subaccount) - everything clawed back (taken from payouts, or owed).
      // Each returned share has a matching clawback, so it is never both excluded and clawed back.
      assert.equal(e.settledKobo + e.onItsWayKobo + e.needsAttentionKobo + e.heldTicketKobo + e.sprayReturnedKobo - e.clawbackOpenKobo,
        truthSpray + truthTicket + truthReturned - truthApplied - truthOpen, `${ctx} identity`);
      assert.ok(balanced(e), `${ctx} balance`);
      for (const k of ["settledKobo", "onItsWayKobo", "heldTicketKobo", "clawbackOpenKobo", "clawbackAppliedKobo", "sprayReturnedKobo", "sprayDirectKobo", "ticketSendingKobo", "needsAttentionKobo"] as const) {
        assert.ok(Number.isSafeInteger(e[k]) && e[k] >= 0, `${ctx} ${k} is a non-negative integer`);
      }
      assert.ok(e.byRoom.every((b) => b.sprayKobo > 0 || b.ticketKobo > 0), `${ctx} byRoom only rooms with earnings`);
      assert.equal(e.byRoom.reduce((n, b) => n + b.sprayKobo, 0), e.totals.sprayKobo, `${ctx} byRoom sprays add up`);
      assert.equal(e.byRoom.reduce((n, b) => n + b.ticketKobo, 0), e.totals.ticketKobo, `${ctx} byRoom tickets add up`);

      // Ranges: the same balance, and exactly the rows in the range.
      for (const range of ["week", "month"] as EarningsRange[]) {
        const er = computeEarnings(input, { range, nowMs: h.nowMs });
        const start = rangeStartMs(range, h.nowMs)!;
        assert.ok(balanced(er), `${ctx} ${range} balance`);
        assert.equal(er.totals.sprayKobo, h.truth[u].sprays.filter((x) => x.at >= start).reduce((n, x) => n + x.share, 0), `${ctx} ${range} sprays`);
        assert.equal(er.totals.ticketKobo, myTickets.filter((x) => x.createdAtMs >= start).reduce((n, x) => n + x.hostKobo, 0), `${ctx} ${range} tickets`);
        assert.ok(er.totals.sprayKobo <= e.totals.sprayKobo && er.settledKobo <= e.settledKobo, `${ctx} ${range} within all`);
        assert.equal(er.clawbackOpenKobo, e.clawbackOpenKobo, `${ctx} ${range} open clawbacks are current, not ranged`);
      }

      // Order of the stored rows never matters; the same seed always gives the same answer.
      const shuffledInput: EarningsInput = {
        viewerId: u, rooms: shuffled(h.input.rooms, seed), tickets: shuffled(h.input.tickets, seed + 1), sprays: shuffled(h.input.sprays, seed + 2),
        payouts: shuffled(h.input.payouts, seed + 3), clawbacks: shuffled(h.input.clawbacks, seed + 4),
      };
      assert.deepEqual(computeEarnings(shuffledInput, { range: "all", nowMs: h.nowMs }), e, `${ctx} order independent`);
    }
    assert.deepEqual(generate(seed, 60 + (seed % 90)).input, h.input, `seed ${seed} generator is deterministic`);
  }
});

test("property generator covers the hard cases (refunds, reversals, chargebacks, partial clawbacks, write-offs)", () => {
  let refunds = 0, reversals = 0, disputes = 0, partial = 0, writtenOff = 0, clawedPaid = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const h = generate(seed, 60 + (seed % 90));
    refunds += h.input.tickets.filter((x) => x.status === "refunded").length;
    reversals += h.input.sprays.filter((s) => s.status === "reversed" || s.status === "reversing").length;
    disputes += h.input.sprays.filter((s) => s.status === "disputed").length;
    partial += h.claws.filter((c) => c.status === "open" && c.recoveredKobo > 0).length;
    writtenOff += h.claws.filter((c) => c.status === "written_off").length;
    clawedPaid += h.input.payouts.filter((p) => p.status === "paid" && p.amountKobo === 0).length;
  }
  for (const [k, v] of Object.entries({ refunds, reversals, disputes, partial, writtenOff, clawedPaid })) assert.ok(v > 0, `${k} never generated`);
});

// ---------------------------------------------------------------- name match (6.1)
test("namesMatch: case, spacing, order and accents do not matter; anything else does (strict)", () => {
  assert.ok(namesMatch("Adébáyọ̀ Okafor", "OKAFOR  ADEBAYO"));
  assert.ok(namesMatch("Mary O'Neil", "ONEIL MARY"));
  assert.ok(namesMatch("Chinedu Ade-Bayo", "adebayo, chinedu"));
  assert.ok(!namesMatch("John Smith", "John Smith Okafor"), "a missing middle name is a mismatch");
  assert.ok(!namesMatch("John Smith", "Jon Smith"));
  assert.ok(!namesMatch("Smith", "Smith"), "one word is never enough");
  assert.ok(!namesMatch("John Smith", ""));
  assert.ok(!namesMatch(null, "John Smith"));
  assert.ok(!namesMatch("John Smith", 42));
  assert.deepEqual(personNameTokens("  Émile   ZOLA "), ["emile", "zola"]);
  assert.equal(last4Of("0123456789"), "6789");
  assert.equal(last4Of("12ab"), "");
});

// ---------------------------------------------------------------- item ids, cursor, receipt (6.3)
const U = "3f9a12bc-45de-4f00-8a1b-0123456789ab";
test("item ids and cursors are strictly parsed", () => {
  assert.deepEqual(parseItemId(`tk_${U}`), { prefix: "tk", rowId: U });
  for (const p of ["tr", "sp", "sr"]) assert.ok(parseItemId(`${p}_${U}`));
  for (const bad of [`xx_${U}`, `tk-${U}`, `tk_${U.toUpperCase()}`, `tk_${U}x`, `tk_../../${U.slice(6)}`, "", null, 7, `tk_${U}' or 1=1`]) {
    assert.equal(parseItemId(bad), null, String(bad));
  }
  const c = encodePaymentsCursor("1729400000123456", `sp_${U}`);
  assert.deepEqual(decodePaymentsCursor(c), { atUs: "1729400000123456", itemId: `sp_${U}` });
  for (const bad of ["", "abc", `1.2.${U}`, `-5.tk_${U}`, `1729400000123456.tk_nope`, `1e9.tk_${U}`, `${"9".repeat(19)}.tk_${U}`, 5, null]) {
    assert.equal(decodePaymentsCursor(bad), null, String(bad));
  }
  assert.equal(receiptNumberOf(`tk_${U}`), "VP-TK-3F9A12BC45DE");
  assert.equal(receiptNumberOf("nope"), "");
});

test("receipt HTML escapes everything, has no script and loads nothing", () => {
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"' \` =/`;
  const r: ReceiptData = {
    itemId: `sp_${U}`, kind: "spray", itemLabel: `Spray: ${evil}`, roomTitle: evil, amountKobo: 100000, vatKobo: 6977,
    atMs: NOW, status: "delivered", cardLast4: "4242",
    business: { name: evil, address: evil, taxId: evil, email: evil },
  };
  const html = renderReceiptHtml(r);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /https?:\/\//i, "no external resource");
  assert.doesNotMatch(html, /\bsrc=|\bhref=/i);
  assert.match(html, /&#60;script&#62;/);
  assert.match(html, /Card ending 4242/);
  assert.match(html, /VP-SP-3F9A12BC45DE/);
  assert.match(html, /₦1,000/);
  assert.equal(escapeHtml(`a<b>&"'`), "a&#60;b&#62;&#38;&#34;&#39;");
  const noCard = renderReceiptHtml({ ...r, cardLast4: "123456" });
  assert.doesNotMatch(noCard, /Card ending/);
  assert.doesNotMatch(noCard, /123456/);
  const refund = renderReceiptHtml({ ...r, kind: "refund", amountKobo: -100000, vatKobo: -6977, status: "pending" });
  assert.match(refund, /Refund receipt/);
  assert.match(refund, /-₦1,000/);
  assert.equal(nairaLabel(50), "₦0.50");
  assert.equal(nairaLabel(1.5), "");
});

// ---------------------------------------------------------------- migration, schema, redaction
test("migration file = payoutsMigration SQL inside BEGIN/COMMIT, additive and idempotent", () => {
  const norm = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
  assert.equal(norm(src("migrations/add_room_payout_account.sql")), `BEGIN; ${norm(SQL)} COMMIT;`);
  // ("ON DELETE CASCADE" is a foreign key rule, not a delete.)
  assert.doesNotMatch(SQL, /\bDROP\b|^\s*DELETE\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\b|\bRENAME\b|ALTER COLUMN/im);
  const creates = SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX)/g) ?? [];
  assert.equal(creates.length, (SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/g) ?? []).length);
  assert.equal((SQL.match(/ADD COLUMN/g) ?? []).length, (SQL.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
  assert.match(SQL, /ADD COLUMN IF NOT EXISTS [a-z_0-9]+ (text|varchar\(255\)|timestamp);/);
  assert.doesNotMatch(SQL, /NOT NULL;\n?ALTER/); // every added column on the existing table is nullable
  assert.match(src("server/storage.ts"), /ROOM_PAYOUT_ACCOUNT_SCHEMA_SQL/);
});

test("Drizzle schema names match the migration", () => {
  const s = src("shared/schema.ts");
  for (const col of ["bank_code", "bank_name", "account_last4", "room_verified_subaccount_code", "name_matched_at"]) assert.match(s, new RegExp(`"${col}"`));
  assert.match(s, /pgTable\("room_payout_account_events"/);
  assert.match(s, /"room_payout_account_events_user_created_idx"/);
  assert.match(s, /"room_payouts_host_status_idx"/);
});

test("redaction strips raw bank fields (snake case) and leaves the organiser routes' camelCase alone", () => {
  const a = src("server/auth.ts");
  assert.match(a, /"account_number",/);
  assert.match(a, /"account_name",/);
  assert.doesNotMatch(a, /^\s*"accountName",/m);
  assert.doesNotMatch(a, /^\s*"accountNumber",/m);
});

// ---------------------------------------------------------------- one helper, route order, no leaks (source checks)
test("every 'can be paid' read goes through one name-checked helper (fix round C1)", () => {
  const p = src("server/rooms/payouts.ts");
  assert.match(p, /room_verified_subaccount_code = paystack_subaccount_code/);
  assert.match(p, /name_matched_at is not null/);
  assert.match(p, /export async function hostPayoutReady\(userId: string\): Promise<boolean> \{\n\s+return \(await payableSubaccountOf\(userId\)\) !== null;/);
  const spray = src("server/rooms/spray.ts");
  assert.match(spray, /import \{ payableSubaccountOf \} from "\.\/payouts";/);
  assert.match(spray, /const subaccountOf = \(userId: string\): Promise<string \| null> => payableSubaccountOf\(userId\);/);
  assert.doesNotMatch(spray, /getOrganizerPaymentAccount|hasVerifiedPayoutAccount/);
  const settle = src("server/rooms/settlement.ts");
  assert.match(settle, /await payableSubaccountOf\(p\.host_id, c\)/);
  assert.doesNotMatch(settle, /from organizer_payment_accounts/);
  const routes = src("server/rooms/roomRoutes.ts");
  assert.match(routes, /roomFeatures\.paidRooms \? await hostPayoutReady\(host\.id\) : false/);
  const ts = src("server/rooms/ticketStorage.ts");
  assert.match(ts, /return hostPayoutReady\(userId\);/);
});

test("fix round I3: no transaction across the Paystack call; settlement waits for an account change", () => {
  const p = src("server/rooms/payouts.ts");
  const fn = p.slice(p.indexOf("async function changeLocked"));
  assert.doesNotMatch(fn, /BEGIN|for update/i, "the change holds no transaction or row lock around the provider call");
  assert.match(p, /withAdvisoryLock\(LOCK_ACCOUNT_CHANGE, userId,/);
  assert.ok(fn.indexOf("hasQueuedPayout(c, userId)") < fn.indexOf("provider().updateSubaccount("), "409 decided before Paystack is touched");
  assert.ok(fn.indexOf("room_verified_subaccount_code = null") < fn.indexOf("provider().updateSubaccount("), "unpayable while changing");
  const settle = src("server/rooms/settlement.ts");
  assert.match(settle, /pg_try_advisory_xact_lock_shared\(\$1::int, hashtext\(\$2::text\)\)/);
  assert.equal((settle.match(/await accountChangeIdle\(c, p\.host_id\)/g) ?? []).length, 2, "queue and admin requeue both check");
  const ps = src("server/payments/paystack.ts");
  assert.equal((ps.match(/signal: AbortSignal\.timeout\(PAYSTACK_TIMEOUT_MS\)/g) ?? []).length, 2);
  assert.match(ps, /PAYSTACK_TIMEOUT_MS = 15_000/);
});

test("fix round I1: organiser lookups share the durable per-user limit; onboarding masks the name", () => {
  const o = src("server/organizer-payments-routes.ts");
  assert.match(o, /takeBankLookupAttempt\(req\.user!\.id, "organizer_resolve"/);
  assert.match(o, /takeBankLookupAttempt\(req\.user!\.id, "organizer_onboard"/);
  assert.match(o, /accountName: maskAccountName\(resolved\.accountName\)/);
  const bankRoutes = o.slice(o.indexOf("/api/organizer/payments/paystack/resolve-account"));
  assert.doesNotMatch(bankRoutes, /console\.error\([^)]*, error\)/, "raw errors (account numbers, names) are never logged");
});

test("payout and earnings routes are registered before any /api/rooms/:id route", () => {
  const routes = src("server/rooms/roomRoutes.ts");
  const body = routes.slice(routes.indexOf("export function registerRoomRoutes"));
  const firstId = body.search(/app\.(get|post|put|patch|delete)\("\/api\/rooms\/:id/);
  assert.ok(firstId > 0);
  assert.ok(body.indexOf("registerRoomPayoutRoutes(app)") > -1 && body.indexOf("registerRoomPayoutRoutes(app)") < firstId);
  assert.ok(body.indexOf("registerRoomEarningsRoutes(app)") > -1 && body.indexOf("registerRoomEarningsRoutes(app)") < firstId);
  assert.ok(body.indexOf("registerRoomPayoutRoutes(app)") < body.indexOf("registerRoomTicketRoutes(app)"));
});

test("the payout code never returns or logs the account name or the full number", () => {
  const p = src("server/rooms/payouts.ts");
  const r = src("server/rooms/payoutRoutes.ts");
  assert.doesNotMatch(r, /accountName|accountNumber/);
  for (const line of p.split("\n").filter((l) => /console\.(log|error|warn)/.test(l))) {
    assert.doesNotMatch(line, /accountNumber|resolvedName|verifiedName|accountName|bankName/, line.trim());
  }
  assert.match(p, /namesMatch\(verifiedName, resolvedName\)/);
  // Decided before any lookup, no attempt spent: no verified name, an unknown bank (review r1 m3).
  const lookup = p.indexOf("await takeBankLookupAttempt(userId");
  assert.ok(p.indexOf('refuse("NO_VERIFIED_NAME")') < lookup && p.indexOf('refuse("BAD_BANK")') < lookup);
  assert.ok(lookup < p.indexOf("provider().resolve("));
  // An empty bank list is never cached (review r1 m3).
  assert.match(p, /if \(banks\.length > 0\) bankCache =/);
  // canLinkAccount is in the status (fix round contract).
  assert.match(p, /canLinkAccount: canLinkAccountFor\(user\)/);
});

test("receipt route sends the exact safety headers", () => {
  const r = src("server/rooms/earningsRoutes.ts");
  assert.match(r, /"Content-Type": "text\/html; charset=utf-8"/);
  assert.match(r, /"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"/);
  assert.match(r, /"X-Content-Type-Options": "nosniff"/);
  assert.match(r, /"Cache-Control": "private, no-store"/);
});

test("review r3 N1: never queue an unpayable host; a waiting payout never blocks a change; it is held still meanwhile", () => {
  const settle = src("server/rooms/settlement.ts");
  const q = settle.slice(settle.indexOf("async function queueDuePayout"), settle.indexOf("export type PayOutcome"));
  assert.ok(q.indexOf("await payableSubaccountOf(p.host_id, c)") > q.indexOf("payoutBlockFor(c, p.room_id)"), "blocked rooms still refund");
  assert.ok(q.indexOf("await payableSubaccountOf(p.host_id, c)") < q.indexOf("applyClawbacks"), "checked before anything is applied");
  assert.match(q, /return "waiting_account";/);
  assert.match(settle, /order by \(exists \(select 1 from organizer_payment_accounts a where a\.user_id = room_payouts\.host_id and \$\{PAYABLE_ACCOUNT_SQL\}\)\) desc/);
  const p = src("server/rooms/payouts.ts");
  assert.match(p, /status = 'queued' and coalesce\(last_error, ''\) <> 'NO_PAYOUT_ACCOUNT'/);
  const ch = p.slice(p.indexOf("async function changeLocked"), p.indexOf("async function changeWithPayoutsHeld"));
  assert.match(ch, /pg_try_advisory_lock\(\$1::int, hashtext\(\$2::text\)\) as ok", \[LOCK_PAYOUT, id\]/);
  assert.match(ch, /pg_advisory_unlock\(\$1::int, hashtext\(\$2::text\)\)", \[LOCK_PAYOUT, id\]/);
});

test("review r3 m3 / m5 / m8", () => {
  const p = src("server/rooms/payouts.ts");
  assert.match(p, /if \(out === BUSY\) \{ logAccount\(userId, "BUSY"\); return refuse\("BUSY"\); \}/);
  const o = src("server/organizer-payments-routes.ts");
  const onboard = o.slice(o.indexOf("/api/organizer/payments/paystack/onboard"));
  assert.ok(onboard.indexOf("withAdvisoryLock(LOCK_ACCOUNT_CHANGE, req.user!.id") < onboard.indexOf("createPaystackSubaccount("), "the lock is taken before Paystack");
  assert.ok(onboard.indexOf("createPaystackSubaccount(") < onboard.indexOf("upsertOrganizerPaymentAccount("));
  const sock = src("server/rooms/roomSocket.ts");
  assert.match(sock, /const floor = room\?\.startedAt \? Math\.max\(peak, 1\) : peak;/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
