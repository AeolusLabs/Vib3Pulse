import { useState, useRef } from "react";
import { Camera, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CreateStoryModalProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function CreateStoryModal({ open, onClose, onCreateStory }: CreateStoryModalProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const { toast } = useToast();

  const createStoryMutation = useMutation({
    mutationFn: async (data: { imageUrl: string; type: string }) => {
      return await apiRequest('POST', '/api/stories', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
      setSelectedImage(null);
      stopCamera();
      onClose();
      toast({
        title: "Story posted",
        description: "Your story has been shared successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to post story. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setSelectedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user' },
        audio: false 
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setShowCamera(true);
    } catch (error) {
      console.error('Error accessing camera:', error);
      alert('Unable to access camera. Please check permissions or try uploading an image instead.');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setShowCamera(false);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0);
        const imageData = canvas.toDataURL('image/jpeg');
        setSelectedImage(imageData);
        stopCamera();
      }
    }
  };

  const handlePostStory = () => {
    if (selectedImage) {
      createStoryMutation.mutate({
        imageUrl: selectedImage,
        type: "image",
      });
    }
  };

  const handleClose = () => {
    stopCamera();
    setSelectedImage(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif">Create Your Story</DialogTitle>
        </DialogHeader>

        {!selectedImage && !showCamera && (
          <div className="space-y-4 py-4">
            <Button
              onClick={startCamera}
              className="w-full h-32 flex flex-col gap-3"
              variant="outline"
              data-testid="button-take-photo"
            >
              <Camera className="h-12 w-12" />
              <span className="font-semibold">Take Photo</span>
            </Button>

            <label htmlFor="story-image-upload" className="block">
              <Button
                variant="outline"
                className="w-full h-32 flex flex-col gap-3"
                asChild
                data-testid="button-upload-photo"
              >
                <span>
                  <Upload className="h-12 w-12" />
                  <span className="font-semibold">Upload Photo</span>
                </span>
              </Button>
            </label>
            <input
              id="story-image-upload"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
        )}

        {showCamera && (
          <div className="space-y-4">
            <div className="relative rounded-lg overflow-hidden bg-black aspect-[3/4]">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={stopCamera}
                variant="outline"
                className="flex-1"
                data-testid="button-cancel-camera"
              >
                Cancel
              </Button>
              <Button
                onClick={capturePhoto}
                className="flex-1"
                data-testid="button-capture-photo"
              >
                <Camera className="h-4 w-4 mr-2" />
                Capture
              </Button>
            </div>
          </div>
        )}

        {selectedImage && !showCamera && (
          <div className="space-y-4">
            <div className="relative rounded-lg overflow-hidden bg-black aspect-[3/4]">
              <img
                src={selectedImage}
                alt="Story preview"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => setSelectedImage(null)}
                variant="outline"
                className="flex-1"
                data-testid="button-retake"
              >
                Retake
              </Button>
              <Button
                onClick={handlePostStory}
                className="flex-1"
                disabled={createStoryMutation.isPending}
                data-testid="button-post-story"
              >
                {createStoryMutation.isPending ? "Posting..." : "Post Story"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
