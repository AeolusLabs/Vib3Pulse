import { useState } from "react";
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

  if (!images || images.length === 0) return null;

  const displayImages = images.slice(0, maxImages);
  const remainingCount = images.length - maxImages;

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  const getGridClass = () => {
    switch (displayImages.length) {
      case 1:
        return "grid-cols-1";
      case 2:
        return "grid-cols-2";
      case 3:
        return "grid-cols-2";
      case 4:
      default:
        return "grid-cols-2";
    }
  };

  const getImageClass = (index: number, total: number) => {
    if (total === 1) {
      return "col-span-1 aspect-video";
    }
    if (total === 3 && index === 0) {
      return "col-span-2 aspect-video";
    }
    return "aspect-square";
  };

  return (
    <>
      <div className={`grid gap-1 rounded-xl overflow-hidden ${getGridClass()} ${className}`}>
        {displayImages.map((image, index) => (
          <div
            key={index}
            className={`relative cursor-pointer overflow-hidden ${getImageClass(index, displayImages.length)}`}
            onClick={() => openLightbox(index)}
            data-testid={`image-grid-item-${index}`}
          >
            <img
              src={image}
              alt={`Image ${index + 1}`}
              className="w-full h-full object-cover transition-transform hover:scale-105"
            />
            {index === maxImages - 1 && remainingCount > 0 && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                <span className="text-white text-2xl font-bold">+{remainingCount}</span>
              </div>
            )}
          </div>
        ))}
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
