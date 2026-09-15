import { ScrollArea } from "@/components/ui/scroll-area";
import UnifiedShareModal from "@/components/UnifiedShareModal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { format } from "date-fns";
import CommentItem from "./CommentItem";
import CommentComposer from "./CommentComposer";
import ImageGrid from "./ImageGrid";
import FeedVideoPlayer from "./FeedVideoPlayer";
import { HeartIcon, MessageCircleIcon, Share2Icon, Repeat2Icon, ArrowLeftIcon } from "@/components/ui/icons";

interface PostDetailViewProps {
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

function initialFor(user?: { username: string; displayName?: string | null; organizationName?: string | null } | null): string {
  if (!user) return "?";
  return (user.displayName || user.organizationName || user.username).charAt(0).toUpperCase();
}

// Full-bleed page for a single post — replaces the old centered-dialog
// treatment (PostDetailDialog) so opening a post feels like navigating to a
// dedicated screen, matching the platform convention of other social apps,
// with comments inline below rather than crammed into a modal.
export default function PostDetailView({
  onClose,
  postId,
  author,
  content,
  image,
  imageUrls,
  videoUrl,
  createdAt,
  highlightCommentId,
}: PostDetailViewProps) {
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
  const keyboardOffset = useKeyboardInset();

  const { data: commentsData, isLoading: commentsLoading } = useQuery<{ comments: any[]; count: number }>({
    queryKey: ['/api/posts', postId, 'comments'],
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
    }, 600);
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
  });

  const { data: repostData } = useQuery<{ hasReposted: boolean; repostCount: number }>({
    queryKey: ['/api/posts', postId, 'repost-status'],
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

  const [shareOpen, setShareOpen] = useState(false);
  const handleShare = () => setShareOpen(true);

  const handleSubmitComment = () => {
    if (newComment.trim()) {
      commentMutation.mutate(newComment.trim());
    }
  };

  return (
    <>
      <div className="h-screen flex flex-col bg-background">
        {/* Minimal header — just back + title, so the post itself is the
            focus rather than the app's global search/notification chrome */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-back">
            <ArrowLeftIcon className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold text-lg">Post</h1>
        </div>

        <ScrollArea className="flex-1">
          <div className="max-w-2xl mx-auto p-4 sm:p-6">
            <div className="flex gap-3">
              <Avatar
                className="h-12 w-12 cursor-pointer hover-elevate"
                onClick={() => {
                  if (author.userId) navigate(`/user/${author.userId}`);
                  else navigate(`/profile/${author.username}`);
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
                {renderContentWithLinkedMentionsAndHashtags(content, navigate)}
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
              <h3 className="font-semibold text-sm mb-4">
                {comments.length > 0 ? `${comments.length} Comment${comments.length === 1 ? '' : 's'}` : 'Comments'}
              </h3>

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
                          renderContent={(content) => (
                            <>{renderContentWithLinkedMentionsAndHashtags(content, navigate)}</>
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        {/* Composer stays pinned to the bottom of the viewport, above the
            keyboard, instead of scrolling away with the comment list */}
        <div
          className="border-t border-border bg-background px-4 py-3 flex-shrink-0"
          style={keyboardOffset > 0 ? { paddingBottom: keyboardOffset } : undefined}
        >
          <div className="max-w-2xl mx-auto">
            <CommentComposer
              value={newComment}
              onChange={setNewComment}
              onSubmit={handleSubmitComment}
              avatarUrl={currentUser?.avatarUrl}
              avatarInitial={initialFor(currentUser)}
              disabled={commentMutation.isPending}
              data-testid="post-detail-composer"
            />
          </div>
        </div>
      </div>

      <UnifiedShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        shareData={{ type: "post", id: postId, title: content.slice(0, 80) || "Post" }}
      />
    </>
  );
}
