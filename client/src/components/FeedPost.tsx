import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heart, MessageCircle, Share2, Bookmark } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
  timestamp: string;
  likes: number;
  comments: number;
  isLiked?: boolean;
}

export default function FeedPost({
  id,
  author,
  content,
  image,
  timestamp,
  likes: initialLikes,
  comments: initialComments,
  isLiked: initialIsLiked = false,
}: FeedPostProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Fetch like status and count from API
  const { data: likeData } = useQuery<{ count: number; isLiked: boolean }>({
    queryKey: [`/api/posts/${id}/likes`],
    initialData: { count: initialLikes, isLiked: initialIsLiked },
  });

  // Fetch bookmark status (we'll need to add this endpoint or track it in posts)
  const [bookmarkStatus, setBookmarkStatus] = useState(false);

  // Like/Unlike mutations with optimistic updates
  const likeMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', `/api/posts/${id}/like`, {});
    },
    onMutate: async () => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: [`/api/posts/${id}/likes`] });
      
      // Snapshot previous value
      const previousLikes = queryClient.getQueryData([`/api/posts/${id}/likes`]);
      
      // Optimistically update
      queryClient.setQueryData([`/api/posts/${id}/likes`], (old: any) => ({
        count: (old?.count || 0) + 1,
        isLiked: true,
      }));
      
      return { previousLikes };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousLikes) {
        queryClient.setQueryData([`/api/posts/${id}/likes`], context.previousLikes);
      }
      toast({
        title: "Error",
        description: "Failed to like post",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/posts/${id}/likes`] });
    },
  });

  const unlikeMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', `/api/posts/${id}/like`, {});
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: [`/api/posts/${id}/likes`] });
      const previousLikes = queryClient.getQueryData([`/api/posts/${id}/likes`]);
      
      queryClient.setQueryData([`/api/posts/${id}/likes`], (old: any) => ({
        count: Math.max((old?.count || 1) - 1, 0),
        isLiked: false,
      }));
      
      return { previousLikes };
    },
    onError: (err, variables, context) => {
      if (context?.previousLikes) {
        queryClient.setQueryData([`/api/posts/${id}/likes`], context.previousLikes);
      }
      toast({
        title: "Error",
        description: "Failed to unlike post",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/posts/${id}/likes`] });
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

  return (
    <Card className="p-4 hover-elevate" data-testid={`post-${id}`}>
      <div className="flex gap-3">
        <Avatar 
          className="h-10 w-10 cursor-pointer hover-elevate" 
          onClick={handleAvatarClick}
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
            <span className="text-xs text-muted-foreground">· {timestamp}</span>
          </div>

          <p className="mt-2 text-sm whitespace-pre-wrap" data-testid={`text-content-${id}`}>
            {content}
          </p>

          {image && (
            <img
              src={image}
              alt="Post"
              className="mt-3 rounded-md w-full max-h-96 object-cover"
              data-testid={`img-post-${id}`}
            />
          )}

          <div className="flex items-center gap-1 mt-3">
            <Button
              variant="ghost"
              size="sm"
              className={`gap-1 ${likeData?.isLiked ? 'text-primary' : ''}`}
              onClick={handleLike}
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
              onClick={() => console.log('Comment on post:', id)}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircle className="h-4 w-4" />
              <span className="text-xs">{initialComments}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleShare}
              data-testid={`button-share-${id}`}
            >
              <Share2 className="h-4 w-4" />
            </Button>

            <div className="flex-1" />

            <Button
              variant="ghost"
              size="sm"
              onClick={handleBookmark}
              disabled={bookmarkMutation.isPending}
              className={bookmarkStatus ? 'text-primary' : ''}
              data-testid={`button-bookmark-${id}`}
            >
              <Bookmark className={`h-4 w-4 ${bookmarkStatus ? 'fill-current' : ''}`} />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
