import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerSafetyRoutes, startSafetyTimerJob } from "./safety-routes";
import { registerPaymentRoutes } from "./payment-routes";
import { registerOrganizerPaymentsRoutes } from "./organizer-payments-routes";
import { buddyRouter } from "./buddyRoutes";
import { registerRatingRoutes } from "./rating-routes";
import { registerSocialRoutes } from "./socialRoutes";
import { startBuddyScheduler } from "./buddyScheduler";
import { startEventGroupDissolveJob } from "./eventGroupScheduler";
import { startSocialCleanupScheduler } from "./socialCleanupScheduler";
import { registerMessagesRoutes } from "./routes/messages-routes";
import { registerVenueRoutes } from "./routes/venue-routes";
import { registerEventsRoutes } from "./routes/events-routes";
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
  registerEventsRoutes(app);
  registerNewSocialRoutes(app);
  registerNotificationRoutes(app);
  registerCommunityRoutes(app);
  registerSafetyRoutes(app);
  registerPaymentRoutes(app);
  registerOrganizerPaymentsRoutes(app);
  app.use("/api/safety", buddyRouter);
  registerRatingRoutes(app);
  registerSocialRoutes(app);

  startSafetyTimerJob();
  startBuddyScheduler();
  startEventGroupDissolveJob();
  startSocialCleanupScheduler();

  return httpServer;
}