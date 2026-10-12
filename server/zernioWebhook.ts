import type { Express } from "express";
import crypto from "crypto";
import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { db } from "./storage";
import { reconcileLateFailures } from "./services/socialCampaigns";

// Zernio -> us. Posting is asynchronous on Zernio's side: our own "posted" status only
// means Zernio accepted the post. These events say what really happened.
//
// Register the endpoint once with scripts/register-zernio-webhook.mjs. Docs:
// https://docs.zernio.com/webhooks  (HMAC-SHA256 hex of the raw body in X-Zernio-Signature,
// X-Zernio-Event-Id is the dedupe key, delivery is at-least-once, reply 2xx within 5s).

export const ZERNIO_WEBHOOK_EVENTS = ["post.published", "post.failed", "account.disconnected"] as const;

export function verifyZernioSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signature.trim().toLowerCase().replace(/^sha256=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const asText = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v;
  const msg = (v as { message?: unknown }).message;
  return typeof msg === "string" ? msg : JSON.stringify(v).slice(0, 300);
};

// Idempotent: Zernio can deliver the same event twice, and every update below is guarded by
// the row's current status, so a repeat changes nothing.
export async function handleZernioEvent(payload: any): Promise<void> {
  const post = payload?.post;
  const postId: string | undefined = post?.id ?? post?._id;
  const firstPlatform = post?.platforms?.[0];

  switch (payload?.event) {
    case "post.published": {
      if (!postId) return;
      const url: string | null = firstPlatform?.publishedUrl ?? payload?.platform?.publishedUrl ?? null;
      await db.execute(sql`
        UPDATE social_posts SET confirmed_at = now(), platform_post_url = ${url}
        WHERE zernio_post_id = ${postId} AND status = 'posted' AND confirmed_at IS NULL
      `);
      return;
    }
    case "post.failed": {
      if (!postId) return;
      const why = asText(firstPlatform?.error) ?? asText(post?.error) ?? "The platform rejected the post";
      const failed = await db.execute(sql`
        UPDATE social_posts SET status = 'failed', error_message = ${why}
        WHERE zernio_post_id = ${postId} AND status = 'posted'
        RETURNING campaign_id, send_id
      `);
      // Zernio accepted this post earlier and counted it toward a "sent" campaign. Now that it
      // really failed, fix the send's status and give the campaign back if nothing is left standing.
      await reconcileLateFailures(failed.rows as Array<{ campaign_id: string | null; send_id: string | null }>);
      return;
    }
    case "account.disconnected": {
      // "intentional" = removed through our own API call, which we already recorded.
      if (payload?.disconnectionType === "intentional") return;
      const accountId: string | undefined = payload?.account?.id ?? payload?.account?._id ?? payload?.account?.accountId;
      if (!accountId) return;
      await db.execute(sql`
        UPDATE connected_socials SET needs_reconnect = true
        WHERE zernio_account_id = ${accountId} AND disconnected_at IS NULL
      `);
      return;
    }
    default:
      return; // account.connected, post.scheduled, ... — nothing for us to do
  }
}

export function registerZernioWebhook(app: Express): void {
  app.post("/api/webhooks/zernio", async (req, res) => {
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;
    if (!secret) {
      // Never accept unsigned input: without a secret there is nothing to verify against.
      console.error("[Zernio Webhook] ZERNIO_WEBHOOK_SECRET is not set; rejecting delivery");
      return res.status(503).json({ message: "Webhook not configured" });
    }
    const raw = (req as any).rawBody as Buffer | undefined;
    const sig = req.headers["x-zernio-signature"] as string | undefined;
    if (!raw || !verifyZernioSignature(raw, sig, secret)) {
      console.error("[Zernio Webhook] Signature verification failed");
      return res.status(400).json({ message: "Invalid signature" });
    }

    const payload = req.body ?? {};
    const eventId = (req.headers["x-zernio-event-id"] as string | undefined) ?? payload.id;
    if (!eventId || typeof eventId !== "string") return res.status(400).json({ message: "Missing event id" });

    try {
      const seen = await db.execute(sql`SELECT 1 FROM zernio_webhook_events WHERE event_id = ${eventId}`);
      if (seen.rows.length > 0) return res.json({ received: true, duplicate: true });

      if (!payload.test) await handleZernioEvent(payload);

      await db.execute(sql`
        INSERT INTO zernio_webhook_events (event_id, event_type) VALUES (${eventId}, ${String(payload.event ?? "unknown")})
        ON CONFLICT (event_id) DO NOTHING
      `);
      res.json({ received: true });
    } catch (err) {
      Sentry.captureException(err);
      console.error("[Zernio Webhook] Processing error:", err instanceof Error ? err.message : err);
      // 500 → Zernio retries, and the handlers are idempotent.
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });
}
