import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Building2, CalendarDays, ImageIcon, Play } from "lucide-react";
import type { Event, Story, User, Venue } from "@shared/schema";

// Cards a message can carry: a shared event, a shared venue, or the story someone replied to.
// They sit inside a bubble, so they tint from the bubble's own text colour instead of fixed colours.

const cardClass =
  "mt-2 flex w-full min-w-[220px] items-center gap-2.5 rounded-xl border border-foreground/10 bg-background/40 p-2 text-left transition-colors hover:bg-background/60 active:scale-[0.99]";

export function AttachedEvent({ eventId }: { eventId: string }) {
  const [, navigate] = useLocation();
  const { data: event } = useQuery<Event>({ queryKey: ["/api/events", eventId], enabled: !!eventId });
  if (!event) return null;
  return (
    <button type="button" className={cardClass} onClick={() => navigate(`/event/${event.id}`)} data-testid={`card-attached-event-${event.id}`}>
      {event.imageUrl ? (
        <img src={event.imageUrl} alt="" className="h-11 w-11 flex-none rounded-lg object-cover" />
      ) : (
        <span className="grid h-11 w-11 flex-none place-items-center rounded-lg bg-background/50"><CalendarDays className="h-5 w-5" /></span>
      )}
      <span className="min-w-0">
        <b className="block truncate text-sm font-semibold leading-tight">{event.title}</b>
        <small className="block truncate text-xs opacity-75">{format(new Date(event.eventDate), "EEE d MMM")} · {event.location}</small>
      </span>
    </button>
  );
}

export function AttachedVenue({ venueId }: { venueId: string }) {
  const [, navigate] = useLocation();
  const { data: venue } = useQuery<Venue>({ queryKey: ["/api/venues", venueId], enabled: !!venueId });
  if (!venue) return null;
  const image = venue.coverImageUrl || venue.imageUrl;
  return (
    <button type="button" className={cardClass} onClick={() => navigate(`/venue/${venue.id}`)} data-testid={`card-attached-venue-${venue.id}`}>
      {image ? (
        <img src={image} alt="" className="h-11 w-11 flex-none rounded-lg object-cover" />
      ) : (
        <span className="grid h-11 w-11 flex-none place-items-center rounded-lg bg-background/50"><Building2 className="h-5 w-5" /></span>
      )}
      <span className="min-w-0">
        <b className="block truncate text-sm font-semibold leading-tight">{venue.name}</b>
        <small className="block truncate text-xs opacity-75">{venue.city || venue.location}</small>
      </span>
    </button>
  );
}

export function StoryReplyCard({ story }: { story?: Story & { user: User } }) {
  const [, navigate] = useLocation();
  const expired = story ? (story.expiresAt ? new Date(story.expiresAt) < new Date() : false) : true;
  const available = !!story && !expired;
  return (
    <div className="mb-2">
      <button
        type="button"
        disabled={!available}
        onClick={() => available && navigate(`/stories/${story!.id}`)}
        className={`relative block h-[198px] w-28 select-none overflow-hidden rounded-xl bg-black/30 text-left ${available ? "transition-transform active:scale-[0.97]" : "opacity-60"}`}
        aria-label={available ? "Open story" : "Story expired"}
      >
        {available ? (
          <>
            <img src={story!.imageUrl} alt="Story" className="absolute inset-0 h-full w-full object-cover" />
            {story!.type === "video" && (
              <span className="absolute left-1.5 top-1.5 rounded-full bg-black/50 p-1"><Play className="h-3 w-3 text-white" /></span>
            )}
            <span className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-2 text-[10px] font-medium text-white">@{story!.user.username}</span>
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[10px] opacity-70">
            <ImageIcon className="h-5 w-5" />Story expired
          </span>
        )}
      </button>
      <p className="mt-1 text-[10px] opacity-70">Replied to story</p>
    </div>
  );
}
