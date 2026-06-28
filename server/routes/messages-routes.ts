import type { Express } from "express";
import { storage } from "../storage";
import { wsManager } from "../websocket";
import { requireAuth } from "../middleware";

export function registerMessagesRoutes(app: Express): void {

  // Messages — unread count only; direct-message CRUD lives in /api/conversations
  app.get("/api/messages/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const count = await storage.getUnreadMessageCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Get unread message count error:", error);
      res.status(500).json({ message: "Failed to get unread message count" });
    }
  });

  // ============================================
  // GROUP CHATS / CONVERSATIONS API
  // ============================================

  // Get all conversations for current user
  app.get("/api/conversations", requireAuth, async (req, res) => {
    try {
      const userConversations = await storage.getUserConversations(req.user!.id);
      res.json(userConversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ message: "Failed to fetch conversations" });
    }
  });

  // Create a new group chat
  app.post("/api/conversations/group", requireAuth, async (req, res) => {
    try {
      const { name, participantIds, avatarUrl } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ message: "Group name is required" });
      }

      if (!participantIds || !Array.isArray(participantIds) || participantIds.length < 1) {
        return res.status(400).json({ message: "At least one participant is required" });
      }

      // Ensure creator is included in participants
      const allParticipants = Array.from(new Set([req.user!.id, ...participantIds]));

      const conversation = await storage.createConversation(
        {
          isGroup: true,
          name: name.trim(),
          avatarUrl,
          createdById: req.user!.id,
        },
        allParticipants
      );

      // Fetch with participants
      const fullConversation = await storage.getConversationById(conversation.id);
      res.status(201).json(fullConversation);
    } catch (error) {
      console.error("Error creating group chat:", error);
      res.status(500).json({ message: "Failed to create group chat" });
    }
  });

  // Get or create a direct conversation
  app.post("/api/conversations/direct", requireAuth, async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId || userId === req.user!.id) {
        return res.status(400).json({ message: "Valid user ID required" });
      }

      const conversation = await storage.getOrCreateDirectConversation(req.user!.id, userId);
      const fullConversation = await storage.getConversationById(conversation.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error creating direct conversation:", error);
      res.status(500).json({ message: "Failed to create conversation" });
    }
  });

  // Get a specific conversation
  app.get("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      // Check if user is a participant
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      res.json(conversation);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ message: "Failed to fetch conversation" });
    }
  });

  // Update group settings (name, avatar)
  app.patch("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot update direct conversations" });
      }

      // Only admins can update group settings
      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can update group settings" });
      }

      const { name, avatarUrl } = req.body;
      const updates: any = {};

      if (name !== undefined) updates.name = name.trim();
      if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;

      const updated = await storage.updateConversation(req.params.id, updates);
      const fullConversation = await storage.getConversationById(updated.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error updating conversation:", error);
      res.status(500).json({ message: "Failed to update conversation" });
    }
  });

  // Delete a group (admin only)
  app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot delete direct conversations" });
      }

      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can delete groups" });
      }

      await storage.deleteConversation(req.params.id);
      res.json({ message: "Group deleted" });
    } catch (error) {
      console.error("Error deleting conversation:", error);
      res.status(500).json({ message: "Failed to delete conversation" });
    }
  });

  // Add a participant to group
  app.post("/api/conversations/:id/participants", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot add participants to direct conversations" });
      }

      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can add participants" });
      }

      const { userId, userRole = 'member' } = req.body;

      if (!userId) {
        return res.status(400).json({ message: "User ID required" });
      }

      // Check if already a participant
      const isAlreadyParticipant = await storage.isConversationParticipant(req.params.id, userId);
      if (isAlreadyParticipant) {
        return res.status(400).json({ message: "User is already a participant" });
      }

      const participant = await storage.addConversationParticipant(req.params.id, userId, userRole);
      res.status(201).json(participant);
    } catch (error) {
      console.error("Error adding participant:", error);
      res.status(500).json({ message: "Failed to add participant" });
    }
  });

  // Remove a participant from group
  app.delete("/api/conversations/:id/participants/:userId", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot remove participants from direct conversations" });
      }

      const currentUserRole = await storage.getParticipantRole(req.params.id, req.user!.id);
      const isRemovingSelf = req.params.userId === req.user!.id;

      // Users can remove themselves, admins can remove others
      if (!isRemovingSelf && currentUserRole !== 'admin') {
        return res.status(403).json({ message: "Only admins can remove other participants" });
      }

      // Check if trying to remove the last admin
      if (isRemovingSelf && currentUserRole === 'admin') {
        const participants = await storage.getConversationParticipants(req.params.id);
        const admins = participants.filter(p => p.role === 'admin');

        if (admins.length === 1) {
          return res.status(400).json({ message: "Cannot leave group - you are the last admin. Transfer admin role first or delete the group." });
        }
      }

      await storage.removeConversationParticipant(req.params.id, req.params.userId);
      res.json({ message: "Participant removed" });
    } catch (error) {
      console.error("Error removing participant:", error);
      res.status(500).json({ message: "Failed to remove participant" });
    }
  });

  // Update participant role
  app.patch("/api/conversations/:id/participants/:userId", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot update roles in direct conversations" });
      }

      const currentUserRole = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (currentUserRole !== 'admin') {
        return res.status(403).json({ message: "Only admins can update roles" });
      }

      const { role } = req.body;
      if (!role || !['admin', 'member'].includes(role)) {
        return res.status(400).json({ message: "Valid role required (admin or member)" });
      }

      const updated = await storage.updateParticipantRole(req.params.id, req.params.userId, role);
      res.json(updated);
    } catch (error) {
      console.error("Error updating participant role:", error);
      res.status(500).json({ message: "Failed to update role" });
    }
  });

  // Generate invite code for group
  app.post("/api/conversations/:id/invite", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationById(req.params.id);

      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      if (!conversation.isGroup) {
        return res.status(400).json({ message: "Cannot create invite for direct conversations" });
      }

      const role = await storage.getParticipantRole(req.params.id, req.user!.id);
      if (role !== 'admin') {
        return res.status(403).json({ message: "Only admins can generate invite codes" });
      }

      const inviteCode = await storage.generateInviteCode(req.params.id);
      res.json({ inviteCode });
    } catch (error) {
      console.error("Error generating invite code:", error);
      res.status(500).json({ message: "Failed to generate invite code" });
    }
  });

  // Join group via invite code
  app.post("/api/conversations/join/:code", requireAuth, async (req, res) => {
    try {
      const conversation = await storage.getConversationByInviteCode(req.params.code);

      if (!conversation) {
        return res.status(404).json({ message: "Invalid invite code" });
      }

      // Check if already a participant
      const isAlreadyParticipant = await storage.isConversationParticipant(conversation.id, req.user!.id);
      if (isAlreadyParticipant) {
        // Return the conversation anyway so they can navigate to it
        const fullConversation = await storage.getConversationById(conversation.id);
        return res.json(fullConversation);
      }

      // Add as member
      await storage.addConversationParticipant(conversation.id, req.user!.id, 'member');
      const fullConversation = await storage.getConversationById(conversation.id);
      res.json(fullConversation);
    } catch (error) {
      console.error("Error joining group:", error);
      res.status(500).json({ message: "Failed to join group" });
    }
  });

  // Get conversation messages
  app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const before = req.query.before as string | undefined;

      const messages = await storage.getConversationMessages(req.params.id, limit, before);

      // Mark as read
      await storage.updateLastReadAt(req.params.id, req.user!.id);

      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  // Send a message in conversation
  app.post("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      const { content, messageType = 'text', eventId, venueId, postId, imageUrls, replyToId } = req.body;

      // Validate content exists for text messages
      if (messageType === 'text' && (!content || content.trim().length === 0)) {
        return res.status(400).json({ message: "Message content required" });
      }

      const message = await storage.sendConversationMessage({
        conversationId: req.params.id,
        senderId: req.user!.id,
        content: content?.trim(),
        messageType,
        eventId,
        venueId,
        postId,
        imageUrls,
        replyToId,
      });

      // Broadcast to all conversation participants in real-time
      const participants = await storage.getConversationParticipants(req.params.id);
      const participantIds = participants.map((p) => p.userId);
      wsManager.broadcastToConversation(req.params.id, participantIds, message);

      res.status(201).json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  // Delete a message
  app.delete("/api/conversations/:id/messages/:messageId", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      await storage.deleteConversationMessage(req.params.messageId);
      res.json({ message: "Message deleted" });
    } catch (error) {
      console.error("Error deleting message:", error);
      res.status(500).json({ message: "Failed to delete message" });
    }
  });

  // ============================================
  // POLLS API
  // ============================================

  // Create a poll in a conversation
  app.post("/api/conversations/:id/polls", requireAuth, async (req, res) => {
    try {
      const isParticipant = await storage.isConversationParticipant(req.params.id, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      const { question, options, allowMultiple, expiresAt } = req.body;

      if (!question || question.trim().length === 0) {
        return res.status(400).json({ message: "Question required" });
      }

      if (!options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ message: "At least 2 options required" });
      }

      const poll = await storage.createPoll(
        {
          conversationId: req.params.id,
          creatorId: req.user!.id,
          question: question.trim(),
          allowMultiple: allowMultiple || false,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        options.map((opt: any) => ({
          text: typeof opt === 'string' ? opt : opt.text,
          eventId: opt.eventId,
          venueId: opt.venueId,
        }))
      );

      res.status(201).json(poll);
    } catch (error) {
      console.error("Error creating poll:", error);
      res.status(500).json({ message: "Failed to create poll" });
    }
  });

  // Get a poll
  app.get("/api/polls/:id", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);

      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }

      // Check if user is in the conversation
      const isParticipant = await storage.isConversationParticipant(poll.conversationId, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      // Get user's votes
      const userVotes = await storage.getUserPollVotes(poll.id, req.user!.id);

      res.json({ ...poll, userVotes });
    } catch (error) {
      console.error("Error fetching poll:", error);
      res.status(500).json({ message: "Failed to fetch poll" });
    }
  });

  // Vote on a poll
  app.post("/api/polls/:id/vote", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);

      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }

      if (poll.status === 'closed') {
        return res.status(400).json({ message: "Poll is closed" });
      }

      if (poll.expiresAt && new Date() > poll.expiresAt) {
        return res.status(400).json({ message: "Poll has expired" });
      }

      const isParticipant = await storage.isConversationParticipant(poll.conversationId, req.user!.id);
      if (!isParticipant) {
        return res.status(403).json({ message: "Not a participant" });
      }

      const { optionId } = req.body;

      if (!optionId) {
        return res.status(400).json({ message: "Option ID required" });
      }

      // Check if option belongs to this poll
      const validOption = poll.options.find(o => o.id === optionId);
      if (!validOption) {
        return res.status(400).json({ message: "Invalid option" });
      }

      // If not allowing multiple, remove existing votes first
      if (!poll.allowMultiple) {
        const existingVotes = await storage.getUserPollVotes(poll.id, req.user!.id);
        for (const vote of existingVotes) {
          await storage.unvotePoll(poll.id, vote.optionId, req.user!.id);
        }
      }

      try {
        const vote = await storage.votePoll(req.params.id, optionId, req.user!.id);
        res.status(201).json(vote);
      } catch (e: any) {
        if (e.code === '23505') { // Unique constraint violation
          return res.status(400).json({ message: "Already voted for this option" });
        }
        throw e;
      }
    } catch (error) {
      console.error("Error voting on poll:", error);
      res.status(500).json({ message: "Failed to vote" });
    }
  });

  // Remove vote from poll
  app.delete("/api/polls/:id/vote/:optionId", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);

      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }

      if (poll.status === 'closed') {
        return res.status(400).json({ message: "Poll is closed" });
      }

      await storage.unvotePoll(req.params.id, req.params.optionId, req.user!.id);
      res.json({ message: "Vote removed" });
    } catch (error) {
      console.error("Error removing vote:", error);
      res.status(500).json({ message: "Failed to remove vote" });
    }
  });

  // Close a poll (creator or admin only)
  app.post("/api/polls/:id/close", requireAuth, async (req, res) => {
    try {
      const poll = await storage.getPoll(req.params.id);

      if (!poll) {
        return res.status(404).json({ message: "Poll not found" });
      }

      // Check if user is creator or admin
      const isCreator = poll.creatorId === req.user!.id;
      const role = await storage.getParticipantRole(poll.conversationId, req.user!.id);

      if (!isCreator && role !== 'admin') {
        return res.status(403).json({ message: "Only poll creator or group admin can close poll" });
      }

      const closedPoll = await storage.closePoll(req.params.id);
      res.json(closedPoll);
    } catch (error) {
      console.error("Error closing poll:", error);
      res.status(500).json({ message: "Failed to close poll" });
    }
  });

}
