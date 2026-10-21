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
const STAGE_GUEST_HOST_PCT = 15;
const MAX_RESERVE_PCT = 0.2;

// ---------------------------------------------------------------- rates (editable by a super-admin; rooms rates plan)
// Every number an admin may change, in PERCENT. The platform shares are percent of net (what is left after VAT, card fees and the
// fraud reserve); the reserves are percent of the price; stage_guest_host is the host's percent of net on a stage-guest spray.
// VAT (7.5%) and the card fee formula are not rates: the tax rate and the provider's fees are not ours to set. A rate change only
// applies to sprays and tickets created after it: each split is computed once, when the spray starts or the ticket is issued, and
// stored on the row.
export const RATE_KEYS = [
  "spray_platform_note", "spray_platform_bundle", "spray_platform_bag", "spray_platform_rain",
  "ticket_platform", "stage_guest_host", "spray_reserve", "ticket_reserve",
] as const;
export type RateKey = typeof RATE_KEYS[number];
export type Rates = Record<RateKey, number>;

export const DEFAULT_RATES: Readonly<Rates> = Object.freeze({
  spray_platform_note: 30, spray_platform_bundle: 25, spray_platform_bag: 20, spray_platform_rain: 15,
  ticket_platform: 15, stage_guest_host: 15, spray_reserve: 2.5, ticket_reserve: 1,
});

const PLATFORM_LIMIT = Object.freeze({ min: 0, max: 50 });
const RESERVE_LIMIT = Object.freeze({ min: 0, max: 10 });
export const RATE_LIMITS: Readonly<Record<RateKey, Readonly<{ min: number; max: number }>>> = Object.freeze({
  spray_platform_note: PLATFORM_LIMIT, spray_platform_bundle: PLATFORM_LIMIT, spray_platform_bag: PLATFORM_LIMIT, spray_platform_rain: PLATFORM_LIMIT,
  ticket_platform: PLATFORM_LIMIT, stage_guest_host: PLATFORM_LIMIT, spray_reserve: RESERVE_LIMIT, ticket_reserve: RESERVE_LIMIT,
});

export function isRateKey(x: unknown): x is RateKey {
  return typeof x === "string" && (RATE_KEYS as readonly string[]).includes(x);
}

/** A number inside the key's limits with at most two decimal places. Never rounds: a bad value is refused with a reason. */
export function validateRate(key: RateKey, value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (!isRateKey(key)) return { ok: false, reason: "Unknown rate" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "The rate must be a number" };
  const { min, max } = RATE_LIMITS[key];
  if (value < min || value > max) return { ok: false, reason: `The rate must be from ${min} to ${max}` };
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) return { ok: false, reason: "Use at most 2 decimal places" };
  return { ok: true, value };
}

export interface Breakdown {
  price: number; vat: number; fee: number; reserve: number; net: number;
  platform: number; host: number; guest: number | null;
}

export function breakdown(opts: { price: number; platformPct: number; reservePct: number; stageGuest?: boolean; stageGuestHostPct?: number }): Breakdown {
  const { price, platformPct, reservePct, stageGuest, stageGuestHostPct = STAGE_GUEST_HOST_PCT } = opts;
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
    // Never more than what the platform's cut left: at the 50% + 50% extremes rounding could otherwise leave the guest at minus 1 kobo.
    const host = Math.min(Math.round((net * stageGuestHostPct) / 100), net - platform);
    return { price, vat, fee, reserve, net, platform, host, guest: net - platform - host };
  }
  return { price, vat, fee, reserve, net, platform, host: net - platform, guest: null };
}

export function sprayBreakdown(tier: SprayTier, stageGuest?: boolean, rates: Rates = DEFAULT_RATES): Breakdown {
  if (!isSprayTier(tier)) throw new RangeError(`unknown spray tier ${String(tier)}`);
  const t = SPRAY_CATALOGUE[tier];
  // The catalogue's platformPct is the starting value; the live number is the saved rate for this tier.
  return breakdown({
    price: t.kobo, platformPct: rates[`spray_platform_${tier}` as RateKey], reservePct: rates.spray_reserve / 100, stageGuest, stageGuestHostPct: rates.stage_guest_host,
  });
}

export function ticketBreakdown(priceKobo: number, rates: Rates = DEFAULT_RATES): Breakdown {
  return breakdown({ price: priceKobo, platformPct: rates.ticket_platform, reservePct: rates.ticket_reserve / 100 });
}

/** Exact: a safe integer in, "50,000 V3C" out. A fraction, NaN or Infinity throws RangeError (never rounded silently). */
export function formatV3c(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`formatV3c needs an integer, got ${n}`);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${digits} ${UNIT_LABEL}`;
}
