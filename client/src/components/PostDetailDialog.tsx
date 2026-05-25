import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useState, useEffect, useRef, Fragment } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import CommentItem from "./CommentItem";
import ImageGrid from "./ImageGrid";
import FeedVideoPlayer from "./FeedVideoPlayer";
import { HeartIcon, MessageCircleIcon, Share2Icon, BookmarkIcon, Repeat2Icon, SendIcon } from "@/components/ui/icons";

interface PostDetailDialogProps {
  open: boolean;
  onClose: () => void;
  postId: string;
  author: {
    name: string;
    username: string;
    avatar?: string;
    userId?: string;
  };
  content: string;
  image?: string;
  imageUrls?: string[];
  videoUrl?: string;
  createdAt?: string | Date;
  highlightCommentId?: string;
}

function renderContentWithLinkedMentionsAndHashtags(
  content: string, 
  navigate: (path: string) => void
) {
  const parts: (string | JSX.Element)[] = [];
  const regex = /(@\w+|#\w+)/g;
  let lastIndex = 0;
  let match;
  let partIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    
    const token = match[0];
    if (token.startsWith('@')) {
      const username = token.slice(1);
      parts.push(
        <button
          key={`mention-${partIndex++}`}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/profile/${username}`);
          }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    } else if (token.startsWith('#')) {
      const hashtag = token.slice(1);
      parts.push(
        <button
          key={`hashtag-${partIndex++}`}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/search?tag=${hashtag}`);
          }}
          className="text-primary hover:underline font-medium"
        >
          {token}
        </button>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts;
}

function formatFullDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, 'h:mm a · MMM d, yyyy');
}

