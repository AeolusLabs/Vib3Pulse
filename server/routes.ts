import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerSafetyRoutes, startSafetyTimerJob } from "./safety-routes";
import { registerPaymentRoutes } from "./payment-routes";
import { registerOrganizerPaymentsRoutes } from "./organizer-payments-routes";
import { buddyRouter } from "./buddyRoutes";
import { registerRatingRoutes } from "./rating-routes";
import { registerSocialRoutes } from "./socialRoutes";
import { registerSocialPlanRoutes } from "./socialPlanRoutes";
import { registerZernioWebhook } from "./zernioWebhook";
import { startBuddyScheduler } from "./buddyScheduler";
import { startEventGroupDissolveJob } from "./eventGroupScheduler";
import { startSocialCleanupScheduler } from "./socialCleanupScheduler";
import { startSocialCampaignScheduler } from "./socialCampaignScheduler";
import { registerMessagesRoutes } from "./routes/messages-routes";
import { registerVenueRoutes } from "./routes/venue-routes";
import { registerVenueSavedRoutes } from "./routes/venue-saved-routes";
import { registerMapRoutes } from "./routes/map-routes";
import { registerRoomRoutes } from "./rooms/roomRoutes";
import { registerBlockRoutes } from "./routes/block-routes";
import { registerVenueSocialRoutes } from "./routes/venue-social-routes";
import { registerDoorRoutes } from "./routes/door-routes";
import { registerEventsRoutes } from "./routes/events-routes";
import { registerSocialEventGate, registerSocialEventRoutes, registerGuestDataExportBlock } from "./routes/social-events-routes";
import { startGuestRetentionJob } from "./services/guestPrivacy";
import { registerPhoneRoutes } from "./routes/phone-routes";
import { startModerationSlaJob } from "./services/moderationJobs";
import { startRevealExpiryJob } from "./services/revealGrants";
import { registerSocialRoutes as registerNewSocialRoutes } from "./routes/social-routes";
import { registerUsersRoutes } from "./routes/users-routes";
import { registerNotificationRoutes } from "./routes/notification-routes";
import { registerMediaRoutes } from "./routes/media-routes";
import { registerCommunityRoutes } from "./routes/community-routes";
import { registerOgRoutes } from "./og-routes";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Crawler-only server-rendered OG tags for /posts/:id — must be registered
  // before the SPA catch-all (wired up later in server/index.ts) so it can
  // intercept known link-unfurling user-agents; real browsers fall through.
  registerOgRoutes(app);

  registerUsersRoutes(app);
  registerMessagesRoutes(app);
  registerMediaRoutes(app);
  registerVenueRoutes(app);
  registerVenueSavedRoutes(app);
  registerMapRoutes(app);
  registerRoomRoutes(app);
  registerBlockRoutes(app);
  registerVenueSocialRoutes(app);
  // Gate first: social events must 404 on the generic /api/events/:id/* routes below.
  registerGuestDataExportBlock(app);
  registerSocialEventGate(app);
  // Before the generic events routes so /api/tickets/undo-check-in is never shadowed.
  registerDoorRoutes(app);
  registerEventsRoutes(app);
  registerSocialEventRoutes(app);
  registerPhoneRoutes(app);
  registerNewSocialRoutes(app);
  registerNotificationRoutes(app);
  registerCommunityRoutes(app);
  registerSafetyRoutes(app);
  registerPaymentRoutes(app);
  registerOrganizerPaymentsRoutes(app);
  app.use("/api/safety", buddyRouter);
  registerRatingRoutes(app);
  registerSocialRoutes(app);
  registerSocialPlanRoutes(app);
  registerZernioWebhook(app);

  startSafetyTimerJob();
  startBuddyScheduler();
  startEventGroupDissolveJob();
  startSocialCleanupScheduler();
  startSocialCampaignScheduler();
  startModerationSlaJob();
  startRevealExpiryJob();
  startGuestRetentionJob();

  return httpServer;
}