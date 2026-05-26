import { useState, useEffect, useCallback, useRef } from "react";

function formatStoryTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return timestamp; // already a human string (mock data)
  const diffSecs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSecs < 60) return diffSecs <= 5 ? "Just now" : `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "Yesterday" : `${diffDays}d ago`;
}

const slideVariants = {
  enter: (dir: "next" | "prev") => ({
    x: dir === "next" ? "100%" : "-100%",
  }),
  center: { x: 0 },
  exit: (dir: "next" | "prev") => ({
    x: dir === "next" ? "-25%" : "25%",
    opacity: 0,
  }),
};

const slideTransition = {
  x: { type: "tween" as const, duration: 0.28, ease: "easeInOut" },
  opacity: { duration: 0.2 },
};

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useMutation, useQuery } from "@tanstack/react-query";
import StoryInteractionsPanel from "@/components/StoryInteractionsPanel";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { XIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, HeartIcon, EyeIcon, SendIcon, Trash2Icon, Share2Icon, LockIcon, RefreshCwIcon, Volume2Icon, VolumeXIcon } from "@/components/ui/icons";

interface StorySlide {
  id: string;
  type: "image" | "text" | "video";
  content: string;
  caption?: string | null;
  videoUrl?: string | null;
  backgroundColor?: string;
  timestamp: string;
  likeCount?: number;
  viewCount?: number;
  isLiked?: boolean;
  isReshare?: boolean;
  privacy?: string;
  originalStoryId?: string | null;
  cropParams?: { x: number; y: number; w: number; h: number } | null;
}

interface StoryViewerProps {
  username: string;
  avatar?: string;
  slides: StorySlide[];
  initialSlide?: number;
  direction?: "next" | "prev";
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  storyOwnerId?: string;
  displayName?: string | null;
  userType?: string;
}

export default function StoryViewer({
  username,
  avatar,
  slides,
  initialSlide = 0,
  direction = "next",
  onClose,
  onNext,
  onPrevious,
  storyOwnerId,
  displayName,
  userType,
}: StoryViewerProps) {
  const { data: currentUser } = useAuth();
  const { toast } = useToast();
  const isOwnStory = currentUser?.id === storyOwnerId;
  const [currentSlide, setCurrentSlide] = useState(initialSlide);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [showLikeAnimation, setShowLikeAnimation] = useState(false);
  const [localLikeStates, setLocalLikeStates] = useState<Record<string, { isLiked: boolean; likeCount: number }>>({});
  const [isVideoMuted, setIsVideoMuted] = useState(true);
  const [showInteractionsPanel, setShowInteractionsPanel] = useState(false);
  const storyVideoRef = useRef<HTMLVideoElement>(null);
  const holdStartRef = useRef(0);
  const navigatingRef = useRef(false);

  const SLIDE_DURATION = 5000;
  const currentStory = slides[currentSlide];
  const isVideoSlide = currentStory?.type === "video";

  // Initialize local like states from slides
  useEffect(() => {
    const initialStates: Record<string, { isLiked: boolean; likeCount: number }> = {};
    slides.forEach(slide => {
      initialStates[slide.id] = {
        isLiked: slide.isLiked || false,
        likeCount: slide.likeCount || 0,
      };
    });
    setLocalLikeStates(initialStates);
  }, [slides]);

  // Preload the next slide's image so the transition is instant
  useEffect(() => {
    const next = slides[currentSlide + 1];
    if (next?.type === "image" && next.content) {
      new Image().src = next.content;
    }
  }, [currentSlide, slides]);

  // Record a view whenever a new slide becomes active (non-owners only)
  useEffect(() => {
    if (!currentStory || isOwnStory) return;
    apiRequest('POST', `/api/stories/${currentStory.id}/view`, undefined).catch(() => {});
  }, [currentStory?.id, isOwnStory]);

  // Live interactions data for the story owner
  const { data: interactionsData } = useQuery<{ viewCount: number; likeCount: number }>({
    queryKey: [`/api/stories/${currentStory?.id}/interactions`],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/stories/${currentStory!.id}/interactions`);
      return res.json();
    },
    enabled: isOwnStory && !!currentStory?.id,
    refetchInterval: 10000,
  });

  const deleteStoryMutation = useMutation({
    mutationFn: async (storyId: string) => {
      return await apiRequest('DELETE', `/api/stories/${storyId}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
      toast({
        title: "Story deleted",
        description: "Your story has been removed.",
      });
      if (currentSlide < slides.length - 1) {
        setCurrentSlide(currentSlide + 1);
        setProgress(0);
      } else {
        onNext?.() || onClose();
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete story. Please try again.",
        variant: "destructive",
      });
    },
  });

  const likeStoryMutation = useMutation({
    mutationFn: async (storyId: string) => {
      const response = await apiRequest('POST', `/api/stories/${storyId}/like`, undefined);
      return response.json();
    },
    onSuccess: (data, storyId) => {
      setLocalLikeStates(prev => ({
        ...prev,
        [storyId]: { isLiked: true, likeCount: data.likeCount },
      }));
      setShowLikeAnimation(true);
      setTimeout(() => setShowLikeAnimation(false), 1000);
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to like story.",
        variant: "destructive",
      });
    },
  });

  const unlikeStoryMutation = useMutation({
    mutationFn: async (storyId: string) => {
      const response = await apiRequest('DELETE', `/api/stories/${storyId}/like`, undefined);
      return response.json();
    },
    onSuccess: (data, storyId) => {
      setLocalLikeStates(prev => ({
        ...prev,
        [storyId]: { isLiked: false, likeCount: data.likeCount },
      }));
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to unlike story.",
        variant: "destructive",
      });
    },
  });

  const reshareStoryMutation = useMutation({
    mutationFn: async (storyId: string) => {
      const response = await apiRequest('POST', `/api/stories/${storyId}/reshare`, undefined);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
      toast({
        title: "Story reshared",
        description: "This story has been added to your stories.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to reshare story.",
        variant: "destructive",
      });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ storyId, content }: { storyId: string; content: string }) => {
      const res = await apiRequest("POST", `/api/stories/${storyId}/reply`, { content });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to send reply");
      }
      return res.json();
    },
    onSuccess: () => {
      setReplyText("");
      setIsPaused(false);
      toast({ title: "Reply sent" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to send reply",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleReply = () => {
    const content = replyText.trim();
    if (!content || !currentStory) return;
    replyMutation.mutate({ storyId: currentStory.id, content });
  };

  const handleDeleteStory = () => {
    if (confirm("Are you sure you want to delete this story?")) {
      const currentStoryId = slides[currentSlide]?.id;
      if (currentStoryId) {
        deleteStoryMutation.mutate(currentStoryId);
      }
    }
  };

  const handleLikeToggle = () => {
    if (!currentStory || isOwnStory) return;
    
    const currentLikeState = localLikeStates[currentStory.id];
    if (currentLikeState?.isLiked) {
      unlikeStoryMutation.mutate(currentStory.id);
    } else {
      likeStoryMutation.mutate(currentStory.id);
    }
  };

  const handleReshare = () => {
    if (!currentStory || isOwnStory) return;
    reshareStoryMutation.mutate(currentStory.id);
  };

  const lastTapRef = useRef(0);

  const handleDoubleTap = useCallback(() => {
    if (!currentStory || isOwnStory) return;
    const currentLikeState = localLikeStates[currentStory.id];
    if (!currentLikeState?.isLiked) {
      likeStoryMutation.mutate(currentStory.id);
    }
  }, [currentStory, isOwnStory, localLikeStates, likeStoryMutation]);

  useEffect(() => {
    navigatingRef.current = false;

    if (isVideoSlide) {
      const video = storyVideoRef.current;
      if (!video) return;

      const onTimeUpdate = () => {
        if (video.duration) {
          setProgress((video.currentTime / video.duration) * 100);
        }
      };
      const advance = () => {
        if (currentSlide < slides.length - 1) {
          setCurrentSlide((curr) => curr + 1);
          setProgress(0);
        } else if (!navigatingRef.current) {
          navigatingRef.current = true;
          onNext?.();
        }
      };

      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("ended", advance);
      video.addEventListener("error", advance);
      video.addEventListener("stalled", () => {
        const fallback = setTimeout(advance, 5000);
        video.addEventListener("playing", () => clearTimeout(fallback), { once: true });
      });

      if (!isPaused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }

      return () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("ended", advance);
        video.removeEventListener("error", advance);
      };
    }

    if (isPaused) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const newProgress = prev + (100 / SLIDE_DURATION) * 100;
        if (newProgress >= 100) {
          if (currentSlide < slides.length - 1) {
            setCurrentSlide((curr) => curr + 1);
            return 0;
          } else if (!navigatingRef.current) {
            navigatingRef.current = true;
            onNext?.();
          }
          return 100;
        }
        return newProgress;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [currentSlide, slides.length, isPaused, onNext, isVideoSlide]);

  const handlePrevious = () => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
      setProgress(0);
    } else {
      onPrevious?.();
    }
  };

  const handleNext = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
      setProgress(0);
    } else {
      onNext?.();
    }
  };

  if (!currentStory) {
    return null;
  }

  const currentLikeState = localLikeStates[currentStory.id] || { isLiked: false, likeCount: 0 };

  const handleTap = (e: React.MouseEvent | React.TouchEvent) => {
    const now = Date.now();
    // Suppress navigation if this was a hold gesture (finger down > 300ms)
    if (holdStartRef.current > 0 && now - holdStartRef.current > 300) {
      return;
    }
    if (now - lastTapRef.current < 300) {
      handleDoubleTap();
      e.preventDefault();
    }
    lastTapRef.current = now;
  };

  return (
    <>
    <motion.div
      className="fixed inset-0 bg-black z-50 flex items-center justify-center"
      custom={direction}
      variants={slideVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={slideTransition}
    >
      <div className="relative w-full h-full mx-auto" style={{ maxWidth: "calc(100dvh * 9 / 16)" }}>
        {/* Progress bars - Snapchat style */}
        <div className="absolute top-0 left-0 right-0 z-30 flex gap-1 p-2 pt-3">
          {slides.map((_, index) => (
            <div key={index} className="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden">
              <div 
                className="h-full bg-white transition-all duration-100 ease-linear rounded-full"
                style={{ 
                  width: index === currentSlide 
                    ? `${progress}%` 
                    : index < currentSlide 
                      ? '100%' 
                      : '0%' 
                }}
              />
            </div>
          ))}
        </div>

        {/* Header - Snapchat style overlay */}
        <div className="absolute top-0 left-0 right-0 z-20 pt-8 px-4 pb-16 bg-gradient-to-b from-black/60 via-black/30 to-transparent">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10 border-2 border-white ring-2 ring-primary">
                <AvatarImage src={avatar} alt={username} />
                <AvatarFallback className="bg-primary text-primary-foreground">
                  {(displayName || username).charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-white text-sm" data-testid="text-story-username">
                    {displayName || username}
                  </p>
                  {currentStory.privacy === 'private' && (
                    <LockIcon className="h-3 w-3 text-white/80" />
                  )}
                  {currentStory.isReshare && (
                    <Badge variant="secondary" className="h-5 text-[10px] bg-white/20 text-white border-0">
                      <RefreshCwIcon className="h-2.5 w-2.5 mr-1" />
                      Reshared
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-white/70">{formatStoryTime(currentStory.timestamp)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {isVideoSlide && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setIsVideoMuted(!isVideoMuted);
                    if (storyVideoRef.current) {
                      storyVideoRef.current.muted = !isVideoMuted;
                    }
                  }}
                  className="text-white hover:bg-white/20"
                  data-testid="button-story-mute"
                >
                  {isVideoMuted ? <VolumeXIcon className="h-5 w-5" /> : <Volume2Icon className="h-5 w-5" />}
                </Button>
              )}
              {isOwnStory && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleDeleteStory}
                  disabled={deleteStoryMutation.isPending}
                  className="text-white hover:bg-white/20"
                  data-testid="button-delete-story"
                >
                  <Trash2Icon className="h-5 w-5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="text-white hover:bg-white/20"
                data-testid="button-close-story"
              >
                <XIcon className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </div>

        {/* Story content */}
        <div className="relative h-full w-full overflow-hidden">
          {currentStory.type === "video" ? (
            <>
              {/* Main video — cropped if cropParams present */}
              {currentStory.cropParams ? (
                <div className="absolute inset-0 overflow-hidden">
                  <video
                    ref={storyVideoRef}
                    src={currentStory.videoUrl || currentStory.content}
                    style={{
                      position: "absolute",
                      left: `${-(currentStory.cropParams.x / currentStory.cropParams.w) * 100}%`,
                      top:  `${-(currentStory.cropParams.y / currentStory.cropParams.h) * 100}%`,
                      width:  `${(100 / currentStory.cropParams.w) * 100}%`,
                      height: `${(100 / currentStory.cropParams.h) * 100}%`,
                      objectFit: "contain",
                    }}
                    muted={isVideoMuted}
                    playsInline
                    autoPlay
                    data-testid="story-video"
                  />
                </div>
              ) : (
                <video
                  ref={storyVideoRef}
                  src={currentStory.videoUrl || currentStory.content}
                  className="relative w-full h-full object-cover"
                  muted={isVideoMuted}
                  playsInline
                  autoPlay
                  data-testid="story-video"
                />
              )}
            </>
          ) : currentStory.type === "image" ? (
            <>
              {/* Blurred background fill for landscape / square images */}
              <img
                src={currentStory.content}
                alt=""
                className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-60"
                aria-hidden="true"
              />
              {/* Main image — never cropped */}
              <img
                src={currentStory.content}
                alt="Story"
                className="relative w-full h-full object-cover"
              />
            </>
          ) : (
            <div
              className="w-full h-full flex items-center justify-center p-8"
              style={{ backgroundColor: currentStory.backgroundColor || "hsl(var(--primary))" }}
            >
              <p className="text-2xl font-serif font-semibold text-center text-white">
                {currentStory.content}
              </p>
            </div>
          )}

          {/* Like animation overlay */}
          <AnimatePresence>
            {showLikeAnimation && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
              >
                <HeartIcon className="h-32 w-32 text-red-500 fill-red-500" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Caption overlay */}
        {currentStory.caption && (
          <div className="absolute bottom-28 left-4 right-4 z-20 pointer-events-none">
            <p className="text-white text-base font-medium text-center bg-black/50 backdrop-blur-sm rounded-lg px-4 py-2 leading-snug">
              {currentStory.caption}
            </p>
          </div>
        )}

        {/* Navigation - handles pause (hold) and tap-to-navigate */}
        <div className="absolute inset-0 z-10 flex pointer-events-none">
          <button
            className="flex-1 pointer-events-auto"
            onMouseDown={() => { holdStartRef.current = Date.now(); setIsPaused(true); }}
            onMouseUp={() => setIsPaused(false)}
            onTouchStart={() => { holdStartRef.current = Date.now(); setIsPaused(true); }}
            onTouchEnd={() => setIsPaused(false)}
            onClick={(e) => { handleTap(e); handlePrevious(); }}
            data-testid="button-previous-story"
          />
          <button
            className="flex-1 pointer-events-auto"
            onMouseDown={() => { holdStartRef.current = Date.now(); setIsPaused(true); }}
            onMouseUp={() => setIsPaused(false)}
            onTouchStart={() => { holdStartRef.current = Date.now(); setIsPaused(true); }}
            onTouchEnd={() => setIsPaused(false)}
            onClick={(e) => { handleTap(e); handleNext(); }}
            data-testid="button-next-story"
          />
        </div>

        {/* Bottom action bar */}
        <div className="absolute bottom-0 left-0 right-0 z-20 p-4 pb-6 bg-gradient-to-t from-black/60 via-black/30 to-transparent">
          {isOwnStory ? (
            /* Owner: tap to open interactions panel */
            <button
              className="flex items-center gap-5 w-full"
              onClick={() => setShowInteractionsPanel(true)}
              data-testid="button-open-interactions"
            >
              <div className="flex items-center gap-1.5">
                <EyeIcon className="h-5 w-5 text-white/80" />
                <span className="text-white font-semibold text-sm">
                  {interactionsData?.viewCount ?? currentStory.viewCount ?? 0}
                </span>
                <span className="text-white/60 text-xs">views</span>
              </div>
              <div className="flex items-center gap-1.5">
                <HeartIcon className="h-5 w-5 text-red-400 fill-red-400" />
                <span className="text-white font-semibold text-sm">
                  {interactionsData?.likeCount ?? currentLikeState.likeCount}
                </span>
                <span className="text-white/60 text-xs">likes</span>
              </div>
              <ChevronUpIcon className="h-4 w-4 text-white/60 ml-auto" />
            </button>
          ) : (
            /* Non-owner: reply + like + reshare */
            <>
              {currentLikeState.likeCount > 0 && (
                <div className="flex items-center gap-1 mb-3 ml-1">
                  <HeartIcon className="h-4 w-4 text-red-500 fill-red-500" />
                  <span className="text-sm text-white font-medium" data-testid="text-like-count">
                    {currentLikeState.likeCount} {currentLikeState.likeCount === 1 ? 'like' : 'likes'}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                {/* Reply input — stopPropagation prevents nav overlay from stealing touch events */}
                <div
                  className="flex-1 relative"
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                >
                  <Input
                    placeholder="Send a message..."
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onFocus={() => setIsPaused(true)}
                    onBlur={() => { if (!replyMutation.isPending) setIsPaused(false); }}
                    onKeyDown={(e) => e.key === "Enter" && handleReply()}
                    disabled={replyMutation.isPending}
                    className="bg-white/10 backdrop-blur-md border-white/20 text-white placeholder:text-white/50 pr-10 disabled:opacity-60"
                    data-testid="input-story-reply"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleReply}
                    disabled={replyMutation.isPending || !replyText.trim()}
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-white hover:bg-white/20 disabled:opacity-50"
                    data-testid="button-send-reply"
                  >
                    <SendIcon className={`h-4 w-4 ${replyMutation.isPending ? "animate-pulse" : ""}`} />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleLikeToggle}
                  disabled={likeStoryMutation.isPending || unlikeStoryMutation.isPending}
                  className={`text-white hover:bg-white/20 ${currentLikeState.isLiked ? 'text-red-500' : ''}`}
                  data-testid="button-like-story"
                >
                  <HeartIcon className={`h-6 w-6 ${currentLikeState.isLiked ? 'fill-red-500' : ''}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleReshare}
                  disabled={reshareStoryMutation.isPending}
                  className="text-white hover:bg-white/20"
                  data-testid="button-reshare-story"
                >
                  <Share2Icon className="h-6 w-6" />
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Navigation arrows for desktop */}
        <div className="hidden md:block">
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 text-white hover:bg-white/20"
            onClick={handlePrevious}
          >
            <ChevronLeftIcon className="h-8 w-8" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 text-white hover:bg-white/20"
            onClick={handleNext}
          >
            <ChevronRightIcon className="h-8 w-8" />
          </Button>
        </div>
      </div>
    </motion.div>

    {isOwnStory && currentStory && (
      <StoryInteractionsPanel
        storyId={currentStory.id}
        open={showInteractionsPanel}
        onOpenChange={setShowInteractionsPanel}
      />
    )}
    </>
  );
}
