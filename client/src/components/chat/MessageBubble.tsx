import { useLocation } from "wouter";
import { format } from "date-fns";
import { Reply } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import ImageGrid from "@/components/ImageGrid";
import FeedVideoPlayer from "@/components/FeedVideoPlayer";
import PollMessage from "@/components/PollMessage";
import { renderMessageWithMentions } from "@/components/MentionInput";
import { AttachedEvent, AttachedVenue, StoryReplyCard } from "./AttachedCards";
import { initialOf, personName } from "./chatUtils";
import type { ChatMessage } from "./types";

interface MessageBubbleProps {
  message: ChatMessage;
  isOwn: boolean;
  first: boolean;
  last: boolean;
  showSender: boolean;
  currentUserId: string;
  currentUsername: string;
  onOpenActions: (message: ChatMessage) => void;
}

// Bubble corners follow the run: only the outer corners of a run of messages are fully round.
function corners(isOwn: boolean, first: boolean, last: boolean) {
  const tl = isOwn ? "rounded-tr-md" : "rounded-tl-md";
  const bl = isOwn ? "rounded-br-md" : "rounded-bl-md";
  return `${first ? "" : tl} ${last ? "" : bl}`;
}

export default function MessageBubble({ message, isOwn, first, last, showSender, currentUserId, currentUsername, onOpenActions }: MessageBubbleProps) {
  const [, navigate] = useLocation();
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const hasImages = (message.imageUrls?.length ?? 0) > 0;
  const hasVideo = !!message.videoUrl;
  const hasMedia = hasImages || hasVideo;
  const isPoll = message.messageType === "poll" && !!message.pollId;
  const name = personName(message.sender);

  const body = isPoll ? (
    <div onClick={stop}>
      <PollMessage pollId={message.pollId as string} currentUserId={currentUserId} isOwnMessage={isOwn} />
    </div>
  ) : message.isDeleted ? (
    <div className="rounded-[18px] border border-dashed px-3.5 py-2 text-sm italic text-muted-foreground" data-testid={`message-deleted-${message.id}`}>
      Message deleted
    </div>
  ) : (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenActions(message)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenActions(message); } }}
      className={`max-w-full cursor-pointer break-words rounded-[18px] text-[15.5px] leading-snug outline-offset-2 transition-transform active:scale-[0.99] ${corners(isOwn, first, last)} ${
        isOwn ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
      } ${hasMedia ? "p-1" : "px-3.5 py-2"}`}
      aria-label="Message options"
      data-testid={`bubble-${message.id}`}
    >
      {message.messageType === "story_reply" && <div className="px-2 pt-2"><StoryReplyCard story={message.story} /></div>}
      {message.replyTo && (
        <div className={`mb-1.5 rounded-lg border-l-2 border-current bg-background/15 px-2 py-1 text-[13px] opacity-90 ${hasMedia ? "mx-2 mt-2" : ""}`}>
          <b className="flex items-center gap-1 text-xs font-semibold"><Reply className="h-3 w-3" />{message.replyTo.sender?.username ?? "Unknown"}</b>
          <span className="line-clamp-1">{message.replyTo.isDeleted ? "Message deleted" : message.replyTo.content || "Attachment"}</span>
        </div>
      )}
      {hasImages && (
        <div className="w-[230px] max-w-full overflow-hidden rounded-[14px]" onClick={stop}>
          <ImageGrid images={message.imageUrls as string[]} maxImages={4} />
        </div>
      )}
      {hasVideo && (
        <div className="w-[230px] max-w-full overflow-hidden rounded-[14px]" onClick={stop}>
          <FeedVideoPlayer src={message.videoUrl as string} autoPlay={false} loop={false} />
        </div>
      )}
      {message.content && (
        <p className={`whitespace-pre-wrap break-words ${hasMedia ? "px-2.5 pb-1.5 pt-2" : ""}`}>
          {renderMessageWithMentions(message.content, currentUsername, (u) => navigate(`/profile/${u}`))}
        </p>
      )}
      {(message.eventId || message.venueId) && (
        <div className={hasMedia ? "px-2 pb-2" : ""} onClick={stop}>
          {message.eventId && <AttachedEvent eventId={message.eventId} />}
          {message.venueId && <AttachedVenue venueId={message.venueId} />}
        </div>
      )}
    </div>
  );

  return (
    <div className={`flex items-end gap-2 ${isOwn ? "justify-end" : ""} ${first ? "mt-2" : ""}`} data-testid={`message-${message.id}`}>
      {!isOwn && (
        <Avatar
          className={`h-8 w-8 flex-none cursor-pointer ${last ? "" : "invisible"}`}
          onClick={() => navigate(`/profile/${message.sender.username}`)}
        >
          <AvatarImage src={message.sender.avatarUrl || ""} alt={name} />
          <AvatarFallback className="text-xs">{initialOf(name)}</AvatarFallback>
        </Avatar>
      )}
      <div className={`flex min-w-0 max-w-[78%] flex-col gap-0.5 ${isOwn ? "items-end" : "items-start"}`}>
        {!isOwn && showSender && <span className="ml-0.5 text-xs font-medium text-muted-foreground">{name}</span>}
        {body}
        {last && !message.isDeleted && (
          <time className="mx-1 mt-0.5 text-[11px] text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()}>
            {format(new Date(message.createdAt), "HH:mm")}
          </time>
        )}
      </div>
    </div>
  );
}
