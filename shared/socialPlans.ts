// Social promotion plans — the single source of truth for tiers, limits and
// prices. Imported by the server (enforcement, charging) and the client
// (display) so the price shown can never drift from the price charged.
//
// Limits are set from Zernio's real cost drivers: the monthly fee per connected
// account (maxPlatforms) and X's per-post charge (one X post per campaign).
// Posts on other platforms are free to us, so they are not the thing capped.
// All prices are smallest currency units (pence / kobo).

export const SOCIAL_TIERS = ["starter", "growth", "pro"] as const;
export type SocialTier = typeof SOCIAL_TIERS[number];

export const SOCIAL_BILLING = ["recurring", "one_off"] as const;
export type SocialBilling = typeof SOCIAL_BILLING[number];

export type SocialCurrency = "GBP" | "NGN";

// A pass lasts this long. Recurring passes are renewed by the payment provider.
export const SOCIAL_PASS_DAYS = 30;

// After a plan ends, connected accounts stay for this long (so renewing is painless),
// then are disconnected on Zernio so they stop costing us the per-account fee.
export const SOCIAL_LAPSE_GRACE_DAYS = 7;

// Accounts connected before plans existed had no plan to lapse from. They get the
// same grace counted from this date instead of being cut off the moment plans ship.
export const SOCIAL_PLANS_LAUNCHED_AT = "2026-10-12T00:00:00Z";

// Scheduling rules.
export const SCHEDULE_MIN_LEAD_MINUTES = 5;     // a send must be at least this far in the future
export const SCHEDULE_MIN_GAP_MINUTES = 30;     // between two sends of one campaign
export const SCHEDULE_CANCEL_CUTOFF_MINUTES = 15; // cancelling closer than this to the first send keeps the campaign spent

// Abuse / platform-rate-limit guard: successful sends per platform per rolling 24h.
export const MAX_SENDS_PER_PLATFORM_PER_DAY = 3;

export interface SocialTierDef {
  id: SocialTier;
  label: string;
  maxPlatforms: number;       // connected platforms allowed at once
  campaignsPerPass: number;   // campaigns per 30-day pass
  timesPerCampaign: number;   // scheduled send times per campaign
  prices: Record<SocialCurrency, Record<SocialBilling, number>>;
}

// One-off passes cost more than the recurring price — recurring is the discount
// for committing. NGN figures are rounded from ~₦1,850 per £1 (Oct 2026); our
// costs are in USD, so re-check them if the rate moves more than ~15%.
export const SOCIAL_TIER_DEFS: Record<SocialTier, SocialTierDef> = {
  starter: {
    id: "starter", label: "Starter", maxPlatforms: 2, campaignsPerPass: 3, timesPerCampaign: 2,
    prices: {
      GBP: { recurring: 999,  one_off: 1299 },
      NGN: { recurring: 1_850_000, one_off: 2_400_000 },
    },
  },
  growth: {
    id: "growth", label: "Growth", maxPlatforms: 4, campaignsPerPass: 8, timesPerCampaign: 3,
    prices: {
      GBP: { recurring: 2499, one_off: 3299 },
      NGN: { recurring: 4_600_000, one_off: 6_100_000 },
    },
  },
  pro: {
    id: "pro", label: "Pro", maxPlatforms: 6, campaignsPerPass: 20, timesPerCampaign: 3,
    prices: {
      GBP: { recurring: 5999, one_off: 7799 },
      NGN: { recurring: 11_100_000, one_off: 14_400_000 },
    },
  },
};

export function isSocialTier(value: unknown): value is SocialTier {
  return typeof value === "string" && (SOCIAL_TIERS as readonly string[]).includes(value);
}

export function tierRank(tier: SocialTier): number {
  return SOCIAL_TIERS.indexOf(tier);
}

export function tierPrice(tier: SocialTier, currency: SocialCurrency, billing: SocialBilling): number {
  return SOCIAL_TIER_DEFS[tier].prices[currency][billing];
}

// ── Cost model (admin estimates + the pricing page) ─────────────────────────
// Assumptions, not quotes. Revisit when the exchange rate moves ~15% or Zernio changes pricing.
export const ASSUMED_USD_PER_GBP = 1.3;
export const ASSUMED_NGN_PER_GBP = 1850;
export const ASSUMED_X_USD_PER_POST = 0.2;      // worst case of Zernio's pass-through $0.005-$0.20
export const ASSUMED_CARD_FEE_PCT = 0.0325;     // Stripe UK international card; Paystack is cheaper
export const ASSUMED_CARD_FEE_FIXED_GBP = 0.2;

// Zernio's graduated per-connected-account bill (docs.zernio.com/pricing): accounts 1-2 free,
// 3-10 $6, 11-100 $3, 101+ $1. Returns USD per month for `accounts` connected accounts.
export function zernioMonthlyBillUsd(accounts: number): number {
  const tiers: Array<[number, number]> = [[2, 0], [10, 6], [100, 3], [Infinity, 1]];
  let total = 0;
  let prev = 0;
  for (const [upTo, price] of tiers) {
    const inTier = Math.max(0, Math.min(accounts, upTo) - prev);
    total += inTier * price;
    prev = upTo;
  }
  return total;
}

// ── Top-ups ─────────────────────────────────────────────────────────────────
// Bought on top of the current pass instead of upgrading mid-period. They add to that pass's
// limits only and end with it (unused extras do not carry into the next period). Priced above the
// per-campaign rate of the plans, so a plan is always the cheaper way to get more.
export const SOCIAL_TOPUP_IDS = ["campaigns_2", "campaigns_5", "platform_1"] as const;
export type SocialTopupId = typeof SOCIAL_TOPUP_IDS[number];

export interface SocialTopupDef {
  id: SocialTopupId;
  kind: "campaigns" | "platform";
  amount: number;
  label: string;
  prices: Record<SocialCurrency, number>; // pence / kobo
}

export const SOCIAL_TOPUP_DEFS: Record<SocialTopupId, SocialTopupDef> = {
  campaigns_2: { id: "campaigns_2", kind: "campaigns", amount: 2, label: "+2 campaigns", prices: { GBP: 799,  NGN: 1_480_000 } },
  campaigns_5: { id: "campaigns_5", kind: "campaigns", amount: 5, label: "+5 campaigns", prices: { GBP: 1799, NGN: 3_300_000 } },
  // One more connected platform for the rest of this period. Zernio bills us per connected
  // account ($3-6/mo), so it is priced to cover that even at the worst rate.
  platform_1:  { id: "platform_1",  kind: "platform",  amount: 1, label: "+1 connected platform", prices: { GBP: 699, NGN: 1_290_000 } },
};

// Most extra platforms a single pass can buy, so top-ups can't be used to run a Pro-sized
// setup on a Starter price.
export const MAX_EXTRA_PLATFORMS = 2;

export function isTopupId(value: unknown): value is SocialTopupId {
  return typeof value === "string" && (SOCIAL_TOPUP_IDS as readonly string[]).includes(value);
}

export function topupPrice(id: SocialTopupId, currency: SocialCurrency): number {
  return SOCIAL_TOPUP_DEFS[id].prices[currency];
}
