import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  Send, 
  Heart, 
  MessageCircle, 
  Repeat2, 
  Share2, 
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useLocation } from "wouter";

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

  const handleProfileClick = () => {
    const path = comment.user.id ? `/user/${comment.user.id}` : `/profile/${comment.user.username}`;
    if (onNavigate) {
      onNavigate(path);
    } else {
      navigate(path);
    }
  };

  // Like status query
  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ['/api/comments', comment.id, 'likes'],
  });

  // Replies query
  const { data: repliesData } = useQuery<{ replies: CommentReply[]; count: number }>({
    queryKey: ['/api/comments', comment.id, 'replies'],
    enabled: showReplies,
  });

  // Repost status query
  const { data: repostData } = useQuery<{ hasReposted: boolean; repostCount: number }>({
    queryKey: ['/api/comments', comment.id, 'repost-status'],
  });

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (likeData?.isLiked) {
        return await apiRequest('DELETE', `/api/comments/${comment.id}/like`, {});
      }
      return await apiRequest('POST', `/api/comments/${comment.id}/like`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/comments', comment.id, 'likes'] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update like",
        variant: "destructive",
      });
    },
  });

  const repostMutation = useMutation({
    mutationFn: async () => {
      if (repostData?.hasReposted) {
        return await apiRequest('DELETE', `/api/comments/${comment.id}/repost`, {});
      }
      return await apiRequest('POST', `/api/comments/${comment.id}/repost`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/comments', comment.id, 'repost-status'] });
      toast({
        title: repostData?.hasReposted ? "Repost removed" : "Reposted!",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update repost",
        variant: "destructive",
      });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest('POST', `/api/comments/${comment.id}/replies`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/comments', comment.id, 'replies'] });
      setReplyText("");
      setShowReplyInput(false);
      setShowReplies(true);
      toast({
        title: "Reply added!",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add reply",
        variant: "destructive",
      });
    },
  });

  const handleShare = async () => {
    const shareUrl = `${window.location.origin}/feed?comment=${comment.id}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Check out this comment',
          text: comment.content,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        toast({
          title: "Link copied!",
          description: "Comment link has been copied to clipboard",
        });
      }
    } catch {
      await navigator.clipboard.writeText(shareUrl);
      toast({
        title: "Link copied!",
        description: "Comment link has been copied to clipboard",
      });
    }
  };

  const handleReply = () => {
    if (replyText.trim()) {
      replyMutation.mutate(replyText);
    }
  };

  const likeCount = likeData?.count ?? 0;
  const isLiked = likeData?.isLiked ?? false;
  const replyCount = repliesData?.count ?? 0;
  const repostCount = repostData?.repostCount ?? 0;
  const hasReposted = repostData?.hasReposted ?? false;
  const replies = repliesData?.replies ?? [];

  return (
    <div className="space-y-2" data-testid={`comment-${comment.id}`}>
      <div className="flex gap-3">
        <Avatar 
          className="h-10 w-10 flex-shrink-0 cursor-pointer hover-elevate"
          onClick={handleProfileClick}
        >
          <AvatarImage src={comment.user.avatarUrl || ""} alt={comment.user.displayName || comment.user.username} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm">
            {(comment.user.displayName || comment.user.organizationName || comment.user.username).charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="bg-muted rounded-lg px-3 py-2">
            <p 
              className="font-semibold text-sm cursor-pointer hover:underline"
              onClick={handleProfileClick}
            >
              {comment.user.displayName || comment.user.organizationName || comment.user.username}
            </p>
            <p className="text-sm mt-1 break-words" data-testid={`comment-text-${comment.id}`}>
              {renderContent ? renderContent(comment.content) : comment.content}
            </p>
          </div>
          
          {/* Interaction buttons */}
          <div className="flex items-center gap-1 mt-1 px-1">
            <Button
              variant="ghost"
              size="sm"
              className={`h-7 px-2 text-xs gap-1 ${isLiked ? 'text-red-500' : 'text-muted-foreground'}`}
              onClick={() => likeMutation.mutate()}
              disabled={likeMutation.isPending}
              data-testid={`button-like-comment-${comment.id}`}
            >
              <Heart className={`h-3.5 w-3.5 ${isLiked ? 'fill-current' : ''}`} />
              <span>{likeCount > 0 ? likeCount : ''}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1 text-muted-foreground"
              onClick={() => setShowReplyInput(!showReplyInput)}
              data-testid={`button-reply-comment-${comment.id}`}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span>{replyCount > 0 ? replyCount : ''}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={`h-7 px-2 text-xs gap-1 ${hasReposted ? 'text-green-500' : 'text-muted-foreground'}`}
              onClick={() => repostMutation.mutate()}
              disabled={repostMutation.isPending}
              data-testid={`button-repost-comment-${comment.id}`}
            >
              <Repeat2 className="h-3.5 w-3.5" />
              <span>{repostCount > 0 ? repostCount : ''}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={handleShare}
              data-testid={`button-share-comment-${comment.id}`}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>

            <span className="text-xs text-muted-foreground ml-auto">
              {format(new Date(comment.createdAt), 'MMM d, h:mm a')}
            </span>
          </div>

          {/* Reply input */}
          {showReplyInput && (
            <div className="flex items-center gap-2 mt-2 pl-2">
              <Input
                type="text"
                placeholder="Write a reply..."
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleReply();
                  }
                }}
                disabled={replyMutation.isPending}
                className="flex-1 h-8 text-sm"
                data-testid={`input-reply-${comment.id}`}
              />
              <Button
                size="icon"
                className="h-8 w-8"
                onClick={handleReply}
                disabled={!replyText.trim() || replyMutation.isPending}
                data-testid={`button-send-reply-${comment.id}`}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {/* Show replies toggle */}
          {replyCount > 0 && (
            <Collapsible open={showReplies} onOpenChange={setShowReplies}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-primary mt-1"
                  data-testid={`button-toggle-replies-${comment.id}`}
                >
                  {showReplies ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5 mr-1" />
                      Hide replies
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5 mr-1" />
                      View {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                    </>
                  )}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-4 mt-2 space-y-2 border-l-2 border-muted pl-4">
                  {replies.map((reply) => (
                    <div key={reply.id} className="flex gap-2" data-testid={`reply-${reply.id}`}>
                      <Avatar className="h-7 w-7 flex-shrink-0">
                        <AvatarImage src={reply.user.avatarUrl || ""} alt={reply.user.displayName || reply.user.username} />
                        <AvatarFallback className="bg-primary/10 text-primary text-xs">
                          {(reply.user.displayName || reply.user.organizationName || reply.user.username).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="bg-muted/50 rounded-lg px-2 py-1.5">
                          <p className="font-medium text-xs">
                            {reply.user.displayName || reply.user.organizationName || reply.user.username}
                          </p>
                          <p className="text-xs mt-0.5 break-words">
                            {reply.content}
                          </p>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5 px-2">
                          {format(new Date(reply.createdAt), 'MMM d, h:mm a')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  );
}
