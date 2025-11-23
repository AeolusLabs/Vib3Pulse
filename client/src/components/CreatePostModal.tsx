import { useState } from "react";
import { Image as ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  onCreatePost?: (content: string, image?: string) => void;
}

export default function CreatePostModal({ open, onClose, onCreatePost }: CreatePostModalProps) {
  const { data: currentUser } = useAuth();
  const [content, setContent] = useState("");
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const maxLength = 280;

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
      onCreatePost?.(content, selectedImage || undefined);
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-serif">Create Post</DialogTitle>
          <DialogDescription>
            Share what's happening with your followers
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
                className="resize-none border-0 p-0 text-lg focus-visible:ring-0 min-h-[120px]"
                data-testid="textarea-post-content"
              />

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
