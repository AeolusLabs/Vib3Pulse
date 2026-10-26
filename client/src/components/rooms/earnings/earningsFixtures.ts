// Seeded money screens for /dev/room-fixture?earn=empty|week|clawback|noaccount|mismatch|soon|attention
// (&page=earnings|payouts|payments). "soon": no account and linking not open on this page yet (canLinkAccount false).
// "attention": a failed ticket payout and a spray refunded before it landed, so every split row shows.
// Pure data in the routes' real shapes (the unit test runs each through the parsers). Imported only by the DEV-only
// fixture page and the unit test, so none of this reaches the production bundle. The week is board 8's 243,600 naira,
// laid out the way the server's computeEarnings does it (fix round 6H): every delivered spray share is sprayDirect
// ("paid out by Paystack", never "settled"); settled, sending, needs attention and held split the TICKET money only.
//   onItsWay = sprayDirect + ticketSending
//   settled + onItsWay + needsAttention + held = totals.spray + totals.ticket - clawbackApplied (0 here)
//   sprayReturned is its own figure, outside totals and outside sprayDirect.

export const EARN_SCENES = ["empty", "week", "clawback", "noaccount", "mismatch", "soon", "attention", "noname"] as const;
export type EarnScene = (typeof EARN_SCENES)[number];
export const EARN_PAGES = ["earnings", "payouts", "payments"] as const;
export type EarnPage = (typeof EARN_PAGES)[number];

export function parseEarnFixture(search: string): { scene: EarnScene; page: EarnPage } | null {
  const q = new URLSearchParams(search);
  const v = q.get("earn");
  if (!v || !(EARN_SCENES as readonly string[]).includes(v)) return null;
  const scene = v as EarnScene;
  const p = q.get("page");
  const page: EarnPage = p && (EARN_PAGES as readonly string[]).includes(p) ? (p as EarnPage) : scene === "mismatch" || scene === "soon" || scene === "noname" ? "payouts" : "earnings";
  return { scene, page };
}

export function fixturePayoutStatus(scene: EarnScene) {
  switch (scene) {
    case "noaccount": return { verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: true, hasVerifiedName: true };
    case "mismatch": return { verifiedAdult: true, account: { bankName: "GTBank", last4: "4821", nameMatches: false }, subaccountReady: false, canLinkAccount: true, hasVerifiedName: true };
    case "soon": return { verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: false, hasVerifiedName: true };
    // A verified adult who has not done the payouts name check yet: the page leads with "Verify your name for payouts".
    case "noname": return { verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: false, hasVerifiedName: false };
    default: return { verifiedAdult: true, account: { bankName: "GTBank", last4: "4821", nameMatches: true }, subaccountReady: true, canLinkAccount: true, hasVerifiedName: true };
  }
}

/** After a fixture save that the bank accepted: the new account, last four only. */
export const FIXTURE_SAVED_STATUS = { verifiedAdult: true, account: { bankName: "Access Bank", last4: "0137", nameMatches: true }, subaccountReady: true, canLinkAccount: true, hasVerifiedName: true };

export const FIXTURE_BANKS = {
  banks: [
    { name: "Access Bank", code: "044" }, { name: "GTBank", code: "058" }, { name: "First Bank of Nigeria", code: "011" },
    { name: "Kuda Bank", code: "50211" }, { name: "Opay", code: "999992" }, { name: "Zenith Bank", code: "057" },
  ],
};

const iso = (now: number, hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

export function fixtureEarnings(scene: EarnScene, range: string, now: number) {
  if (scene === "empty") {
    return {
      totals: { sprayKobo: 0, ticketKobo: 0 }, settledKobo: 0, onItsWayKobo: 0, heldTicketKobo: 0, clawbackOpenKobo: 0,
      sprayDirectKobo: 0, ticketSendingKobo: 0, needsAttentionKobo: 0, sprayReturnedKobo: 0, clawbackAppliedKobo: 0, byRoom: [], nextTicketReleaseAt: null,
    };
  }
  // "all" and "month" show a little more than the week, so switching the period visibly changes the numbers.
  const k = range === "all" ? 3 : range === "month" ? 2 : 1;
  // Tickets 142,965: settled 88,435 and held 54,530 in the week. "attention": of the settled part, 20,000 is still being
  // sent and 30,000 failed (finance follows up), and a 7,584 share of a spray refunded before it landed is taken back.
  const attention = scene === "attention";
  const ticketKobo = 14_296_500;
  const ticketSendingKobo = attention ? 2_000_000 : 0;
  const needsAttentionKobo = attention ? 3_000_000 : 0;
  const heldTicketKobo = 5_453_000;
  const settledKobo = ticketKobo - heldTicketKobo - ticketSendingKobo - needsAttentionKobo;
  const sprayKobo = 10_063_500 * k;
  const sprayDirectKobo = sprayKobo;
  const sprayReturnedKobo = attention ? 758_400 : 0;
  return {
    totals: { sprayKobo, ticketKobo },
    settledKobo,
    onItsWayKobo: sprayDirectKobo + ticketSendingKobo,
    sprayDirectKobo, ticketSendingKobo, needsAttentionKobo, sprayReturnedKobo, clawbackAppliedKobo: 0,
    heldTicketKobo,
    clawbackOpenKobo: scene === "clawback" || attention ? 758_400 : 0,
    byRoom: [
      { roomId: "fixture-paid-room", title: "Amapiano Sunday Session", sprayKobo: 6_763_500, ticketKobo: 14_296_500, at: iso(now, 30) },
      { roomId: "fixture-room", title: "Friday Pre-Drinks, Lagos to London", sprayKobo: 3_300_000 + 10_063_500 * (k - 1), ticketKobo: 0, at: iso(now, 72) },
    ],
    nextTicketReleaseAt: new Date(now + 18 * 3_600_000).toISOString(),
  };
}

/** Two pages, so Show more can be tried. Page two holds a refund (negative) and repeats one row of page one. */
export function fixturePayments(scene: EarnScene, cursor: string | null, now: number) {
  if (scene === "empty") return { items: [], next: null };
  const ticket = { id: "rtk_fx_0001", kind: "ticket", title: "Amapiano Sunday Session", amountKobo: 500_000, vatKobo: 34_884, at: iso(now, 26), status: "paid" };
  if (!cursor) {
    return {
      items: [
        { id: "spr_fx_0003", kind: "spray", title: "Friday Pre-Drinks, Lagos to London", amountKobo: 100_000, vatKobo: 6_977, at: iso(now, 2), status: "delivered" },
        { id: "spr_fx_0002", kind: "spray", title: "Friday Pre-Drinks, Lagos to London", amountKobo: 1_000_000, vatKobo: 69_767, at: iso(now, 3), status: "pending" },
        ticket,
      ],
      next: "fx-cursor-2",
    };
  }
  return {
    items: [
      ticket,
      { id: "ref_fx_0001", kind: "refund", title: "Open mic: poetry night", amountKobo: -300_000, vatKobo: -20_930, at: iso(now, 50), status: "processed" },
      { id: "rtk_fx_0000", kind: "ticket", title: "Open mic: poetry night", amountKobo: 300_000, vatKobo: 20_930, at: iso(now, 80), status: "refunded" },
    ],
    next: null,
  };
}
