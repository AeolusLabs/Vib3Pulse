import { useState, useEffect } from "react";
import { Image as ImageIcon, X, Calendar, MapPin, Building2 } from "lucide-react";
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
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { Event, Venue } from "@shared/schema";

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
  onCreatePost?: (content: string, image?: string, eventId?: string, venueId?: string) => void;
}

export default function CreatePostModal({ 
  open, 
  onClose, 
  attachedEvent,
  attachedVenue,
  onCreatePost 
}: CreatePostModalProps) {
  const { data: currentUser } = useAuth();
  const [content, setContent] = useState("");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const maxLength = 280;

  useEffect(() => {
    if (open && (attachedEvent || attachedVenue)) {
      const itemName = attachedEvent?.title || attachedVenue?.name || "";
      const itemType = attachedEvent ? "event" : "venue";
      setContent(`Check out this ${itemType}: ${itemName} `);
    }
  }, [open, attachedEvent, attachedVenue]);

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

  const handlePost = () => {
    if (content.trim()) {
      onCreatePost?.(
        content, 
        selectedImage || undefined,
        attachedEvent?.id,
        attachedVenue?.id
      );
      console.log('Created post:', content, selectedImage ? 'with image' : 'text only');
      setContent("");
      setSelectedImage(null);
      onClose();
    }
  };

  const handleClose = () => {
    setContent("");
    setSelectedImage(null);
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

              {selectedImage && (
                <div className="relative rounded-lg overflow-hidden border">
                  <img
                    src={selectedImage}
                    alt="Upload preview"
                    className="w-full max-h-64 object-cover"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 bg-background/80 hover:bg-background"
                    onClick={() => setSelectedImage(null)}
                    data-testid="button-remove-image"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t">
            <div className="flex items-center gap-2">
              <label htmlFor="post-image-upload">
                <Button
                  variant="ghost"
                  size="icon"
                  asChild
                  data-testid="button-add-image"
                >
                  <span className="cursor-pointer">
                    <ImageIcon className="h-5 w-5 text-primary" />
                  </span>
                </Button>
              </label>
              <input
                id="post-image-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />
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
