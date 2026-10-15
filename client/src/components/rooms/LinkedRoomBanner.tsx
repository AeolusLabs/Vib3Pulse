import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { UsersIcon } from "@/components/ui/icons";
import { ageLimitLabel, fetchRooms, formatWhen, type RoomView } from "@/lib/roomsApi";

/** "Join the virtual room" for an event or venue, when a live or upcoming room is attached to it. Renders nothing otherwise. */
export default function LinkedRoomBanner({ eventId, venueId }: { eventId?: string; venueId?: string }) {
  const { data } = useQuery<RoomView[]>({
    queryKey: ["/api/rooms", "linked", eventId ?? "", venueId ?? ""],
    queryFn: () => fetchRooms("live", { eventId, venueId }),
    enabled: !!(eventId || venueId),
    staleTime: 20_000,
  });
  const room = data?.find((r) => r.status === "live") ?? data?.[0];
  if (!room) return null;
  const live = room.status === "live";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-primary/5 p-3.5" data-testid="linked-room-banner">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold"><UsersIcon className="h-4 w-4 text-primary" aria-hidden />{live ? "A virtual room is live" : "A virtual room is planned"}</p>
        <p className="truncate text-xs text-muted-foreground">{room.title} · {ageLimitLabel(room.ageLimit)}{!live && room.scheduledFor ? ` · ${formatWhen(room.scheduledFor)}` : ""}</p>
      </div>
      <Button asChild size="sm" className="min-h-[44px] shrink-0 rounded-full"><Link href={`/rooms/${room.id}`} data-testid="link-join-virtual-room">{live ? "Join the virtual room" : "See the room"}</Link></Button>
    </div>
  );
}
