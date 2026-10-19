import { Link } from "wouter";
import HostAvatar from "@/components/rooms/HostAvatar";
import { CalendarIcon, ClockIcon, UsersIcon } from "@/components/ui/icons";
import { KIND_LABEL, formatWhen, hostName, type PeekMember } from "@/lib/roomsApi";
import { ageTagLabel, cardLabel, coverColour, friendsInside, showPriceChip, type HomeRoom } from "@/lib/roomsHome";

const tag = "rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground";
const nameOf = (p: PeekMember) => p.displayName || p.organizationName || p.username || "Someone";

interface Props {
  room: HomeRoom;
  friendIds: ReadonlySet<string>;
  selfId?: string | null;
  paidRoomsOn: boolean;
}

/** One room in the list. The whole card is one link named in full, so a screen reader hears it once. Tap opens the room. */
export default function RoomCard({ room, friendIds, selfId, paidRoomsOn }: Props) {
  const live = room.status === "live";
  const cover = coverColour(room.id);
  const friends = friendsInside(room.peek, friendIds, selfId);
  const faces = (room.peek?.length ? room.peek : room.host ? [{ userId: room.host.id, role: "host", ...room.host } as PeekMember] : []).slice(0, 4);
  const label = cardLabel(room, hostName(room.host), KIND_LABEL[room.kind], friends.map(nameOf), live ? undefined : formatWhen(room.scheduledFor));
  return (
    <Link href={`/rooms/${room.id}`} aria-label={label} className="group block min-h-[44px] rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-testid={`room-card-${room.id}`}>
      <article className="overflow-hidden rounded-2xl border border-border bg-card transition-[transform,border-color] duration-200 motion-reduce:transition-none group-hover:border-primary/40 motion-safe:group-hover:-translate-y-[3px] motion-safe:group-active:translate-y-0">
        <div className="relative flex h-28 items-center justify-center" style={{ backgroundImage: `linear-gradient(135deg, ${cover.from}, ${cover.to})` }} data-testid={`cover-${room.id}`}>
          <div className="flex -space-x-3" aria-hidden>
            {faces.map((p) => <HostAvatar key={p.userId} person={p} className="h-14 w-14 rounded-full ring-2 ring-background" />)}
          </div>
          {live && <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-xs font-medium" aria-hidden><span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" />Live</span>}
          {live && <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-background/85 px-2.5 py-1 text-xs" aria-hidden><UsersIcon className="h-3.5 w-3.5" /><span data-testid={`count-${room.id}`}>{room.memberCount ?? 0}</span></span>}
        </div>
        <div className="space-y-3 p-4" aria-hidden>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{room.title}</h3>
            <p className="truncate text-sm text-muted-foreground">{hostName(room.host)}</p>
            {friends.length > 0 && <p className="truncate text-sm text-primary" data-testid={`friends-inside-${room.id}`}>{friends.slice(0, 2).map(nameOf).join(", ")}{friends.length > 2 ? ` +${friends.length - 2}` : ""} inside</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={tag} data-testid={`badge-age-${room.id}`}>{ageTagLabel(room.ageLimit)}</span>
            <span className={tag}>{KIND_LABEL[room.kind]}</span>
            {room.liveVideo && <span className={tag} data-testid={`badge-live-video-${room.id}`}>Live video</span>}
            {!live && room.scheduledFor && <span className={`${tag} inline-flex items-center gap-1`}><ClockIcon className="h-3 w-3" />{formatWhen(room.scheduledFor)}</span>}
            {(room.eventId || room.venueId) && <span className={`${tag} inline-flex items-center gap-1`}><CalendarIcon className="h-3 w-3" />{room.eventId ? "Event" : "Venue"}</span>}
            {/* Placeholder only: no price is read or shown until paid rooms are built. Never rendered while the flag is off. */}
            {showPriceChip(room, paidRoomsOn) && <span className={`${tag} opacity-60`} data-testid={`price-chip-${room.id}`}>Price soon</span>}
          </div>
        </div>
      </article>
    </Link>
  );
}
