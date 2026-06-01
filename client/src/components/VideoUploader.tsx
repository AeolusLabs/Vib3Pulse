import { useState, useRef, useCallback, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, ensureCsrfToken } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { XIcon, FilmIcon, UploadIcon } from "@/components/ui/icons";

interface VideoUploaderProps {
  onComplete: (objectPath: string) => void;
  onClear: () => void;
  videoUrl?: string | null;
  className?: string;
  compact?: boolean;
  maxSizeMB?: number;
  fileToUpload?: File | null;
}

const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/x-matroska"]);
const ALLOWED_VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "mkv", "avi"]);

export function VideoUploader({
  onComplete,
  onClear,
  videoUrl,
  className,
  compact = false,
  maxSizeMB = 50,
  fileToUpload,
}: VideoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const { toast } = useToast();

  const maxFileSize = maxSizeMB * 1024 * 1024;

  const uploadVideo = useCallback(async (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const isAllowed = ALLOWED_VIDEO_TYPES.has(file.type) || (!file.type && ALLOWED_VIDEO_EXTS.has(ext));
    if (!isAllowed) {
      toast({
        title: "Unsupported format",
        description: "Please select an MP4, MOV, WebM, MKV, or AVI video.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > maxFileSize) {
      toast({
        title: "Video too large",
        description: `Please select a video under ${maxSizeMB}MB.`,
        variant: "destructive",
      });
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setLocalPreview(previewUrl);
    setIsUploading(true);
    setUploadProgress(0);

    try {
      const uploadUrlRes = await apiRequest("POST", "/api/objects/upload");
      const { uploadURL } = await uploadUrlRes.json() as { uploadURL: string };

      setUploadProgress(20);

      const csrfToken = await ensureCsrfToken();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadURL);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.setRequestHeader("x-csrf-token", csrfToken);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(20 + Math.round((e.loaded / e.total) * 60));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.send(file);
      });

      setUploadProgress(85);

      const aclRes = await apiRequest("PUT", "/api/post-media", { imageURL: uploadURL });
      if (!aclRes.ok) {
        throw new Error("Failed to set media permissions");
      }
      const { objectPath } = await aclRes.json() as { objectPath: string };

      setUploadProgress(100);
      onComplete(objectPath);
    } catch (error) {
      toast({
        title: "Upload failed",
        description: "Could not upload video. Please try again.",
        variant: "destructive",
      });
      setLocalPreview(null);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  }, [maxFileSize, maxSizeMB, onComplete, toast]);

  // Auto-start upload when a file is provided directly from the unified picker
  useEffect(() => {
    if (fileToUpload && !localPreview && !isUploading) {
      uploadVideo(fileToUpload);
    }
  }, [fileToUpload, uploadVideo, localPreview, isUploading]);

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    uploadVideo(file);
  }, [uploadVideo]);

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

  const handleClear = () => {
    setLocalPreview(null);
    onClear();
  };

  const displayUrl = videoUrl || localPreview;

  if (displayUrl) {
    return (
      <div className={cn("space-y-2", className)}>
        <div className="relative rounded-lg overflow-hidden border aspect-video bg-black">
          <video
            src={displayUrl}
            className="w-full h-full object-contain"
            controls
            muted
            data-testid="video-preview"
          />
          {isUploading && (
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
              <p className="text-white text-sm font-medium">Uploading...</p>
              <Progress value={uploadProgress} className="w-3/4" />
              <p className="text-white/70 text-xs">{uploadProgress}%</p>
            </div>
          )}
          {!isUploading && (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="absolute top-2 right-2 h-7 w-7 rounded-full shadow-lg"
              onClick={handleClear}
              data-testid="button-remove-video"
            >
              <XIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
        {videoUrl && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <FilmIcon className="h-3 w-3" />
            Video attached
          </p>
        )}
      </div>
    );
  }

  if (compact) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          data-testid="button-add-video"
        >
          <FilmIcon className="h-5 w-5 text-primary" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={handleInputChange}
          data-testid="input-video-upload"
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
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
        data-testid="dropzone-video"
      >
        <UploadIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground mb-1">
          Drag & drop a video or click to browse
        </p>
        <p className="text-xs text-muted-foreground">
          MP4, MOV, or WebM up to {maxSizeMB}MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={handleInputChange}
          data-testid="input-video-upload"
        />
      </div>
    </div>
  );
}
