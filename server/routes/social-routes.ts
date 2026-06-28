import type { Express } from "express";
import express from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { insertPostSchema, insertStorySchema } from "@shared/schema";
import { requireAuth } from "../middleware";
import { sanitizeTextOnly, sensitiveOperationLimiter } from "../security";
import { deliverNotification } from "../notifications";
import { resolveUserId } from "../utils/users";
import { ObjectStorageService } from "../objectStorage";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export function registerSocialRoutes(app: Express): void {
  const largeJsonParser = express.json({ limit: '50mb' });

  // Posts
  app.get("/api/posts", async (req, res) => {
    try {
      const posts = await storage.getPostsWithCommunity();
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch posts" });
    }
  });

  app.get("/api/posts/user/:userId", async (req, res) => {
    try {
      const posts = await storage.getUserPosts(req.params.userId);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user posts" });
    }
  });

  app.get("/api/posts/:postId", async (req, res) => {
    try {
      const post = await storage.getPost(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found" });
      const user = await storage.getUser(post.userId);
      res.json({ ...post, user });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch post" });
    }
  });

  app.post("/api/posts", requireAuth, async (req, res) => {
    try {
      const postData = insertPostSchema.omit({ userId: true }).parse(req.body);

      // If posting to a community, validate membership
      if (postData.communityId) {
        const isMember = await storage.isCommunityMember(req.user!.id, postData.communityId);
        if (!isMember) {
          return res.status(403).json({ message: "You must be a member of this community to post" });
        }
      }

      const sanitizedPostData = {
        ...postData,
        content: sanitizeTextOnly(postData.content || ""),
      };

      const post = await storage.createPost({
        ...sanitizedPostData,
        userId: req.user!.id,
      });

      // Extract and store hashtags from post content
      const hashtagRegex = /#(\w+)/g;
      const hashtagMatches = sanitizedPostData.content.match(hashtagRegex) || [];
      for (const match of hashtagMatches) {
        const hashtag = await storage.getOrCreateHashtag(match);
        await storage.addHashtagToPost(post.id, hashtag.id);
      }

      // Extract mentions and create notifications
      const mentionRegex = /@(\w+)/g;
      const mentionMatches = sanitizedPostData.content.match(mentionRegex) || [];
      for (const match of mentionMatches) {
        const username = match.substring(1); // Remove @ symbol
        const mentionedUser = await storage.getUserByUsername(username);
        if (mentionedUser && mentionedUser.id !== req.user!.id) {
          await storage.addMentionToPost(post.id, mentionedUser.id);

          // Create notification for the mentioned user
          const poster = await storage.getUser(req.user!.id);
          await deliverNotification({
            userId: mentionedUser.id,
            type: "mention",
            title: "You were mentioned",
            message: `${poster?.displayName || poster?.username || "Someone"} mentioned you in a post`,
            link: `/feed?post=${post.id}`,
            relatedUserId: req.user!.id,
            relatedEntityId: post.id,
          });
        }
      }

      // Notify community members if this is a community post
      if (postData.communityId) {
        const community = await storage.getCommunity(postData.communityId);
        const memberIds = await storage.getCommunityMemberIds(postData.communityId);
        const poster = await storage.getUser(req.user!.id);

        for (const memberId of memberIds) {
          // Don't notify the poster themselves
          if (memberId !== req.user!.id) {
            await deliverNotification({
              userId: memberId,
              type: "community_post",
              title: `New post in ${community?.name}`,
              message: `${poster?.displayName || poster?.username || "Someone"} posted in ${community?.name}`,
              link: `/feed?post=${post.id}`,
              relatedUserId: req.user!.id,
              relatedEntityId: post.id,
            });
          }
        }
      }

      res.json(post);
    } catch (error) {
      console.error("Post creation error:", error);
      res.status(400).json({ message: "Invalid post data" });
    }
  });

  app.delete("/api/posts/:id", requireAuth, async (req, res) => {
    try {
      const post = await storage.getPost(req.params.id);
      if (!post) {
        return res.status(404).json({ message: "Post not found" });
      }

      if (post.userId !== req.user!.id) {
        return res.status(403).json({ message: "Not authorized to delete this post" });
      }

      await storage.deletePost(req.params.id);
      res.json({ message: "Post deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete post" });
    }
  });

  // ──── Media Storage (Railway-compatible, DB-backed) ────────────────────────

  // Helper: store base64 data URL in DB, return /api/media/{id} URL
  async function storeMedia(data: string, ownerId: string): Promise<string> {
    const base64Data = data.includes(',') ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64Data, 'base64');

    // fileTypeFromBuffer reads magic bytes — the declared MIME in the data URL
    // is ignored. Any file whose bytes don't parse as image/* or video/* is
    // rejected here, including executables, archives, and spoofed extensions.
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || (!detected.mime.startsWith('image/') && !detected.mime.startsWith('video/'))) {
      throw new MediaValidationError(
        `File type not allowed: ${detected?.mime ?? 'unknown'}`
      );
    }

    const safeData = `data:${detected.mime};base64,${base64Data}`;
    const id = await storage.saveMedia(safeData, detected.mime, ownerId);
    return `/api/media/${id}`;
  }

  // Serve any uploaded media from DB
  app.get("/api/media/:id", requireAuth, async (req, res) => {
    try {
      const media = await storage.getMedia(req.params.id);
      if (!media) return res.sendStatus(404);
      const base64 = media.data.includes(',') ? media.data.split(',')[1] : media.data;
      const buffer = Buffer.from(base64, 'base64');
      res.set('Content-Type', media.contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('Content-Length', String(buffer.length));
      res.send(buffer);
    } catch {
      res.sendStatus(500);
    }
  });

  // Central upload: accepts base64 data URL, stores in DB, returns /api/media/{id} URL
  app.post("/api/media/upload", requireAuth, largeJsonParser, async (req, res) => {
    try {
      const { data } = req.body;
      if (!data || !data.startsWith('data:')) {
        return res.status(400).json({ message: "Invalid media data" });
      }
      const url = await storeMedia(data, req.user!.id);
      res.json({ url });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      res.status(500).json({ message: "Failed to save media" });
    }
  });

  // Stories
  app.get("/api/stories", async (req, res) => {
    try {
      const viewerId = req.user?.id;
      const stories = await storage.getActiveStories(viewerId);
      res.json(stories);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch stories" });
    }
  });

  // Get story image upload URL (legacy endpoint — kept for compatibility)
  app.get("/api/stories/upload-url", requireAuth, async (req, res) => {
    const tempId = crypto.randomUUID();
    res.json({ uploadURL: `/api/media/binary-upload/${tempId}`, stablePath: null });
  });

  // Server-side story image upload (bypasses CORS issues)
  app.post("/api/stories/upload", requireAuth, largeJsonParser, async (req, res) => {
    try {
      const { imageData } = req.body;
      const isImage = imageData && imageData.startsWith('data:image');
      const isVideo = imageData && imageData.startsWith('data:video');
      if (!imageData || (!isImage && !isVideo)) {
        return res.status(400).json({ message: "Invalid media data" });
      }
      const stablePath = await storeMedia(imageData, req.user!.id);
      res.json({ stablePath, mediaType: isVideo ? 'video' : 'image' });
    } catch (error) {
      if (error instanceof MediaValidationError) {
        return res.status(400).json({ message: error.message });
      }
      console.error("Error uploading story media:", error);
      res.status(500).json({ message: "Failed to upload media" });
    }
  });

  app.post("/api/stories", requireAuth, async (req, res) => {
    try {
      const { allowedViewerIds, ...storyInput } = req.body;
      const storyData = insertStorySchema.omit({ userId: true }).parse(storyInput);
      const story = await storage.createStory({ ...storyData, userId: req.user!.id }, allowedViewerIds);
      res.json(story);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(422).json({ message: error.errors[0]?.message ?? "Invalid story data" });
      }
      console.error("Create story error:", error);
      res.status(500).json({ message: "Story could not be saved. Please try again." });
    }
  });

  // Fix ACL on existing story images that are missing public visibility
  app.post("/api/stories/fix-acl", requireAuth, async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const allStories = await storage.getActiveStories(req.user!.id);
      const userStories = allStories.filter(s => s.userId === req.user!.id);

      let fixed = 0;
      const errors: { storyId: string; error: string }[] = [];

      for (const story of userStories) {
        if (story.imageUrl && story.imageUrl.startsWith('/objects/')) {
          try {
            await objectStorageService.trySetObjectEntityAclPolicy(story.imageUrl, {
              owner: req.user!.id,
              visibility: "public",
            });
            fixed++;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // ObjectNotFoundError means the image doesn't exist - not a real failure
            if (errorMessage.includes('ObjectNotFound') || errorMessage.includes('not found')) {
              console.log(`Story ${story.id} image not found in storage, skipping`);
            } else {
              console.error(`Failed to fix ACL for story ${story.id}:`, err);
              errors.push({ storyId: story.id, error: errorMessage });
            }
          }
        }
      }

      res.json({
        message: `Fixed ACL on ${fixed} story images`,
        fixed,
        total: userStories.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error("Fix ACL error:", error);
      res.status(500).json({ message: "Failed to fix story ACLs" });
    }
  });

  app.get("/api/stories/:storyId", async (req, res) => {
    try {
      const { storyId } = req.params;
      const story = await storage.getStory(storyId);
      if (!story) return res.status(404).json({ message: "Story not found" });

      const user = await storage.getUser(story.userId);
      if (!user) return res.status(404).json({ message: "Story not found" });

      const { passwordHash, ...userWithoutPassword } = user;
      const likeCount = await storage.getStoryLikeCount(storyId);
      const viewCount = await storage.getStoryViewCount(storyId);
      let isLiked = false;
      if (req.user?.id) {
        isLiked = await storage.hasUserLikedStory(req.user.id, storyId);
      }

      res.json({
        ...story,
        user: userWithoutPassword,
        likeCount,
        viewCount,
        isLiked,
        isReshare: !!story.originalStoryId,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch story" });
    }
  });

  app.delete("/api/stories/:id", requireAuth, async (req, res) => {
    try {
      const stories = await storage.getUserStories(req.user!.id);
      const story = stories.find(s => s.id === req.params.id);

      if (!story) {
        return res.status(404).json({ message: "Story not found or not authorized" });
      }

      await storage.deleteStory(req.params.id);
      res.json({ message: "Story deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete story" });
    }
  });

  // Story Likes
  app.post("/api/stories/:storyId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }

      // Check if user can view this story
      const canView = await storage.canViewStory(userId, storyId);
      if (!canView) {
        return res.status(403).json({ message: "Not authorized to view this story" });
      }

      await storage.likeStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);

      // Create notification for story owner (if not liking own story)
      if (story.userId !== userId) {
        const liker = await storage.getUser(userId);
        const likerName = liker?.displayName || liker?.username || "Someone";
        await deliverNotification({
          userId: story.userId,
          type: "story_like",
          title: "Story Liked",
          message: `${likerName} liked your story`,
          link: `/stories/${storyId}`,
          relatedUserId: userId,
          relatedEntityId: storyId,
        });
      }

      res.json({ liked: true, likeCount });
    } catch (error) {
      console.error("Like story error:", error);
      res.status(500).json({ message: "Failed to like story" });
    }
  });

  app.delete("/api/stories/:storyId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      await storage.unlikeStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);
      res.json({ liked: false, likeCount });
    } catch (error) {
      console.error("Unlike story error:", error);
      res.status(500).json({ message: "Failed to unlike story" });
    }
  });

  app.get("/api/stories/:storyId/like-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const isLiked = await storage.hasUserLikedStory(userId, storyId);
      const likeCount = await storage.getStoryLikeCount(storyId);
      res.json({ isLiked, likeCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get like status" });
    }
  });

  // Story Reshares
  app.post("/api/stories/:storyId/reshare", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const originalStory = await storage.getStory(storyId);
      if (!originalStory) {
        return res.status(404).json({ message: "Story not found" });
      }

      // Check if user can view this story
      const canView = await storage.canViewStory(userId, storyId);
      if (!canView) {
        return res.status(403).json({ message: "Not authorized to reshare this story" });
      }

      // Users can't reshare their own stories
      if (originalStory.userId === userId) {
        return res.status(400).json({ message: "Cannot reshare your own story" });
      }

      const resharedStory = await storage.reshareStory(userId, storyId);
      res.json(resharedStory);
    } catch (error) {
      console.error("Reshare story error:", error);
      res.status(500).json({ message: "Failed to reshare story" });
    }
  });

  // Story Views - record a view when the viewer opens a story slide
  app.post("/api/stories/:storyId/view", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }

      // Don't record owner viewing their own story
      if (story.userId !== userId) {
        await storage.recordStoryView(storyId, userId);
      }

      const viewCount = await storage.getStoryViewCount(storyId);
      res.json({ viewCount });
    } catch (error) {
      console.error("Record story view error:", error);
      res.status(500).json({ message: "Failed to record view" });
    }
  });

  // Story Interactions - viewers + likers list (owner only)
  app.get("/api/stories/:storyId/interactions", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const storyId = req.params.storyId;

      const story = await storage.getStory(storyId);
      if (!story) {
        return res.status(404).json({ message: "Story not found" });
      }

      if (story.userId !== userId) {
        return res.status(403).json({ message: "Only the story owner can view interactions" });
      }

      const viewers = await storage.getStoryViewersWithLikeStatus(storyId);
      const viewCount = viewers.length;
      const likeCount = await storage.getStoryLikeCount(storyId);

      res.json({ viewers, viewCount, likeCount });
    } catch (error) {
      console.error("Get story interactions error:", error);
      res.status(500).json({ message: "Failed to get interactions" });
    }
  });

  // Story Replies — sends as a real DM in the replier's conversation thread with the story owner
  app.post("/api/stories/:storyId/reply", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { storyId } = req.params;

      const story = await storage.getStory(storyId);
      if (!story) return res.status(404).json({ message: "Story not found" });
      if (story.userId === userId) return res.status(400).json({ message: "Cannot reply to your own story" });

      const canView = await storage.canViewStory(userId, storyId);
      if (!canView) return res.status(403).json({ message: "Not authorized to view this story" });

      const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
      if (!content) return res.status(400).json({ message: "Content is required" });

      // Get or create the direct conversation thread between replier and story owner
      const conversation = await storage.getOrCreateDirectConversation(userId, story.userId);

      await storage.sendConversationMessage({
        conversationId: conversation.id,
        senderId: userId,
        content,
        messageType: "story_reply",
        storyId,
      });

      // Notification is best-effort — a failure here must not roll back the sent message
      try {
        const sender = await storage.getUser(userId);
        const senderName = sender?.displayName || sender?.username || "Someone";
        await deliverNotification({
          userId: story.userId,
          type: "story_reply",
          title: "Story Reply",
          message: `${senderName} replied to your story`,
          link: `/messages/${conversation.id}`,
          relatedUserId: userId,
          relatedEntityId: storyId,
        });
      } catch (notifErr) {
        console.error("Story reply notification failed:", notifErr);
      }

      res.status(201).json({ conversationId: conversation.id });
    } catch (error) {
      console.error("Story reply error:", error);
      res.status(400).json({ message: "Failed to send reply" });
    }
  });

  // Post Interactions - Likes
  app.post("/api/posts/:postId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      const alreadyLiked = await storage.hasUserLikedPost(userId, postId);
      if (alreadyLiked) {
        return res.status(400).json({ message: "Already liked this post" });
      }

      const like = await storage.likePost(userId, postId);

      // Create notification for post owner (if not liking own post)
      const posts = await storage.getPosts();
      const post = posts.find(p => p.id === postId);
      if (post && post.userId !== userId) {
        const liker = await storage.getUser(userId);
        const postSnippet = post.content.length > 50 ? post.content.substring(0, 50) + "..." : post.content;
        await deliverNotification({
          userId: post.userId,
          type: "post_like",
          title: "New Post Like",
          message: `${liker?.displayName || liker?.username || "Someone"} liked your post: "${postSnippet}"`,
          link: `/feed?post=${postId}`,
          relatedUserId: userId,
          relatedEntityId: postId,
        });
      }

      res.json(like);
    } catch (error) {
      res.status(500).json({ message: "Failed to like post" });
    }
  });

  app.delete("/api/posts/:postId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      await storage.unlikePost(userId, postId);
      res.json({ message: "Unliked post" });
    } catch (error) {
      res.status(500).json({ message: "Failed to unlike post" });
    }
  });

  app.get("/api/posts/:postId/likes", requireAuth, async (req, res) => {
    try {
      const postId = req.params.postId;
      const userId = req.user!.id;

      const count = await storage.getPostLikes(postId);
      const isLiked = await storage.hasUserLikedPost(userId, postId);

      res.json({ count, isLiked });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch likes" });
    }
  });

  // Post Interactions - Comments
  app.post("/api/posts/:postId/comments", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Comment content is required" });
      }

      // Sanitize content to prevent XSS
      const sanitizedContent = sanitizeTextOnly(content.trim());

      const comment = await storage.addComment({
        userId,
        postId,
        content: sanitizedContent,
      });

      // Create notification for post owner (if not commenting on own post)
      const posts = await storage.getPosts();
      const post = posts.find(p => p.id === postId);
      if (post && post.userId !== userId) {
        const commenter = await storage.getUser(userId);
        const commentSnippet = sanitizedContent.length > 60 ? sanitizedContent.substring(0, 60) + "..." : sanitizedContent;
        await deliverNotification({
          userId: post.userId,
          type: "post_comment",
          title: "New Comment",
          message: `${commenter?.displayName || commenter?.username || "Someone"} commented: "${commentSnippet}"`,
          link: `/feed?post=${postId}&comment=${comment.id}`,
          relatedUserId: userId,
          relatedEntityId: comment.id,
        });
      }

      res.json(comment);
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment" });
    }
  });

  app.get("/api/posts/:postId/comments", async (req, res) => {
    try {
      const postId = req.params.postId;
      const comments = await storage.getPostComments(postId);
      res.json({ comments, count: comments.length });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  // Comment Interactions - Like
  app.post("/api/comments/:commentId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;

      const alreadyLiked = await storage.hasUserLikedComment(userId, commentId);
      if (alreadyLiked) {
        return res.status(400).json({ message: "Already liked this comment" });
      }

      const like = await storage.likeComment(userId, commentId);
      res.json(like);
    } catch (error) {
      res.status(500).json({ message: "Failed to like comment" });
    }
  });

  app.delete("/api/comments/:commentId/like", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      await storage.unlikeComment(userId, commentId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to unlike comment" });
    }
  });

  app.get("/api/comments/:commentId/likes", async (req, res) => {
    try {
      const commentId = req.params.commentId;
      const userId = req.user?.id;
      const count = await storage.getCommentLikeCount(commentId);
      const isLiked = userId ? await storage.hasUserLikedComment(userId, commentId) : false;
      res.json({ count, isLiked });
    } catch (error) {
      res.status(500).json({ message: "Failed to get comment likes" });
    }
  });

  // Comment Interactions - Replies
  app.post("/api/comments/:commentId/replies", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Reply content is required" });
      }

      const sanitizedContent = sanitizeTextOnly(content.trim());
      const reply = await storage.addCommentReply(userId, commentId, sanitizedContent);
      res.json(reply);
    } catch (error) {
      res.status(500).json({ message: "Failed to add reply" });
    }
  });

  app.get("/api/comments/:commentId/replies", async (req, res) => {
    try {
      const commentId = req.params.commentId;
      const replies = await storage.getCommentReplies(commentId);
      const count = await storage.getCommentReplyCount(commentId);
      res.json({ replies, count });
    } catch (error) {
      res.status(500).json({ message: "Failed to get replies" });
    }
  });

  // Comment Interactions - Repost
  app.post("/api/comments/:commentId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;

      const alreadyReposted = await storage.hasUserRepostedComment(userId, commentId);
      if (alreadyReposted) {
        return res.status(400).json({ message: "Already reposted this comment" });
      }

      const repost = await storage.repostComment(userId, commentId);
      res.json(repost);
    } catch (error) {
      res.status(500).json({ message: "Failed to repost comment" });
    }
  });

  app.delete("/api/comments/:commentId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      await storage.unrepostComment(userId, commentId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove repost" });
    }
  });

  app.get("/api/comments/:commentId/repost-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const commentId = req.params.commentId;
      const hasReposted = await storage.hasUserRepostedComment(userId, commentId);
      const repostCount = await storage.getCommentRepostCount(commentId);
      res.json({ hasReposted, repostCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get repost status" });
    }
  });

  // Post Interactions - Bookmarks
  app.post("/api/posts/:postId/bookmark", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      const alreadyBookmarked = await storage.hasUserBookmarkedPost(userId, postId);
      if (alreadyBookmarked) {
        return res.status(400).json({ message: "Already bookmarked this post" });
      }

      const bookmark = await storage.bookmarkPost(userId, postId);
      res.json(bookmark);
    } catch (error) {
      res.status(500).json({ message: "Failed to bookmark post" });
    }
  });

  app.delete("/api/posts/:postId/bookmark", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      await storage.unbookmarkPost(userId, postId);
      res.json({ message: "Removed bookmark" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove bookmark" });
    }
  });

  // ============================================
  // POST REPOSTS
  // ============================================

  app.post("/api/posts/:postId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      const alreadyReposted = await storage.hasUserRepostedPost(userId, postId);
      if (alreadyReposted) {
        return res.status(400).json({ message: "Already reposted this post" });
      }

      const repost = await storage.repostPost(userId, postId);

      // Notify the original post author
      const originalPost = await storage.getPost(postId);
      if (originalPost && originalPost.userId !== userId) {
        const reposter = await storage.getUser(userId);
        await deliverNotification({
          userId: originalPost.userId,
          type: "repost",
          title: "Post Reposted",
          message: `${reposter?.displayName || reposter?.username || "Someone"} reposted your post`,
          link: `/feed?post=${postId}`,
          relatedUserId: userId,
          relatedEntityId: postId,
        });
      }

      res.json(repost);
    } catch (error) {
      res.status(500).json({ message: "Failed to repost" });
    }
  });

  app.delete("/api/posts/:postId/repost", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      await storage.unrepostPost(userId, postId);
      res.json({ message: "Removed repost" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove repost" });
    }
  });

  app.get("/api/posts/:postId/repost-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const postId = req.params.postId;

      const hasReposted = await storage.hasUserRepostedPost(userId, postId);
      const repostCount = await storage.getPostRepostCount(postId);

      res.json({ hasReposted, repostCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get repost status" });
    }
  });

  // ============================================
  // HASHTAGS
  // ============================================

  app.get("/api/hashtags/trending", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const trending = await storage.getTrendingHashtags(limit);
      res.json(trending);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch trending hashtags" });
    }
  });

  app.get("/api/hashtags/:tag/posts", async (req, res) => {
    try {
      const tag = req.params.tag;
      const posts = await storage.getPostsByHashtag(tag);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch posts by hashtag" });
    }
  });

  // ============================================
  // MENTIONS
  // ============================================

  app.get("/api/users/:userId/mentions", requireAuth, async (req, res) => {
    try {
      const userId = req.params.userId;
      const mentions = await storage.getUserMentions(userId);
      res.json(mentions);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch user mentions" });
    }
  });

  // Follows
  app.post("/api/follows/:identifier", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);

      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }

      if (followerId === followingId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
      }

      const isAlreadyFollowing = await storage.isFollowing(followerId, followingId);
      if (isAlreadyFollowing) {
        return res.status(400).json({ message: "Already following this user" });
      }

      const follow = await storage.followUser(followerId, followingId);

      // Notify user they have a new follower
      const follower = await storage.getUser(followerId);
      await deliverNotification({
        userId: followingId,
        type: "new_follower",
        title: "New Follower",
        message: `${follower?.displayName || follower?.username || "Someone"} started following you`,
        link: `/profile/${follower?.username}`,
        relatedUserId: followerId,
        relatedEntityId: followerId,
      });

      res.json(follow);
    } catch (error) {
      res.status(500).json({ message: "Failed to follow user" });
    }
  });

  app.delete("/api/follows/:identifier", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);

      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }

      await storage.unfollowUser(followerId, followingId);
      res.json({ message: "Unfollowed successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to unfollow user" });
    }
  });

  app.get("/api/follows/:identifier/status", requireAuth, async (req, res) => {
    try {
      const followerId = req.user!.id;
      const followingId = await resolveUserId(req.params.identifier);

      if (!followingId) {
        return res.status(404).json({ message: "User not found" });
      }

      const isFollowing = await storage.isFollowing(followerId, followingId);
      res.json({ isFollowing });
    } catch (error) {
      res.status(500).json({ message: "Failed to check follow status" });
    }
  });

  app.get("/api/follows/:identifier/followers", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }
      const followers = await storage.getFollowers(userId);
      // Return just the user objects for easier frontend consumption
      const users = followers.map(f => f.follower);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch followers" });
    }
  });

  // Get current user's following list (authenticated route with stable path)
  app.get("/api/follows/me/following", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const following = await storage.getFollowing(userId);
      const users = following.map(f => f.following);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch following" });
    }
  });

  app.get("/api/follows/:identifier/following", async (req, res) => {
    try {
      const userId = await resolveUserId(req.params.identifier);
      if (!userId) {
        return res.status(404).json({ message: "User not found" });
      }
      const following = await storage.getFollowing(userId);
      // Return just the user objects for easier frontend consumption
      const users = following.map(f => f.following);
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch following" });
    }
  });
}
