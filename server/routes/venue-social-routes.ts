import type { Express } from "express";
import { z } from "zod";
import { getVenueNightsSocialProof, getVenueReviews } from "../services/venueSocial";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

export function registerVenueSocialRoutes(app: Express): void {
  // Public. Going counts for everyone; "friends going" only appears when the caller is logged in.
  app.get("/api/venues/:venueId/social-proof", async (req, res) => {
    try {
      const nights = await getVenueNightsSocialProof(req.params.venueId, req.user?.id ?? null);
      res.set("Cache-Control", "private, max-age=30");
      res.json({ nights });
    } catch (error) {
      console.error("[VenueSocial] social-proof error:", error);
      res.status(500).json({ message: "Failed to load who's going" });
    }
  });

  // Public. Reviews are written by verified attendees (see rating-routes.ts hasAttendedVenue).
  app.get("/api/venues/:venueId/reviews", async (req, res) => {
    try {
      const page = pageSchema.safeParse(req.query);
      if (!page.success) return res.status(400).json({ message: "Invalid paging parameters" });
      const reviews = await getVenueReviews(req.params.venueId, page.data.limit, page.data.offset);
      res.json({ reviews });
    } catch (error) {
      console.error("[VenueSocial] reviews error:", error);
      res.status(500).json({ message: "Failed to load reviews" });
    }
  });
}
