import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import CreateRoomDialog from "@/components/rooms/CreateRoomDialog";
import HostAvatar from "@/components/rooms/HostAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarIcon, ClockIcon, PlusIcon, UsersIcon } from "@/components/ui/icons";
import { KIND_LABEL, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, formatWhen, hostName, type RoomScope, type RoomView } from "@/lib/roomsApi";

const TABS: { scope: RoomScope; label: string; empty: string }[] = [
  { scope: "live", label: "Live now", empty: "No public rooms are live right now. Start one." },
  { scope: "upcoming", label: "Upcoming", empty: "Nothing scheduled yet." },
  { scope: "friends", label: "Friends", empty: "None of the people you follow back are in a room." },
];

export function RoomCard({ room }: { room: RoomView }) {
  const live = room.status === "live";
  return (
    <Link href={`/rooms/${room.id}`} className="block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-testid={`room-card-${room.id}`}>
      <Card className="flex items-center gap-3 rounded-2xl p-4 transition-colors hover:bg-muted/40">
        <HostAvatar person={room.host ?? {}} className="h-12 w-12" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{room.title}</p>
          <p className="truncate text-sm text-muted-foreground">{hostName(room.host)} · {KIND_LABEL[room.kind]}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="outline" data-testid={`badge-age-${room.id}`}>{ageLimitLabel(room.ageLimit)}</Badge>
            {room.visibility !== "public" && <Badge variant="outline">{VISIBILITY_LABEL[room.visibility]}</Badge>}
            {live ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground"><UsersIcon className="h-3.5 w-3.5" aria-hidden />{room.memberCount ?? 0} in the room</span>
            ) : room.scheduledFor ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground"><ClockIcon className="h-3.5 w-3.5" aria-hidden />{formatWhen(room.scheduledFor)}</span>
            ) : null}
            {(room.eventId || room.venueId) && <span className="inline-flex items-center gap-1 text-muted-foreground"><CalendarIcon className="h-3.5 w-3.5" aria-hidden />{room.eventId ? "Linked to an event" : "Linked to a venue"}</span>}
          </div>
        </div>
        {live && <Badge className="shrink-0 bg-red-600 text-white hover:bg-red-600">Live</Badge>}
      </Card>
    </Link>
  );
}

export default function RoomsPage() {
  const [scope, setScope] = useState<RoomScope>("live");
  const [creating, setCreating] = useState(false);
  const { data: rooms, isLoading, isError, refetch } = useQuery<RoomView[]>({
    queryKey: ["/api/rooms", scope],
    queryFn: () => fetchRooms(scope),
    refetchInterval: scope === "live" ? 15_000 : false,
    staleTime: 5_000,
  });
  const tab = TABS.find((t) => t.scope === scope)!;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-primary">Virtual</p>
            <h1 className="mt-1 font-serif text-4xl font-bold tracking-tight">Rooms</h1>
            <p className="mt-1 text-sm text-muted-foreground">Join the night from anywhere, as your avatar.</p>
          </div>
          <Button onClick={() => setCreating(true)} className="min-h-[44px] shrink-0" data-testid="button-new-room"><PlusIcon className="mr-1.5 h-4 w-4" />New room</Button>
        </header>

        <Tabs value={scope} onValueChange={(v) => setScope(v as RoomScope)}>
          <TabsList className="grid w-full grid-cols-3" aria-label="Room lists">
            {TABS.map((t) => <TabsTrigger key={t.scope} value={t.scope} className="min-h-[44px]" data-testid={`tab-rooms-${t.scope}`}>{t.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>

        <p role="status" className="sr-only" data-testid="rooms-count">{isLoading ? "Loading rooms" : `${rooms?.length ?? 0} ${rooms?.length === 1 ? "room" : "rooms"}`}</p>
        <section aria-busy={isLoading} className="space-y-3">
          {isLoading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)
          ) : isError ? (
            <Card className="space-y-3 rounded-2xl p-6 text-center">
              <p className="text-sm text-muted-foreground">Couldn't load rooms.</p>
              <Button variant="outline" onClick={() => refetch()}>Try again</Button>
            </Card>
          ) : rooms && rooms.length > 0 ? (
            rooms.map((r) => <RoomCard key={r.id} room={r} />)
          ) : (
            <Card className="rounded-2xl p-8 text-center text-sm text-muted-foreground" data-testid="text-rooms-empty">{tab.empty}</Card>
          )}
        </section>
      </main>
      <BottomNavigation />
      <CreateRoomDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
