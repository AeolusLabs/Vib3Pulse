import * as Sentry from "@sentry/node";

// Read once at module load — never read from process.env inside a request
// handler so the key is never accidentally captured in a closure that gets logged.
const BASE_URL = (process.env.ZERNIO_BASE_URL ?? "").replace(/\/$/, "");
const API_KEY  = process.env.ZERNIO_API_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ZernioConnectedAccount {
  platform:   string;
  username:   string;
  account_id: string;
}

export interface ZernioPostResult {
  post_id:  string;
  cost_usd: number;
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
  const data = await zernioFetch<{ profile_id: string }>("/v1/profiles", {
    method: "POST",
    body:   JSON.stringify({ external_id: userId }),
  });
  return data.profile_id;
}

/**
 * Generate the OAuth redirect URL for a given platform.
 *
 * `state`       — opaque token stored in the session; Zernio passes it back in
 *                 the callback so we can verify it and prevent OAuth CSRF.
 * `callbackUrl` — the absolute URL Zernio should redirect to after the user
 *                 authorises (e.g. https://vib3pulse.app/api/auth/social/callback).
 */
export async function generateOAuthUrl(
  platform:    string,
  profileId:   string,
  state:       string,
  callbackUrl: string,
): Promise<string> {
  const data = await zernioFetch<{ auth_url: string }>(
    `/v1/profiles/${encodeURIComponent(profileId)}/oauth/url`,
    {
      method: "POST",
      body:   JSON.stringify({ platform, state, redirect_uri: callbackUrl }),
    },
  );
  return data.auth_url;
}

/**
 * Post content to one or more social accounts.
 * Returns Zernio's post ID and the cost they charged for this operation.
 *
 * Called once per platform in Promise.allSettled so a single platform
 * failure does not abort the others.
 */
export async function postToSocialMedia(
  profileId: string,
  accounts:  Array<{ platform: string; accountId: string }>,
  content:   string,
): Promise<ZernioPostResult> {
  return zernioFetch<ZernioPostResult>("/v1/posts", {
    method: "POST",
    body:   JSON.stringify({
      profile_id: profileId,
      accounts:   accounts.map((a) => ({
        platform:   a.platform,
        account_id: a.accountId,
      })),
      content,
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
  const data = await zernioFetch<{ accounts: ZernioConnectedAccount[] }>(
    `/v1/profiles/${encodeURIComponent(profileId)}/accounts`,
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
