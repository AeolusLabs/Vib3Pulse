import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchIcon, CalendarIcon, Building2Icon } from "@/components/ui/icons";
import type { Event, Venue } from "@shared/schema";
import ChatSheet, { Segmented } from "./ChatSheet";

type Tab = "event" | "venue";
const MAX_ROWS = 50;

interface SharePickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (item: { type: "event" | "venue"; id: string; title: string }) => void;
}

function Thumb({ src, fallback }: { src?: string | null; fallback: "event" | "venue" }) {
  return src ? (
    <img src={src} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
  ) : (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      {fallback === "event" ? <CalendarIcon className="h-5 w-5" /> : <Building2Icon className="h-5 w-5" />}
    </span>
  );
}

export default function SharePickerSheet({ open, onOpenChange, onPick }: SharePickerSheetProps) {
  const [tab, setTab] = useState<Tab>("event");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setTab("event");
      setQuery("");
    }
  }, [open]);

  const { data: events, isLoading: loadingEvents } = useQuery<Event[]>({ queryKey: ["/api/events"], enabled: open && tab === "event" });
  const { data: venues, isLoading: loadingVenues } = useQuery<Venue[]>({ queryKey: ["/api/venues"], enabled: open && tab === "venue" });

  const q = query.trim().toLowerCase();

  const eventRows = useMemo(() => {
    const now = Date.now();
    return (events ?? [])
      .filter((e) => new Date(e.eventDate).getTime() > now)
      .filter((e) => !q || e.title.toLowerCase().includes(q))
      .slice(0, MAX_ROWS);
  }, [events, q]);

  const venueRows = useMemo(
    () => (venues ?? []).filter((v) => !q || v.name.toLowerCase().includes(q)).slice(0, MAX_ROWS),
    [venues, q]
  );

  const loading = tab === "event" ? loadingEvents : loadingVenues;
  const rows = tab === "event" ? eventRows.length : venueRows.length;

  const pick = (item: { type: Tab; id: string; title: string }) => {
    onPick(item);
    onOpenChange(false);
  };

  const rowClass =
    "flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  return (
    <ChatSheet open={open} onOpenChange={onOpenChange} title="Share in chat">
      <div className="space-y-3 px-4 pb-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "event", label: "Events" },
            { value: "venue", label: "Venues" },
          ]}
        />
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "event" ? "Search events" : "Search venues"}
            aria-label={tab === "event" ? "Search events" : "Search venues"}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t">
        {loading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-[72px] items-center gap-3 px-4">
                <Skeleton className="h-12 w-12 rounded-lg" />
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
            ))}
          </div>
        ) : rows === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {q ? "No matches" : tab === "event" ? "No upcoming events" : "No venues yet"}
          </p>
        ) : tab === "event" ? (
          <ul className="divide-y divide-border">
            {eventRows.map((e) => (
              <li key={e.id}>
                <button type="button" className={rowClass} onClick={() => pick({ type: "event", id: e.id, title: e.title })}>
                  <Thumb src={e.imageUrl} fallback="event" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {format(new Date(e.eventDate), "EEE d MMM, h:mm a")}
                      {e.location ? ` · ${e.location}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-border">
            {venueRows.map((v) => (
              <li key={v.id}>
                <button type="button" className={rowClass} onClick={() => pick({ type: "venue", id: v.id, title: v.name })}>
                  <Thumb src={v.coverImageUrl || v.imageUrl} fallback="venue" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{v.name}</span>
                    {v.city && <span className="block truncate text-xs text-muted-foreground">{v.city}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ChatSheet>
  );
}
