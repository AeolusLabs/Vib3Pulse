import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import type { RoomMemberView } from "@/lib/roomReducer";

interface Props {
  members: RoomMemberView[];
  memberCount: number;
  selfId: string | null;
  /** Same sheet as tapping an avatar, so everything in the scene is reachable from the list too. */
  onPick: (member: RoomMemberView) => void;
  hidden: Set<string>;
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const roleLabel = (r: RoomMemberView["role"]) => (r === "host" ? "Host" : r === "cohost" ? "Co-host" : "");

/** Everyone in the room, hosts first. Lives in the People tab. */
export default function MemberList({ members, memberCount, selfId, onPick, hidden }: Props) {
  const ordered = [...members].sort((a, b) => (a.role === "guest" ? 1 : 0) - (b.role === "guest" ? 1 : 0));
  return (
    <div data-testid="member-list">
      <p className="px-1 text-sm text-muted-foreground">Pick someone to see what you can do.</p>
      <ul className="mt-2 space-y-1">
        {ordered.map((m) => (
          <li key={m.userId}>
            <Button variant="ghost" className="flex min-h-[48px] w-full items-center justify-start gap-3 rounded-xl px-2" onClick={() => onPick(m)} data-testid={`member-row-${m.userId}`}>
              <HostAvatar person={m} className="h-9 w-9" mode="head" />
              <span className="min-w-0 flex-1 truncate text-left text-sm">{nameOf(m)}{m.userId === selfId ? " (you)" : ""}{hidden.has(m.userId) ? " · muted by you" : ""}</span>
              {roleLabel(m.role) && <span className="text-xs text-muted-foreground">{roleLabel(m.role)}</span>}
              {m.muted && <span className="text-xs text-muted-foreground">Muted</span>}
            </Button>
          </li>
        ))}
      </ul>
      {memberCount > members.length && <p className="mt-2 px-2 text-xs text-muted-foreground">+{memberCount - members.length} more</p>}
    </div>
  );
}
