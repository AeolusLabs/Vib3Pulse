import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import { Loader2Icon, UsersIcon } from "@/components/ui/icons";
import { KIND_LABEL, VISIBILITY_LABEL, ageLimitLabel, hostName, type PeekMember, type RoomHostSummary, type RoomView } from "@/lib/roomsApi";

interface Props {
  room: Omit<RoomView, "host" | "memberCount">;
  host: RoomHostSummary | null;
  peek: PeekMember[];
  memberCount: number;
  joining: boolean;
  onJoin: () => void;
}

const nameOfPeek = (p: PeekMember) => p.displayName || p.organizationName || p.username || "Guest";

/** The doorway: who is inside, the age limit, what to expect. Tapping Join is also the tap that lets the browser play room audio. */
export default function RoomLobby({ room, host, peek, memberCount, joining, onJoin }: Props) {
  const names = peek.slice(0, 3).map(nameOfPeek);
  const more = Math.max(0, memberCount - names.length);
  return (
    <section className="space-y-5 rounded-2xl border border-border bg-gradient-to-br from-primary/20 to-primary/5 p-6 text-center sm:p-8" aria-label="Before you join" data-testid="room-lobby">
      <div className="flex justify-center -space-x-3" aria-hidden>
        {(peek.length ? peek : host ? [{ userId: host.id, role: "host", ...host } as PeekMember] : []).slice(0, 5).map((p) => (
          <HostAvatar key={p.userId} person={p} className="h-14 w-14 rounded-full ring-2 ring-background" />
        ))}
      </div>
      <div className="space-y-1">
        <h2 className="font-serif text-3xl font-bold tracking-tight">Ready to join?</h2>
        <p className="text-sm text-muted-foreground" data-testid="lobby-who">
          {memberCount === 0
            ? `${hostName(host)} is getting set up.`
            : `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""} ${memberCount === 1 && names.length === 1 ? "is" : "are"} in the room.`}
        </p>
      </div>
      <ul className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground" aria-label="Room details">
        <li className="rounded-full border border-border px-3 py-1" data-testid="lobby-age">{ageLimitLabel(room.ageLimit)}</li>
        <li className="rounded-full border border-border px-3 py-1">{KIND_LABEL[room.kind]}</li>
        {room.visibility !== "public" && <li className="rounded-full border border-border px-3 py-1">{VISIBILITY_LABEL[room.visibility]}</li>}
        <li className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1"><UsersIcon className="h-3.5 w-3.5" aria-hidden />Up to {room.capacity}</li>
      </ul>
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">
        You join as your avatar and can chat and react. You'll hear the room when you join; the host can invite you to speak.
        {room.noDirectInteractions ? " The host turned off private waves and gifts here." : ""}
      </p>
      <Button size="lg" className="h-12 min-w-[10rem] rounded-full" onClick={onJoin} disabled={joining} data-testid="button-join-room">
        {joining ? <><Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />Joining…</> : "Join room"}
      </Button>
    </section>
  );
}
