// Single source of truth for currency display + creation-time defaults on the
// client. Charge-time currency itself is always the explicit, stored
// `currency` column on the event/venue — never re-derived here or anywhere
// else. See asSupportedCurrency() in server/payments/index.ts.

// Currencies VibePulse can actually charge in today — Stripe (GBP) and
// Paystack (NGN). Keep in sync with SupportedCurrency in
// server/payments/types.ts. Creation-time pickers should only ever offer
// these — anything else has no payment rail behind it and will fail at
// checkout.
export const SUPPORTED_CURRENCIES = [
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "NGN", symbol: "₦", name: "Nigerian Naira" },
] as const;

export type SupportedCurrencyCode = typeof SUPPORTED_CURRENCIES[number]["code"];

// Broader symbol map for DISPLAY only, so legacy/edge-case data (anything
// stored before the creation picker was restricted to the two above) still
// renders a sensible symbol instead of silently defaulting to £.
const DISPLAY_SYMBOLS: Record<string, string> = {
  GBP: "£", USD: "$", EUR: "€", NGN: "₦", CAD: "C$", AUD: "A$", ZAR: "R", GHS: "₵",
};

export function getCurrencySymbol(currency: string | null | undefined): string {
  if (!currency) return "£";
  return DISPLAY_SYMBOLS[currency] ?? "£";
}

// Format a smallest-currency-unit integer (pence/kobo) for display. Mirrors
// server/payments/index.ts formatAmount().
export function formatMoney(amountSmallestUnit: number | null | undefined, currency: string | null | undefined): string {
  const amount = (amountSmallestUnit ?? 0) / 100;
  const symbol = getCurrencySymbol(currency);
  if (currency === "NGN") {
    return `${symbol}${amount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}

// Same as formatMoney but drops decimals once the amount reaches 100 units
// (£100 / ₦100) — used in dashboard/analytics contexts where large numbers
// benefit from less visual clutter.
export function formatMoneyCompact(amountSmallestUnit: number | null | undefined, currency: string | null | undefined): string {
  const amount = (amountSmallestUnit ?? 0) / 100;
  const symbol = getCurrencySymbol(currency);
  if (amount === 0) return `${symbol}0`;
  const maximumFractionDigits = amount >= 100 ? 0 : 2;
  if (currency === "NGN") {
    return `${symbol}${amount.toLocaleString("en-NG", { maximumFractionDigits })}`;
  }
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits,
  }).format(amount);
}

// Last-resort default when nothing better is known — browser locale is a
// weak signal (a Nigerian organizer on an en-GB browser would guess wrong),
// which is why this is only the final fallback in deriveDefaultCurrency().
function detectCurrencyFromLocale(): SupportedCurrencyCode {
  const locale = (typeof navigator !== "undefined" && navigator.language) || "en-GB";
  const map: Record<string, SupportedCurrencyCode> = { "en-GB": "GBP", "en-NG": "NGN" };
  return map[locale] || map[locale.split("-")[0]] || "GBP";
}

export interface PayoutStatusForDefault {
  stripe?: { payoutsEnabled: boolean } | null;
  paystack?: { payoutsEnabled: boolean } | null;
}

// Best default for a NEW event/venue's currency picker, before the organizer
// confirms/overrides it via the dropdown. Priority: the provider they can
// actually receive money through (strongest signal — no point defaulting to
// a currency they have no payout account for) beats a locale guess.
export function deriveDefaultCurrency(payoutStatus?: PayoutStatusForDefault | null): SupportedCurrencyCode {
  const hasPaystack = !!payoutStatus?.paystack?.payoutsEnabled;
  const hasStripe = !!payoutStatus?.stripe?.payoutsEnabled;
  if (hasPaystack && !hasStripe) return "NGN";
  if (hasStripe && !hasPaystack) return "GBP";
  return detectCurrencyFromLocale();
}
