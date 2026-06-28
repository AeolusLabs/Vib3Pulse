import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth } from "../middleware";
import { sanitizeTextOnly } from "../security";

export function registerCommunityRoutes(app: Express): void {
  app.get("/api/communities", async (req, res) => {
    try {
      const communities = await storage.getCommunities();
      res.json(communities);
    } catch (error) {
      console.error("Error fetching communities:", error);
      res.status(500).json({ message: "Failed to fetch communities" });
    }
  });

  // Get user's communities (communities they are a member of)
  app.get("/api/communities/my", requireAuth, async (req, res) => {
    try {
      const communities = await storage.getUserCommunities(req.user!.id);
      res.json(communities);
    } catch (error) {
      console.error("Error fetching user communities:", error);
      res.status(500).json({ message: "Failed to fetch user communities" });
    }
  });

  // Get a specific community
  app.get("/api/communities/:id", async (req, res) => {
    try {
      const community = await storage.getCommunityWithDetails(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      res.json(community);
    } catch (error) {
      console.error("Error fetching community:", error);
      res.status(500).json({ message: "Failed to fetch community" });
    }
  });

  // Create a new community
  app.post("/api/communities", requireAuth, async (req, res) => {
    try {
      const { name, description, coverImageUrl } = req.body;

      if (!name || name.trim().length === 0) {
        return res.status(400).json({ message: "Community name is required" });
      }

      // Generate slug from name
      const slug = name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);

      // Check if slug already exists
      const existingCommunity = await storage.getCommunityBySlug(slug);
      if (existingCommunity) {
        return res.status(400).json({ message: "A community with a similar name already exists" });
      }

      const community = await storage.createCommunity({
        name: sanitizeTextOnly(name.trim()),
        slug,
        description: description ? sanitizeTextOnly(description) : null,
        coverImageUrl: coverImageUrl || null,
        createdByUserId: req.user!.id,
      });

      // Auto-join the creator as owner
      await storage.joinCommunity(req.user!.id, community.id, "owner");

      res.status(201).json(community);
    } catch (error) {
      console.error("Error creating community:", error);
      res.status(500).json({ message: "Failed to create community" });
    }
  });

  // Update a community
  app.put("/api/communities/:id", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership || membership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can update this community" });
      }

      const { name, description, coverImageUrl } = req.body;
      const updates: any = {};

      if (name) updates.name = sanitizeTextOnly(name.trim());
      if (description !== undefined) updates.description = description ? sanitizeTextOnly(description) : null;
      if (coverImageUrl !== undefined) updates.coverImageUrl = coverImageUrl;

      const updatedCommunity = await storage.updateCommunity(req.params.id, updates);
      res.json(updatedCommunity);
    } catch (error) {
      console.error("Error updating community:", error);
      res.status(500).json({ message: "Failed to update community" });
    }
  });

  // Delete a community
  app.delete("/api/communities/:id", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership || membership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can delete this community" });
      }

      await storage.deleteCommunity(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting community:", error);
      res.status(500).json({ message: "Failed to delete community" });
    }
  });

  // Join a community
  app.post("/api/communities/:id/join", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if already a member
      const isMember = await storage.isCommunityMember(req.user!.id, req.params.id);
      if (isMember) {
        return res.status(400).json({ message: "Already a member of this community" });
      }

      const membership = await storage.joinCommunity(req.user!.id, req.params.id);
      res.status(201).json(membership);
    } catch (error) {
      console.error("Error joining community:", error);
      res.status(500).json({ message: "Failed to join community" });
    }
  });

  // Leave a community
  app.delete("/api/communities/:id/leave", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      // Check if user is the owner
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (membership?.role === "owner") {
        return res.status(400).json({ message: "Owner cannot leave the community. Transfer ownership or delete the community." });
      }

      await storage.leaveCommunity(req.user!.id, req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error leaving community:", error);
      res.status(500).json({ message: "Failed to leave community" });
    }
  });

  // Get community members
  app.get("/api/communities/:id/members", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const members = await storage.getCommunityMembers(req.params.id, limit, offset);
      res.json(members);
    } catch (error) {
      console.error("Error fetching community members:", error);
      res.status(500).json({ message: "Failed to fetch community members" });
    }
  });

  // Get community posts
  app.get("/api/communities/:id/posts", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10) || 30, 100);
      const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
      const posts = await storage.getCommunityPosts(req.params.id, limit, offset);
      res.json(posts);
    } catch (error) {
      console.error("Error fetching community posts:", error);
      res.status(500).json({ message: "Failed to fetch community posts" });
    }
  });

  // Check membership status
  app.get("/api/communities/:id/membership", requireAuth, async (req, res) => {
    try {
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      res.json({ isMember: !!membership, membership: membership || null });
    } catch (error) {
      console.error("Error checking membership:", error);
      res.status(500).json({ message: "Failed to check membership" });
    }
  });

  // Toggle notification preference for current user in a community
  app.patch("/api/communities/:id/notifications", requireAuth, async (req, res) => {
    try {
      const membership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!membership) {
        return res.status(403).json({ message: "You are not a member of this community" });
      }
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }
      await storage.setCommunityNotifications(req.user!.id, req.params.id, enabled);
      res.json({ notificationsEnabled: enabled });
    } catch (error) {
      console.error("Error updating notification preference:", error);
      res.status(500).json({ message: "Failed to update notification preference" });
    }
  });

  // Get community by slug
  app.get("/api/communities/slug/:slug", async (req, res) => {
    try {
      const community = await storage.getCommunityBySlug(req.params.slug);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      const details = await storage.getCommunityWithDetails(community.id);
      res.json(details);
    } catch (error) {
      console.error("Error fetching community by slug:", error);
      res.status(500).json({ message: "Failed to fetch community" });
    }
  });

  // Get events linked to a community
  app.get("/api/communities/:id/events", async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }
      const communityEvents = await storage.getCommunityEvents(req.params.id);
      res.json(communityEvents);
    } catch (error) {
      console.error("Error fetching community events:", error);
      res.status(500).json({ message: "Failed to fetch community events" });
    }
  });

  // Update a member's role (owner only)
  app.patch("/api/communities/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || callerMembership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can change member roles" });
      }

      if (req.params.userId === req.user!.id) {
        return res.status(400).json({ message: "Use transfer-ownership to change your own role" });
      }

      const { role } = req.body;
      if (!["moderator", "member"].includes(role)) {
        return res.status(400).json({ message: "Role must be 'moderator' or 'member'" });
      }

      const targetMembership = await storage.getCommunityMembership(req.params.userId, req.params.id);
      if (!targetMembership) {
        return res.status(404).json({ message: "Member not found" });
      }

      const updated = await storage.updateCommunityMemberRole(req.params.userId, req.params.id, role);
      res.json(updated);
    } catch (error) {
      console.error("Error updating member role:", error);
      res.status(500).json({ message: "Failed to update member role" });
    }
  });

  // Kick a member (owner or moderator)
  app.delete("/api/communities/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || !["owner", "moderator"].includes(callerMembership.role)) {
        return res.status(403).json({ message: "Only owners and moderators can remove members" });
      }

      if (req.params.userId === req.user!.id) {
        return res.status(400).json({ message: "Use the leave endpoint to leave the community" });
      }

      const targetMembership = await storage.getCommunityMembership(req.params.userId, req.params.id);
      if (!targetMembership) {
        return res.status(404).json({ message: "Member not found" });
      }

      if (callerMembership.role === "moderator" && ["owner", "moderator"].includes(targetMembership.role)) {
        return res.status(403).json({ message: "Moderators can only remove regular members" });
      }

      await storage.removeCommunityMember(req.params.userId, req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error removing community member:", error);
      res.status(500).json({ message: "Failed to remove member" });
    }
  });

  // Transfer community ownership (owner only)
  app.patch("/api/communities/:id/transfer-ownership", requireAuth, async (req, res) => {
    try {
      const community = await storage.getCommunity(req.params.id);
      if (!community) {
        return res.status(404).json({ message: "Community not found" });
      }

      const callerMembership = await storage.getCommunityMembership(req.user!.id, req.params.id);
      if (!callerMembership || callerMembership.role !== "owner") {
        return res.status(403).json({ message: "Only the owner can transfer ownership" });
      }

      const { newOwnerId } = req.body;
      if (!newOwnerId) {
        return res.status(400).json({ message: "newOwnerId is required" });
      }

      const newOwnerMembership = await storage.getCommunityMembership(newOwnerId, req.params.id);
      if (!newOwnerMembership) {
        return res.status(404).json({ message: "New owner must be a member of this community" });
      }

      await storage.updateCommunityMemberRole(req.user!.id, req.params.id, "member");
      await storage.updateCommunityMemberRole(newOwnerId, req.params.id, "owner");
      await storage.updateCommunity(req.params.id, { createdByUserId: newOwnerId });

      res.json({ message: "Ownership transferred successfully" });
    } catch (error) {
      console.error("Error transferring ownership:", error);
      res.status(500).json({ message: "Failed to transfer ownership" });
    }
  });
}