import { useState, useEffect } from "react";
import { ImagePlus, Film, Calendar, Building2, Users, Globe, X, MapPin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import MentionTextarea from "@/components/MentionTextarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
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

// B2: SVG circular character counter — green → amber → red
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
  const [mediaMode, setMediaMode] = useState<"none" | "photos" | "video">("none");
  const [selectedCommunityId, setSelectedCommunityId] = useState<string>("none");
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const maxLength = 280;

  const { data: myCommunities = [] } = useQuery<CommunityWithRole[]>({
    queryKey: ["/api/communities/my"],
    enabled: open && !!currentUser,
  });

  useEffect(() => {
    if (open) setSelectedCommunityId(defaultCommunityId || "none");
  }, [open, defaultCommunityId]);

  // Track virtual keyboard height via visualViewport so the toolbar stays above the keyboard
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

  const toggleMediaMode = (mode: "photos" | "video") => {
    if (mediaMode === mode) {
      setMediaMode("none");
      if (mode === "photos") setSelectedImages([]);
      else setUploadedVideoUrl(null);
    } else {
      setMediaMode(mode);
      setSelectedImages([]);
      setUploadedVideoUrl(null);
    }
  };

  // B5: cycle audience through Everyone → community1 → community2 → …
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
    setMediaMode("none");
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
        {/* Backdrop */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* B1: full-screen on mobile, centered card on sm+ */}
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

          {/* ── Header ── */}
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

          {/* ── Scrollable body ── */}
          <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2">
            <div className="flex gap-3">
              {/* Avatar + vertical thread line */}
              <div className="flex flex-col items-center flex-shrink-0">
                <Avatar className="h-10 w-10">
                  <AvatarImage src="" alt={authorName || "User"} />
                  <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                    {avatarInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="w-0.5 flex-1 bg-border/40 mt-2 rounded-full min-h-[16px]" />
              </div>

              {/* Compose area */}
              <div className="flex-1 min-w-0 pb-4">
                {/* Author + B5: audience pill */}
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

                {/* B4: 18px borderless textarea */}
                <MentionTextarea
                  placeholder="What's happening?"
                  value={content}
                  onChange={setContent}
                  maxLength={maxLength}
                  rows={4}
                  className="resize-none border-0 bg-transparent text-[18px] leading-relaxed focus-visible:ring-0 p-0 min-h-[80px] placeholder:text-muted-foreground/60 shadow-none"
                  data-testid="textarea-post-content"
                />

                {/* Attached event card */}
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

                {/* Attached venue card */}
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

                {/* Media uploaders */}
                {mediaMode === "photos" && (
                  <div className="mt-3">
                    <MultiImageUploader
                      maxImages={4}
                      images={selectedImages}
                      onImagesChange={setSelectedImages}
                      compact
                    />
                  </div>
                )}
                {mediaMode === "video" && (
                  <div className="mt-3">
                    <VideoUploader
                      videoUrl={uploadedVideoUrl}
                      onComplete={(objectPath) => setUploadedVideoUrl(objectPath)}
                      onClear={() => setUploadedVideoUrl(null)}
                      compact={!uploadedVideoUrl}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Footer toolbar ── */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-border flex-shrink-0">
            {/* B3: individual icon buttons */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => toggleMediaMode("photos")}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-full transition-colors",
                  mediaMode === "photos"
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                )}
                aria-label="Add photos"
                data-testid="button-mode-photos"
              >
                <ImagePlus className="h-5 w-5" />
              </button>
              <button
                onClick={() => toggleMediaMode("video")}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-full transition-colors",
                  mediaMode === "video"
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                )}
                aria-label="Add video"
                data-testid="button-mode-video"
              >
                <Film className="h-5 w-5" />
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

            {/* B2: character ring */}
            <CharacterRing count={content.length} max={maxLength} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
