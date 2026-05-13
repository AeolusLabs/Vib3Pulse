import cron from "node-cron";
import { expirePendingBuddies } from "./buddyService.js";

export function startBuddyScheduler(): void {
  // Every hour: find pending buddy invitations older than 48 hours and mark them expired
  cron.schedule("0 * * * *", async () => {
    try {
      const count = await expirePendingBuddies();
      if (count > 0) {
        console.log(`[BuddyScheduler] Expired ${count} pending invitation(s)`);
      }
    } catch (err: any) {
      console.error("[BuddyScheduler] Error running expiry job:", err.message);
    }
  });

  console.log("[BuddyScheduler] Buddy expiry job started (hourly)");
}
