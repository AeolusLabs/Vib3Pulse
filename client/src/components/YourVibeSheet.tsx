import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CameraIcon, ChevronRightIcon, UsersIcon } from "@/components/ui/icons";
import { fetchRooms } from "@/lib/roomsApi";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the existing story creator, unchanged. */
  onStory: () => void;
  /** Opens the create-room flow. */
  onRoom: () => void;
}

/** What "Your Vib3" does when tapped: share a story (as before), start a room, or go look at rooms. */
export default function YourVibeSheet({ open, onOpenChange, onStory, onRoom }: Props) {
  const { data: live } = useQuery({ queryKey: ["/api/rooms", "live"], queryFn: () => fetchRooms("live"), enabled: open, staleTime: 15_000 });
  const rows = [
    { key: "story", icon: <CameraIcon className="h-5 w-5" aria-hidden />, title: "Post a story", sub: "A photo or video that lasts 24 hours.", onClick: onStory },
    { key: "room", icon: <UsersIcon className="h-5 w-5" aria-hidden />, title: "Start a room", sub: "Host a live space for a night, a set or a chat.", onClick: onRoom },
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl" data-testid="your-vibe-sheet">
        <SheetHeader className="text-left">
          <SheetTitle>Your Vib3</SheetTitle>
          <SheetDescription>Share a moment or open a room.</SheetDescription>
        </SheetHeader>
        <div className="mt-3 space-y-2">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => { onOpenChange(false); r.onClick(); }}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              data-testid={`vibe-${r.key}`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{r.icon}</span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{r.title}</span><span className="block text-xs text-muted-foreground">{r.sub}</span></span>
              <ChevronRightIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
            </button>
          ))}
          <Link href="/rooms" onClick={() => onOpenChange(false)} className="flex min-h-[56px] items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid="vibe-browse-rooms">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-600/10 text-red-600"><UsersIcon className="h-5 w-5" aria-hidden /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">Browse rooms</span><span className="block text-xs text-muted-foreground" data-testid="vibe-live-count">{live ? (live.length ? `${live.length} live now` : "Nothing live right now") : "See what's on"}</span></span>
            <ChevronRightIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
