import type { Express } from "express";
import { and, eq, or } from "drizzle-orm";
import { db } from "../storage";
import { requireAuth } from "../middleware";
import { userBlocks, follows, mapAllowedViewers, users } from "@shared/schema";

export function registerBlockRoutes(app: Express): void {
  // People the current user has blocked (never the reverse: who blocked you is not disclosed).
  app.get("/api/blocks", requireAuth, async (req, res) => {
    try {
      const rows = await db.select({
        id: users.id, username: users.username, displayName: users.displayName,
        organizationName: users.organizationName, avatarUrl: users.avatarUrl,
      }).from(userBlocks).innerJoin(users, eq(users.id, userBlocks.blockedId))
        .where(eq(userBlocks.blockerId, req.user!.id));
      res.json({ blocked: rows });
    } catch (error) {
      console.error("List blocks error:", error);
      res.status(500).json({ message: "Failed to load blocked users" });
    }
  });

  // Idempotent. Also cuts the follow relationship and map visibility both ways.
  app.put("/api/blocks/:userId", requireAuth, async (req, res) => {
    try {
      const me = req.user!.id;
      const target = req.params.userId;
      if (target === me) return res.status(400).json({ message: "You can't block yourself" });
      const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, target)).limit(1);
      if (!exists) return res.status(404).json({ message: "User not found" });

      await db.transaction(async (tx) => {
        await tx.insert(userBlocks).values({ blockerId: me, blockedId: target }).onConflictDoNothing();
        await tx.delete(follows).where(or(
          and(eq(follows.followerId, me), eq(follows.followingId, target)),
          and(eq(follows.followerId, target), eq(follows.followingId, me)),
        ));
        await tx.delete(mapAllowedViewers).where(or(
          and(eq(mapAllowedViewers.userId, me), eq(mapAllowedViewers.viewerId, target)),
          and(eq(mapAllowedViewers.userId, target), eq(mapAllowedViewers.viewerId, me)),
        ));
      });
      res.json({ blocked: true });
    } catch (error) {
      console.error("Block error:", error);
      res.status(500).json({ message: "Failed to block user" });
    }
  });

  app.delete("/api/blocks/:userId", requireAuth, async (req, res) => {
    try {
      await db.delete(userBlocks).where(and(eq(userBlocks.blockerId, req.user!.id), eq(userBlocks.blockedId, req.params.userId)));
      res.json({ blocked: false });
    } catch (error) {
      console.error("Unblock error:", error);
      res.status(500).json({ message: "Failed to unblock user" });
    }
  });
}
