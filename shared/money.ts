// Pure money math. All amounts are integer kobo. Formulas: spec section 5.
// Note: the owner's 500 naira minimum real charge is enforced at the charge boundary (phase 5),
// not here. The n20 and n50 tiers sit below it on purpose; breakdown() does not check a minimum.

export const UNIT_LABEL = "V3C";

export type SprayTier = "n20" | "n50" | "n100" | "bundle" | "bag" | "rain";

export const SPRAY_CATALOGUE: Record<SprayTier, { v3c: number; kobo: number; platformPct: number; label: string }> = {
  n20: { v3c: 2000, kobo: 2000, platformPct: 30, label: "Small note" },
  n50: { v3c: 5000, kobo: 5000, platformPct: 30, label: "Medium note" },
  n100: { v3c: 10000, kobo: 10000, platformPct: 30, label: "Large note" },
  bundle: { v3c: 100000, kobo: 100000, platformPct: 25, label: "Bundle" },
  bag: { v3c: 1000000, kobo: 1000000, platformPct: 20, label: "Money bag" },
  rain: { v3c: 10000000, kobo: 10000000, platformPct: 15, label: "Make it Rain" },
};

export const TICKET_PLATFORM_PCT = 15;
const SPRAY_RESERVE_PCT = 0.025;
const TICKET_RESERVE_PCT = 0.01;
const STAGE_GUEST_HOST_PCT = 15;

export interface Breakdown {
  price: number; vat: number; fee: number; reserve: number; net: number;
  platform: number; host: number; guest: number | null;
}

export function breakdown(opts: { price: number; platformPct: number; reservePct: number; stageGuest?: boolean }): Breakdown {
  const { price, platformPct, reservePct, stageGuest } = opts;
  if (!Number.isInteger(price) || price <= 0) throw new RangeError(`price must be a positive integer of kobo, got ${price}`);
  const vat = Math.round((price * 75) / 1075);
  const fee = Math.min(200000, Math.round((price * 15) / 1000) + (price >= 250000 ? 10000 : 0));
  // integer numerator avoids float noise from reservePct such as 0.025
  const reserve = Math.round((price * Math.round(reservePct * 10000)) / 10000);
  const net = price - vat - fee - reserve;
  const platform = Math.round((net * platformPct) / 100);
  if (stageGuest) {
    const host = Math.round((net * STAGE_GUEST_HOST_PCT) / 100);
    return { price, vat, fee, reserve, net, platform, host, guest: net - platform - host };
  }
  return { price, vat, fee, reserve, net, platform, host: net - platform, guest: null };
}

export function sprayBreakdown(tier: SprayTier, stageGuest?: boolean): Breakdown {
  const t = SPRAY_CATALOGUE[tier];
  return breakdown({ price: t.kobo, platformPct: t.platformPct, reservePct: SPRAY_RESERVE_PCT, stageGuest });
}

export function ticketBreakdown(priceKobo: number): Breakdown {
  return breakdown({ price: priceKobo, platformPct: TICKET_PLATFORM_PCT, reservePct: TICKET_RESERVE_PCT });
}

export function formatV3c(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} ${UNIT_LABEL}`;
}
