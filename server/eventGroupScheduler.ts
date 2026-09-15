import cron from "node-cron";
import { storage } from "./storage.js";

export function startEventGroupDissolveJob(): void {
  // Every hour: dissolve event group chats whose linked event ended >7 days ago.
  cron.schedule("0 * * * *", async () => {
    try {
      const ids = await storage.getDissolvableEventGroupConversationIds();
      for (const id of ids) {
        await storage.deleteConversation(id);
      }
      if (ids.length > 0) {
        console.log(`[EventGroupScheduler] Dissolved ${ids.length} event group chat(s)`);
      }
    } catch (err: any) {
      console.error("[EventGroupScheduler] Error running dissolve job:", err.message);
    }
  });

  console.log("[EventGroupScheduler] Event group dissolve job started (hourly)");
}
