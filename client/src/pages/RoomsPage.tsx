import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import StartRoomFlow from "@/components/rooms/create/StartRoomFlow";
import HostAvatar from "@/components/rooms/HostAvatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon, ClockIcon, PlusIcon, UsersIcon } from "@/components/ui/icons";
import { KIND_LABEL, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, formatWhen, hostName, type PeekMember, type RoomScope, type RoomView } from "@/lib/roomsApi";

const TABS: { scope: RoomScope; label: string; empty: string }[] = [
  { scope: "live", label: "Live now", empty: "No public rooms are live right now." },
  { scope: "upcoming", label: "Upcoming", empty: "Nothing is scheduled yet." },
  { scope: "friends", label: "Friends", empty: "None of the people you follow back are in a room." },
];

const tag = "rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground";

function whoIsIn(room: RoomView): string {
  const peek = room.peek ?? [];
  const n = room.memberCount ?? 0;
  if (n === 0) return "Be the first in";
  const names = peek.slice(0, 2).map((p: PeekMember) => p.displayName || p.organizationName || p.username || "Guest");
  const more = n - names.length;
  return `${names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

export function RoomCard({ room }: { room: RoomView }) {
  const live = room.status === "live";
  const faces = (room.peek?.length ? room.peek : room.host ? [{ userId: room.host.id, role: "host", ...room.host } as PeekMember] : []).slice(0, 4);
  return (
    <Link href={`/rooms/${room.id}`} className="group block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-testid={`room-card-${room.id}`}>
      <article className="overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200 group-hover:-translate-y-[3px] group-hover:border-violet-500/30 group-active:translate-y-0">
        <div className="relative flex h-28 items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
          <div className="flex -space-x-3" aria-hidden>
            {faces.map((p) => <HostAvatar key={p.userId} person={p} className="h-14 w-14 rounded-full ring-2 ring-background" />)}
          </div>
          {live && <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 backdrop-blur px-2.5 py-1 text-xs font-medium"><span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />Live</span>}
          {live && <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-background/80 backdrop-blur px-2.5 py-1 text-xs"><UsersIcon className="h-3.5 w-3.5" aria-hidden /><span data-testid={`count-${room.id}`}>{room.memberCount ?? 0}</span><span className="sr-only"> in the room</span></span>}
        </div>
        <div className="space-y-3 p-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{room.title}</h3>
            <p className="truncate text-sm text-muted-foreground">{hostName(room.host)}{live ? ` · ${whoIsIn(room)}` : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={tag} data-testid={`badge-age-${room.id}`}>{ageLimitLabel(room.ageLimit)}</span>
            <span className={tag}>{KIND_LABEL[room.kind]}</span>
            {room.liveVideo && <span className={tag} data-testid={`badge-live-video-${room.id}`}>Live video</span>}
            {room.visibility !== "public" && <span className={tag}>{VISIBILITY_LABEL[room.visibility]}</span>}
            {!live && room.scheduledFor && <span className={`${tag} inline-flex items-center gap-1`}><ClockIcon className="h-3 w-3" aria-hidden />{formatWhen(room.scheduledFor)}</span>}
            {(room.eventId || room.venueId) && <span className={`${tag} inline-flex items-center gap-1`}><CalendarIcon className="h-3 w-3" aria-hidden />{room.eventId ? "Event" : "Venue"}</span>}
          </div>
          <span className="flex h-11 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground transition-colors group-hover:bg-primary/90">{live ? "Join" : "View"}</span>
        </div>
      </article>
    </Link>
  );
}

function useScope(scope: RoomScope, active: RoomScope) {
  return useQuery<RoomView[]>({
    queryKey: ["/api/rooms", scope],
    queryFn: () => fetchRooms(scope),
    refetchInterval: scope === "live" && active === "live" ? 15_000 : false,
    staleTime: 5_000,
  });
}

export default function RoomsPage() {
  const [scope, setScope] = useState<RoomScope>("live");
  const [creating, setCreating] = useState(false);
  const queries = { live: useScope("live", scope), upcoming: useScope("upcoming", scope), friends: useScope("friends", scope) };
  const { data: rooms, isLoading, isError, refetch } = queries[scope];
  const tab = TABS.find((t) => t.scope === scope)!;

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
          <Button onClick={() => setCreating(true)} className="h-12 rounded-full px-6" data-testid="button-new-room"><PlusIcon className="mr-2 h-4 w-4" />Start a room</Button>
        </header>

        <div role="tablist" aria-label="Room lists" className="flex gap-1 rounded-full border border-border p-1 sm:inline-flex">
          {TABS.map((t) => {
            const count = queries[t.scope].data?.length;
            const on = t.scope === scope;
            return (
              <button key={t.scope} role="tab" aria-selected={on} onClick={() => setScope(t.scope)} data-testid={`tab-rooms-${t.scope}`}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-sm sm:px-4 sm:gap-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:flex-none ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {t.label}
                {count !== undefined && <span className={`rounded-full px-1.5 text-xs ${on ? "bg-primary-foreground/20" : "bg-muted"}`}>{count}</span>}
              </button>
            );
          })}
        </div>

        <p role="status" className="sr-only" data-testid="rooms-count">{isLoading ? "Loading rooms" : `${rooms?.length ?? 0} ${rooms?.length === 1 ? "room" : "rooms"}`}</p>
        <section aria-busy={isLoading} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {isLoading ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-full rounded-2xl" />)
          ) : isError ? (
            <div className="space-y-3 rounded-2xl border border-border p-8 text-center md:col-span-2">
              <p className="text-sm text-muted-foreground">Couldn't load rooms.</p>
              <Button variant="outline" className="rounded-full" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : rooms && rooms.length > 0 ? (
            rooms.map((r) => <RoomCard key={r.id} room={r} />)
          ) : (
            <div className="space-y-4 rounded-2xl border border-dashed border-border p-10 text-center md:col-span-2" data-testid="text-rooms-empty">
              <p className="text-sm text-muted-foreground">{tab.empty}</p>
              <Button variant="outline" className="rounded-full" onClick={() => setCreating(true)}>Start a room</Button>
            </div>
          )}
        </section>
      </main>
      <BottomNavigation />
      <StartRoomFlow open={creating} onOpenChange={setCreating} />
    </div>
  );
}
