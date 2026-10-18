import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import HostAvatar from "@/components/rooms/HostAvatar";
import type { RoomMemberView } from "@/lib/roomReducer";
import { profilePath, shouldFetchProfile, fillMissing } from "@/lib/profilePath";
import { ExternalLinkIcon } from "@/components/ui/icons";

export { profilePath };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: RoomMemberView | null;
  /** When false (anonymous guests, later phases) nothing is fetched and nothing renders. Defaults to true. */
  canViewProfile?: boolean;
}

/** Only the fields we show are read; the server already withholds birthdate, email and phone from this endpoint. */
interface PeekUser { displayName?: string | null; organizationName?: string | null; username?: string | null; bio?: string | null; avatarUrl?: string | null; avatar?: unknown }
interface FollowStats { followersCount: number; followingCount: number }

const nameOf = (m: { displayName?: string | null; organizationName?: string | null; username?: string | null }) => m.displayName || m.organizationName || m.username || "Guest";

/** A quick look at someone's public profile without leaving the room. */
export default function ProfilePeekSheet({ open, onOpenChange, member, canViewProfile = true }: Props) {
  const [, navigate] = useLocation();
  const allowed = shouldFetchProfile(member, canViewProfile);
  const identifier = member && allowed ? (member.username?.trim() || member.userId) : null;
  const enabled = open && allowed && !!identifier;

  const user = useQuery<PeekUser>({
    queryKey: ["/api/users", identifier, "peek"],
    queryFn: async () => {
      const r = await fetch(`/api/users/${encodeURIComponent(identifier!)}`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load profile");
      return r.json();
    },
    enabled,
    staleTime: 30_000,
  });
  const stats = useQuery<FollowStats>({
    queryKey: ["/api/users", identifier, "follow-stats"],
    queryFn: async () => {
      const r = await fetch(`/api/users/${encodeURIComponent(identifier!)}/follow-stats`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load counts");
      return r.json();
    },
    enabled,
    staleTime: 30_000,
  });

  if (!member || !allowed) return null;
  // Room data first (already on screen), then the fuller public profile when it arrives.
  const shown = fillMissing(member, user.data);
  const bio = user.data?.bio?.trim();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl" data-testid="profile-peek-sheet">
        <SheetHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <HostAvatar person={shown} className="h-16 w-16" />
          <div className="min-w-0">
            <SheetTitle className="truncate">{nameOf(shown)}</SheetTitle>
            <SheetDescription>{shown.username ? `@${shown.username}` : "Profile"}</SheetDescription>
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-4" aria-live="polite">
          {user.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : user.isError ? (
            <p className="text-sm text-muted-foreground" data-testid="peek-error">Couldn't load more about this person right now.</p>
          ) : bio ? (
            <p className="whitespace-pre-wrap break-words text-sm" data-testid="peek-bio">{bio}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No bio yet.</p>
          )}

          {stats.data && (
            <dl className="flex gap-6 text-sm" data-testid="peek-counts">
              <div><dt className="text-xs text-muted-foreground">Followers</dt><dd className="font-semibold">{stats.data.followersCount}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Following</dt><dd className="font-semibold">{stats.data.followingCount}</dd></div>
            </dl>
          )}
        </div>

        <div className="mt-5 space-y-2">
          <Button className="min-h-[44px] w-full" onClick={() => { onOpenChange(false); navigate(profilePath(member)); }} data-testid="button-open-full-profile">
            <ExternalLinkIcon className="mr-2 h-4 w-4" />Open full profile
          </Button>
          <p className="text-center text-xs text-muted-foreground">This leaves the room.</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
