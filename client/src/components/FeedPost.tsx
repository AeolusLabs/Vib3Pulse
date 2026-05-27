import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import CommentDialog from "@/components/CommentDialog";
import UnifiedShareModal from "@/components/UnifiedShareModal";
import LinkPreviewCard, { extractFirstUrl } from "@/components/LinkPreviewCard";
import ImageGrid from "@/components/ImageGrid";
import FeedVideoPlayer from "@/components/FeedVideoPlayer";
import EventDetailsModal from "@/components/EventDetailsModal";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { Event, Venue } from "@shared/schema";
import { HeartIcon, MessageCircleIcon, Share2Icon, BookmarkIcon, Repeat2Icon, CalendarIcon, MapPinIcon, Building2Icon, MoreHorizontalIcon, Trash2Icon } from "@/components/ui/icons";
import { BadgeCheck } from "lucide-react";

function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const postDate = typeof date === "string" ? new Date(date) : date;
  const diffInSeconds = Math.floor((now.getTime() - postDate.getTime()) / 1000);

  if (diffInSeconds < 60) return diffInSeconds <= 5 ? "Just now" : `${diffInSeconds}s`;
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d`;
  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) return `${diffInWeeks}w`;
  return format(postDate, "MMM d, yyyy");
}

interface MentionedUser {
  username: string;
  avatarUrl?: string | null;
  displayName?: string | null;
}

interface FeedPostProps {
  id: string;
  author: {
    name: string;
    username: string;
    avatar?: string;
    isOrganizer?: boolean;
    isVerified?: boolean;
    userId?: string;
  };
  content: string;
  image?: string;
  imageUrls?: string[];
  videoUrl?: string | null;
  timestamp?: string;
  createdAt?: string | Date;
  likes: number;
  comments: number;
  isLiked?: boolean;
  isRepost?: boolean;
  repostedBy?: { name: string; username: string; userId?: string };
  eventId?: string | null;
  venueId?: string | null;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
  community?: { id: string; name: string; slug?: string } | null;
  mentionedUsers?: MentionedUser[];
  hasActiveStory?: boolean;
  /** When true: renders flat/borderless for the main feed timeline */
  feedMode?: boolean;
  onPostClick?: () => void;
}

function renderContent(
  content: string,
  navigate: (path: string) => void,
  mentionedUsers: MentionedUser[] = []
) {
  const parts: (string | JSX.Element)[] = [];
  const regex = /(@\w+|#\w+)/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  const userMap = new Map(mentionedUsers.map((u) => [u.username.toLowerCase(), u]));

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith("@")) {
      const username = token.slice(1);
      const mentioned = userMap.get(username.toLowerCase());
      parts.push(
        <button
          key={`m-${i++}`}
          onClick={(e) => { e.stopPropagation(); navigate(`/profile/${username}`); }}
          className="inline-flex items-center gap-0.5 text-primary hover:underline font-medium"
          data-testid={`mention-${username}`}
        >
          {mentioned?.avatarUrl && (
            <img src={mentioned.avatarUrl} alt={username} className="h-4 w-4 rounded-full object-cover inline-block" />
          )}
          {token}
        </button>
      );
    } else {
      const tag = token.slice(1);
      parts.push(
        <button
          key={`h-${i++}`}
          onClick={(e) => { e.stopPropagation(); navigate(`/search?tag=${tag}`); }}
          className="text-primary hover:underline font-medium"
          data-testid={`hashtag-${tag}`}
        >
          {token}
        </button>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts;
}

export default function FeedPost({
  id,
  author,
  content,
  image,
  imageUrls = [],
  videoUrl,
  timestamp,
  createdAt,
  likes: initialLikes,
  comments: initialComments,
  isLiked: initialIsLiked = false,
  isRepost = false,
  repostedBy,
  eventId,
  venueId,
  attachedEvent,
  attachedVenue,
  community,
  mentionedUsers = [],
  hasActiveStory = false,
  feedMode = false,
  onPostClick,
}: FeedPostProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [eventModalEvent, setEventModalEvent] = useState<Event | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [likeAnimating, setLikeAnimating] = useState(false);
  const [displayTime, setDisplayTime] = useState(() =>
    createdAt ? formatRelativeTime(createdAt) : timestamp || "Just now"
  );

  const isOwnPost = currentUser?.id === author.userId;

  useEffect(() => {
    if (!createdAt) return;
    setDisplayTime(formatRelativeTime(createdAt));
    const interval = setInterval(() => setDisplayTime(formatRelativeTime(createdAt)), 30000);
    return () => clearInterval(interval);
  }, [createdAt]);

  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ["/api/posts", id, "likes"],
    staleTime: 0,
  });

  const { data: commentsData } = useQuery<{ comments: any[]; count: number }>({
    queryKey: ["/api/posts", id, "comments"],
    staleTime: 0,
  });
  const comments = commentsData?.comments || [];
  const commentCount = commentsData?.count ?? comments.length;

  const [bookmarkStatus, setBookmarkStatus] = useState(false);

  const { data: repostData } = useQuery<{ hasReposted: boolean; repostCount: number }>({
    queryKey: ["/api/posts", id, "repost-status"],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/posts/${id}/repost-status`);
        if (!res.ok) return { hasReposted: false, repostCount: 0 };
        return res.json();
      } catch {
        return { hasReposted: false, repostCount: 0 };
      }
    },
  });

  const { data: fetchedEvent } = useQuery<Event>({
    queryKey: ["/api/events", eventId],
    enabled: !!eventId && !attachedEvent,
  });
  const { data: fetchedVenue } = useQuery<Venue>({
    queryKey: ["/api/venues", venueId],
    enabled: !!venueId && !attachedVenue,
  });
  const displayEvent = attachedEvent || fetchedEvent;
  const displayVenue = attachedVenue || fetchedVenue;

  // ── Mutations ──────────────────────────────────────────────────────────────

  const likeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/posts/${id}/like`, {}),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/posts", id, "likes"] });
      const prev = queryClient.getQueryData(["/api/posts", id, "likes"]);
      queryClient.setQueryData(["/api/posts", id, "likes"], (old: any) => ({
        count: (old?.count || 0) + 1,
        isLiked: true,
      }));
      return { prev };
    },
    onError: (_, __, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/posts", id, "likes"], ctx.prev);
      toast({ title: "Error", description: "Failed to like post", variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/posts", id, "likes"] }),
  });

  const unlikeMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/posts/${id}/like`, {}),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/posts", id, "likes"] });
      const prev = queryClient.getQueryData(["/api/posts", id, "likes"]);
      queryClient.setQueryData(["/api/posts", id, "likes"], (old: any) => ({
        count: Math.max((old?.count || 1) - 1, 0),
        isLiked: false,
      }));
      return { prev };
    },
    onError: (_, __, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/posts", id, "likes"], ctx.prev);
      toast({ title: "Error", description: "Failed to unlike post", variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/posts", id, "likes"] }),
  });

  const handleLike = () => {
    if (likeData?.isLiked) {
      unlikeMutation.mutate();
    } else {
      setLikeAnimating(true);
      setTimeout(() => setLikeAnimating(false), 400);
      likeMutation.mutate();
    }
  };

  const bookmarkMutation = useMutation({
    mutationFn: (currentlyBookmarked: boolean) =>
      currentlyBookmarked
        ? apiRequest("DELETE", `/api/posts/${id}/bookmark`, {})
        : apiRequest("POST", `/api/posts/${id}/bookmark`, {}),
    onMutate: (currentlyBookmarked) => {
      const prev = bookmarkStatus;
      setBookmarkStatus(!currentlyBookmarked);
      return { prev };
    },
    onSuccess: (_, currentlyBookmarked) => {
      toast({ title: currentlyBookmarked ? "Bookmark removed" : "Saved!" });
      queryClient.invalidateQueries({ queryKey: ["/api/bookmarks"] });
    },
    onError: (_, __, ctx) => {
      if (ctx?.prev !== undefined) setBookmarkStatus(ctx.prev);
      toast({ title: "Error", description: "Failed to update bookmark", variant: "destructive" });
    },
  });

  const repostMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/posts/${id}/repost`, {}),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/posts", id, "repost-status"] });
      const prev = queryClient.getQueryData(["/api/posts", id, "repost-status"]);
      queryClient.setQueryData(["/api/posts", id, "repost-status"], (old: any) => ({
        hasReposted: true,
        repostCount: (old?.repostCount || 0) + 1,
      }));
      return { prev };
    },
    onError: (_, __, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/posts", id, "repost-status"], ctx.prev);
      toast({ title: "Error", description: "Failed to repost", variant: "destructive" });
    },
    onSuccess: () => toast({ title: "Reposted!" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts", id, "repost-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/posts"] });
    },
  });

  const unrepostMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/posts/${id}/repost`, {}),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/posts", id, "repost-status"] });
      const prev = queryClient.getQueryData(["/api/posts", id, "repost-status"]);
      queryClient.setQueryData(["/api/posts", id, "repost-status"], (old: any) => ({
        hasReposted: false,
        repostCount: Math.max((old?.repostCount || 1) - 1, 0),
      }));
      return { prev };
    },
    onError: (_, __, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/posts", id, "repost-status"], ctx.prev);
      toast({ title: "Error", description: "Failed to remove repost", variant: "destructive" });
    },
    onSuccess: () => toast({ title: "Repost removed" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts", id, "repost-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/posts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/posts/${id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posts"] });
      toast({ title: "Post deleted" });
    },
    onError: () => toast({ title: "Error", description: "Failed to delete post", variant: "destructive" }),
  });

  const handleShare = () => setShareOpen(true);

  // ── Media ──────────────────────────────────────────────────────────────────

  // When a post has an attached event, skip post.imageUrl — the event card
  // shows the current image. This prevents a stale/black image appearing above the card.
  const allImages = [
    ...imageUrls,
    ...(image && !imageUrls.includes(image) && !eventId ? [image] : []),
  ].filter(Boolean) as string[];

  // ── Wrapper ────────────────────────────────────────────────────────────────

  const wrapperClass = feedMode
    ? "px-4 pt-4 pb-1 hover:bg-muted/20 transition-colors"
    : "p-4 hover-elevate rounded-xl border border-border bg-card";

  const Wrapper = feedMode
    ? ({ children }: { children: React.ReactNode }) => (
        <article className={wrapperClass} data-testid={`post-${id}`}>{children}</article>
      )
    : ({ children }: { children: React.ReactNode }) => (
        <Card className="p-4 hover-elevate" data-testid={`post-${id}`}>{children}</Card>
      );

  return (
    <Wrapper>
      {/* Repost banner */}
      {isRepost && repostedBy && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
          <Repeat2Icon className="h-3 w-3" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (repostedBy.userId) navigate(`/user/${repostedBy.userId}`);
              else navigate(`/profile/${repostedBy.username}`);
            }}
            className="hover:underline"
            data-testid={`repost-indicator-${id}`}
          >
            {repostedBy.name} reposted
          </button>
        </div>
      )}

      <div
        className="flex gap-3 cursor-pointer"
        onClick={() => onPostClick?.()}
      >
        {/* Avatar with optional story ring (A4) */}
        <div
          className={cn(
            "flex-shrink-0 cursor-pointer self-start",
            hasActiveStory &&
              "p-[2.5px] rounded-full bg-gradient-to-br from-primary via-purple-300 to-secondary"
          )}
          onClick={(e) => {
            e.stopPropagation();
            if (author.userId) navigate(`/user/${author.userId}`);
          }}
          data-testid={`avatar-${id}`}
        >
          <div className={cn(hasActiveStory && "p-[2px] bg-background rounded-full")}>
            <Avatar className="h-10 w-10">
              <AvatarImage src={author.avatar} alt={author.name} />
              <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                {author.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {/* Compact author row (A5) */}
          <div className="flex items-center gap-1.5 flex-wrap min-w-0 mb-1">
            <span className="font-semibold text-sm leading-tight" data-testid={`text-author-${id}`}>
              {author.name}
            </span>
            {author.isVerified && (
              <BadgeCheck className="h-[15px] w-[15px] text-blue-500 fill-blue-500 flex-shrink-0" data-testid={`badge-verified-${id}`} />
            )}
            {author.isOrganizer && (
              <span className="text-[11px] bg-primary/10 text-primary px-1.5 py-px rounded-full font-medium flex-shrink-0">
                Organizer
              </span>
            )}
            {community && (
              <Link
                href={`/community/${community.slug ?? community.id}`}
                onClick={(e) => e.stopPropagation()}
              >
                <Badge variant="outline" className="text-[11px] py-0 flex-shrink-0 cursor-pointer hover:bg-muted/50" data-testid={`community-tag-${id}`}>
                  in {community.name}
                </Badge>
              </Link>
            )}
            <span className="text-xs text-muted-foreground flex-shrink-0">
              @{author.username} · {displayTime}
            </span>
          </div>

          {/* Post content (A3) */}
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words" data-testid={`text-content-${id}`}>
            {renderContent(content, navigate, mentionedUsers)}
          </p>

          {/* Link preview */}
          {(() => {
            const firstUrl = extractFirstUrl(content);
            return firstUrl && !displayEvent && !displayVenue ? (
              <LinkPreviewCard url={firstUrl} />
            ) : null;
          })()}

          {/* Video */}
          {videoUrl && (
            <div className="mt-3" data-testid={`video-post-${id}`}>
              <FeedVideoPlayer src={videoUrl} />
            </div>
          )}

          {/* Images */}
          {!videoUrl && allImages.length > 0 && (
            <div className="mt-3" data-testid={`images-post-${id}`}>
              <ImageGrid
                images={allImages}
                maxImages={4}
                postData={{
                  id,
                  likesCount: likeData?.count || initialLikes,
                  commentsCount: initialComments,
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
                currentUser={
                  currentUser
                    ? {
                        id: currentUser.id,
                        username: currentUser.username,
                        displayName: currentUser.displayName || currentUser.username,
                        avatarUrl: undefined,
                      }
                    : null
                }
              />
            </div>
          )}

          {/* Attached event — full-width banner with modal on click */}
          {displayEvent && (
            <Card
              className="mt-3 border border-primary/25 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors overflow-hidden"
              onClick={(e) => { e.stopPropagation(); setEventModalEvent(displayEvent); }}
              data-testid={`attached-event-${id}`}
            >
              {displayEvent.imageUrl && (
                <div className="w-full h-40 overflow-hidden">
                  <img
                    src={displayEvent.imageUrl}
                    alt={displayEvent.title}
                    className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                  />
                </div>
              )}
              <CardContent className="p-3">
                <Badge variant="secondary" className="mb-1.5 text-xs">
                  <CalendarIcon className="h-3 w-3 mr-1" />Event
                </Badge>
                <h4 className="font-semibold text-sm line-clamp-1">{displayEvent.title}</h4>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <CalendarIcon className="h-3 w-3" />
                  {format(new Date(displayEvent.eventDate), "MMM d, yyyy")}
                </p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <MapPinIcon className="h-3 w-3" />
                  <span className="line-clamp-1">{displayEvent.location}</span>
                </p>
              </CardContent>
            </Card>
          )}

          {/* Attached venue */}
          {displayVenue && (
            <Card
              className="mt-3 border border-primary/25 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors"
              onClick={(e) => { e.stopPropagation(); navigate(`/discover?venue=${displayVenue.id}`); }}
              data-testid={`attached-venue-${id}`}
            >
              <CardContent className="p-3">
                <div className="flex gap-3">
                  {(displayVenue.coverImageUrl || displayVenue.imageUrl) && (
                    <img
                      src={displayVenue.coverImageUrl || displayVenue.imageUrl || ""}
                      alt={displayVenue.name}
                      className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <Badge variant="secondary" className="mb-1 text-xs">
                      <Building2Icon className="h-3 w-3 mr-1" />Venue
                    </Badge>
                    <h4 className="font-semibold text-sm line-clamp-1">{displayVenue.name}</h4>
                    <p className="text-xs text-muted-foreground">{displayVenue.category}</p>
                    {displayVenue.city && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPinIcon className="h-3 w-3" />
                        <span className="line-clamp-1">{displayVenue.city}</span>
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action bar (A2) */}
          <div className="flex items-center mt-2.5 -ml-2" onClick={(e) => e.stopPropagation()}>
            {/* Like */}
            <button
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1.5 rounded-full text-sm transition-all duration-150",
                likeData?.isLiked
                  ? "text-red-500"
                  : "text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
              )}
              onClick={handleLike}
              disabled={likeMutation.isPending || unlikeMutation.isPending}
              data-testid={`button-like-${id}`}
            >
              <HeartIcon
                className={cn(
                  "h-[18px] w-[18px] transition-transform duration-150",
                  likeData?.isLiked ? "fill-red-500" : "group-hover:scale-110",
                  likeAnimating && "animate-heart-pop"
                )}
              />
              <span className="text-xs font-medium tabular-nums">
                {(likeData?.count || 0) > 0 ? likeData?.count || 0 : ""}
              </span>
            </button>

            {/* Comment */}
            <button
              className="group flex items-center gap-1.5 px-2 py-1.5 rounded-full text-sm text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all duration-150"
              onClick={() => setCommentDialogOpen(true)}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircleIcon className="h-[18px] w-[18px] group-hover:scale-110 transition-transform duration-150" />
              <span className="text-xs font-medium tabular-nums">
                {commentCount > 0 ? commentCount : ""}
              </span>
            </button>

            {/* Repost */}
            <button
              className={cn(
                "group flex items-center gap-1.5 px-2 py-1.5 rounded-full text-sm transition-all duration-150",
                repostData?.hasReposted
                  ? "text-emerald-500"
                  : "text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10"
              )}
              onClick={() => repostData?.hasReposted ? unrepostMutation.mutate() : repostMutation.mutate()}
              disabled={repostMutation.isPending || unrepostMutation.isPending}
              data-testid={`button-repost-${id}`}
            >
              <Repeat2Icon
                className={cn(
                  "h-[18px] w-[18px] transition-transform duration-150",
                  repostData?.hasReposted ? "text-emerald-500" : "group-hover:scale-110"
                )}
              />
              <span className="text-xs font-medium tabular-nums">
                {(repostData?.repostCount || 0) > 0 ? repostData?.repostCount : ""}
              </span>
            </button>

            <div className="flex-1" />

            {/* Share */}
            <button
              className="group p-1.5 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all duration-150"
              onClick={handleShare}
              data-testid={`button-share-${id}`}
            >
              <Share2Icon className="h-[18px] w-[18px] group-hover:scale-110 transition-transform duration-150" />
            </button>

            {/* Bookmark */}
            <button
              className={cn(
                "group p-1.5 rounded-full transition-all duration-150",
                bookmarkStatus
                  ? "text-primary"
                  : "text-muted-foreground hover:text-primary hover:bg-primary/10"
              )}
              onClick={() => bookmarkMutation.mutate(bookmarkStatus)}
              disabled={bookmarkMutation.isPending}
              data-testid={`button-bookmark-${id}`}
            >
              <BookmarkIcon
                className={cn(
                  "h-[18px] w-[18px] transition-transform duration-150",
                  bookmarkStatus ? "fill-current" : "group-hover:scale-110"
                )}
              />
            </button>

            {/* More (own posts) */}
            {isOwnPost && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="group p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-150"
                    data-testid={`button-more-${id}`}
                  >
                    <MoreHorizontalIcon className="h-[18px] w-[18px]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => setDeleteDialogOpen(true)}
                    className="text-destructive focus:text-destructive"
                    data-testid={`menu-delete-${id}`}
                  >
                    <Trash2Icon className="h-4 w-4 mr-2" />
                    Delete post
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      {eventModalEvent && (
        <EventDetailsModal
          event={eventModalEvent}
          onClose={() => setEventModalEvent(null)}
        />
      )}

      <UnifiedShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        shareData={{ type: "post", id, title: content.slice(0, 80) || "Post" }}
      />

      <CommentDialog
        open={commentDialogOpen}
        onClose={() => setCommentDialogOpen(false)}
        postId={id}
        postSummary={{
          authorName: author.name,
          authorUsername: author.username,
          authorAvatar: author.avatar,
          content,
        }}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete post?</AlertDialogTitle>
            <AlertDialogDescription>
              This can't be undone. The post will be removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-${id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-delete-${id}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Wrapper>
  );
}
