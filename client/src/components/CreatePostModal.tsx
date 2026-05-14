import { useState, useEffect, useRef } from "react";
import { Images, Calendar, Building2, Users, Globe, X, MapPin, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import MentionTextarea from "@/components/MentionTextarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { Event, Venue, Community } from "@shared/schema";
import { VideoUploader } from "./VideoUploader";

type CommunityWithRole = Community & { memberCount: number; role: string };

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  attachedEvent?: Event | null;
  attachedVenue?: Venue | null;
  defaultCommunityId?: string | null;
  onCreatePost?: (
    content: string,
    images?: string[],
    eventId?: string,
    venueId?: string,
    communityId?: string,
    videoDataUrl?: string,
    videoUrl?: string
  ) => void;
}

const MAX_IMAGES = 4;

function CharacterRing({ count, max }: { count: number; max: number }) {
  const r = 14;
  const circumference = 2 * Math.PI * r;
  const ratio = Math.min(count / max, 1.05);
  const offset = circumference * (1 - ratio);
  const color = count > max ? "#ef4444" : count > max * 0.8 ? "#f59e0b" : "#22c55e";
  const showNumber = count > max * 0.8;

  return (
    <div className="relative h-8 w-8 flex items-center justify-center flex-shrink-0">
      <svg width="32" height="32" viewBox="0 0 32 32" className="-rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="2.5" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.15s ease, stroke 0.15s ease" }}
        />
      </svg>
      {showNumber && (
        <span className="absolute text-[10px] font-semibold tabular-nums" style={{ color }}>
          {max - count}
        </span>
      )}
    </div>
  );
}

