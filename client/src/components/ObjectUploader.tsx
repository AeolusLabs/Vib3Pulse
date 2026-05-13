import { useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ObjectUploaderProps {
  maxNumberOfFiles?: number;
  maxFileSizeMB?: number;
  onComplete?: (urls: string[]) => void;
  onError?: (error: string) => void;
  buttonClassName?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  children: ReactNode;
  disabled?: boolean;
  // Legacy props — kept for compatibility but ignored internally
  onGetUploadParameters?: unknown;
  maxFileSize?: number;
}

const MAX_IMAGE_DIMENSION = 1200;
const JPEG_QUALITY = 0.85;

async function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(MAX_IMAGE_DIMENSION / img.width, MAX_IMAGE_DIMENSION / img.height, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function ObjectUploader({
  maxNumberOfFiles = 1,
  maxFileSizeMB = 10,
  onComplete,
  onError,
  buttonClassName,
  buttonVariant = "outline",
  buttonSize = "default",
  children,
  disabled = false,
}: ObjectUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const maxBytes = maxFileSizeMB * 1024 * 1024;
    const toProcess = Array.from(files).slice(0, maxNumberOfFiles);
    const oversized = toProcess.filter(f => f.size > maxBytes);
    if (oversized.length > 0) {
      const msg = `File too large. Maximum size is ${maxFileSizeMB}MB.`;
      toast({ title: "File too large", description: msg, variant: "destructive" });
      onError?.(msg);
      return;
    }

    setIsUploading(true);
    try {
      const urls: string[] = [];
      for (const file of toProcess) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });
        const compressed = file.type.startsWith("image/") ? await compressImage(dataUrl) : dataUrl;
        const res = await apiRequest("POST", "/api/upload-images", { images: [compressed] });
        const data = await res.json() as { urls: string[] };
        if (data.urls?.[0]) urls.push(data.urls[0]);
      }
      onComplete?.(urls);
    } catch (err) {
      const msg = "Upload failed. Please try again.";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
      onError?.(msg);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [maxNumberOfFiles, maxFileSizeMB, onComplete, onError, toast]);

  return (
    <div>
      <Button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={buttonClassName}
        variant={buttonVariant}
        size={buttonSize}
        disabled={disabled || isUploading}
        data-testid="button-upload"
      >
        {isUploading ? "Uploading..." : children}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple={maxNumberOfFiles > 1}
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
        data-testid="input-object-upload"
      />
    </div>
  );
}
