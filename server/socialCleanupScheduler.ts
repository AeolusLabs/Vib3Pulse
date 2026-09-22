import cron from "node-cron";
import { storage } from "./storage.js";
import * as zernioClient from "./zernio.js";

const STALE_DAYS = 60;

// Releases connected social accounts that have gone STALE_DAYS with no
// successful blast — each one costs Zernio's per-connected-account fee
// regardless of use, so an idle connection is a pure recurring liability.
// Exported separately from the cron wrapper so it can be invoked directly
// (e.g. via a one-off script) without waiting for the scheduled time.
export async function runSocialCleanup(): Promise<number> {
  const stale = await storage.getStaleConnectedSocials(STALE_DAYS);
  for (const conn of stale) {
    try {
      await zernioClient.disconnectAccount(conn.zernioAccountId);
    } catch (err) {
      console.error(
        `[SocialCleanup] Zernio disconnect failed for ${conn.userId}/${conn.platform}, proceeding with local disconnect:`,
        err instanceof Error ? err.message : err,
      );
    }
    await storage.disconnectSocial(conn.userId, conn.platform);
  }
  return stale.length;
}

export function startSocialCleanupScheduler(): void {
  // Daily at 03:00 — off-peak, low chance of racing an in-flight promote
  cron.schedule("0 3 * * *", async () => {
    try {
      const count = await runSocialCleanup();
      if (count > 0) {
        console.log(`[SocialCleanup] Auto-disconnected ${count} idle social account(s)`);
      }
    } catch (err: any) {
      console.error("[SocialCleanup] Error running cleanup job:", err.message);
    }
  });

  console.log("[SocialCleanup] Stale social connection cleanup job started (daily 03:00)");
}
