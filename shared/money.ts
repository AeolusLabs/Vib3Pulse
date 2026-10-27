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

// ---------------------------------------------------------------- gaming: team spray (owner decision 2026-10-22)
/**
 * The smallest team spray: MIN_CHARGE_KOBO (500 naira) for each player on the team now, so every equal share is at least the
 * 500 naira minimum (a team of 2 is 100,000 kobo). Throws RangeError for anything but a whole number of players from 1.
 */
export function teamSprayMinimumKobo(players: number): number {
  if (!Number.isSafeInteger(players) || players < 1) throw new RangeError(`a team spray needs at least one player, got ${players}`);
  return MIN_CHARGE_KOBO * players;
}

/** The tiers a team of this size may be sprayed with: those at or above teamSprayMinimumKobo. None for an empty team. */
export function teamSprayTiers(players: number): SprayTier[] {
  if (!Number.isSafeInteger(players) || players < 1) return [];
  const min = teamSprayMinimumKobo(players);
  return SPRAY_TIERS.filter((t) => SPRAY_CATALOGUE[t].kobo >= min);
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

/**
 * A rate set must leave the host a share of a host spray, and the host AND the stage person a share of a stage spray, on every tier.
 * A zero share cannot be sent to the payment provider, so such a set would make every spray of that kind fail. null = fine.
 */
export function rateSetProblem(rates: Rates): string | null {
  for (const t of SPRAY_TIERS) {
    const toHost = sprayBreakdown(t, false, rates);
    const toStage = sprayBreakdown(t, true, rates);
    if (toHost.host <= 0 || toStage.host <= 0 || (toStage.guest ?? 0) <= 0) {
      return "These rates would leave the host or the person on stage with nothing from a spray, so those sprays would be refused. Lower the platform cut or change the host's share of a stage spray.";
    }
  }
  return null;
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

// ---------------------------------------------------------------- gaming: team spray money (owner rules 2026-10-22, backend-E-brief)
/**
 * Splits `total` across `weights` in proportion, in whole kobo, deterministically: floor(total * w / sum) each, then the
 * leftover kobo one each to the largest fractional remainders, ties in list order. The parts always sum to `total`, and when
 * total <= sum(weights) no part exceeds its weight. (A few million kobo at most, so total * w stays far inside the safe range.)
 */
export function allocateKobo(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total < 0 || !weights.every((w) => Number.isSafeInteger(w) && w >= 0) || sum <= 0) {
    throw new RangeError("allocateKobo: whole, non-negative kobo and at least one positive weight");
  }
  const base = weights.map((w) => Math.floor((total * w) / sum));
  const order = weights.map((w, i) => ({ i, rem: (total * w) % sum })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  let left = total - base.reduce((a, b) => a + b, 0);
  for (const o of order) { if (left <= 0) break; base[o.i] += 1; left -= 1; }
  return base;
}

export interface TeamShare {
  userId: string;
  isHost: boolean;
  /** What the payer is shown for this player: the equal split of the charge (remainder to the featured player). */
  gross: number;
  /** What goes to this player's own subaccount: an equal part of the pool (remainder kobo featured player first). */
  recipient: number;
  /** This row's allocated part of the whole-charge deductions (see below). gross = vat + paystackFee + reserve + platform + host + recipient. */
  vat: number; paystackFee: number; reserve: number; platform: number; host: number;
}

/**
 * The whole team spray, in the owner's order (CORRECTION 1): the deductions are taken on the WHOLE charge X first, exactly as a
 * single spray does it (breakdown(): VAT, the card fee with its flat part once, the reserve, then the tier's platform % of what
 * is left, then the host %), and what is left (the pool) is split EQUALLY among the N players, each into their own subaccount.
 *  - The host % applies only to the part of the net that goes to players who are not the host: net * hostPct * (N - hosts) / N
 *    (the whole net when the host is not on the team; nothing when the host is the only player). Never more than net - platform.
 *  - The host's subaccount receives whole.host (and, when the host plays, also their equal share of the pool: one merged entry).
 *  - The pool's remainder (pool mod N) goes one kobo each to the featured player first, then in team (list) order.
 * Per-row bookkeeping (spray_payments needs every row's parts to sum to its amount): each row's gross is the equal split of X
 * (splitShares: remainder to the featured player); its recipient part is the pool share above; the rest of the row
 * (gross - recipient) is filled with the whole-charge parts in the order vat, fee, reserve, platform, host, each part spread
 * over the rows in proportion to the row room still left (allocateKobo: largest remainder, ties in team order). That never
 * overfills a row, and the last part (host) fills every row exactly, so the rows' parts sum to X and each row to its gross.
 * Invariants (tested): platform + host + vat + fee + reserve + sum(recipient) = X; every recipient > 0; all non-negative integers.
 * Throws RangeError for an unknown tier, no players, duplicates, or a pool too small to give every player at least one kobo.
 */
export function teamSprayBreakdown(
  tier: SprayTier, players: ReadonlyArray<{ userId: string; isHost: boolean }>, featuredId: string | null, rates: Rates = DEFAULT_RATES,
): {
  whole: { gross: number; vat: number; paystackFee: number; reserve: number; platform: number; host: number; pool: number };
  shares: TeamShare[]; hostTotal: number;
} {
  if (!isSprayTier(tier)) throw new RangeError(`unknown spray tier ${String(tier)}`);
  const n = players.length;
  if (n < 1 || new Set(players.map((p) => p.userId)).size !== n) throw new RangeError("teamSprayBreakdown: one or more distinct players");
  const price = SPRAY_CATALOGUE[tier].kobo;
  const whole = breakdown({ price, platformPct: rates[`spray_platform_${tier}` as RateKey], reservePct: rates.spray_reserve / 100 });
  const nonHost = players.filter((p) => !p.isHost).length;
  const host = nonHost === 0 ? 0 : Math.min(Math.round((whole.net * rates.stage_guest_host * nonHost) / (100 * n)), whole.net - whole.platform);
  const pool = whole.net - whole.platform - host;
  // featured first, then team order: who gets the remainder kobo of the pool, and of the gross
  const order = players.map((_, i) => i);
  const fi = featuredId === null ? -1 : players.findIndex((p) => p.userId === featuredId);
  if (fi > 0) order.splice(0, order.length, fi, ...order.filter((i) => i !== fi));
  const each = Math.floor(pool / n), rest = pool - each * n;
  const recipient = players.map(() => each);
  for (let k = 0; k < rest; k++) recipient[order[k]] += 1;
  const grossEach = Math.floor(price / n);
  const gross = players.map(() => grossEach);
  gross[order[0]] += price - grossEach * n;
  if (!recipient.every((r) => r > 0)) throw new RangeError("teamSprayBreakdown: every player's cut must be positive");
  const room = players.map((_, i) => gross[i] - recipient[i]);
  if (!room.every((r) => r >= 0)) throw new RangeError("teamSprayBreakdown: a cut cannot exceed its share");
  const fill = (total: number): number[] => {
    const cap = room.slice();
    const sum = cap.reduce((a, b) => a + b, 0);
    if (total === 0) return cap.map(() => 0);
    if (total > sum) throw new RangeError("teamSprayBreakdown: parts do not fit the rows");
    const part = allocateKobo(total, cap);
    for (let i = 0; i < room.length; i++) room[i] -= part[i];
    return part;
  };
  const vat = fill(whole.vat), fee = fill(whole.fee), reserve = fill(whole.reserve), platform = fill(whole.platform), hostPart = fill(host);
  if (!room.every((r) => r === 0)) throw new RangeError("teamSprayBreakdown: the rows do not add up");
  const shares: TeamShare[] = players.map((p, i) => ({
    userId: p.userId, isHost: p.isHost, gross: gross[i], recipient: recipient[i],
    vat: vat[i], paystackFee: fee[i], reserve: reserve[i], platform: platform[i], host: hostPart[i],
  }));
  const hostTotal = host + shares.filter((s) => s.isHost).reduce((a, s) => a + s.recipient, 0);
  return {
    whole: { gross: price, vat: whole.vat, paystackFee: whole.fee, reserve: whole.reserve, platform: whole.platform, host, pool },
    shares, hostTotal,
  };
}
