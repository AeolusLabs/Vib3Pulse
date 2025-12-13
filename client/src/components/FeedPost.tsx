import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Heart, MessageCircle, Share2, Bookmark, Repeat2, Calendar, MapPin, Building2, MoreHorizontal, Trash2 } from "lucide-react";
import { useState, useEffect, Fragment } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import CommentDialog from "@/components/CommentDialog";
import { format } from "date-fns";
import type { Event, Venue } from "@shared/schema";

function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const postDate = typeof date === 'string' ? new Date(date) : date;
  const diffInSeconds = Math.floor((now.getTime() - postDate.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return diffInSeconds <= 5 ? 'Just now' : `${diffInSeconds}s`;
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}h`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) {
    return `${diffInDays}d`;
  }

  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) {
    return `${diffInWeeks}w`;
  }

  return format(postDate, 'MMM d, yyyy');
}

interface FeedPostProps {
  id: string;
  author: {
    name: string;
    username: string;
    avatar?: string;
    isOrganizer?: boolean;
    userId?: string;
  };
  content: string;
  image?: string;
  timestamp?: string;
  createdAt?: string | Date;
  likes: number;
  comments: number;
  isLiked?: boolean;
  isRepost?: boolean;
  repostedBy?: {
    name: string;
    username: string;
    userId?: string;
  };
  eventId?: string | null;
  venueId?: string | null;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
  onPostClick?: () => void;
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
          data-testid={`mention-${username}`}
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
          data-testid={`hashtag-${hashtag}`}
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

export default function FeedPost({
  id,
  author,
  content,
  image,
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
  onPostClick,
}: FeedPostProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [displayTime, setDisplayTime] = useState(() => 
    createdAt ? formatRelativeTime(createdAt) : timestamp || 'Just now'
  );
  
  const isOwnPost = currentUser?.id === author.userId;

  useEffect(() => {
    if (!createdAt) return;
    
    setDisplayTime(formatRelativeTime(createdAt));
    
    const interval = setInterval(() => {
      setDisplayTime(formatRelativeTime(createdAt));
    }, 30000);
    
    return () => clearInterval(interval);
  }, [createdAt]);

  // Fetch like status and count from API
  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: ['/api/posts', id, 'likes'],
    staleTime: 0,
  });

  // Fetch comment count (always fetch to show count, not just when dialog is open)
  const { data: commentsData } = useQuery<{ comments: any[]; count: number }>({
    queryKey: ['/api/posts', id, 'comments'],
    staleTime: 0,
  });
  
  const comments = commentsData?.comments || [];
  const commentCount = commentsData?.count ?? comments.length;

  // Fetch bookmark status (we'll need to add this endpoint or track it in posts)
  const [bookmarkStatus, setBookmarkStatus] = useState(false);

  // Fetch repost status and count
  const { data: repostData } = useQuery<{ hasReposted: boolean; repostCount: number }>({
    queryKey: ['/api/posts', id, 'repost-status'],
    queryFn: async () => {
      try {
        const response = await fetch(`/api/posts/${id}/repost-status`);
        if (!response.ok) return { hasReposted: false, repostCount: 0 };
        return response.json();
      } catch {
        return { hasReposted: false, repostCount: 0 };
      }
    },
  });

  // Fetch attached event if we have an eventId but no attachedEvent prop
  const { data: fetchedEvent } = useQuery<Event>({
    queryKey: ['/api/events', eventId],
    enabled: !!eventId && !attachedEvent,
  });

  // Fetch attached venue if we have a venueId but no attachedVenue prop
  const { data: fetchedVenue } = useQuery<Venue>({
    queryKey: ['/api/venues', venueId],
    enabled: !!venueId && !attachedVenue,
  });

  // Use provided attached data or fetched data
  const displayEvent = attachedEvent || fetchedEvent;
  const displayVenue = attachedVenue || fetchedVenue;

  // Like/Unlike mutations with optimistic updates
  const likeMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', `/api/posts/${id}/like`, {});
    },
    onMutate: async () => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/posts', id, 'likes'] });
      
      // Snapshot previous value
      const previousLikes = queryClient.getQueryData(['/api/posts', id, 'likes']);
      
      // Optimistically update
      queryClient.setQueryData(['/api/posts', id, 'likes'], (old: any) => ({
        count: (old?.count || 0) + 1,
        isLiked: true,
      }));
      
      return { previousLikes };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousLikes) {
        queryClient.setQueryData(['/api/posts', id, 'likes'], context.previousLikes);
      }
      toast({
        title: "Error",
        description: "Failed to like post",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', id, 'likes'] });
    },
  });

  const unlikeMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', `/api/posts/${id}/like`, {});
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['/api/posts', id, 'likes'] });
      const previousLikes = queryClient.getQueryData(['/api/posts', id, 'likes']);
      
      queryClient.setQueryData(['/api/posts', id, 'likes'], (old: any) => ({
        count: Math.max((old?.count || 1) - 1, 0),
        isLiked: false,
      }));
      
      return { previousLikes };
    },
    onError: (err, variables, context) => {
      if (context?.previousLikes) {
        queryClient.setQueryData(['/api/posts', id, 'likes'], context.previousLikes);
      }
      toast({
        title: "Error",
        description: "Failed to unlike post",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', id, 'likes'] });
    },
  });

  const handleLike = () => {
    if (likeData?.isLiked) {
      unlikeMutation.mutate();
    } else {
      likeMutation.mutate();
    }
  };

  const handleAvatarClick = () => {
    if (author.userId) {
      navigate(`/user/${author.userId}`);
    }
  };

  const handleShare = () => {
    // Copy post link to clipboard
    const postUrl = `${window.location.origin}/posts/${id}`;
    navigator.clipboard.writeText(postUrl).then(() => {
      toast({
        title: "Link copied!",
        description: "Post link copied to clipboard",
      });
    });
  };

  const bookmarkMutation = useMutation({
    mutationFn: async (currentlyBookmarked: boolean) => {
      if (currentlyBookmarked) {
        return await apiRequest('DELETE', `/api/posts/${id}/bookmark`, {});
      } else {
        return await apiRequest('POST', `/api/posts/${id}/bookmark`, {});
      }
    },
    onMutate: async (currentlyBookmarked) => {
      // Optimistically update local state
      const previousState = bookmarkStatus;
      setBookmarkStatus(!currentlyBookmarked);
      return { previousState };
    },
    onSuccess: (_, currentlyBookmarked) => {
      toast({
        title: currentlyBookmarked ? "Removed bookmark" : "Post saved!",
        description: currentlyBookmarked ? "Post removed from bookmarks" : "Post saved to bookmarks",
      });
      // Invalidate any bookmark list queries
      queryClient.invalidateQueries({ queryKey: ['/api/bookmarks'] });
    },
    onError: (_, __, context) => {
      // Rollback on error
      if (context?.previousState !== undefined) {
        setBookmarkStatus(context.previousState);
      }
      toast({
        title: "Error",
        description: "Failed to update bookmark",
        variant: "destructive",
      });
    },
  });

  const handleBookmark = () => {
    bookmarkMutation.mutate(bookmarkStatus);
  };

  // Repost mutation
  const repostMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', `/api/posts/${id}/repost`, {});
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['/api/posts', id, 'repost-status'] });
      const previousData = queryClient.getQueryData(['/api/posts', id, 'repost-status']);
      queryClient.setQueryData(['/api/posts', id, 'repost-status'], (old: any) => ({
        hasReposted: true,
        repostCount: (old?.repostCount || 0) + 1,
      }));
      return { previousData };
    },
    onError: (_, __, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['/api/posts', id, 'repost-status'], context.previousData);
      }
      toast({
        title: "Error",
        description: "Failed to repost",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      toast({
        title: "Reposted!",
        description: "Post shared to your followers",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', id, 'repost-status'] });
      queryClient.invalidateQueries({ queryKey: ['/api/posts'] });
    },
  });

  const unrepostMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', `/api/posts/${id}/repost`, {});
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['/api/posts', id, 'repost-status'] });
      const previousData = queryClient.getQueryData(['/api/posts', id, 'repost-status']);
      queryClient.setQueryData(['/api/posts', id, 'repost-status'], (old: any) => ({
        hasReposted: false,
        repostCount: Math.max((old?.repostCount || 1) - 1, 0),
      }));
      return { previousData };
    },
    onError: (_, __, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['/api/posts', id, 'repost-status'], context.previousData);
      }
      toast({
        title: "Error",
        description: "Failed to remove repost",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      toast({
        title: "Repost removed",
        description: "Repost has been removed",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts', id, 'repost-status'] });
      queryClient.invalidateQueries({ queryKey: ['/api/posts'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', `/api/posts/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts'] });
      toast({
        title: "Post deleted",
        description: "Your post has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete post. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleRepost = () => {
    if (repostData?.hasReposted) {
      unrepostMutation.mutate();
    } else {
      repostMutation.mutate();
    }
  };

  return (
    <Card className="p-4 hover-elevate" data-testid={`post-${id}`}>
      {isRepost && repostedBy && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
          <Repeat2 className="h-3 w-3" />
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
        <Avatar 
          className="h-10 w-10 cursor-pointer hover-elevate" 
          onClick={(e) => {
            e.stopPropagation();
            handleAvatarClick();
          }}
          data-testid={`avatar-${id}`}
        >
          <AvatarImage src={author.avatar} alt={author.name} />
          <AvatarFallback>
            {author.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm" data-testid={`text-author-${id}`}>
              {author.name}
            </p>
            <p className="text-xs text-muted-foreground">
              @{author.username}
            </p>
            {author.isOrganizer && (
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                Organizer
              </span>
            )}
            <span className="text-xs text-muted-foreground">· {displayTime}</span>
          </div>

          <p className="mt-2 text-sm whitespace-pre-wrap" data-testid={`text-content-${id}`}>
            {renderContentWithLinkedMentionsAndHashtags(content, navigate)}
          </p>

          {image && (
            <img
              src={image}
              alt="Post"
              className="mt-3 rounded-md w-full max-h-96 object-cover"
              data-testid={`img-post-${id}`}
            />
          )}

          {displayEvent && (
            <Card 
              className="mt-3 border-2 border-primary/30 bg-primary/5 cursor-pointer hover-elevate"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/discover?event=${displayEvent.id}`);
              }}
              data-testid={`attached-event-${id}`}
            >
              <CardContent className="p-3">
                <div className="flex gap-3">
                  {displayEvent.imageUrl && (
                    <img 
                      src={displayEvent.imageUrl} 
                      alt={displayEvent.title}
                      className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <Badge variant="secondary" className="mb-1 text-xs">
                      <Calendar className="h-3 w-3 mr-1" />
                      Event
                    </Badge>
                    <h4 className="font-semibold text-sm line-clamp-1">{displayEvent.title}</h4>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(displayEvent.eventDate), "MMM d, yyyy")}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      <span className="line-clamp-1">{displayEvent.location}</span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {displayVenue && (
            <Card 
              className="mt-3 border-2 border-primary/30 bg-primary/5 cursor-pointer hover-elevate"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/discover?venue=${displayVenue.id}`);
              }}
              data-testid={`attached-venue-${id}`}
            >
              <CardContent className="p-3">
                <div className="flex gap-3">
                  {(displayVenue.coverImageUrl || displayVenue.imageUrl) && (
                    <img 
                      src={displayVenue.coverImageUrl || displayVenue.imageUrl || ""} 
                      alt={displayVenue.name}
                      className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <Badge variant="secondary" className="mb-1 text-xs">
                      <Building2 className="h-3 w-3 mr-1" />
                      Venue
                    </Badge>
                    <h4 className="font-semibold text-sm line-clamp-1">{displayVenue.name}</h4>
                    <p className="text-xs text-muted-foreground">{displayVenue.category}</p>
                    {displayVenue.city && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        <span className="line-clamp-1">{displayVenue.city}</span>
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center gap-1 mt-3">
            <Button
              variant="ghost"
              size="sm"
              className={`gap-1 ${likeData?.isLiked ? 'text-primary' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleLike();
              }}
              disabled={likeMutation.isPending || unlikeMutation.isPending}
              data-testid={`button-like-${id}`}
            >
              <Heart className={`h-4 w-4 ${likeData?.isLiked ? 'fill-current' : ''}`} />
              <span className="text-xs">{likeData?.count || 0}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={(e) => {
                e.stopPropagation();
                setCommentDialogOpen(true);
              }}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircle className="h-4 w-4" />
              <span className="text-xs">{commentCount}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={`gap-1 ${repostData?.hasReposted ? 'text-green-500' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleRepost();
              }}
              disabled={repostMutation.isPending || unrepostMutation.isPending}
              data-testid={`button-repost-${id}`}
            >
              <Repeat2 className={`h-4 w-4 ${repostData?.hasReposted ? 'fill-current' : ''}`} />
              <span className="text-xs">{repostData?.repostCount || 0}</span>
            </Button>

            <div className="flex-1" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`button-more-${id}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => handleShare()} data-testid={`menu-share-${id}`}>
                  <Share2 className="h-4 w-4 mr-2" />
                  Share
                </DropdownMenuItem>
                <DropdownMenuItem 
                  onClick={() => handleBookmark()} 
                  disabled={bookmarkMutation.isPending}
                  data-testid={`menu-bookmark-${id}`}
                >
                  <Bookmark className={`h-4 w-4 mr-2 ${bookmarkStatus ? 'fill-current text-primary' : ''}`} />
                  {bookmarkStatus ? 'Saved' : 'Save'}
                </DropdownMenuItem>
                {isOwnPost && (
                  <DropdownMenuItem 
                    onClick={() => setDeleteDialogOpen(true)}
                    className="text-destructive focus:text-destructive"
                    data-testid={`menu-delete-${id}`}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <CommentDialog
        open={commentDialogOpen}
        onClose={() => setCommentDialogOpen(false)}
        postId={id}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Post</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this post? This action cannot be undone.
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
    </Card>
  );
}
