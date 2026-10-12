import { useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format } from "date-fns";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Event } from "@shared/schema";
import { conversationTitle, initialOf, inboxTime, lastSenderLabel, otherParticipant, personName } from "./chatUtils";
import { EVENT_CHAT_CLOSES_AFTER_DAYS, type ConversationWithDetails } from "./types";

interface ConversationRowProps {
  conv: ConversationWithDetails;
  meId: string;
  active: boolean;
  onOpen: (conv: ConversationWithDetails) => void;
}

/** Closing note for an event chat, e.g. "Closes in 5 days" (it auto-dissolves a week after the event). */
export function eventChatClosing(eventDate: Date | string): string | null {
  const closes = addDays(new Date(eventDate), EVENT_CHAT_CLOSES_AFTER_DAYS);
  const days = differenceInCalendarDays(closes, new Date());
  if (days < 0) return null;
  return days === 0 ? "Closes today" : `Closes in ${days} ${days === 1 ? "day" : "days"}`;
}

function RowAvatar({ conv, meId, event }: { conv: ConversationWithDetails; meId: string; event?: Event }) {
  if (conv.isGroup && event) {
    const d = new Date(event.eventDate);
    return (
      <span className="flex h-[52px] w-[52px] flex-none flex-col items-center justify-center rounded-[14px] border bg-card leading-none" aria-hidden="true">
        <b className="font-serif text-xl">{format(d, "d")}</b>
        <span className="mt-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">{format(d, "MMM")}</span>
      </span>
    );
  }
  if (conv.isGroup) {
    const members = conv.participants.filter((p) => p.userId !== meId).slice(0, 2);
    if (conv.avatarUrl || members.length < 2) {
      return (
        <Avatar className="h-[52px] w-[52px] flex-none">
          <AvatarImage src={conv.avatarUrl || ""} alt={conv.name || "Group"} />
          <AvatarFallback className="bg-primary/10 text-primary"><Users className="h-5 w-5" /></AvatarFallback>
        </Avatar>
      );
    }
    return (
      <span className="flex h-[52px] w-[52px] flex-none items-center" aria-hidden="true">
        {members.map((p, i) => (
          <Avatar key={p.userId} className={`h-9 w-9 border-2 border-background ${i > 0 ? "-ml-3" : ""}`}>
            <AvatarImage src={p.user.avatarUrl || ""} />
            <AvatarFallback className="text-xs">{initialOf(personName(p.user))}</AvatarFallback>
          </Avatar>
        ))}
      </span>
    );
  }
  const other = otherParticipant(conv, meId)?.user;
  const name = other ? personName(other) : "?";
  return (
    <Avatar className={`h-[52px] w-[52px] flex-none ${other?.userType === "organizer" ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}>
      <AvatarImage src={other?.avatarUrl || ""} alt={name} />
      <AvatarFallback className="bg-primary/10 font-semibold text-primary">{initialOf(name)}</AvatarFallback>
    </Avatar>
  );
}

export default function ConversationRow({ conv, meId, active, onOpen }: ConversationRowProps) {
  const unread = conv.unreadCount > 0;
  const { data: event } = useQuery<Event>({ queryKey: ["/api/events", conv.eventId], enabled: !!conv.eventId });
  const other = !conv.isGroup ? otherParticipant(conv, meId)?.user : undefined;
  const closing = event ? eventChatClosing(event.eventDate) : null;
  const sender = lastSenderLabel(conv, meId);

  return (
    <button
      type="button"
      onClick={() => onOpen(conv)}
      aria-current={active ? "true" : undefined}
      className={`grid min-h-[72px] w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-left transition-[background-color,transform] duration-150 active:scale-[0.99] hover-elevate ${active ? "bg-primary/10" : ""}`}
      data-testid={`conversation-${conv.id}`}
    >
      <RowAvatar conv={conv} meId={meId} event={event} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <b className={`truncate ${unread ? "font-semibold" : "font-medium"}`}>{conversationTitle(conv, meId)}</b>
          {conv.eventId && <span className="flex-none text-[11px] font-semibold uppercase tracking-wider text-primary">Event chat</span>}
          {conv.isGroup && !conv.eventId && (
            <span className="flex-none text-[11px] font-semibold text-muted-foreground">{conv.participants.length}</span>
          )}
          {other?.userType === "organizer" && <span className="flex-none text-[11px] font-semibold uppercase tracking-wider text-primary">Organiser</span>}
        </span>
        <span className={`block truncate text-[15px] ${unread ? "font-medium text-foreground" : "text-muted-foreground"}`}>
          {conv.lastMessagePreview ? (
            <>
              {sender && <span className={unread ? "text-foreground" : ""}>{sender}: </span>}
              {conv.lastMessagePreview}
            </>
          ) : (
            closing ?? "Say hello"
          )}
        </span>
        {conv.eventId && closing && conv.lastMessagePreview && <span className="block truncate text-xs text-muted-foreground">{closing}</span>}
      </span>
      <span className="flex flex-col items-end gap-1.5 text-xs text-muted-foreground">
        {conv.lastMessageAt && <time className={unread ? "font-semibold text-primary" : ""}>{inboxTime(conv.lastMessageAt)}</time>}
        {unread && (
          <span className="grid h-[22px] min-w-[22px] place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground" data-testid={`badge-unread-${conv.id}`}>
            {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
          </span>
        )}
      </span>
    </button>
  );
}
