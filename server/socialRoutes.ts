import type { Express, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import * as Sentry from "@sentry/node";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import { storage } from "./storage";
import { requireAuth } from "./middleware";
import { sanitizeTextOnly, logSecurityEvent } from "./security";
import * as zernioClient from "./zernio";
import { ZernioError } from "./zernio";
import { SOCIAL_PLATFORMS, type SocialPlatform, type Event } from "@shared/schema";

// Promote is money-per-call — key per user (not IP) so shared NAT can't
// burn another organizer's quota, and 20/h is permissive enough for real use.
const promoteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user as any)?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: {
    message: "Too many promote requests. Please try again in an hour.",
    code: "RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const PLATFORM_WHITELIST = new Set<string>(SOCIAL_PLATFORMS);
const PROMOTE_COOLDOWN_MINUTES = 2;
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

// Build sanitized post content from event data. All organizer-controlled fields
// are stripped of HTML and capped so injected newlines can't bloat the post.
function buildPostContent(event: Event): string {
  const appUrl   = (process.env.APP_URL ?? "https://vib3pulse.app").replace(/\/$/, "");
  const title    = sanitizeTextOnly(event.title).slice(0, 100);
  const location = sanitizeTextOnly(event.location).slice(0, 80);
  // Strip spaces so the hashtag is one token; strip special chars to keep it clean
  const category = sanitizeTextOnly(event.category)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 30);

  const d    = new Date(event.eventDate);
  const date = d.toLocaleDateString("en-GB", {
    weekday: "long",
    day:     "numeric",
    month:   "long",
    year:    "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return [
    `🎉 Join us at ${title}!`,
    `📅 ${date} @ ${time}`,
    `📍 ${location}`,
    `🎟️ Get tickets: ${appUrl}/events/${event.id}`,
    `👥 Join community: ${appUrl}/events/${event.id}/community`,
    `#VybePulse #${category}`,
  ].join("\n");
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

      const baseUrl     = process.env.APP_URL ?? `${req.protocol}://${req.headers.host}`;
      const callbackUrl = `${baseUrl.replace(/\/$/, "")}/api/auth/social/callback`;

      const authUrl = await zernioClient.generateOAuthUrl(platform, profileId, state, callbackUrl);
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
          zernioAccountId: account.account_id,
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

  // ── 3. Promote event to social media ──────────────────────────────────────
  app.post(
    "/api/events/:id/promote",
    requireAuth,
    promoteRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const eventId = req.params.id;

        const bodySchema = z.object({
          platforms: z
            .array(z.enum(SOCIAL_PLATFORMS))
            .min(1, "Select at least one platform")
            .max(SOCIAL_PLATFORMS.length),
        });
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ message: parsed.error.errors[0].message });
        }
        const { platforms } = parsed.data;

        const event = await storage.getEvent(eventId);
        if (!event)                                    return res.status(404).json({ message: "Event not found" });
        if (event.organizerId !== req.user!.id)        return res.status(403).json({ message: "You do not own this event" });
        if (event.moderationStatus !== "approved")     return res.status(403).json({ message: "Event must be approved before it can be promoted" });

        const profileId = await getOrCreateProfileId(req.user!.id);
        const content   = buildPostContent(event);

        type PlatformResult = { platform: string; success: boolean; error?: string };
        const results: PlatformResult[] = [];
        let postsCreated = 0;
        let totalCostUsd = 0;

        // allSettled: one platform's failure does not abort the others
        await Promise.allSettled(
          platforms.map(async (platform: SocialPlatform) => {
            // Idempotency guard: block if already posted successfully within the cooldown window
            const recent = await storage.getRecentSocialPost(eventId, platform, PROMOTE_COOLDOWN_MINUTES);
            if (recent) {
              results.push({ platform, success: false, error: "Already posted recently" });
              return;
            }

            const account = await storage.getConnectedSocial(req.user!.id, platform);
            if (!account) {
              await storage.insertSocialPost({
                eventId,
                userId:       req.user!.id,
                platform,
                content,
                status:       "failed",
                errorMessage: `${platform} not connected`,
                costUsd:      "0",
              });
              results.push({ platform, success: false, error: `${platform} not connected` });
              return;
            }

            try {
              const { postId, costUsd } = await zernioClient.postToSocialMedia(
                profileId,
                [{ platform, accountId: account.zernioAccountId }],
                content,
              );

              await storage.insertSocialPost({
                eventId,
                userId:       req.user!.id,
                platform,
                zernioPostId: postId,
                content,
                status:       "posted",
                costUsd:      costUsd.toFixed(2),
              });

              postsCreated++;
              totalCostUsd += costUsd;
              results.push({ platform, success: true });
            } catch (err) {
              const errorMessage =
                err instanceof ZernioError ? err.message : "Posting failed";

              await storage.insertSocialPost({
                eventId,
                userId:       req.user!.id,
                platform,
                content,
                status:       "failed",
                errorMessage,
                costUsd:      "0",
              });
              results.push({ platform, success: false, error: errorMessage });
            }
          }),
        );

        const failed = results.filter((r) => !r.success);
        res.json({
          postsCreated,
          totalCostUsd:  parseFloat(totalCostUsd.toFixed(2)),
          platforms:     results,
          ...(failed.length > 0 && { failed: failed.map((f) => f.platform) }),
        });
      } catch (err) {
        if (err instanceof ZernioError) {
          return res.status(err.status).json({ message: err.message });
        }
        Sentry.captureException(err);
        res.status(500).json({ message: "Failed to promote event" });
      }
    },
  );

  // ── 4. List active connected accounts ─────────────────────────────────────
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

  // ── 5. Disconnect a social account ────────────────────────────────────────
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
