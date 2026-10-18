import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import HostAvatar from "@/components/rooms/HostAvatar";
import { orderPeople } from "@/lib/roomShell";
import type { RoomMemberView } from "@/lib/roomReducer";

export interface PeopleSheetProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  members: RoomMemberView[];
  /** Everyone in the room; `members` is capped by the server. */
  memberCount: number;
  selfId: string | null;
  /** People the viewer muted for themselves. */
  hidden: Set<string>;
  /** Tapped a person. The page closes this sheet and opens that person's actions. */
  onPick(m: RoomMemberView): void;
  /** Guests given the mic, so they sort under the hosts and get an "On the mic" label. Optional; empty when voice is off. */
  stage?: string[];
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** Everyone in the room, hosts first. Replaces the old People tab. Escape, the scrim and the close button dismiss it. */
export default function PeopleSheet({ open, onOpenChange, members, memberCount, selfId, hidden, onPick, stage = [] }: PeopleSheetProps) {
  const onMic = new Set(stage);
  const ordered = orderPeople(members, stage);
  const total = Math.max(memberCount, members.length);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" className="max-h-[84dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="people-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">In the room, {total}</SheetTitle>
          <SheetDescription>Pick someone to see what you can do.</SheetDescription>
        </SheetHeader>
        <ul className="mt-3 grid gap-0.5" data-testid="member-list">
          {ordered.map((m) => {
            const tag = m.role === "host" ? "Host" : m.role === "cohost" ? "Co-host" : onMic.has(m.userId) ? "On the mic" : "";
            const you = m.userId === selfId;
            return (
              <li key={m.userId}>
                <button type="button" onClick={() => onPick(m)} className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted ${FOCUS}`} data-testid={`member-row-${m.userId}`}>
                  <HostAvatar person={m} className="h-9 w-9 shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className={you ? "font-semibold text-primary" : undefined}>{you ? "You" : nameOf(m)}</span>
                    {hidden.has(m.userId) && <span className="text-muted-foreground"> · muted by you</span>}
                  </span>
                  {m.muted && <span className="shrink-0 text-xs text-muted-foreground">Chat muted</span>}
                  {tag && <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {memberCount > members.length && <p className="mt-2 px-2 text-xs text-muted-foreground">+{memberCount - members.length} more</p>}
      </RoomSheetContent>
    </Sheet>
  );
}
