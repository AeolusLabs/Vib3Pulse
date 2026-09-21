import * as Sentry from "@sentry/node";

// Read once at module load — never read from process.env inside a request
// handler so the key is never accidentally captured in a closure that gets logged.
const BASE_URL = (process.env.ZERNIO_BASE_URL ?? "").replace(/\/$/, "");
const API_KEY  = process.env.ZERNIO_API_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ZernioConnectedAccount {
  _id:      string;
  platform: string;
  username: string;
  isActive: boolean;
}

export interface ZernioPlatformResult {
  platform:         string;
  status:           string;
  platformPostUrl?: string;
  errorMessage?:    string;
}

// Zernio's real API has no cost/billing field on posts — pricing is metered
// separately via /usage/get-billing, not returned per-post.
export interface ZernioPostResult {
  post: {
    _id:       string;
    status:    string;
    platforms: ZernioPlatformResult[];
  };
}

// Structured error so routes can branch on HTTP status (e.g. 503 vs 400)
export class ZernioError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name   = "ZernioError";
    this.status = status;
  }
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

// IMPORTANT: never log `err`, `body`, or the full URL here — Zernio error
// responses can echo back request headers which would leak the API key into
// Railway logs. Only the sanitised `safeMessage` is logged / sent to Sentry.
async function zernioFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!API_KEY) {
    throw new ZernioError(
      "ZERNIO_API_KEY is not configured — set it in Railway environment variables",
      500,
    );
  }
  if (!BASE_URL) {
    throw new ZernioError(
      "ZERNIO_BASE_URL is not configured — set it in Railway environment variables",
      500,
    );
  }

  const method = (options.method ?? "GET").toUpperCase();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        ...(options.headers ?? {}),
      },
    });
  } catch (networkErr) {
    // fetch() itself threw — Zernio is unreachable
    const err = new ZernioError("Zernio service is unavailable, please try again later", 503);
    Sentry.captureException(err, { extra: { path, method } });
    throw err;
  }

  if (!res.ok) {
    const safeMessage = `Zernio API error ${res.status} on ${method} ${path}`;
    const err = new ZernioError(safeMessage, res.status >= 500 ? 503 : res.status);
    Sentry.captureException(err, { extra: { path, method, httpStatus: res.status } });
    throw err;
  }

  return res.json() as Promise<T>;
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Create a Zernio profile for an organizer on first connect.
 * Returns the zernio_profile_id to be stored on the users row.
 */
export async function createOrganizerProfile(userId: string): Promise<string> {
  const data = await zernioFetch<{ profile: { _id: string; name: string } }>("/v1/profiles", {
    method: "POST",
    // `name` is an organizational label only (must be unique per team) — it
    // has no functional effect on routing, so a stable per-user label is fine.
    body:   JSON.stringify({ name: `organizer-${userId}` }),
  });
  return data.profile._id;
}

/**
 * Generate the OAuth redirect URL for a given platform.
 *
 * `redirectUrl` — the absolute URL Zernio should send the browser back to once
 *                 the user authorises. Zernio appends its own query params
 *                 (`connected`, `profileId`, `accountId`, `username`) to it.
 *
 * NOTE: Zernio's connect flow has no native `state`/CSRF param — if the caller
 * needs to round-trip a CSRF token, it must be embedded directly in
 * `redirectUrl`'s query string. Zernio's docs describe appending its own
 * params but don't explicitly confirm existing query params on `redirectUrl`
 * survive that — verify with a live OAuth connect test before trusting it.
 */
export async function generateOAuthUrl(
  platform:    string,
  profileId:   string,
  redirectUrl: string,
): Promise<string> {
  const qs = new URLSearchParams({ profileId, redirect_url: redirectUrl }).toString();
  const data = await zernioFetch<{ authUrl: string }>(
    `/v1/connect/${encodeURIComponent(platform)}?${qs}`,
  );
  return data.authUrl;
}

/**
 * Post content to one or more social accounts. The profile is implied by the
 * `accountId`s passed in — Zernio's post endpoint takes no separate profileId.
 *
 * Posting is asynchronous on Zernio's side (status starts as "scheduled" /
 * "publishing"); this returns the initial per-platform status only. A
 * platform entry with status "failed" was rejected immediately (e.g. bad
 * account); anything else was accepted for processing — final delivery
 * confirmation would require polling GET /v1/posts/{id} or a webhook, neither
 * of which this integration currently implements.
 */
export async function postToSocialMedia(
  accounts: Array<{ platform: string; accountId: string }>,
  content:  string,
): Promise<ZernioPostResult> {
  return zernioFetch<ZernioPostResult>("/v1/posts", {
    method: "POST",
    body:   JSON.stringify({
      content,
      platforms: accounts.map((a) => ({
        platform:  a.platform,
        accountId: a.accountId,
      })),
      publishNow: true,
    }),
  });
}

/**
 * Fetch all currently-connected social accounts for a Zernio profile.
 * Called in the OAuth callback to sync Zernio's state into our DB.
 */
export async function listConnectedAccounts(
  profileId: string,
): Promise<ZernioConnectedAccount[]> {
  const qs = new URLSearchParams({ profileId }).toString();
  const data = await zernioFetch<{ accounts: ZernioConnectedAccount[] }>(
    `/v1/accounts?${qs}`,
  );
  return data.accounts ?? [];
}

/**
 * Revoke a single connected account on Zernio's side.
 * Our DB soft-delete (disconnected_at) happens separately in the route.
 */
export async function disconnectAccount(zernioAccountId: string): Promise<void> {
  await zernioFetch<{ success: boolean }>(
    `/v1/accounts/${encodeURIComponent(zernioAccountId)}`,
    { method: "DELETE" },
  );
}
