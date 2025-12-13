import { Share2, MessageCircle, Newspaper } from "lucide-react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Event, Venue } from "@shared/schema";

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  event?: Event | null;
  venue?: Venue | null;
}

export default function ShareModal({ open, onClose, event, venue }: ShareModalProps) {
  const [, navigate] = useLocation();

  const itemName = event?.title || venue?.name || "Item";
  const itemType = event ? "event" : "venue";

  const handleShareToFeed = () => {
    const shareData = event 
      ? { type: "event", id: event.id, title: event.title }
      : venue 
        ? { type: "venue", id: venue.id, name: venue.name }
        : null;
    
    if (shareData) {
      sessionStorage.setItem("shareToFeed", JSON.stringify(shareData));
      navigate("/feed");
    }
    onClose();
  };

  const handleShareToMessage = () => {
    const shareData = event 
      ? { type: "event", id: event.id, title: event.title }
      : venue 
        ? { type: "venue", id: venue.id, name: venue.name }
        : null;
    
    if (shareData) {
      // Store in localStorage as backup AND pass via URL params to survive login redirects
      localStorage.setItem("shareToMessage", JSON.stringify(shareData));
      const encodedData = encodeURIComponent(JSON.stringify(shareData));
      navigate(`/messages?share=${encodedData}`);
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif flex items-center gap-2">
            <Share2 className="h-5 w-5 text-primary" />
            Share {itemType === "event" ? "Event" : "Venue"}
          </DialogTitle>
          <DialogDescription>
            Share "{itemName}" with your followers
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <Card 
            className="hover-elevate cursor-pointer border-2 border-transparent hover:border-primary/20"
            onClick={handleShareToFeed}
            data-testid="share-to-feed"
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Newspaper className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold">Share to Feed</h3>
                <p className="text-sm text-muted-foreground">
                  Create a post with this {itemType} attached
                </p>
              </div>
            </CardContent>
          </Card>

          <Card 
            className="hover-elevate cursor-pointer border-2 border-transparent hover:border-primary/20"
            onClick={handleShareToMessage}
            data-testid="share-to-message"
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <MessageCircle className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold">Send as Message</h3>
                <p className="text-sm text-muted-foreground">
                  Send this {itemType} directly to a follower
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-share">
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
