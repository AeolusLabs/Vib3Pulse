import cron from "node-cron";
import * as Sentry from "@sentry/node";
import {
  disconnectLapsedAccounts,
  failStuckSends,
  runDueSends,
  sendExpiryReminders,
  sendLegacyConnectionNotices,
} from "./services/socialCampaigns";

// Every minute: post whatever is due. Safe to run on several instances at once
// (sends are claimed with FOR UPDATE SKIP LOCKED). A tick that's still running when
// the next one fires is skipped rather than overlapped.
let sending = false;

export function startSocialCampaignScheduler(): void {
  cron.schedule("* * * * *", async () => {
    if (sending) return;
    sending = true;
    try {
      const stuck = await failStuckSends();
      if (stuck > 0) console.warn(`[SocialCampaign] Marked ${stuck} interrupted send(s) as failed`);
      const ran = await runDueSends();
      if (ran > 0) console.log(`[SocialCampaign] Ran ${ran} scheduled send(s)`);
    } catch (err) {
      Sentry.captureException(err);
      console.error("[SocialCampaign] Scheduler error:", err instanceof Error ? err.message : err);
    } finally {
      sending = false;
    }
  });

  // Hourly: plan expiry reminders and disconnecting accounts whose plan lapsed.
  cron.schedule("17 * * * *", async () => {
    try {
      const reminded = await sendExpiryReminders();
      const noticed = await sendLegacyConnectionNotices();
      const disconnected = await disconnectLapsedAccounts();
      if (noticed > 0) console.log(`[SocialLifecycle] Sent ${noticed} social plans notice(s)`);
      if (reminded > 0) console.log(`[SocialLifecycle] Sent ${reminded} plan expiry reminder(s)`);
      if (disconnected > 0) console.log(`[SocialLifecycle] Disconnected ${disconnected} lapsed account(s)`);
    } catch (err) {
      Sentry.captureException(err);
      console.error("[SocialLifecycle] Error:", err instanceof Error ? err.message : err);
    }
  });

  console.log("[SocialCampaign] Scheduler started (sends every minute, plan lifecycle hourly)");
}
