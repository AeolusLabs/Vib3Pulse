// A ticket's QR carries its full validationCode (a UUID). The short code printed under the QR is the
// first 8 hex characters of it, shown as XXXX-XXXX, so door staff can type it when a QR will not scan.
// The server resolves it by prefix within one event or night, so it only has to be unique there.

const HEX_ONLY = /[^0-9a-f]/g;

/** "a3f912bc-..." -> "A3F9-12BC". */
export function shortCodeOf(validationCode: string): string {
  const hex = validationCode.toLowerCase().replace(HEX_ONLY, "").slice(0, 8).toUpperCase();
  return hex.length > 4 ? `${hex.slice(0, 4)}-${hex.slice(4)}` : hex;
}

/** Whatever staff typed ("a3f9 12bc", "A3F9-12BC") reduced to lowercase hex with no separators. */
export function normalizeShortCode(input: string): string {
  return input.toLowerCase().replace(HEX_ONLY, "");
}

/** True for a complete short code (8 hex characters, separators ignored). */
export function isCompleteShortCode(input: string): boolean {
  return normalizeShortCode(input).length === 8;
}

/** A full UUID validationCode, as scanned from a QR. */
export function isFullValidationCode(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.trim());
}
