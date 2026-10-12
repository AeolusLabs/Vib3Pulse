import * as Sentry from "@sentry/node";
import { storage } from "../storage";
import { sanitizeTextOnly } from "../security";
import * as zernioClient from "../zernio";
import { ZernioError } from "../zernio";
import type { SocialPlatform, Event, Venue, VenueEntryNight } from "@shared/schema";

const PROMOTE_COOLDOWN_MINUTES = 2;

// Which thing a post promotes. Exactly one of eventId / venueId is set; venueNightId
// (a specific night) always comes with its venueId.
export interface PromoCols {
  eventId: string | null;
  venueId: string | null;
  venueNightId: string | null;
}

const appUrl = () => (process.env.APP_URL ?? "https://vib3pulse.app").replace(/\/$/, "");
const hashtag = (value: string) => sanitizeTextOnly(value).replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);

function formatWhen(value: Date | string): { date: string; time: string } {
  const d = new Date(value);
  return {
    date: d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  };
}

// Build sanitized post content. All organizer-controlled fields are stripped of HTML
// and capped so injected newlines can't bloat the post.
export function buildPostContent(event: Event): string {
  const title    = sanitizeTextOnly(event.title).slice(0, 100);
  const location = sanitizeTextOnly(event.location).slice(0, 80);
  const { date, time } = formatWhen(event.eventDate);

  return [
    `🎉 Join us at ${title}!`,
    `📅 ${date} @ ${time}`,
    `📍 ${location}`,
    `🎟️ Get tickets: ${appUrl()}/events/${event.id}`,
    `👥 Join community: ${appUrl()}/events/${event.id}/community`,
    `#VybePulse #${hashtag(event.category)}`,
  ].join("\n");
}

export function buildVenueNightContent(night: VenueEntryNight, venue: Venue): string {
  const name  = sanitizeTextOnly(night.name).slice(0, 100);
  const place = sanitizeTextOnly(venue.name).slice(0, 80);
  const where = sanitizeTextOnly(venue.address || venue.location).slice(0, 80);
  const { date, time } = formatWhen(night.date);

  return [
    `🎉 ${name} at ${place}!`,
    `📅 ${date} @ ${time}`,
    `📍 ${where}`,
    `🎟️ Entry & details: ${appUrl()}/venues/${venue.id}`,
    `#VybePulse #${hashtag(venue.category)}`,
  ].join("\n");
}

export function buildVenueContent(venue: Venue): string {
  const name  = sanitizeTextOnly(venue.name).slice(0, 100);
  const where = sanitizeTextOnly(venue.address || venue.location).slice(0, 80);
  const blurb = venue.description ? sanitizeTextOnly(venue.description).replace(/\s+/g, " ").slice(0, 140) : "";

  return [
    `✨ ${name}`,
    ...(blurb ? [blurb] : []),
    `📍 ${where}`,
    `🔗 See what's on: ${appUrl()}/venues/${venue.id}`,
    `#VybePulse #${hashtag(venue.category)}`,
  ].join("\n");
}

export interface SocialPromoteResult {
  postsCreated: number;
  totalCostUsd: number;
  platforms: Array<{ platform: string; success: boolean; error?: string }>;
  failed?: string[];
}

// The single code path that actually posts to Zernio. Only ever called after the
// caller has verified an active plan and consumed a campaign from it
// (server/socialPlanRoutes.ts, server/services/socialCampaigns.ts) — never expose
// a route that reaches this function without that check.
export async function postToSocials(
  target:    { cols: PromoCols; content: string },
  userId:    string,
  platforms: SocialPlatform[],
  // The campaign/send this post belongs to, so a late Zernio failure can find its way back.
  ref:       { campaignId?: string; sendId?: string } = {},
): Promise<SocialPromoteResult> {
  const { cols, content } = target;

  type PlatformResult = { platform: string; success: boolean; error?: string };
  const results: PlatformResult[] = [];
  let postsCreated = 0;
  // Zernio's real API has no per-post cost field (pricing is metered
  // separately) — always 0, kept for response-shape compatibility.
  const totalCostUsd = 0;

  const record = (platform: string, fields: { zernioPostId?: string; status: string; errorMessage?: string }) =>
    storage.insertSocialPost({ ...cols, ...ref, userId, platform, content, costUsd: "0", ...fields });

  // allSettled: one platform's failure does not abort the others
  await Promise.allSettled(
    platforms.map(async (platform: SocialPlatform) => {
      // Idempotency guard: block if already posted successfully within the cooldown window
      const recent = await storage.getRecentSocialPost(cols, platform, PROMOTE_COOLDOWN_MINUTES);
      if (recent) {
        results.push({ platform, success: false, error: "Already posted recently" });
        return;
      }

      const account = await storage.getConnectedSocial(userId, platform);
      if (!account) {
        await record(platform, { status: "failed", errorMessage: `${platform} not connected` });
        results.push({ platform, success: false, error: `${platform} not connected` });
        return;
      }
      if (account.needsReconnect) {
        await record(platform, { status: "failed", errorMessage: `${platform} needs to be reconnected` });
        results.push({ platform, success: false, error: `${platform} needs to be reconnected` });
        return;
      }

      try {
        const { post } = await zernioClient.postToSocialMedia(
          [{ platform, accountId: account.zernioAccountId }],
          content,
        );

        // Posting is async on Zernio's side — a "failed" status here means
        // the platform rejected the post immediately (e.g. bad account);
        // anything else means it was accepted for processing. Final delivery is
        // confirmed later by the Zernio webhook (server/zernioWebhook.ts).
        const platformResult = post.platforms.find((p) => p.platform === platform);
        const failed = platformResult?.status === "failed";

        await record(platform, {
          zernioPostId: post._id,
          status:       failed ? "failed" : "posted",
          errorMessage: failed ? (platformResult?.errorMessage ?? "Posting failed") : undefined,
        });

        if (failed) {
          results.push({ platform, success: false, error: platformResult?.errorMessage ?? "Posting failed" });
        } else {
          postsCreated++;
          results.push({ platform, success: true });
        }
      } catch (err) {
        const errorMessage = err instanceof ZernioError ? err.message : "Posting failed";
        await record(platform, { status: "failed", errorMessage });
        results.push({ platform, success: false, error: errorMessage });
      }
    }),
  );

  const failed = results.filter((r) => !r.success);

  // Nothing published: the caller gives the campaign back to the plan allowance.
  // Still worth a signal — repeated zero-success sends usually mean a dead Zernio
  // token or a platform outage.
  if (postsCreated === 0) {
    Sentry.captureMessage("Social campaign: zero posts succeeded", {
      level: "warning",
      extra: { ...cols, userId, platforms, results },
    });
  }

  return {
    postsCreated,
    totalCostUsd: parseFloat(totalCostUsd.toFixed(2)),
    platforms:    results,
    ...(failed.length > 0 && { failed: failed.map((f) => f.platform) }),
  };
}
