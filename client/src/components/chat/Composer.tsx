import { useEffect, useRef, useState } from "react";
import { BarChart3, Building2, ImagePlus, Loader2, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MentionInput } from "@/components/MentionInput";
import { VideoUploader } from "@/components/VideoUploader";
import type { User } from "@shared/schema";
import type { ChatMessage } from "./types";

// Matches CreatePostModal's cap so the two attachment flows stay consistent.
const MAX_CHAT_IMAGES = 4;

export interface ComposerPayload {
  content: string;
  /** data: URLs picked on this device; uploaded by the sender before the message is posted. */
  images?: string[];
  videoUrl?: string;
}

interface ComposerProps {
  participants: Array<{ user: User }>;
  replyingTo: ChatMessage | null;
  onCancelReply: () => void;
  /** Resolve true when the message was sent so the composer can clear itself. */
  onSend: (payload: ComposerPayload) => Promise<boolean>;
  sending: boolean;
  onOpenPoll: () => void;
  onOpenShare: () => void;
  /** Changes when the open chat changes, to move focus into the field. */
  focusKey: string;
}

/** One composer for direct and group chats: + menu, pill field, round send, reply bar. */
export default function Composer({ participants, replyingTo, onCancelReply, onSend, sending, onOpenPoll, onOpenShare, focusKey }: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const hasImages = images.length > 0;
  const hasVideo = !!(videoFile || videoUrl);
  const uploadingVideo = !!videoFile && !videoUrl;
  const canSend = (!!text.trim() || hasImages || !!videoUrl) && !uploadingVideo && !sending;

  useEffect(() => {
    wrap.current?.querySelector<HTMLInputElement>("input[type=text], input:not([type])")?.focus();
  }, [focusKey]);

  const submit = async () => {
    if (!canSend) return;
    const ok = await onSend({ content: text.trim(), images: hasImages ? images : undefined, videoUrl: videoUrl ?? undefined });
    if (ok) {
      setText("");
      setImages([]);
      setVideoFile(null);
      setVideoUrl(null);
    }
  };

  const onMedia = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const videoFiles = files.filter((f) => f.type.startsWith("video/"));
    if (videoFiles.length > 0 && imageFiles.length === 0) {
      setImages([]);
      setVideoUrl(null);
      setVideoFile(videoFiles[0]);
    } else if (imageFiles.length > 0) {
      setVideoFile(null);
      setVideoUrl(null);
      const room = MAX_CHAT_IMAGES - images.length;
      imageFiles.slice(0, Math.max(room, 0)).forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => setImages((prev) => (prev.length >= MAX_CHAT_IMAGES ? prev : [...prev, reader.result as string]));
        reader.readAsDataURL(file);
      });
    }
    e.target.value = "";
  };

  return (
    <div className="flex-shrink-0 border-t bg-background px-3 pb-3 pt-2" ref={wrap} data-testid="composer">
      {replyingTo && (
        <div className="mb-2 flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-[13px]" data-testid="reply-bar">
          <div className="min-w-0 flex-1">
            <b className="block font-semibold text-primary">Replying to {replyingTo.sender?.displayName || replyingTo.sender?.username || "message"}</b>
            <p className="truncate text-muted-foreground">{replyingTo.content || "Attachment"}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 flex-none" onClick={onCancelReply} aria-label="Cancel reply" data-testid="button-cancel-reply">
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {hasImages && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative h-16 w-16 flex-none overflow-hidden rounded-lg border">
              <img src={img} alt={`Attachment ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                className="absolute right-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-background/90"
                onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                aria-label={`Remove attachment ${i + 1}`}
                data-testid={`button-remove-attachment-${i}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {hasVideo && (
        <div className="mb-2 max-w-[200px]">
          <VideoUploader
            compact={false}
            fileToUpload={videoFile}
            videoUrl={videoUrl}
            onComplete={(path) => { setVideoUrl(path); setVideoFile(null); }}
            onClear={() => { setVideoFile(null); setVideoUrl(null); }}
          />
        </div>
      )}

      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon" className="h-11 w-11 flex-none rounded-xl" aria-label="Add attachment" data-testid="button-attachment-menu">
              <Plus className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="min-w-[220px]">
            <DropdownMenuItem className="min-h-[44px]" onClick={() => { if (mediaInput.current) { mediaInput.current.value = ""; mediaInput.current.click(); } }} data-testid="menu-attach-media">
              <ImagePlus className="mr-3 h-4 w-4" />Photo or video
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" onClick={onOpenPoll} data-testid="menu-attach-poll">
              <BarChart3 className="mr-3 h-4 w-4" />Poll
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-[44px]" onClick={onOpenShare} data-testid="menu-attach-share">
              <Building2 className="mr-3 h-4 w-4" />Share an event or venue
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={mediaInput}
          type="file"
          accept="image/*,video/mp4,video/quicktime,video/webm"
          multiple
          className="hidden"
          onChange={onMedia}
          data-testid="input-attachment"
        />
        <MentionInput
          placeholder="Message"
          value={text}
          onChange={setText}
          participants={participants}
          onSubmit={() => void submit()}
          className="h-11 flex-1 rounded-full border-border/40 bg-muted/50 px-5 text-[15.5px]"
          data-testid="input-message"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="grid h-11 w-11 flex-none place-items-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-[0.95] disabled:opacity-40"
          aria-label="Send message"
          data-testid="button-send"
        >
          {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </button>
      </form>
    </div>
  );
}
