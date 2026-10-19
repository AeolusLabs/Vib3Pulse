import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import RoomCard from "@/components/rooms/home/RoomCard";
import FiltersSheet from "@/components/rooms/home/FiltersSheet";
import StartRoomButton from "@/components/rooms/home/StartRoomButton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { fetchRooms, useRoomsConfig, type RoomScope } from "@/lib/roomsApi";
import { FIXTURE_FRIEND_IDS, NO_FILTERS, TAB_COPY, TAB_ORDER, activeFilterCount, applyFilters, fixtureHome, nextTab, type HomeFilters, type HomeRoom } from "@/lib/roomsHome";

// DEV only, no network for the lists: /rooms?home=live or ?home=empty.
const FIXTURE = import.meta.env.DEV && typeof window !== "undefined" ? fixtureHome(new URLSearchParams(window.location.search).get("home")) : null;

// The server returns at most 30 rooms per list and has no paging yet, so this is one page per tab. Add a cursor here when it does.
function useScope(scope: RoomScope, active: RoomScope) {
  return useQuery<HomeRoom[]>({
    queryKey: ["/api/rooms", scope],
    queryFn: async () => (FIXTURE ? FIXTURE[scope] : ((await fetchRooms(scope)) as HomeRoom[])),
    refetchInterval: scope === "live" && active === "live" && !FIXTURE ? 15_000 : false,
    staleTime: 5_000,
  });
}

export default function RoomsPage() {
  const [scope, setScope] = useState<RoomScope>("live");
  const [filters, setFilters] = useState<HomeFilters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersBtn = useRef<HTMLButtonElement>(null);
  const { data: me } = useAuth();
  const { data: config } = useRoomsConfig();
  const paidRoomsOn = !FIXTURE && config?.features.paidRooms === true;
  const { data: following } = useQuery<{ id: string }[]>({ queryKey: ["/api/follows/me/following"], enabled: !FIXTURE && !!me });
  const friendIds = useMemo<ReadonlySet<string>>(() => (FIXTURE ? FIXTURE_FRIEND_IDS : new Set((following ?? []).map((u) => u.id))), [following]);
  const selfId = (me as { id?: string } | undefined)?.id ?? null;

  const queries = { live: useScope("live", scope), upcoming: useScope("upcoming", scope), friends: useScope("friends", scope) };
  const { data: all, isLoading, isError, refetch } = queries[scope];
  const rooms = useMemo(() => (all ? applyFilters(all, filters, { friendIds, selfId, paidRoomsOn }) : undefined), [all, filters, friendIds, selfId, paidRoomsOn]);
  const nFilters = activeFilterCount(filters, paidRoomsOn);
  const copy = TAB_COPY[scope];
  const filteredOut = nFilters > 0 && (all?.length ?? 0) > 0;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-primary">Virtual</p>
            <h1 className="mt-1 font-serif text-4xl font-bold tracking-tight">Rooms</h1>
            <p className="mt-1 text-sm text-muted-foreground">Drop into a room and hang out as your avatar.</p>
          </div>
          <StartRoomButton />
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Room lists" className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-full border border-border p-1 sm:flex-none"
            onKeyDown={(e) => { const next = nextTab(scope, e.key); if (!next) return; e.preventDefault(); setScope(next); document.getElementById(`rooms-tab-${next}`)?.focus(); }}>
            {TAB_ORDER.map((s) => {
              const count = queries[s].data ? applyFilters(queries[s].data!, filters, { friendIds, selfId, paidRoomsOn }).length : undefined;
              const on = s === scope;
              return (
                <button key={s} id={`rooms-tab-${s}`} role="tab" aria-selected={on} aria-controls="rooms-panel" tabIndex={on ? 0 : -1} onClick={() => setScope(s)} data-testid={`tab-rooms-${s}`}
                  className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-sm transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:flex-none sm:gap-2 sm:px-4 ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  {TAB_COPY[s].label}
                  {count !== undefined && <span className={`hidden rounded-full px-1.5 text-xs min-[360px]:inline ${on ? "bg-primary-foreground/20" : "bg-muted"}`}>{count}</span>}
                </button>
              );
            })}
          </div>
          <Button ref={filtersBtn} variant="outline" onClick={() => setFiltersOpen(true)} className="h-11 rounded-full px-4" data-testid="button-room-filters">
            Filters{nFilters > 0 ? ` (${nFilters})` : ""}
          </Button>
        </div>

        <p role="status" className="sr-only" data-testid="rooms-count">{isLoading ? "Loading rooms" : `${rooms?.length ?? 0} ${rooms?.length === 1 ? "room" : "rooms"}`}</p>
        <section id="rooms-panel" role="tabpanel" aria-labelledby={`rooms-tab-${scope}`} aria-busy={isLoading} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {isLoading ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-full rounded-2xl motion-reduce:animate-none" />)
          ) : isError ? (
            <div className="space-y-3 rounded-2xl border border-border p-8 text-center md:col-span-2" role="alert" data-testid="text-rooms-error">
              <p className="text-sm text-muted-foreground">Could not load rooms.</p>
              <Button variant="outline" className="h-11 rounded-full" onClick={() => refetch()} data-testid="button-rooms-retry">Try again</Button>
            </div>
          ) : rooms && rooms.length > 0 ? (
            rooms.map((r) => <RoomCard key={r.id} room={r} friendIds={friendIds} selfId={selfId} paidRoomsOn={paidRoomsOn} />)
          ) : filteredOut ? (
            <div className="space-y-4 rounded-2xl border border-dashed border-border p-10 text-center md:col-span-2" data-testid="text-rooms-empty-filtered">
              <p className="text-sm text-muted-foreground">{copy.emptyFiltered}</p>
              <Button variant="outline" className="h-11 rounded-full" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>
            </div>
          ) : (
            <div className="space-y-4 rounded-2xl border border-dashed border-border p-10 text-center md:col-span-2" data-testid="text-rooms-empty">
              <p className={scope === "live" ? "font-serif text-2xl font-semibold" : "text-sm text-muted-foreground"}>{copy.empty}</p>
              {scope === "live" && <p className="text-sm text-muted-foreground">Nobody is in a room yet. Be the first.</p>}
              <StartRoomButton variant="quiet" />
            </div>
          )}
        </section>
      </main>
      <BottomNavigation />
      <FiltersSheet open={filtersOpen} onOpenChange={setFiltersOpen} value={filters} onApply={setFilters} paidRoomsOn={paidRoomsOn} returnFocusTo={() => filtersBtn.current} />
    </div>
  );
}
