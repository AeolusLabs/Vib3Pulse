// Where Paystack sends a room ticket buyer back after paying. Pure (no I/O), so it can be unit tested.
//
// Only ever APP_URL, the one origin we own: never the Host or Origin header, which the caller controls (a forged Host
// would make Paystack send the buyer, with their payment reference, to someone else's site). Outside production a missing
// APP_URL falls back to the request host (local dev and the test server). In production a missing or malformed APP_URL
// gives null, and checkout refuses (500 CHECKOUT_FAILED) with a log line naming the setting.
export function ticketCheckoutBaseUrl(env: NodeJS.ProcessEnv, devFallback: string): string | null {
  const app = (env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (app) {
    try {
      const u = new URL(app);
      return u.protocol === "https:" || u.protocol === "http:" ? app : null;
    } catch {
      return null; // not a URL: refuse rather than guess
    }
  }
  return env.NODE_ENV === "production" ? null : devFallback;
}
