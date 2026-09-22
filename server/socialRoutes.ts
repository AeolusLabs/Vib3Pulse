import type { Express, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import * as Sentry from "@sentry/node";
import { storage } from "./storage";
import { requireAuth } from "./middleware";
import { logSecurityEvent } from "./security";
import * as zernioClient from "./zernio";
import { ZernioError } from "./zernio";
import { SOCIAL_PLATFORMS } from "@shared/schema";

const PLATFORM_WHITELIST = new Set<string>(SOCIAL_PLATFORMS);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Augment express-session so TypeScript knows about oauthState on req.session.
// TypeScript merges this with the adminId/adminRole augmentation in admin-routes.ts.
declare module "express-session" {
  interface SessionData {
    oauthState?: {
      value:     string;
      platform:  string;
      expiresAt: number; // Unix ms timestamp
    };
  }
}

// ── Helper: get or lazily create the organizer's Zernio profile ID ─────────
async function getOrCreateProfileId(userId: string): Promise<string> {
  const user = await storage.getUser(userId);
  if (!user) throw new ZernioError("User not found", 401);

  const existing = (user as any).zernioProfileId as string | null | undefined;
  if (existing) return existing;

  const profileId = await zernioClient.createOrganizerProfile(userId);
  await storage.setZernioProfileId(userId, profileId);
  return profileId;
}

export function registerSocialRoutes(app: Express): void {

  // ── 1. Initiate OAuth flow ─────────────────────────────────────────────────
  // Called by the frontend with window.open('/api/auth/social/connect?platform=instagram').
  // Redirects the popup to Zernio's OAuth page; Zernio sends it back to /callback.
  app.get("/api/auth/social/connect", requireAuth, async (req: Request, res: Response) => {
    try {
      const platform = (req.query.platform as string | undefined) ?? "";

      if (!PLATFORM_WHITELIST.has(platform)) {
        return res.status(400).json({
          message: `Invalid platform. Supported: ${SOCIAL_PLATFORMS.join(", ")}`,
        });
      }
      if (req.user!.userType !== "organizer") {
        return res.status(403).json({ message: "Only organizers can connect social accounts" });
      }

      const profileId = await getOrCreateProfileId(req.user!.id);

      // Store a one-time state token in the session to prevent OAuth CSRF.
      // The callback must return this exact value or the request is rejected.
      const state = crypto.randomBytes(32).toString("hex");
      req.session.oauthState = {
        value:     state,
        platform,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      };

      const baseUrl = process.env.APP_URL ?? `${req.protocol}://${req.headers.host}`;
      // `state` is embedded directly in the redirect URL's query string since
      // Zernio's connect flow has no native state/CSRF param of its own — see
      // the caveat on generateOAuthUrl.
      const callbackUrl =
        `${baseUrl.replace(/\/$/, "")}/api/auth/social/callback?state=${encodeURIComponent(state)}`;

      const authUrl = await zernioClient.generateOAuthUrl(platform, profileId, callbackUrl);
      res.redirect(authUrl);
    } catch (err) {
      if (err instanceof ZernioError) {
        return res.status(err.status).json({ message: err.message });
      }
      Sentry.captureException(err);
      res.status(500).json({ message: "Failed to start social account connection" });
    }
  });

  // ── 2. OAuth callback ──────────────────────────────────────────────────────
  // Zernio redirects the popup here after the user authorises.
  // Returns a tiny HTML page that posts a message to the parent window and closes.
  // The parent's event listener handles refreshing the connected-accounts list.
  app.get("/api/auth/social/callback", requireAuth, async (req: Request, res: Response) => {
    // Sends the result back to the opener popup then closes it
    const sendResult = (ok: boolean, errorMsg?: string) => {
      const payload = JSON.stringify(
        ok ? { success: true } : { success: false, error: errorMsg },
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // postMessage with explicit origin so the message can't be intercepted
      // by a malicious page that also opened a popup from a different origin.
      res.send(`<!doctype html><html><head><title>Connecting…</title></head><body>
<script>
(function() {
  var result = ${payload};
  try {
    if (window.opener && typeof window.opener.postMessage === 'function') {
      window.opener.postMessage(result, window.location.origin);
    }
  } catch(e) {}
  window.close();
})();
</script>
</body></html>`);
    };

    try {
      const returnedState = req.query.state as string | undefined;
      const saved         = req.session.oauthState;

      if (!returnedState || !saved) {
        logSecurityEvent("suspicious_activity", {
          path:   req.path,
          reason: "oauth_state_missing",
          userId: req.user!.id,
          ip:     req.ip,
        });
        return sendResult(false, "Session expired. Please try connecting again.");
      }
      if (Date.now() > saved.expiresAt) {
        delete req.session.oauthState;
        return sendResult(false, "OAuth session expired. Please try again.");
      }
      if (returnedState !== saved.value) {
        logSecurityEvent("suspicious_activity", {
          path:   req.path,
          reason: "oauth_state_mismatch",
          userId: req.user!.id,
          ip:     req.ip,
        });
        return sendResult(false, "Security check failed. Please try connecting again.");
      }

      // Clear immediately — state tokens are single-use
      delete req.session.oauthState;

      const profileId = await getOrCreateProfileId(req.user!.id);
      const accounts  = await zernioClient.listConnectedAccounts(profileId);

      // Whitelist-filter Zernio's response before writing to DB — defends
      // against unexpected platform names appearing if Zernio adds new ones
      const valid = accounts.filter((a) => PLATFORM_WHITELIST.has(a.platform));

      for (const account of valid) {
        await storage.upsertConnectedSocial({
          userId:          req.user!.id,
          platform:        account.platform,
          zernioAccountId: account._id,
          handle:          account.username ?? null,
        });
      }

      sendResult(true);
    } catch (err) {
      if (err instanceof ZernioError) {
        return sendResult(false, err.message);
      }
      Sentry.captureException(err);
      sendResult(false, "Something went wrong. Please try connecting again.");
    }
  });

  // ── 3. List active connected accounts ─────────────────────────────────────
  app.get("/api/organizer/connected-socials", requireAuth, async (req: Request, res: Response) => {
    try {
      if (req.user!.userType !== "organizer") {
        return res.status(403).json({ message: "Only organizers can manage social accounts" });
      }
      const accounts = await storage.getConnectedSocials(req.user!.id);
      res.json(
        accounts.map((a) => ({
          platform:    a.platform,
          handle:      a.handle,
          connectedAt: a.connectedAt,
        })),
      );
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ message: "Failed to fetch connected accounts" });
    }
  });

  // ── 4. Disconnect a social account ────────────────────────────────────────
  app.post("/api/organizer/disconnect-social", requireAuth, async (req: Request, res: Response) => {
    try {
      if (req.user!.userType !== "organizer") {
        return res.status(403).json({ message: "Only organizers can manage social accounts" });
      }

      const bodySchema = z.object({ platform: z.enum(SOCIAL_PLATFORMS) });
      const parsed     = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid platform" });
      }
      const { platform } = parsed.data;

      // Verify ownership before calling Zernio
      const account = await storage.getConnectedSocial(req.user!.id, platform);
      if (!account) {
        return res.status(404).json({ message: `${platform} is not connected` });
      }

      // Best-effort: revoke on Zernio's side, but don't block on failure.
      // The local soft-delete always proceeds so the organizer's view is consistent.
      try {
        await zernioClient.disconnectAccount(account.zernioAccountId);
      } catch (zernioErr) {
        Sentry.captureException(zernioErr, { extra: { userId: req.user!.id, platform } });
        console.error("[Social] Zernio disconnect failed, proceeding with local disconnect:", zernioErr instanceof Error ? zernioErr.message : zernioErr);
      }

      await storage.disconnectSocial(req.user!.id, platform);
      res.json({ success: true });
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ message: "Failed to disconnect account" });
    }
  });
}
