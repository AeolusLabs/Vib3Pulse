const SYMBOLS: Record<string, string> = {
  GBP: "£", USD: "$", EUR: "€", NGN: "₦", CAD: "C$", AUD: "A$", ZAR: "R", GHS: "₵",
};

export function getCurrencySymbol(code?: string | null): string {
  return SYMBOLS[code ?? "GBP"] ?? "£";
}

// Amounts are stored in the smallest currency unit (pence / kobo).
export function formatPrice(smallest: number, currency?: string | null): string {
  return `${getCurrencySymbol(currency)}${(smallest / 100).toFixed(2)}`;
}
