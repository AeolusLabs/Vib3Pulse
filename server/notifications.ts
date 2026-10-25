import { storage } from "./storage";
import { wsManager } from "./websocket";
import { sendPushNotification } from "./pushService";
import type { NotificationType } from "@shared/schema";

export async function deliverNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  relatedUserId?: string;
  relatedEntityId?: string;
  /** What a push shows on a lock screen when it must differ from the in-app text. */
  push?: { title: string; body: string };
}): Promise<void> {
  const { push, ...stored } = params;
  await storage.createNotification(stored as Parameters<typeof storage.createNotification>[0]);
  wsManager.sendToUser(params.userId, { type: "notification", data: { type: params.type } });
  sendPushNotification(params.userId, {
    title: push?.title ?? params.title,
    body: push?.body ?? params.message,
    url: params.link,
    tag: params.type,
  }).catch(() => {});
}