export default function PostDetailDialog({
  open,
  onClose,
  postId,
  author,
  content,
  image,
  imageUrls,
  videoUrl,
  createdAt,
  highlightCommentId,
}: PostDetailDialogProps) {
  const allImages = [
    ...(imageUrls || []),
    ...(image && !imageUrls?.includes(image) ? [image] : []),
  ].filter(Boolean) as string[];
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [newComment, setNewComment] = useState('');
  const [highlightActive, setHighlightActive] = useState(true);
  const commentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const { data: commentsData, isLoading: commentsLoading } = useQuery<{ comments: any[]; count: number }>({
    queryKey: ['/api/posts', postId, 'comments'],
    enabled: open,
  });

  const comments = commentsData?.comments || [];

  // Reset highlight pulse whenever targeting a new comment
  useEffect(() => {
    setHighlightActive(true);
  }, [highlightCommentId]);

  // Once comments have loaded, scroll to the targeted comment and schedule fade-out
  useEffect(() => {
    if (!highlightCommentId || commentsLoading || comments.length === 0) return;
    const el = commentRefs.current.get(highlightCommentId);
    if (!el) return;
    const scrollTimer = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    const fadeTimer = setTimeout(() => {
      setHighlightActive(false);
    }, 2800);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(fadeTimer);
    };
  }, [highlightCommentId, commentsLoading, comments.length]);

  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ['/api/posts', postId, 'likes'],
    enabled: open,
  });

  const { data: repostData } = useQuery<{ hasReposted: boolean; repostCount: number }>({
    queryKey: ['/api/posts', postId, 'repost-status'],
    enabled: open,
    queryFn: async () => {
      try {
        const response = await fetch(`/api/posts/${postId}/repost-status`);
        if (!response.ok) return { hasReposted: false, repostCount: 0 };
        return response.json();
      } catch {
        return { hasReposted: false, repostCount: 0 };
      }
    },
  });

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (likeData?.isLiked) {
        return await apiRequest('DELETE', `/api/posts/${postId}/like`, {});
      }
      return await apiRequest('POST', `/api/posts/${postId}/like`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', postId, 'likes'] });
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
        return await apiRequest('DELETE', `/api/posts/${postId}/repost`, {});
      }
      return await apiRequest('POST', `/api/posts/${postId}/repost`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', postId, 'repost-status'] });
      toast({
        title: repostData?.hasReposted ? "Repost removed" : "Reposted!",
        description: repostData?.hasReposted ? "Repost has been removed" : "Post shared to your followers",
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

  const commentMutation = useMutation({
    mutationFn: async (content: string) => {
      return await apiRequest('POST', `/api/posts/${postId}/comments`, { content });
    },
    onSuccess: () => {
      setNewComment('');
      queryClient.invalidateQueries({ queryKey: ['/api/posts', postId, 'comments'] });
      toast({
        title: "Comment added",
        description: "Your comment has been posted",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to post comment",
        variant: "destructive",
      });
    },
  });

  const handleShare = () => {
    const postUrl = `${window.location.origin}/posts/${postId}`;
    navigator.clipboard.writeText(postUrl).then(() => {
      toast({
        title: "Link copied!",
        description: "Post link copied to clipboard",
      });
    });
  };

  const handleSubmitComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (newComment.trim()) {
      commentMutation.mutate(newComment.trim());
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Post</DialogTitle>
          <DialogDescription className="sr-only">
            View full post details, comments, and interact with the post
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6">
            <div className="flex gap-3">
              <Avatar 
                className="h-12 w-12 cursor-pointer hover-elevate" 
                onClick={() => {
                  if (author.userId) navigate(`/user/${author.userId}`);
                  else navigate(`/profile/${author.username}`);
                  onClose();
                }}
                data-testid={`dialog-avatar-${postId}`}
              >
                <AvatarImage src={author.avatar} alt={author.name} />
                <AvatarFallback>
                  {author.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1">
                <div className="flex flex-col">
                  <p className="font-semibold text-base" data-testid={`dialog-author-${postId}`}>
                    {author.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    @{author.username}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-base whitespace-pre-wrap leading-relaxed" data-testid={`dialog-content-${postId}`}>
                {renderContentWithLinkedMentionsAndHashtags(content, (path) => {
                  navigate(path);
                  onClose();
                })}
              </p>
            </div>

            {videoUrl && (
              <div className="mt-4" data-testid={`dialog-video-${postId}`}>
                <FeedVideoPlayer src={videoUrl} />
              </div>
            )}

            {!videoUrl && allImages.length > 0 && (
              <div className="mt-4" data-testid={`dialog-images-${postId}`}>
                <ImageGrid 
                  images={allImages} 
                  maxImages={4}
                  postData={{
                    id: postId,
                    likesCount: likeData?.count || 0,
                    commentsCount: comments.length,
                    repostsCount: repostData?.repostCount || 0,
                    isLiked: likeData?.isLiked || false,
                    isReposted: repostData?.hasReposted || false,
                    author: {
                      id: author.userId || "",
                      username: author.username,
                      displayName: author.name,
                      avatarUrl: author.avatar,
                    },
                  }}
                  currentUser={currentUser ? {
                    id: currentUser.id,
                    username: currentUser.username,
                    displayName: currentUser.displayName || currentUser.username,
                    avatarUrl: undefined,
                  } : null}
                />
              </div>
            )}

            {createdAt && (
              <p className="mt-4 text-sm text-muted-foreground">
                {formatFullDateTime(createdAt)}
              </p>
            )}

            <div className="flex items-center justify-between pt-4 mt-4 border-t">
              <div className="flex items-center gap-6">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`gap-2 ${likeData?.isLiked ? 'text-primary' : ''}`}
                  onClick={() => likeMutation.mutate()}
                  disabled={likeMutation.isPending}
                  data-testid={`dialog-like-${postId}`}
                >
                  <HeartIcon className={`h-5 w-5 ${likeData?.isLiked ? 'fill-current' : ''}`} />
                  <span>{likeData?.count || 0}</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  data-testid={`dialog-comment-count-${postId}`}
                >
                  <MessageCircleIcon className="h-5 w-5" />
                  <span>{comments.length}</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  className={`gap-2 ${repostData?.hasReposted ? 'text-green-500' : ''}`}
                  onClick={() => repostMutation.mutate()}
                  disabled={repostMutation.isPending}
                  data-testid={`dialog-repost-${postId}`}
                >
                  <Repeat2Icon className={`h-5 w-5 ${repostData?.hasReposted ? 'fill-current' : ''}`} />
                  <span>{repostData?.repostCount || 0}</span>
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleShare}
                  data-testid={`dialog-share-${postId}`}
                >
                  <Share2Icon className="h-5 w-5" />
                </Button>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t">
              <h3 className="font-semibold text-sm mb-4">Comments</h3>
              
              <form onSubmit={handleSubmitComment} className="flex gap-2 mb-4">
                <Input
                  placeholder="Add a comment..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  className="flex-1"
                  data-testid={`dialog-comment-input-${postId}`}
                />
                <Button 
                  type="submit" 
                  size="icon"
                  disabled={!newComment.trim() || commentMutation.isPending}
                  data-testid={`dialog-comment-submit-${postId}`}
                >
                  <SendIcon className="h-4 w-4" />
                </Button>
              </form>

              {commentsLoading ? (
                <p className="text-sm text-muted-foreground">Loading comments...</p>
              ) : comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet. Be the first to comment!</p>
              ) : (
                <div className="space-y-4">
                  {comments.map((comment: any) => {
                    const isHighlighted = comment.id === highlightCommentId;
                    return (
                      <div
                        key={comment.id}
                        ref={(el) => {
                          if (el) commentRefs.current.set(comment.id, el);
                          else commentRefs.current.delete(comment.id);
                        }}
                        className={`rounded-lg transition-[background-color] duration-1000 ${
                          isHighlighted && highlightActive
                            ? "bg-primary/10"
                            : "bg-transparent"
                        }`}
                      >
                        <CommentItem
                          comment={comment}
                          postId={postId}
                          onNavigate={(path) => {
                            navigate(path);
                            onClose();
                          }}
                          renderContent={(content) => (
                            <>
                              {renderContentWithLinkedMentionsAndHashtags(content, (path) => {
                                navigate(path);
                                onClose();
                              })}
                            </>
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
