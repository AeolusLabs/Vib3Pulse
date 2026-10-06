import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { UsersIcon, MessageCircleIcon } from "@/components/ui/icons";
import type { EventLinks } from "@shared/schema";

// One shared fetch (deduped by react-query) feeds every event card on screen.
export function useEventLinks(): Record<string, EventLinks> {
  const { data } = useQuery<Record<string, EventLinks>>({
    queryKey: ["/api/events/links"],
    staleTime: 60_000,
  });
  return data ?? {};
}

const stop = (e: React.MouseEvent) => e.stopPropagation();

// Community + group-chat indicators for an event card. Renders nothing when
// the event has neither. The chat badge only links for chat participants.
export default function EventLinkBadges({ eventId, className = "" }: { eventId: string; className?: string }) {
  const links = useEventLinks()[eventId];
  if (!links || (!links.communitySlug && !links.hasGroupChat)) return null;

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} data-testid={`event-links-${eventId}`}>
      {links.communitySlug && (
        <Link href={`/community/${links.communitySlug}`} onClick={stop}>
          <Badge variant="secondary" className="text-[10px] gap-1 cursor-pointer max-w-full" data-testid="badge-event-community">
            <UsersIcon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{links.communityName}</span>
          </Badge>
        </Link>
      )}
      {links.hasGroupChat &&
        (links.groupChatId ? (
          <Link href={`/messages/${links.groupChatId}`} onClick={stop}>
            <Badge variant="secondary" className="text-[10px] gap-1 cursor-pointer" data-testid="badge-event-chat">
              <MessageCircleIcon className="h-3 w-3" />
              Group chat
            </Badge>
          </Link>
        ) : (
          <Badge variant="outline" className="text-[10px] gap-1" data-testid="badge-event-chat">
            <MessageCircleIcon className="h-3 w-3" />
            Group chat
          </Badge>
        ))}
    </div>
  );
}
