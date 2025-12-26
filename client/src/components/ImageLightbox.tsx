import { useState, useEffect, useCallback, useRef } from "react";
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImageLightboxProps {
  images: string[];
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
}

export default function ImageLightbox({
  images,
  initialIndex = 0,
  open,
  onClose,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isLoading, setIsLoading] = useState(true);
  const [isZoomed, setIsZoomed] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, open]);

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
      setIsZoomed(false);
    }
  }, [currentIndex]);

  const goToNext = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setIsLoading(true);
      setIsZoomed(false);
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

  const toggleZoom = () => {
    setIsZoomed(!isZoomed);
  };

  if (!open || images.length === 0) return null;

  return (
    <div
      className="fixed inset-0 bg-black/95 flex items-center justify-center"
      style={{ zIndex: 9999 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isZoomed) {
          onClose();
        }
      }}
      data-testid="image-lightbox"
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 text-white hover:bg-white/20 z-10"
        onClick={onClose}
        data-testid="lightbox-close"
      >
        <X className="h-6 w-6" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-16 text-white hover:bg-white/20 z-10"
        onClick={toggleZoom}
        data-testid="lightbox-zoom"
      >
        {isZoomed ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
      </Button>

      {images.length > 1 && currentIndex > 0 && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-4 text-white hover:bg-white/20 z-10 h-12 w-12"
          onClick={goToPrevious}
          data-testid="lightbox-prev"
        >
          <ChevronLeft className="h-8 w-8" />
        </Button>
      )}

      {images.length > 1 && currentIndex < images.length - 1 && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-4 text-white hover:bg-white/20 z-10 h-12 w-12"
          onClick={goToNext}
          data-testid="lightbox-next"
        >
          <ChevronRight className="h-8 w-8" />
        </Button>
      )}

      <div
        className="relative max-w-[90vw] max-h-[90vh] flex items-center justify-center"
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
          className={`max-w-full max-h-[90vh] object-contain transition-transform duration-200 ${
            isZoomed ? "scale-150 cursor-zoom-out" : "cursor-zoom-in"
          } ${isLoading ? "opacity-0" : "opacity-100"}`}
          onClick={toggleZoom}
          onLoad={() => setIsLoading(false)}
          draggable={false}
          data-testid="lightbox-image"
        />
      </div>

      {images.length > 1 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2">
          {images.map((_, index) => (
            <button
              key={index}
              className={`w-2 h-2 rounded-full transition-colors ${
                index === currentIndex ? "bg-white" : "bg-white/40"
              }`}
              onClick={() => {
                setCurrentIndex(index);
                setIsLoading(true);
                setIsZoomed(false);
              }}
              data-testid={`lightbox-dot-${index}`}
            />
          ))}
        </div>
      )}

      {images.length > 1 && (
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-white/70 text-sm">
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>
  );
}
