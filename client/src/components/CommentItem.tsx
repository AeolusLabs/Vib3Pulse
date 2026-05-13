import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Send,
  Heart,
  MessageCircle,
  Share2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNowStrict } from "date-fns";
import { useLocation } from "wouter";
import MentionTextarea from "./MentionTextarea";

type Comment = {
  id: string;
  userId: string;
  postId: string;
  content: string;
  createdAt: string;
  user: {
    id: string;
    username: string;
    displayName?: string;
    organizationName?: string;
    avatarUrl?: string;
  };
};

type CommentReply = {
  id: string;
  userId: string;
  commentId: string;
  content: string;
  createdAt: string;
  user: {
    id: string;
    username: string;
    displayName?: string;
    organizationName?: string;
    avatarUrl?: string;
  };
};

interface CommentItemProps {
  comment: Comment;
  postId: string;
  onNavigate?: (path: string) => void;
  renderContent?: (content: string) => React.ReactNode;
}

function relativeTime(dateStr: string) {
  try {
    return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: true });
  } catch {
    return "";
  }
}

function renderWithMentions(text: string, navigate: (path: string) => void): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(@\w+|#\w+)/g;
  let lastIndex = 0;
  let match;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("@")) {
      const username = token.slice(1);
      parts.push(
        <button
          key={i++}
          onClick={(e) => { e.stopPropagation(); navigate(`/profile/${username}`); }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    } else {
      parts.push(
        <button
          key={i++}
          onClick={(e) => { e.stopPropagation(); navigate(`/search?tag=${token.slice(1)}`); }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

export default function CommentItem({
  comment,
  postId,
  onNavigate,
  renderContent,
}: CommentItemProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [showReplies, setShowReplies] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [showReplyInput, setShowReplyInput] = useState(false);

  const goTo = (path: string) => {
    if (onNavigate) onNavigate(path);
    else navigate(path);
  };

  const handleProfileClick = () => {
    goTo(comment.user.id ? `/user/${comment.user.id}` : `/profile/${comment.user.username}`);
  };

  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ["/api/comments", comment.id, "likes"],
  });

  const { data: repliesData, isLoading: repliesLoading } = useQuery<{ replies: CommentReply[]; count: number }>({
    queryKey: ["/api/comments", comment.id, "replies"],
    enabled: showReplies,
  });

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (likeData?.isLiked) {
        return await apiRequest("DELETE", `/api/comments/${comment.id}/like`, {});
      }
      return await apiRequest("POST", `/api/comments/${comment.id}/like`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/comments", comment.id, "likes"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update like", variant: "destructive" });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest("POST", `/api/comments/${comment.id}/replies`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/comments", comment.id, "replies"] });
      setReplyText("");
      setShowReplyInput(false);
      setShowReplies(true);
      toast({ title: "Reply posted!" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to post reply", variant: "destructive" });
    },
  });

  const handleOpenReply = () => {
    const prefix = `@${comment.user.username} `;
    setReplyText(replyText.startsWith(prefix) ? replyText : prefix);
    setShowReplyInput(true);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/feed?comment=${comment.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ text: comment.content, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "Link copied!" });
      }
    } catch {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied!" });
    }
  };

  const likeCount = likeData?.count ?? 0;
  const isLiked = likeData?.isLiked ?? false;
  const replyCount = repliesData?.count ?? 0;
  const replies = repliesData?.replies ?? [];
  const displayName = comment.user.displayName || comment.user.organizationName || comment.user.username;

  return (
    <div className="flex gap-3" data-testid={`comment-${comment.id}`}>
      {/* Avatar + thread line */}
      <div className="flex flex-col items-center flex-shrink-0">
        <Avatar
          className="h-9 w-9 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={handleProfileClick}
        >
          <AvatarImage src={comment.user.avatarUrl || ""} alt={displayName} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm">
            {displayName.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {/* Thread line — shows when replies are visible */}
        {showReplies && replies.length > 0 && (
          <div className="w-0.5 flex-1 bg-border mt-1 min-h-4" />
        )}
      </div>

      <div className="flex-1 min-w-0 pb-2">
        {/* Author + time */}
        <div className="flex items-baseline gap-1.5 flex-wrap mb-0.5">
          <button
            className="font-semibold text-sm hover:underline"
            onClick={handleProfileClick}
          >
            {displayName}
          </button>
          <span className="text-xs text-muted-foreground">@{comment.user.username}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{relativeTime(comment.createdAt)}</span>
        </div>

        {/* Content */}
        <p className="text-sm break-words leading-relaxed" data-testid={`comment-text-${comment.id}`}>
          {renderContent ? renderContent(comment.content) : renderWithMentions(comment.content, goTo)}
        </p>

        {/* Action bar */}
        <div className="flex items-center gap-0 mt-1.5 -ml-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-1.5 text-xs gap-1 ${isLiked ? "text-red-500" : "text-muted-foreground"} hover:text-red-500`}
            onClick={() => likeMutation.mutate()}
            disabled={likeMutation.isPending}
            data-testid={`button-like-comment-${comment.id}`}
          >
            <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
            {likeCount > 0 && <span>{likeCount}</span>}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5 text-xs gap-1 text-muted-foreground hover:text-primary"
            onClick={handleOpenReply}
            data-testid={`button-reply-comment-${comment.id}`}
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {replyCount > 0 && <span>{replyCount}</span>}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5 text-xs text-muted-foreground hover:text-primary"
            onClick={handleShare}
            data-testid={`button-share-comment-${comment.id}`}
          >
            <Share2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Reply input */}
        {showReplyInput && (
          <div className="mt-2 flex gap-2 items-start">
            <div className="flex-1">
              <MentionTextarea
                value={replyText}
                onChange={setReplyText}
                placeholder={`Reply to @${comment.user.username}...`}
                rows={2}
                className="text-sm resize-none"
                data-testid={`input-reply-${comment.id}`}
              />
            </div>
            <div className="flex flex-col gap-1 pt-1">
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={() => { if (replyText.trim()) replyMutation.mutate(replyText); }}
                disabled={!replyText.trim() || replyMutation.isPending}
                data-testid={`button-send-reply-${comment.id}`}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setShowReplyInput(false)}
              >
                ✕
              </Button>
            </div>
          </div>
        )}

        {/* Show/hide replies toggle */}
        {replyCount > 0 && (
          <button
            className="flex items-center gap-1.5 text-xs text-primary mt-2 hover:underline font-medium"
            onClick={() => setShowReplies(!showReplies)}
            data-testid={`button-toggle-replies-${comment.id}`}
          >
            {showReplies ? (
              <><ChevronUp className="h-3.5 w-3.5" /> Hide {replyCount === 1 ? "reply" : `${replyCount} replies`}</>
            ) : (
              <><ChevronDown className="h-3.5 w-3.5" /> View {replyCount} {replyCount === 1 ? "reply" : "replies"}</>
            )}
          </button>
        )}

        {/* Replies list */}
        {showReplies && (
          <div className="mt-3 space-y-3">
            {repliesLoading ? (
              <p className="text-xs text-muted-foreground">Loading replies…</p>
            ) : (
              replies.map((reply) => (
                <ReplyItem
                  key={reply.id}
                  reply={reply}
                  commentAuthorUsername={comment.user.username}
                  navigate={goTo}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReplyItemProps {
  reply: CommentReply;
  commentAuthorUsername: string;
  navigate: (path: string) => void;
}

function ReplyItem({ reply, commentAuthorUsername, navigate }: ReplyItemProps) {
  const { toast } = useToast();
  const [replyLiked, setReplyLiked] = useState(false);
  const [replyLikeCount, setReplyLikeCount] = useState(0);

  const displayName = reply.user.displayName || reply.user.organizationName || reply.user.username;

  const handleLike = () => {
    setReplyLiked(!replyLiked);
    setReplyLikeCount((c) => (replyLiked ? c - 1 : c + 1));
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/feed?reply=${reply.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied!" });
    } catch {
      toast({ title: "Link copied!" });
    }
  };

  const goToProfile = () => navigate(reply.user.id ? `/user/${reply.user.id}` : `/profile/${reply.user.username}`);

  return (
    <div className="flex gap-2.5" data-testid={`reply-${reply.id}`}>
      <Avatar
        className="h-7 w-7 flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={goToProfile}
      >
        <AvatarImage src={reply.user.avatarUrl || ""} alt={displayName} />
        <AvatarFallback className="bg-primary/10 text-primary text-xs">
          {displayName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap mb-0.5">
          <button
            className="font-semibold text-xs hover:underline"
            onClick={goToProfile}
          >
            {displayName}
          </button>
          <span className="text-[11px] text-muted-foreground">@{reply.user.username}</span>
          <span className="text-[11px] text-muted-foreground">·</span>
          <span className="text-[11px] text-muted-foreground">{relativeTime(reply.createdAt)}</span>
        </div>

        <p className="text-sm break-words leading-relaxed">
          {renderWithMentions(reply.content, navigate)}
        </p>

        <div className="flex items-center gap-0 mt-1 -ml-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 px-1.5 text-[11px] gap-1 ${replyLiked ? "text-red-500" : "text-muted-foreground"} hover:text-red-500`}
            onClick={handleLike}
          >
            <Heart className={`h-3 w-3 ${replyLiked ? "fill-current" : ""}`} />
            {replyLikeCount > 0 && <span>{replyLikeCount}</span>}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary"
            onClick={handleShare}
          >
            <Share2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
