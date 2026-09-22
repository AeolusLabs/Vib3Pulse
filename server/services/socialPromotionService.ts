import * as Sentry from "@sentry/node";
import { storage } from "../storage";
import { sanitizeTextOnly } from "../security";
import * as zernioClient from "../zernio";
import { ZernioError } from "../zernio";
import type { SocialPlatform, Event } from "@shared/schema";

const PROMOTE_COOLDOWN_MINUTES = 2;

// Build sanitized post content from event data. All organizer-controlled fields
// are stripped of HTML and capped so injected newlines can't bloat the post.
export function buildPostContent(event: Event): string {
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

export interface SocialPromoteResult {
  postsCreated: number;
  totalCostUsd: number;
  platforms: Array<{ platform: string; success: boolean; error?: string }>;
  failed?: string[];
}

// The single code path that actually posts to Zernio. Only ever called after
// payment has been verified (server/payment-routes.ts) — never expose an
// unpaid route that reaches this function.
export async function postEventToSocials(
  event:     Event,
  userId:    string,
  platforms: SocialPlatform[],
): Promise<SocialPromoteResult> {
  const content = buildPostContent(event);

  type PlatformResult = { platform: string; success: boolean; error?: string };
  const results: PlatformResult[] = [];
  let postsCreated = 0;
  // Zernio's real API has no per-post cost field (pricing is metered
  // separately) — always 0, kept for response-shape compatibility.
  const totalCostUsd = 0;

  // allSettled: one platform's failure does not abort the others
  await Promise.allSettled(
    platforms.map(async (platform: SocialPlatform) => {
      // Idempotency guard: block if already posted successfully within the cooldown window
      const recent = await storage.getRecentSocialPost(event.id, platform, PROMOTE_COOLDOWN_MINUTES);
      if (recent) {
        results.push({ platform, success: false, error: "Already posted recently" });
        return;
      }

      const account = await storage.getConnectedSocial(userId, platform);
      if (!account) {
        await storage.insertSocialPost({
          eventId: event.id,
          userId,
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
        const { post } = await zernioClient.postToSocialMedia(
          [{ platform, accountId: account.zernioAccountId }],
          content,
        );

        // Posting is async on Zernio's side — a "failed" status here means
        // the platform rejected the post immediately (e.g. bad account);
        // anything else means it was accepted for processing.
        const platformResult = post.platforms.find((p) => p.platform === platform);
        const failed = platformResult?.status === "failed";

        await storage.insertSocialPost({
          eventId: event.id,
          userId,
          platform,
          zernioPostId: post._id,
          content,
          status:       failed ? "failed" : "posted",
          errorMessage: failed ? (platformResult?.errorMessage ?? "Posting failed") : undefined,
          costUsd:      "0",
        });

        if (failed) {
          results.push({
            platform,
            success: false,
            error: platformResult?.errorMessage ?? "Posting failed",
          });
        } else {
          postsCreated++;
          results.push({ platform, success: true });
        }
      } catch (err) {
        const errorMessage =
          err instanceof ZernioError ? err.message : "Posting failed";

        await storage.insertSocialPost({
          eventId: event.id,
          userId,
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

  // Paid confirmation with zero successful posts means the organizer was
  // charged but got nothing — no automated refund exists anywhere in this
  // codebase, so surface it for manual follow-up rather than going silent.
  if (postsCreated === 0) {
    Sentry.captureMessage("Social promotion charged but zero posts succeeded", {
      level: "warning",
      extra: { eventId: event.id, userId, platforms, results },
    });
  }

  return {
    postsCreated,
    totalCostUsd: parseFloat(totalCostUsd.toFixed(2)),
    platforms:    results,
    ...(failed.length > 0 && { failed: failed.map((f) => f.platform) }),
  };
}
