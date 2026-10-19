// Pure money math. All amounts are integer kobo. Formulas: spec section 5.
// The owner's 500 naira minimum real charge (MIN_CHARGE_KOBO, 50,000 kobo) holds for every spray tier: the smallest note is
// 500 naira (decided 2026-10-19). assertChargeable() is the charge-boundary check; breakdown() itself only needs a positive
// integer price (tickets have their own range in shared/rooms.ts).

export const UNIT_LABEL = "V3C";

/** The smallest real charge the platform ever makes, in kobo (500 naira). */
export const MIN_CHARGE_KOBO = 50000;

export type SprayTier = "note" | "bundle" | "bag" | "rain";

/** 1 V3C = 1 kobo. V3C is only a price label, never a balance. */
export const SPRAY_CATALOGUE: Readonly<Record<SprayTier, Readonly<{ v3c: number; kobo: number; platformPct: number; label: string }>>> = Object.freeze({
  note: Object.freeze({ v3c: 50000, kobo: 50000, platformPct: 30, label: "Note" }),
  bundle: Object.freeze({ v3c: 100000, kobo: 100000, platformPct: 25, label: "Bundle" }),
  bag: Object.freeze({ v3c: 1000000, kobo: 1000000, platformPct: 20, label: "Money bag" }),
  rain: Object.freeze({ v3c: 10000000, kobo: 10000000, platformPct: 15, label: "Make it Rain" }),
});

/** Every tier, smallest first. */
export const SPRAY_TIERS: readonly SprayTier[] = Object.freeze(["note", "bundle", "bag", "rain"] as SprayTier[]);

/** True only for one of the four tier names (never a prototype key such as "toString" or "__proto__"). */
export function isSprayTier(x: unknown): x is SprayTier {
  return typeof x === "string" && (SPRAY_TIERS as readonly string[]).includes(x);
}

/** Throws RangeError unless `kobo` is a safe integer of at least MIN_CHARGE_KOBO. Call it before any real charge. */
export function assertChargeable(kobo: number): void {
  if (!Number.isSafeInteger(kobo) || kobo < MIN_CHARGE_KOBO) {
    throw new RangeError(`a charge must be an integer of at least ${MIN_CHARGE_KOBO} kobo, got ${kobo}`);
  }
}

export const TICKET_PLATFORM_PCT = 15;
const SPRAY_RESERVE_PCT = 0.025;
const TICKET_RESERVE_PCT = 0.01;
const STAGE_GUEST_HOST_PCT = 15;
const MAX_RESERVE_PCT = 0.2;

export interface Breakdown {
  price: number; vat: number; fee: number; reserve: number; net: number;
  platform: number; host: number; guest: number | null;
}

export function breakdown(opts: { price: number; platformPct: number; reservePct: number; stageGuest?: boolean }): Breakdown {
  const { price, platformPct, reservePct, stageGuest } = opts;
  if (!Number.isSafeInteger(price) || price <= 0) throw new RangeError(`price must be a positive integer of kobo, got ${price}`);
  if (typeof platformPct !== "number" || !Number.isFinite(platformPct) || platformPct < 0 || platformPct > 100) {
    throw new RangeError(`platformPct must be a number from 0 to 100, got ${platformPct}`);
  }
  if (typeof reservePct !== "number" || !Number.isFinite(reservePct) || reservePct < 0 || reservePct > MAX_RESERVE_PCT) {
    throw new RangeError(`reservePct must be a number from 0 to ${MAX_RESERVE_PCT}, got ${reservePct}`);
  }
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
  if (!isSprayTier(tier)) throw new RangeError(`unknown spray tier ${String(tier)}`);
  const t = SPRAY_CATALOGUE[tier];
  return breakdown({ price: t.kobo, platformPct: t.platformPct, reservePct: SPRAY_RESERVE_PCT, stageGuest });
}

export function ticketBreakdown(priceKobo: number): Breakdown {
  return breakdown({ price: priceKobo, platformPct: TICKET_PLATFORM_PCT, reservePct: TICKET_RESERVE_PCT });
}

/** Exact: a safe integer in, "50,000 V3C" out. A fraction, NaN or Infinity throws RangeError (never rounded silently). */
export function formatV3c(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`formatV3c needs an integer, got ${n}`);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${digits} ${UNIT_LABEL}`;
}
