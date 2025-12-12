import { useState, useRef } from "react";
import { Camera, Upload, Globe, Lock, Users, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import StoryCamera from "./StoryCamera";

interface CreateStoryModalProps {
  open: boolean;
  onClose: () => void;
  onCreateStory?: (type: "image" | "text", content: string) => void;
}

export default function CreateStoryModal({ open, onClose, onCreateStory }: CreateStoryModalProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [showFullscreenCamera, setShowFullscreenCamera] = useState(false);
  const [privacy, setPrivacy] = useState<"public" | "private">("public");
  const [selectedViewers, setSelectedViewers] = useState<string[]>([]);
  const [showViewerSelection, setShowViewerSelection] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const { toast } = useToast();

  // Fetch followers for private story selection
  const { data: followers } = useQuery<Array<{ follower: User }>>({
    queryKey: ['/api/followers'],
    enabled: privacy === "private",
  });

  const [isUploading, setIsUploading] = useState(false);

  const uploadImageToStorage = async (imageDataUrl: string): Promise<string> => {
    // Use server-side upload to bypass CORS issues with direct GCS uploads
    const response = await fetch('/api/stories/upload', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageData: imageDataUrl }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Upload failed' }));
      throw new Error(error.message || 'Failed to upload image');
    }
    
    const { stablePath } = await response.json();
    return stablePath;
  };

  const createStoryMutation = useMutation({
    mutationFn: async (data: { imageUrl: string; type: string; privacy: string; allowedViewerIds?: string[] }) => {
      return await apiRequest('POST', '/api/stories', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/stories'] });
      resetState();
      onClose();
      toast({
        title: "Story posted",
        description: privacy === "private" 
          ? `Your story has been shared with ${selectedViewers.length} selected viewers.`
          : "Your story has been shared with everyone.",
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

  const resetState = () => {
    setSelectedImage(null);
    setPrivacy("public");
    setSelectedViewers([]);
    setShowViewerSelection(false);
    setShowFullscreenCamera(false);
    setIsUploading(false);
    stopCamera();
  };

  const handleCameraCapture = (imageDataUrl: string) => {
    setSelectedImage(imageDataUrl);
    setShowFullscreenCamera(false);
  };

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

  const handlePostStory = async () => {
    if (selectedImage) {
      try {
        setIsUploading(true);
        
        let imageUrl = selectedImage;
        if (selectedImage.startsWith('data:')) {
          imageUrl = await uploadImageToStorage(selectedImage);
        }
        
        createStoryMutation.mutate({
          imageUrl,
          type: "image",
          privacy,
          allowedViewerIds: privacy === "private" ? selectedViewers : undefined,
        });
      } catch (error) {
        console.error('Error uploading story:', error);
        toast({
          title: "Upload Error",
          description: "Failed to upload your story image. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const toggleViewer = (userId: string) => {
    setSelectedViewers(prev => 
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const selectAllFollowers = () => {
    if (followers) {
      setSelectedViewers(followers.map(f => f.follower.id));
    }
  };

  const deselectAllFollowers = () => {
    setSelectedViewers([]);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif">Create Your Story</DialogTitle>
          <DialogDescription>
            Share a moment with your followers
          </DialogDescription>
        </DialogHeader>

        {!selectedImage && !showCamera && (
          <div className="space-y-4 py-4">
            <Button
              onClick={() => setShowFullscreenCamera(true)}
              className="w-full h-32 flex flex-col gap-3 bg-gradient-to-br from-[#D0BFFF] to-[#B0D0FF] hover:from-[#C0AFEF] hover:to-[#A0C0EF] text-black"
              data-testid="button-take-photo"
            >
              <Camera className="h-12 w-12" />
              <span className="font-semibold">Open Camera</span>
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

        {selectedImage && !showCamera && !showViewerSelection && (
          <div className="space-y-4">
            <div className="relative rounded-lg overflow-hidden bg-black aspect-[3/4]">
              <img
                src={selectedImage}
                alt="Story preview"
                className="w-full h-full object-cover"
              />
            </div>

            {/* Privacy Settings */}
            <div className="bg-muted/50 rounded-lg p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {privacy === "public" ? (
                    <Globe className="h-5 w-5 text-green-500" />
                  ) : (
                    <Lock className="h-5 w-5 text-amber-500" />
                  )}
                  <div>
                    <Label htmlFor="privacy-toggle" className="font-medium">
                      {privacy === "public" ? "Public Story" : "Private Story"}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {privacy === "public" 
                        ? "Anyone on VibePulse can see this" 
                        : "Only selected followers can see this"}
                    </p>
                  </div>
                </div>
                <Switch
                  id="privacy-toggle"
                  checked={privacy === "private"}
                  onCheckedChange={(checked) => {
                    setPrivacy(checked ? "private" : "public");
                    if (!checked) setSelectedViewers([]);
                  }}
                  data-testid="switch-privacy"
                />
              </div>

              {privacy === "private" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowViewerSelection(true)}
                  className="w-full"
                  data-testid="button-select-viewers"
                >
                  <Users className="h-4 w-4 mr-2" />
                  {selectedViewers.length > 0 
                    ? `${selectedViewers.length} viewer${selectedViewers.length > 1 ? 's' : ''} selected`
                    : "Select who can view"}
                </Button>
              )}
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
                disabled={isUploading || createStoryMutation.isPending || (privacy === "private" && selectedViewers.length === 0)}
                data-testid="button-post-story"
              >
                {isUploading ? "Uploading..." : createStoryMutation.isPending ? "Posting..." : "Post Story"}
              </Button>
            </div>
          </div>
        )}

        {/* Viewer Selection Screen */}
        {showViewerSelection && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Select Viewers</h3>
                <p className="text-sm text-muted-foreground">
                  Choose who can see your private story
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowViewerSelection(false)}
                data-testid="button-close-viewer-selection"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={selectAllFollowers}
                data-testid="button-select-all"
              >
                Select All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={deselectAllFollowers}
                data-testid="button-deselect-all"
              >
                Deselect All
              </Button>
            </div>

            <ScrollArea className="h-[300px] rounded-md border p-2">
              {followers && followers.length > 0 ? (
                <div className="space-y-2">
                  {followers.map(({ follower }) => (
                    <div
                      key={follower.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover-elevate cursor-pointer"
                      onClick={() => toggleViewer(follower.id)}
                      data-testid={`viewer-${follower.id}`}
                    >
                      <Checkbox
                        checked={selectedViewers.includes(follower.id)}
                        onCheckedChange={() => toggleViewer(follower.id)}
                        data-testid={`checkbox-viewer-${follower.id}`}
                      />
                      <Avatar className="h-10 w-10">
                        <AvatarFallback className="bg-primary/10 text-primary">
                          {(follower.displayName || follower.username).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {follower.displayName || follower.username}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          @{follower.username}
                        </p>
                      </div>
                      {selectedViewers.includes(follower.id) && (
                        <Check className="h-4 w-4 text-primary" />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center p-4">
                  <Users className="h-12 w-12 text-muted-foreground mb-2" />
                  <p className="text-muted-foreground">
                    No followers yet. When someone follows you, they'll appear here.
                  </p>
                </div>
              )}
            </ScrollArea>

            <Button
              onClick={() => setShowViewerSelection(false)}
              className="w-full"
              data-testid="button-done-selecting"
            >
              Done ({selectedViewers.length} selected)
            </Button>
          </div>
        )}
      </DialogContent>

      <StoryCamera
        open={showFullscreenCamera}
        onClose={() => setShowFullscreenCamera(false)}
        onCapture={handleCameraCapture}
        onSwitchToUpload={() => {
          // Trigger the file upload input
          const fileInput = document.getElementById('story-image-upload') as HTMLInputElement;
          if (fileInput) {
            fileInput.click();
          }
        }}
      />
    </Dialog>
  );
}
