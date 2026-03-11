import { useState, useEffect } from "react";
import { ImagePlus, Calendar, MapPin, Building2, Users, Film } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { Event, Venue, Community } from "@shared/schema";
import { MultiImageUploader } from "./MultiImageUploader";
import { VideoUploader } from "./VideoUploader";

type CommunityWithRole = Community & { memberCount: number; role: string };

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
  defaultCommunityId?: string | null;
  onCreatePost?: (content: string, images?: string[], eventId?: string, venueId?: string, communityId?: string, videoDataUrl?: string, videoUrl?: string) => void;
}

export default function CreatePostModal({ 
  open, 
  onClose, 
  attachedEvent,
  attachedVenue,
  defaultCommunityId,
  onCreatePost 
}: CreatePostModalProps) {
  const { data: currentUser } = useAuth();
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [mediaMode, setMediaMode] = useState<"photos" | "video">("photos");
  const [selectedCommunityId, setSelectedCommunityId] = useState<string>("none");
  const maxLength = 280;
  const maxImages = 4;

  // Fetch user's communities
  const { data: myCommunities = [] } = useQuery<CommunityWithRole[]>({
    queryKey: ['/api/communities/my'],
    enabled: open && !!currentUser,
  });

  // Set default community when opening - sync on every open
  useEffect(() => {
    if (open) {
      setSelectedCommunityId(defaultCommunityId || "none");
    }
  }, [open, defaultCommunityId]);

  useEffect(() => {
    if (open && (attachedEvent || attachedVenue)) {
      const itemName = attachedEvent?.title || attachedVenue?.name || "";
      const itemType = attachedEvent ? "event" : "venue";
      setContent(`Check out this ${itemType}: ${itemName} `);
    }
  }, [open, attachedEvent, attachedVenue]);

  const switchMediaMode = (mode: "photos" | "video") => {
    if (mode === mediaMode) return;
    setMediaMode(mode);
    setSelectedImages([]);
    setUploadedVideoUrl(null);
  };

  const handlePost = () => {
    if (content.trim()) {
      onCreatePost?.(
        content, 
        selectedImages.length > 0 ? selectedImages : undefined,
        attachedEvent?.id,
        attachedVenue?.id,
        selectedCommunityId !== "none" ? selectedCommunityId : undefined,
        undefined,
        uploadedVideoUrl || undefined
      );
      setContent("");
      setSelectedImages([]);
      setUploadedVideoUrl(null);
      setSelectedCommunityId("none");
      onClose();
    }
  };

  const handleClose = () => {
    setContent("");
    setSelectedImages([]);
    setUploadedVideoUrl(null);
    setMediaMode("photos");
    setSelectedCommunityId("none");
    onClose();
  };

  const remainingChars = maxLength - content.length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif">Create Post</DialogTitle>
          <DialogDescription>
            {attachedEvent 
              ? `Share the event "${attachedEvent.title}" with your followers`
              : attachedVenue
                ? `Share the venue "${attachedVenue.name}" with your followers`
                : "Share what's happening with your followers"
            }
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-3">
            <Avatar className="h-10 w-10 flex-shrink-0">
              <AvatarImage 
                src="" 
                alt={currentUser?.userType === 'social' 
                  ? (currentUser.displayName || currentUser.username) 
                  : (currentUser?.organizationName || currentUser?.username || 'User')
                } 
              />
              <AvatarFallback className="bg-primary/10 text-primary">
                {currentUser?.userType === 'social'
                  ? (currentUser.displayName?.charAt(0) || currentUser.username.charAt(0)).toUpperCase()
                  : (currentUser?.organizationName?.charAt(0) || currentUser?.username.charAt(0) || 'U').toUpperCase()
                }
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 space-y-3">
              <Textarea
                placeholder="What's happening?"
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, maxLength))}
                className="resize-none border-0 text-lg focus-visible:ring-0 min-h-[120px]"
                data-testid="textarea-post-content"
              />

              {attachedEvent && (
                <Card className="border-2 border-primary/30 bg-primary/5">
                  <CardContent className="p-3">
                    <div className="flex gap-3">
                      {attachedEvent.imageUrl && (
                        <img 
                          src={attachedEvent.imageUrl} 
                          alt={attachedEvent.title}
                          className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <Badge variant="secondary" className="mb-1 text-xs">
                          <Calendar className="h-3 w-3 mr-1" />
                          Event
                        </Badge>
                        <h4 className="font-semibold text-sm line-clamp-1">{attachedEvent.title}</h4>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(attachedEvent.eventDate), "MMM d, yyyy")}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          <span className="line-clamp-1">{attachedEvent.location}</span>
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {attachedVenue && (
                <Card className="border-2 border-primary/30 bg-primary/5">
                  <CardContent className="p-3">
                    <div className="flex gap-3">
                      {(attachedVenue.coverImageUrl || attachedVenue.imageUrl) && (
                        <img 
                          src={attachedVenue.coverImageUrl || attachedVenue.imageUrl || ""} 
                          alt={attachedVenue.name}
                          className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <Badge variant="secondary" className="mb-1 text-xs">
                          <Building2 className="h-3 w-3 mr-1" />
                          Venue
                        </Badge>
                        <h4 className="font-semibold text-sm line-clamp-1">{attachedVenue.name}</h4>
                        <p className="text-xs text-muted-foreground">{attachedVenue.category}</p>
                        {attachedVenue.city && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            <span className="line-clamp-1">{attachedVenue.city}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {mediaMode === "photos" && (
                <MultiImageUploader
                  maxImages={maxImages}
                  images={selectedImages}
                  onImagesChange={setSelectedImages}
                  compact
                />
              )}

              {mediaMode === "video" && (
                <VideoUploader
                  videoUrl={uploadedVideoUrl}
                  onComplete={(objectPath) => setUploadedVideoUrl(objectPath)}
                  onClear={() => setUploadedVideoUrl(null)}
                  compact={!uploadedVideoUrl}
                />
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t">
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-md border overflow-visible">
                <Button
                  variant={mediaMode === "photos" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => switchMediaMode("photos")}
                  className="rounded-r-none"
                  data-testid="button-mode-photos"
                >
                  <ImagePlus className="h-4 w-4 mr-1" />
                  Photos
                </Button>
                <Button
                  variant={mediaMode === "video" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => switchMediaMode("video")}
                  className="rounded-l-none"
                  data-testid="button-mode-video"
                >
                  <Film className="h-4 w-4 mr-1" />
                  Video
                </Button>
              </div>

            
              
              {myCommunities.length > 0 && (
                <Select value={selectedCommunityId} onValueChange={setSelectedCommunityId}>
                  <SelectTrigger className="w-[160px] h-8" data-testid="select-community-trigger">
                    <Users className="h-4 w-4 mr-1" />
                    <SelectValue placeholder="Post to..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" data-testid="select-item-my-feed">My Feed</SelectItem>
                    {myCommunities.map((community) => (
                      <SelectItem key={community.id} value={community.id} data-testid={`select-item-community-${community.id}`}>
                        {community.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`text-sm ${
                  remainingChars < 20
                    ? remainingChars < 0
                      ? 'text-destructive'
                      : 'text-orange-500'
                    : 'text-muted-foreground'
                }`}
                data-testid="text-char-count"
              >
                {remainingChars}
              </span>
              <Button
                onClick={handlePost}
                disabled={!content.trim() || remainingChars < 0}
                data-testid="button-post"
              >
                Post
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
