import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import type { RoomMemberView } from "@/lib/roomReducer";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: RoomMemberView[];
  memberCount: number;
  selfId: string | null;
  /** Same sheet as tapping an avatar, so everything in the scene is reachable without it. */
  onPick: (member: RoomMemberView) => void;
  hidden: Set<string>;
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const roleLabel = (r: RoomMemberView["role"]) => (r === "host" ? "Host" : r === "cohost" ? "Co-host" : "");

export default function MemberListSheet({ open, onOpenChange, members, memberCount, selfId, onPick, hidden }: Props) {
  const ordered = [...members].sort((a, b) => (a.role === "guest" ? 1 : 0) - (b.role === "guest" ? 1 : 0));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-sm" data-testid="member-list-sheet">
        <SheetHeader className="text-left">
          <SheetTitle>In the room ({memberCount})</SheetTitle>
          <SheetDescription>Pick someone to see what you can do.</SheetDescription>
        </SheetHeader>
        <ul className="mt-3 space-y-1">
          {ordered.map((m) => (
            <li key={m.userId}>
              <Button variant="ghost" className="flex min-h-[48px] w-full items-center justify-start gap-3 px-2" onClick={() => onPick(m)} data-testid={`member-row-${m.userId}`}>
                <HostAvatar person={m} className="h-9 w-9" />
                <span className="min-w-0 flex-1 truncate text-left text-sm">{nameOf(m)}{m.userId === selfId ? " (you)" : ""}{hidden.has(m.userId) ? " · muted by you" : ""}</span>
                {roleLabel(m.role) && <span className="text-xs text-muted-foreground">{roleLabel(m.role)}</span>}
                {m.muted && <span className="text-xs text-muted-foreground">Muted</span>}
              </Button>
            </li>
          ))}
        </ul>
        {memberCount > members.length && <p className="mt-2 px-2 text-xs text-muted-foreground">+{memberCount - members.length} more</p>}
      </SheetContent>
    </Sheet>
  );
}
