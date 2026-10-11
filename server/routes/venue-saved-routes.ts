import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth } from "../middleware";

export function registerVenueSavedRoutes(app: Express): void {
  // Current user's saved venues, most recently saved first
  app.get("/api/saved-venues", requireAuth, async (req, res) => {
    try {
      res.json(await storage.getSavedVenues(req.user!.id));
    } catch (error) {
      console.error("Get saved venues error:", error);
      res.status(500).json({ message: "Failed to get saved venues" });
    }
  });

  app.get("/api/venues/:id/saved", requireAuth, async (req, res) => {
    try {
      res.json({ saved: await storage.isVenueSaved(req.user!.id, req.params.id) });
    } catch (error) {
      console.error("Get venue saved error:", error);
      res.status(500).json({ message: "Failed to check saved venue" });
    }
  });

  // Idempotent
  app.put("/api/venues/:id/save", requireAuth, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      await storage.saveVenue(req.user!.id, venue.id);
      res.json({ saved: true });
    } catch (error) {
      console.error("Save venue error:", error);
      res.status(500).json({ message: "Failed to save venue" });
    }
  });

  // Idempotent
  app.delete("/api/venues/:id/save", requireAuth, async (req, res) => {
    try {
      const venue = await storage.getVenue(req.params.id);
      if (!venue) return res.status(404).json({ message: "Venue not found" });
      await storage.unsaveVenue(req.user!.id, venue.id);
      res.json({ saved: false });
    } catch (error) {
      console.error("Unsave venue error:", error);
      res.status(500).json({ message: "Failed to unsave venue" });
    }
  });
}
