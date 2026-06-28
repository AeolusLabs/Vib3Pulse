import { storage } from "./storage";
import { wsManager } from "./websocket";
import { sendPushNotification } from "./pushService";

export async function deliverNotification(params: {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  relatedUserId?: string;
  relatedEntityId?: string;
}): Promise<void> {
  await storage.createNotification(params as Parameters<typeof storage.createNotification>[0]);
  wsManager.sendToUser(params.userId, { type: "notification", data: { type: params.type } });
  sendPushNotification(params.userId, {
    title: params.title,
    body: params.message,
    url: params.link,
    tag: params.type,
  }).catch(() => {});
}