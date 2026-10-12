// Upcoming tickets are kept on the device so the QR opens with no signal at the door. The cache holds
// each ticket's validation code (the QR), so it is keyed by user and wiped on log out.

const PREFIX = "vp_wallet_v1_";

export interface CachedWallet {
  savedAt: number;
  event: unknown[];
  venue: unknown[];
}

export function readWalletCache(userId: string): CachedWallet | null {
  try {
    const raw = localStorage.getItem(PREFIX + userId);
    return raw ? (JSON.parse(raw) as CachedWallet) : null;
  } catch {
    return null;
  }
}

export function writeWalletCache(userId: string, event: unknown[], venue: unknown[]): void {
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify({ savedAt: Date.now(), event, venue } satisfies CachedWallet));
  } catch {
    // Storage full or blocked (private window): the wallet still works online.
  }
}

/** Remove every cached wallet on this device. Called on log out. */
export function clearWalletCache(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
