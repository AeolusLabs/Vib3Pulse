import { useState, useEffect, useCallback, useRef } from "react";
import { X, MoreHorizontal, Download, Heart, MessageCircle, Repeat2, Share2, BarChart3, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface PostData {
  id: string;
  likesCount: number;
  commentsCount: number;
  repostsCount: number;
  isLiked?: boolean;
  isReposted?: boolean;
  author?: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

interface ImageLightboxProps {
  images: string[];
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  postData?: PostData;
  currentUser?: CurrentUser | null;
}

function formatCount(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return count.toString();
}

export default function ImageLightbox({
  images,
  initialIndex = 0,
  open,
  onClose,
  postData,
  currentUser,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isLoading, setIsLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [isLiked, setIsLiked] = useState(postData?.isLiked || false);
  const [likesCount, setLikesCount] = useState(postData?.likesCount || 0);
  const [isReposted, setIsReposted] = useState(postData?.isReposted || false);
  const [repostsCount, setRepostsCount] = useState(postData?.repostsCount || 0);
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, open]);

  useEffect(() => {
    if (postData) {
      setIsLiked(postData.isLiked || false);
      setLikesCount(postData.likesCount || 0);
      setIsReposted(postData.isReposted || false);
      setRepostsCount(postData.repostsCount || 0);
    }
  }, [postData]);

  useEffect(() => {
    if (open) {
      setIsLoading(true);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, currentIndex]);

  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setIsLoading(true);
    }
  }, [currentIndex]);

  const goToNext = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setIsLoading(true);
    }
  }, [currentIndex, images.length]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft") {
        goToPrevious();
      } else if (e.key === "ArrowRight") {
        goToNext();
      }
    },
    [open, onClose, goToPrevious, goToNext]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (touchStartX.current === null || touchEndX.current === null) return;
    
    const diff = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50;

    if (Math.abs(diff) > minSwipeDistance) {
      if (diff > 0) {
        goToNext();
      } else {
        goToPrevious();
      }
    }

    touchStartX.current = null;
    touchEndX.current = null;
  };

  const handleDownload = async () => {
    const imageUrl = images[currentIndex];
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const filename = imageUrl.split('/').pop() || `image-${currentIndex + 1}.jpg`;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download image:', error);
      window.open(imageUrl, '_blank');
    }
  };

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (!postData) return;
      if (isLiked) {
        return apiRequest("DELETE", `/api/posts/${postData.id}/like`);
      }
      return apiRequest("POST", `/api/posts/${postData.id}/like`, {});
    },
    onMutate: () => {
      setIsLiked(!isLiked);
      setLikesCount(prev => isLiked ? prev - 1 : prev + 1);
    },
    onError: () => {
      setIsLiked(isLiked);
      setLikesCount(prev => isLiked ? prev + 1 : prev - 1);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postData?.id, "likes"] });
    },
  });

  const repostMutation = useMutation({
    mutationFn: async () => {
      if (!postData) return;
      if (isReposted) {
        return apiRequest("DELETE", `/api/posts/${postData.id}/repost`);
      }
      return apiRequest("POST", `/api/posts/${postData.id}/repost`, {});
    },
    onMutate: () => {
      setIsReposted(!isReposted);
      setRepostsCount(prev => isReposted ? prev - 1 : prev + 1);
    },
    onError: () => {
      setIsReposted(isReposted);
      setRepostsCount(prev => isReposted ? prev + 1 : prev - 1);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postData?.id, "repost-status"] });
    },
  });

  const commentMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!postData) return;
      return apiRequest("POST", `/api/posts/${postData.id}/comments`, { content });
    },
    onSuccess: () => {
      setReplyText("");
      toast({ title: "Reply posted!" });
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/posts", postData?.id] });
    },
    onError: () => {
      toast({ title: "Failed to post reply", variant: "destructive" });
    },
  });

  const handleShare = async () => {
    if (navigator.share && postData) {
      try {
        await navigator.share({
          title: 'Check out this post',
          url: `${window.location.origin}/post/${postData.id}`,
        });
      } catch {
        navigator.clipboard.writeText(`${window.location.origin}/post/${postData.id}`);
        toast({ title: "Link copied!" });
      }
    } else if (postData) {
      navigator.clipboard.writeText(`${window.location.origin}/post/${postData.id}`);
      toast({ title: "Link copied!" });
    }
  };

  const handleReply = () => {
    if (replyText.trim() && postData) {
      commentMutation.mutate(replyText.trim());
    }
  };

  if (!open || images.length === 0) return null;

  return (
    <div
      className="fixed inset-0 bg-black flex flex-col"
      style={{ zIndex: 9999 }}
      data-testid="image-lightbox"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between p-3 z-10">
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/20"
          onClick={onClose}
          data-testid="lightbox-close"
        >
          <X className="h-6 w-6" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/20"
              data-testid="lightbox-options"
            >
              <MoreHorizontal className="h-6 w-6" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-700">
            <DropdownMenuItem onClick={handleDownload} className="text-white hover:bg-white/10 cursor-pointer">
              <Download className="h-4 w-4 mr-2" />
              Download image
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Image area */}
      <div 
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        
        <img
          src={images[currentIndex]}
          alt={`Image ${currentIndex + 1} of ${images.length}`}
          className={`max-w-full max-h-full object-contain ${isLoading ? "opacity-0" : "opacity-100"}`}
          onLoad={() => setIsLoading(false)}
          draggable={false}
          data-testid="lightbox-image"
        />

        {/* Image dots indicator */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, index) => (
              <button
                key={index}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  index === currentIndex ? "bg-white" : "bg-white/40"
                }`}
                onClick={() => {
                  setCurrentIndex(index);
                  setIsLoading(true);
                }}
                data-testid={`lightbox-dot-${index}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Engagement bar */}
      {postData && (
        <div className="border-t border-zinc-800 px-4 py-2">
          <div className="flex items-center justify-between max-w-lg mx-auto">
            <button 
              className="flex items-center gap-1.5 text-zinc-400 hover:text-blue-400 transition-colors"
              onClick={() => {
                const input = document.getElementById('lightbox-reply-input');
                input?.focus();
              }}
              data-testid="lightbox-comment-btn"
            >
              <MessageCircle className="h-5 w-5" />
              <span className="text-sm">{formatCount(postData.commentsCount)}</span>
            </button>

            <button 
              className={`flex items-center gap-1.5 transition-colors ${isReposted ? 'text-green-500' : 'text-zinc-400 hover:text-green-500'}`}
              onClick={() => repostMutation.mutate()}
              data-testid="lightbox-repost-btn"
            >
              <Repeat2 className="h-5 w-5" />
              <span className="text-sm">{formatCount(repostsCount)}</span>
            </button>

            <button 
              className={`flex items-center gap-1.5 transition-colors ${isLiked ? 'text-pink-500' : 'text-zinc-400 hover:text-pink-500'}`}
              onClick={() => likeMutation.mutate()}
              data-testid="lightbox-like-btn"
            >
              <Heart className={`h-5 w-5 ${isLiked ? 'fill-current' : ''}`} />
              <span className="text-sm">{formatCount(likesCount)}</span>
            </button>

            <button 
              className="flex items-center gap-1.5 text-zinc-400 hover:text-blue-400 transition-colors"
              data-testid="lightbox-views"
            >
              <BarChart3 className="h-5 w-5" />
              <span className="text-sm">{formatCount(Math.floor((postData.likesCount + postData.commentsCount + postData.repostsCount) * 15))}</span>
            </button>

            <button 
              className="text-zinc-400 hover:text-blue-400 transition-colors"
              onClick={handleShare}
              data-testid="lightbox-share-btn"
            >
              <Share2 className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* Reply input */}
      {postData && currentUser && (
        <div className="border-t border-zinc-800 p-3">
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <Avatar className="h-8 w-8 flex-shrink-0">
              <AvatarImage src={currentUser.avatarUrl} />
              <AvatarFallback className="bg-gradient-to-br from-purple-500 to-pink-500 text-white text-xs">
                {currentUser.displayName?.charAt(0) || currentUser.username?.charAt(0) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 relative">
              <Input
                id="lightbox-reply-input"
                placeholder="Post your reply"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleReply();
                  }
                }}
                className="bg-transparent border-zinc-700 text-white placeholder:text-zinc-500 pr-10"
                data-testid="lightbox-reply-input"
              />
              {replyText.trim() && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-primary hover:text-primary/80"
                  onClick={handleReply}
                  disabled={commentMutation.isPending}
                  data-testid="lightbox-reply-submit"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
