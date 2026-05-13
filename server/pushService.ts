import webpush from "web-push";
import { storage } from "./storage.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@vibepulse.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  tag?: string;
}

export async function sendPushNotification(userId: string, payload: PushPayload): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = await storage.getPushSubscriptionsByUserId(userId);
  if (subscriptions.length === 0) return;

  const data = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || "/pwa-icon-192.png",
    badge: payload.badge || "/favicon.png",
    url: payload.url || "/",
    tag: payload.tag,
  });

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
          },
          data
        );
      } catch (err: unknown) {
        // 410 Gone = subscription expired; remove it
        if (err && typeof err === "object" && "statusCode" in err && err.statusCode === 410) {
          await storage.deletePushSubscription(sub.endpoint);
        }
      }
    })
  );
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}