export default function CreatePostModal({
  open,
  onClose,
  attachedEvent,
  attachedVenue,
  defaultCommunityId,
  onCreatePost,
}: CreatePostModalProps) {
  const { data: currentUser } = useAuth();
  const [content, setContent] = useState("");
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [videoFileToUpload, setVideoFileToUpload] = useState<File | null>(null);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string>("none");
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const maxLength = 280;

  const hasImages = selectedImages.length > 0;
  const hasVideo = !!(videoFileToUpload || uploadedVideoUrl);

  const { data: myCommunities = [] } = useQuery<CommunityWithRole[]>({
    queryKey: ["/api/communities/my"],
    enabled: open && !!currentUser,
  });

  useEffect(() => {
    if (open) setSelectedCommunityId(defaultCommunityId || "none");
  }, [open, defaultCommunityId]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const diff = window.innerHeight - (vv.height + vv.offsetTop);
      setKeyboardOffset(Math.max(0, diff));
    };
    if (open) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      update();
    } else {
      setKeyboardOffset(0);
    }
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [open]);

  useEffect(() => {
    if (open && (attachedEvent || attachedVenue)) {
      const name = attachedEvent?.title || attachedVenue?.name || "";
      const type = attachedEvent ? "event" : "venue";
      setContent(`Check out this ${type}: ${name} `);
    }
  }, [open, attachedEvent, attachedVenue]);

  const openMediaPicker = () => {
    if (mediaInputRef.current) {
      mediaInputRef.current.value = "";
      mediaInputRef.current.click();
    }
  };

  const handleMediaSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const videoFiles = files.filter((f) =>
      ["video/mp4", "video/quicktime", "video/webm"].includes(f.type)
    );

    if (videoFiles.length > 0 && imageFiles.length === 0) {
      // Pure video selection — clear images, start video upload
      setSelectedImages([]);
      setUploadedVideoUrl(null);
      setVideoFileToUpload(videoFiles[0]);
    } else if (imageFiles.length > 0) {
      // Images selected — clear video, add images up to MAX_IMAGES
      setVideoFileToUpload(null);
      setUploadedVideoUrl(null);
      const remaining = MAX_IMAGES - selectedImages.length;
      if (remaining <= 0) return;
      const toAdd = imageFiles.slice(0, remaining);
      toAdd.forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setSelectedImages((prev) => {
            if (prev.length >= MAX_IMAGES) return prev;
            return [...prev, reader.result as string];
          });
        };
        reader.readAsDataURL(file);
      });
    }

    e.target.value = "";
  };

  const removeImage = (index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const clearVideo = () => {
    setVideoFileToUpload(null);
    setUploadedVideoUrl(null);
  };

  const cycleAudience = () => {
    if (myCommunities.length === 0) return;
    const options = ["none", ...myCommunities.map((c) => c.id)];
    const idx = options.indexOf(selectedCommunityId);
    setSelectedCommunityId(options[(idx + 1) % options.length]);
  };

  const handlePost = () => {
    if (!content.trim()) return;
    onCreatePost?.(
      content,
      selectedImages.length > 0 ? selectedImages : undefined,
      attachedEvent?.id,
      attachedVenue?.id,
      selectedCommunityId !== "none" ? selectedCommunityId : undefined,
      undefined,
      uploadedVideoUrl || undefined
    );
    resetAndClose();
  };

  const resetAndClose = () => {
    setContent("");
    setSelectedImages([]);
    setUploadedVideoUrl(null);
    setVideoFileToUpload(null);
    setSelectedCommunityId("none");
    onClose();
  };

  const selectedCommunity = myCommunities.find((c) => c.id === selectedCommunityId);
  const canPost = content.trim().length > 0 && content.length <= maxLength;
  const authorName =
    currentUser?.userType === "social"
      ? currentUser?.displayName || currentUser?.username
      : currentUser?.organizationName || currentUser?.username;
  const avatarInitial =
    (
      currentUser?.userType === "social"
        ? currentUser?.displayName?.charAt(0) || currentUser?.username.charAt(0)
        : currentUser?.organizationName?.charAt(0) || currentUser?.username.charAt(0)
    )?.toUpperCase() || "U";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && resetAndClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        <DialogPrimitive.Content
          className={cn(
            "fixed inset-0 z-50 flex flex-col bg-background outline-none",
            "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
            "sm:w-full sm:max-w-xl sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl sm:max-h-[85vh]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          )}
          style={keyboardOffset > 0 ? { paddingBottom: keyboardOffset } : undefined}
        >
          <DialogPrimitive.Title className="sr-only">New Post</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Compose and share a new post with your followers.
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <button
              onClick={resetAndClose}
              className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            <span className="font-semibold text-sm">New Post</span>
            <button
              onClick={handlePost}
              disabled={!canPost}
              className="px-4 py-1.5 rounded-full text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors"
              data-testid="button-post"
            >
              Post
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2">
            <div className="flex gap-3">
              {/* Avatar + thread line */}
              <div className="flex flex-col items-center flex-shrink-0">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={currentUser?.avatarUrl || ""} alt={authorName || "User"} />
                  <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                    {avatarInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="w-0.5 flex-1 bg-border/40 mt-2 rounded-full min-h-[16px]" />
              </div>

              {/* Compose area */}
              <div className="flex-1 min-w-0 pb-4">
                {/* Author + audience pill */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="font-semibold text-sm leading-none">{authorName}</span>
                  {myCommunities.length > 0 && (
                    <button
                      onClick={cycleAudience}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
                      title="Tap to change audience"
                      data-testid="button-audience-pill"
                    >
                      {selectedCommunity ? (
                        <>
                          <Users className="h-3 w-3" />
                          {selectedCommunity.name}
                        </>
                      ) : (
                        <>
                          <Globe className="h-3 w-3" />
                          Everyone
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Textarea */}
                <MentionTextarea
                  placeholder="What's happening?"
                  value={content}
                  onChange={setContent}
                  maxLength={maxLength}
                  rows={4}
                  className="resize-none border-0 bg-transparent text-[18px] leading-relaxed focus-visible:ring-0 p-0 min-h-[80px] placeholder:text-muted-foreground/60 shadow-none"
                  data-testid="textarea-post-content"
                />

                {/* Attached event */}
                {attachedEvent && (
                  <Card className="border border-primary/30 bg-primary/5 mt-3">
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

                {/* Attached venue */}
                {attachedVenue && (
                  <Card className="border border-primary/30 bg-primary/5 mt-3">
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

                {/* Image preview grid */}
                {hasImages && (
                  <div className="mt-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      {selectedImages.map((img, i) => (
                        <div key={i} className="relative rounded-lg overflow-hidden border aspect-square group">
                          <img src={img} alt={`Upload ${i + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                          <Button
                            type="button"
                            variant="destructive"
                            size="icon"
                            className="absolute top-1 right-1 h-7 w-7 rounded-full shadow-lg"
                            onClick={() => removeImage(i)}
                            data-testid={`button-remove-image-${i}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      {selectedImages.length < MAX_IMAGES && (
                        <button
                          type="button"
                          onClick={openMediaPicker}
                          className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors"
                          aria-label="Add more images"
                          data-testid="button-add-more-images"
                        >
                          <Plus className="h-6 w-6" />
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {selectedImages.length}/{MAX_IMAGES} images
                    </p>
                  </div>
                )}

                {/* Video uploader — receives the file and auto-uploads */}
                {hasVideo && (
                  <div className="mt-3">
                    <VideoUploader
                      fileToUpload={videoFileToUpload}
                      videoUrl={uploadedVideoUrl}
                      onComplete={(objectPath) => {
                        setUploadedVideoUrl(objectPath);
                        setVideoFileToUpload(null);
                      }}
                      onClear={clearVideo}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer toolbar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-border flex-shrink-0">
            <div className="flex items-center gap-0.5">
              {/* Single unified media button */}
              <button
                onClick={openMediaPicker}
                disabled={hasVideo}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-full transition-colors",
                  hasImages
                    ? "text-primary bg-primary/10"
                    : hasVideo
                    ? "text-muted-foreground/30 cursor-not-allowed"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                )}
                aria-label="Add photos or video"
                data-testid="button-add-media"
              >
                <Images className="h-5 w-5" />
              </button>
              <button
                disabled
                className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground/35 cursor-not-allowed"
                aria-label="Add event (coming soon)"
              >
                <Calendar className="h-5 w-5" />
              </button>
              <button
                disabled
                className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground/35 cursor-not-allowed"
                aria-label="Add venue (coming soon)"
              >
                <Building2 className="h-5 w-5" />
              </button>
            </div>

            <CharacterRing count={content.length} max={maxLength} />
          </div>

          {/* Hidden unified file input — accepts both images and videos */}
          <input
            ref={mediaInputRef}
            type="file"
            accept="image/*,video/mp4,video/quicktime,video/webm"
            multiple
            className="hidden"
            onChange={handleMediaSelected}
            data-testid="input-media-upload"
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
