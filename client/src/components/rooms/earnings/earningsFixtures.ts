// Seeded money screens for /dev/room-fixture?earn=empty|week|clawback|noaccount|mismatch|organiser|soon
// (&page=earnings|payouts|payments). "organiser": set up through organiser payouts (no account here, subaccount ready).
// "soon": no account and linking not open on this page yet (canLinkAccount false).
// Pure data in the routes' real shapes (the unit test runs each through the parsers). Imported only by the DEV-only
// fixture page and the unit test, so none of this reaches the production bundle. The week matches flows.html board 8:
// settled 88,435 + on its way 12,200 + held for tickets 142,965 = 243,600 naira.

export const EARN_SCENES = ["empty", "week", "clawback", "noaccount", "mismatch", "organiser", "soon"] as const;
export type EarnScene = (typeof EARN_SCENES)[number];
export const EARN_PAGES = ["earnings", "payouts", "payments"] as const;
export type EarnPage = (typeof EARN_PAGES)[number];

export function parseEarnFixture(search: string): { scene: EarnScene; page: EarnPage } | null {
  const q = new URLSearchParams(search);
  const v = q.get("earn");
  if (!v || !(EARN_SCENES as readonly string[]).includes(v)) return null;
  const scene = v as EarnScene;
  const p = q.get("page");
  const page: EarnPage = p && (EARN_PAGES as readonly string[]).includes(p) ? (p as EarnPage) : scene === "mismatch" || scene === "soon" ? "payouts" : "earnings";
  return { scene, page };
}

export function fixturePayoutStatus(scene: EarnScene) {
  switch (scene) {
    case "noaccount": return { verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: true };
    case "mismatch": return { verifiedAdult: true, account: { bankName: "GTBank", last4: "4821", nameMatches: false }, subaccountReady: false, canLinkAccount: true };
    case "organiser": return { verifiedAdult: true, account: null, subaccountReady: true, canLinkAccount: false };
    case "soon": return { verifiedAdult: true, account: null, subaccountReady: false, canLinkAccount: false };
    default: return { verifiedAdult: true, account: { bankName: "GTBank", last4: "4821", nameMatches: true }, subaccountReady: true, canLinkAccount: true };
  }
}

/** After a fixture save that the bank accepted: the new account, last four only. */
export const FIXTURE_SAVED_STATUS = { verifiedAdult: true, account: { bankName: "Access Bank", last4: "0137", nameMatches: true }, subaccountReady: true, canLinkAccount: true };

export const FIXTURE_BANKS = {
  banks: [
    { name: "Access Bank", code: "044" }, { name: "GTBank", code: "058" }, { name: "First Bank of Nigeria", code: "011" },
    { name: "Kuda Bank", code: "50211" }, { name: "Opay", code: "999992" }, { name: "Zenith Bank", code: "057" },
  ],
};

const iso = (now: number, hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

export function fixtureEarnings(scene: EarnScene, range: string, now: number) {
  if (scene === "empty") {
    return { totals: { sprayKobo: 0, ticketKobo: 0 }, settledKobo: 0, onItsWayKobo: 0, heldTicketKobo: 0, clawbackOpenKobo: 0, byRoom: [], nextTicketReleaseAt: null };
  }
  // "all" and "month" show a little more than the week, so switching the period visibly changes the numbers.
  const k = range === "all" ? 3 : range === "month" ? 2 : 1;
  return {
    totals: { sprayKobo: 10_063_500 * k, ticketKobo: 14_296_500 },
    settledKobo: 8_843_500 + 10_063_500 * (k - 1),
    onItsWayKobo: 1_220_000,
    heldTicketKobo: 14_296_500,
    clawbackOpenKobo: scene === "clawback" ? 758_400 : 0,
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
