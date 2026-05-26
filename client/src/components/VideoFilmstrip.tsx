import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { captureVideoThumbnail } from "@/hooks/useVideoSplitter";

interface VideoFilmstripProps {
  videoUrl: string;
  duration: number;
  frameCount?: number;
  className?: string;
}

const frameVariants = {
  hidden: { opacity: 0, y: 3 },
  show: { opacity: 1, y: 0, transition: { duration: 0.16, ease: "easeOut" } },
};

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

/**
 * Renders a horizontal strip of video thumbnails evenly spaced across the
 * video duration. Thumbnails are generated asynchronously one at a time using
 * setTimeout(0) batching to avoid blocking the main thread. Each frame fades
 * in with a 30ms stagger via Framer Motion.
 */
export function VideoFilmstrip({
  videoUrl,
  duration,
  frameCount = 10,
  className = "",
}: VideoFilmstripProps) {
  const [thumbs, setThumbs] = useState<(string | null)[]>(() =>
    Array(frameCount).fill(null),
  );

  useEffect(() => {
    if (!videoUrl || duration <= 0) return;

    let cancelled = false;
    setThumbs(Array(frameCount).fill(null));

    // Spread seek points evenly across the duration.
    // For a single frame, place it at the midpoint.
    const seekPoints = Array.from({ length: frameCount }, (_, i) =>
      frameCount === 1
        ? duration / 2
        : (i / (frameCount - 1)) * duration,
    );

    let idx = 0;

    const generateNext = () => {
      if (cancelled || idx >= frameCount) return;
      const i = idx++;
      const seekSec = Math.max(0, Math.min(seekPoints[i], duration - 0.05));

      captureVideoThumbnail(videoUrl, seekSec)
        .then(dataUrl => {
          if (!cancelled && dataUrl) {
            setThumbs(prev => {
              const updated = [...prev];
              updated[i] = dataUrl;
              return updated;
            });
          }
        })
        .finally(() => {
          // Yield to the browser between frames to keep the UI responsive.
          setTimeout(generateNext, 0);
        });
    };

    generateNext();

    return () => {
      cancelled = true;
    };
  }, [videoUrl, duration, frameCount]);

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className={`flex overflow-hidden rounded-lg ${className}`}
      style={{ height: 52 }}
      aria-hidden
    >
      {thumbs.map((src, i) => (
        <motion.div
          key={i}
          variants={frameVariants}
          className="flex-1 relative overflow-hidden"
          style={{ minWidth: 0 }}
        >
          {src ? (
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-white/8 animate-pulse" />
          )}
        </motion.div>
      ))}
    </motion.div>
  );
}