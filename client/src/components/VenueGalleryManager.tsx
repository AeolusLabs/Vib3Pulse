import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ObjectUploader } from "@/components/ObjectUploader";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Replace, Upload, Camera, FolderOpen } from "lucide-react";

interface VenueGalleryManagerProps {
  venueId: string;
  imageUrls: string[];
  maxImages?: number;
}

export function VenueGalleryManager({ venueId, imageUrls: propImageUrls, maxImages = 6 }: VenueGalleryManagerProps) {
  const { toast } = useToast();
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  
  // Local state that syncs from props but can be optimistically updated
  const [localImageUrls, setLocalImageUrls] = useState<string[]>(propImageUrls);
  
  // Sync local state when props change (e.g., after query refetch)
  useEffect(() => {
    setLocalImageUrls(propImageUrls);
  }, [propImageUrls]);

  const updateGalleryMutation = useMutation({
    mutationFn: async (newImageUrls: string[]) => {
      const response = await apiRequest("PATCH", `/api/venues/${venueId}`, { imageUrls: newImageUrls });
      return response.json();
    },
    onMutate: async (newImageUrls) => {
      // Optimistically update local state immediately
      setLocalImageUrls(newImageUrls);
    },
    onSuccess: (data) => {
      // Update local state with server response to ensure consistency
      if (data?.imageUrls) {
        setLocalImageUrls(data.imageUrls);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId] });
      toast({ title: "Gallery updated successfully" });
    },
    onError: () => {
      // Revert to props on error
      setLocalImageUrls(propImageUrls);
      toast({ title: "Failed to update gallery", variant: "destructive" });
    },
  });

  const handleDeleteImage = (index: number) => {
    const newUrls = localImageUrls.filter((_, i) => i !== index);
    updateGalleryMutation.mutate(newUrls);
    setDeleteIndex(null);
  };

  const handleReplaceComplete = (urls: string[], index: number) => {
    if (urls[0]) {
      const newUrls = [...localImageUrls];
      newUrls[index] = urls[0];
      updateGalleryMutation.mutate(newUrls);
      setReplaceIndex(null);
    }
  };

  const handleAddComplete = (urls: string[]) => {
    if (urls.length > 0) updateGalleryMutation.mutate([...localImageUrls, ...urls]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Manage Gallery</h3>
        <span className="text-sm text-muted-foreground">
          {localImageUrls.length}/{maxImages} images
        </span>
      </div>

      {localImageUrls.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {localImageUrls.map((url, idx) => (
            <div key={`${url}-${idx}`} className="relative aspect-video rounded-lg overflow-hidden border">
              <img 
                src={url} 
                alt={`Gallery ${idx + 1}`} 
                className="w-full h-full object-cover"
              />
              <div className="absolute top-1.5 right-1.5 flex gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="h-7 w-7 rounded-full shadow-md bg-background/80 backdrop-blur-sm"
                  onClick={() => setReplaceIndex(idx)}
                  disabled={updateGalleryMutation.isPending}
                  data-testid={`button-replace-gallery-${idx}`}
                  title="Replace image"
                >
                  <Replace className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="destructive"
                  className="h-7 w-7 rounded-full shadow-md"
                  onClick={() => setDeleteIndex(idx)}
                  disabled={updateGalleryMutation.isPending}
                  data-testid={`button-delete-gallery-${idx}`}
                  title="Delete image"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {localImageUrls.length < maxImages && (
        <div className="space-y-3">
          <ObjectUploader
            maxNumberOfFiles={maxImages - localImageUrls.length}
            maxFileSizeMB={10}
            onComplete={handleAddComplete}
            buttonVariant="outline"
            buttonSize="default"
          >
            <Upload className="h-4 w-4 mr-2" />
            Add Photos
          </ObjectUploader>
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <Camera className="h-3 w-3" />
            You can take a photo or choose from your device
          </p>
        </div>
      )}

      <Dialog open={deleteIndex !== null} onOpenChange={() => setDeleteIndex(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Image</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this image from your gallery? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteIndex(null)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => deleteIndex !== null && handleDeleteImage(deleteIndex)}
              disabled={updateGalleryMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {updateGalleryMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={replaceIndex !== null} onOpenChange={() => setReplaceIndex(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace Image</DialogTitle>
            <DialogDescription>
              Choose a new image to replace the current one.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <ObjectUploader
              maxNumberOfFiles={1}
              maxFileSizeMB={10}
              onComplete={(urls) => replaceIndex !== null && handleReplaceComplete(urls, replaceIndex)}
              buttonVariant="default"
              buttonSize="default"
            >
              <FolderOpen className="h-4 w-4 mr-2" />
              Choose New Image
            </ObjectUploader>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
