import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize } from "lucide-react";
import { cn } from "@/lib/utils";

interface FeedVideoPlayerProps {
  src: string;
  className?: string;
  autoPlay?: boolean;
  loop?: boolean;
  poster?: string;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export default function FeedVideoPlayer({
  src,
  className,
  autoPlay = true,
  loop = true,
  poster,
}: FeedVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [showPlayIcon, setShowPlayIcon] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (autoPlay) {
              video.play().catch(() => {});
            }
          } else {
            video.pause();
          }
        });
      },
      { threshold: [0, 0.5] }
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, [autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setDuration(video.duration || 0);
      if (video.duration) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };
    const onLoadedMetadata = () => {
      setDuration(video.duration || 0);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const fs =
        !!document.fullscreenElement ||
        !!(document as any).webkitFullscreenElement;
      setIsFullscreen(fs);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  const hideControlsLater = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying && !isDragging) {
        setShowControls(false);
      }
    }, 3000);
  }, [isPlaying, isDragging]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    hideControlsLater();
  }, [hideControlsLater]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }

    setShowPlayIcon(true);
    setTimeout(() => setShowPlayIcon(false), 600);
    revealControls();
  }, [revealControls]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    revealControls();
  }, [revealControls]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const video = videoRef.current;

    const isFs =
      !!document.fullscreenElement ||
      !!(document as any).webkitFullscreenElement;

    if (isFs) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    } else {
      // Prefer container fullscreen; fall back to video element for iOS Safari
      if (container?.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if ((container as any)?.webkitRequestFullscreen) {
        (container as any).webkitRequestFullscreen();
      } else if (video && (video as any).webkitEnterFullscreen) {
        // iOS Safari native video fullscreen
        (video as any).webkitEnterFullscreen();
      }
    }
    revealControls();
  }, [revealControls]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      const bar = progressRef.current;
      if (!video || !bar || !video.duration) return;

      const rect = bar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      video.currentTime = ratio * video.duration;
      revealControls();
    },
    [revealControls]
  );

  const handleProgressDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const video = videoRef.current;
      const bar = progressRef.current;
      if (!video || !bar || !video.duration) return;

      const rect = bar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      video.currentTime = ratio * video.duration;
    },
    [isDragging]
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative bg-black rounded-lg overflow-hidden group cursor-pointer select-none",
        isFullscreen && "rounded-none",
        className
      )}
      onMouseMove={revealControls}
      onMouseLeave={() => {
        if (isPlaying && !isDragging) setShowControls(false);
      }}
      data-testid="video-player"
    >
      <video
        ref={videoRef}
        src={src}
        className="w-full aspect-video object-contain bg-black"
        muted={isMuted}
        loop={loop}
        playsInline
        preload="metadata"
        poster={poster}
        onClick={togglePlay}
        data-testid="video-element"
      />

      {showPlayIcon && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-black/50 rounded-full p-4 animate-ping-once">
            {isPlaying ? (
              <Play className="h-10 w-10 text-white fill-white" />
            ) : (
              <Pause className="h-10 w-10 text-white fill-white" />
            )}
          </div>
        </div>
      )}

      {!isPlaying && !showPlayIcon && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
        >
          <div className="bg-black/40 rounded-full p-5">
            <Play className="h-12 w-12 text-white fill-white" />
          </div>
        </div>
      )}

      {/* Muted badge — tap to unmute hint */}
      {isMuted && isPlaying && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleMute(); }}
          className="absolute top-2 left-2 z-20 flex items-center gap-1 bg-black/60 hover:bg-black/80 text-white text-xs font-medium px-2 py-1 rounded-full transition-colors pointer-events-auto"
          aria-label="Tap to unmute"
        >
          <VolumeX className="h-3 w-3" />
          <span>Muted</span>
        </button>
      )}

      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-300",
          "bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-10 pb-2 px-3",
          showControls ? "opacity-100" : "opacity-0"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          ref={progressRef}
          className="relative h-1 bg-white/30 rounded-full cursor-pointer mb-2 group/progress"
          onClick={handleProgressClick}
          onMouseDown={(e) => {
            setIsDragging(true);
            handleProgressClick(e);
          }}
          onMouseMove={handleProgressDrag}
          onMouseUp={() => setIsDragging(false)}
          onMouseLeave={() => setIsDragging(false)}
          data-testid="video-progress-bar"
        >
          <div
            className="absolute top-0 left-0 h-full bg-white rounded-full transition-[width] duration-75"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 bg-white rounded-full shadow-md opacity-0 group-hover/progress:opacity-100 transition-opacity"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={togglePlay}
              className="p-1 text-white hover:text-white/80 transition-colors"
              data-testid="button-play-pause"
            >
              {isPlaying ? (
                <Pause className="h-4 w-4 fill-white" />
              ) : (
                <Play className="h-4 w-4 fill-white" />
              )}
            </button>
            <span className="text-xs text-white/80 font-mono tabular-nums" data-testid="video-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={toggleMute}
              className="p-1 text-white hover:text-white/80 transition-colors"
              data-testid="button-mute-toggle"
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-1 text-white hover:text-white/80 transition-colors"
              data-testid="button-fullscreen"
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleMute();
        }}
        className={cn(
          "absolute top-3 right-3 z-20 p-2 rounded-full bg-black/50 text-white transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0"
        )}
        data-testid="button-mute-corner"
      >
        {isMuted ? (
          <VolumeX className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>

      <style>{`
        @keyframes ping-once {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        .animate-ping-once {
          animation: ping-once 0.6s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
