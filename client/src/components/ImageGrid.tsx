import { useState, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ImageLightbox from "./ImageLightbox";

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

interface ImageGridProps {
  images: string[];
  maxImages?: number;
  className?: string;
  postData?: PostData;
  currentUser?: CurrentUser | null;
}

export default function ImageGrid({ images, maxImages = 4, className = "", postData, currentUser }: ImageGridProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!images || images.length === 0) return null;

  const displayImages = images.slice(0, maxImages);

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setActiveSlide(Math.min(idx, displayImages.length - 1));
  }, [displayImages.length]);

  const goToSlide = useCallback((idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
    setActiveSlide(idx);
  }, []);

  // Single image — simple full-width with bottom fade
  if (displayImages.length === 1) {
    return (
      <>
        <div
          className={`relative rounded-xl overflow-hidden cursor-pointer ${className}`}
          onClick={() => openLightbox(0)}
          data-testid="image-grid-item-0"
        >
          <img
            src={displayImages[0]}
            alt="Post image"
            className="w-full object-cover max-h-[480px]"
          />
          {/* Bottom fade so text below image reads cleanly */}
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-black/10 to-transparent pointer-events-none" />
        </div>

        <ImageLightbox
          images={images}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          postData={postData}
          currentUser={currentUser}
        />
      </>
    );
  }

  // Multiple images — swipeable carousel
  return (
    <>
      <div className={`relative rounded-xl overflow-hidden ${className}`}>
        {/* Scrollable track */}
        <div
          ref={scrollRef}
          className="flex overflow-x-auto scrollbar-none"
          style={{ scrollSnapType: "x mandatory" }}
          onScroll={handleScroll}
        >
          {displayImages.map((image, index) => (
            <div
              key={index}
              className="flex-shrink-0 w-full cursor-pointer"
              style={{ scrollSnapAlign: "start" }}
              onClick={() => openLightbox(index)}
              data-testid={`image-grid-item-${index}`}
            >
              <img
                src={image}
                alt={`Image ${index + 1}`}
                className="w-full object-cover max-h-[420px] min-h-[200px]"
              />
            </div>
          ))}
        </div>

        {/* Arrow buttons — visible on hover on desktop */}
        {activeSlide > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); goToSlide(activeSlide - 1); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors z-10"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {activeSlide < displayImages.length - 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); goToSlide(activeSlide + 1); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors z-10"
            aria-label="Next image"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}

        {/* Image counter badge */}
        <div className="absolute top-2 right-2 bg-black/60 text-white text-xs font-medium px-2 py-0.5 rounded-full pointer-events-none">
          {activeSlide + 1} / {displayImages.length}
        </div>

        {/* Dot indicators */}
        <div className="absolute bottom-2.5 left-0 right-0 flex justify-center gap-1.5 pointer-events-none">
          {displayImages.map((_, i) => (
            <div
              key={i}
              className={`transition-all rounded-full ${
                i === activeSlide
                  ? "w-4 h-1.5 bg-white"
                  : "w-1.5 h-1.5 bg-white/50"
              }`}
            />
          ))}
        </div>
      </div>

      <ImageLightbox
        images={images}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        postData={postData}
        currentUser={currentUser}
      />
    </>
  );
}
