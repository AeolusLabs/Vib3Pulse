import { useState, useRef, useCallback } from "react";
import { X, ImagePlus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MultiImageUploaderProps {
  maxImages: number;
  images: string[];
  onImagesChange: (images: string[]) => void;
  className?: string;
  compact?: boolean;
}

export function MultiImageUploader({
  maxImages,
  images,
  onImagesChange,
  className,
  compact = false,
}: MultiImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files) return;
    
    const remainingSlots = maxImages - images.length;
    const filesToProcess = Array.from(files).slice(0, remainingSlots);
    
    filesToProcess.forEach((file) => {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onloadend = () => {
          onImagesChange([...images, reader.result as string]);
        };
        reader.readAsDataURL(file);
      }
    });
  }, [images, maxImages, onImagesChange]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(e.target.files);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const removeImage = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    onImagesChange(newImages);
  };

  const canAddMore = images.length < maxImages;

  if (compact) {
    return (
      <div className={cn("space-y-3", className)}>
        {images.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {images.map((image, index) => (
              <div key={index} className="relative rounded-lg overflow-hidden border aspect-square">
                <img
                  src={image}
                  alt={`Upload ${index + 1}`}
                  className="w-full h-full object-cover"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 h-6 w-6 bg-background/80 hover:bg-background"
                  onClick={() => removeImage(index)}
                  data-testid={`button-remove-image-${index}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        
        {canAddMore && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-add-image"
            >
              <ImagePlus className="h-5 w-5 text-primary" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleInputChange}
              data-testid="input-image-upload"
            />
          </>
        )}
        
        {images.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {images.length}/{maxImages} images
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {images.map((image, index) => (
            <div key={index} className="relative rounded-lg overflow-hidden border aspect-video">
              <img
                src={image}
                alt={`Upload ${index + 1}`}
                className="w-full h-full object-cover"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 h-7 w-7 bg-background/80 hover:bg-background"
                onClick={() => removeImage(index)}
                data-testid={`button-remove-image-${index}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {canAddMore && (
        <div
          className={cn(
            "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          data-testid="dropzone-images"
        >
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground mb-1">
            Drag & drop images or click to browse
          </p>
          <p className="text-xs text-muted-foreground">
            {images.length}/{maxImages} images • Max 10MB each
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleInputChange}
            data-testid="input-image-upload"
          />
        </div>
      )}
    </div>
  );
}
