import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { Event } from "@shared/schema";
import { CalendarIcon } from "@/components/ui/icons";

// Ranks other upcoming events by overlap with this one (category, city, organiser).
// Reuses the shared /api/events list cache — no extra request.
export default function SimilarEvents({ event }: { event: Event }) {
  const [, navigate] = useLocation();
  const { data } = useQuery<Event[] | { events: Event[] }>({ queryKey: ["/api/events"] });
  const all = Array.isArray(data) ? data : data?.events ?? [];
  const now = Date.now();

  const similar = all
    .filter((e) => e.id !== event.id && !e.isCancelled && new Date(e.eventDate).getTime() > now)
    .map((e) => ({
      e,
      score:
        (e.category === event.category ? 2 : 0) +
        (event.city && e.city === event.city ? 1 : 0) +
        (e.organizerId === event.organizerId ? 1 : 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || +new Date(a.e.eventDate) - +new Date(b.e.eventDate))
    .slice(0, 3)
    .map((x) => x.e);

  if (similar.length === 0) return null;

  return (
    <section aria-labelledby="similar-events-heading">
      <h3 id="similar-events-heading" className="text-sm font-semibold mb-2">More like this</h3>
      <ul className="space-y-1">
        {similar.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="w-full flex items-center gap-3 rounded-lg p-2 -mx-2 text-left min-h-[44px] transition-[background-color,transform] duration-150 ease-out hover:bg-muted/50 active:scale-[0.98]"
              onClick={() => navigate(`/event/${e.id}`)}
            >
              <span className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-md bg-muted flex items-center justify-center">
                {e.imageUrl ? (
                  <img src={e.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <CalendarIcon className="h-5 w-5 text-muted-foreground/60" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium truncate">{e.title}</span>
                <span className="block text-xs text-muted-foreground truncate">
                  {format(new Date(e.eventDate), "EEE d MMM, h:mm a")} · {e.city || e.location}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
