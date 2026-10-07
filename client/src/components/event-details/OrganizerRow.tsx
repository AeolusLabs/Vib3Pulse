import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CheckCircleIcon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface PublicOrganizer {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean;
  bio?: string | null;
}

interface Props {
  organizer: PublicOrganizer;
  currentUserId?: string;
  onNavigate: () => void;
}

export default function OrganizerRow({ organizer, currentUserId, onNavigate }: Props) {
  const [, navigate] = useLocation();
  const name = organizer.displayName || organizer.username;
  const canFollow = !!currentUserId && currentUserId !== organizer.id;
  const statusKey = [`/api/follows/${organizer.id}/status`];

  const { data: status } = useQuery<{ isFollowing: boolean }>({ queryKey: statusKey, enabled: canFollow });
  const toggleFollow = useMutation({
    mutationFn: () => apiRequest(status?.isFollowing ? "DELETE" : "POST", `/api/follows/${organizer.id}`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: statusKey }),
  });

  return (
    <div className="flex items-center gap-3" data-testid="event-organizer">
      <button
        type="button"
        className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-lg -m-1 p-1 transition-[background-color,transform] duration-150 ease-out hover:bg-muted/50 active:scale-[0.98]"
        onClick={() => { onNavigate(); navigate(`/profile/${organizer.username}`); }}
      >
        <Avatar className="h-11 w-11">
          <AvatarImage src={organizer.avatarUrl || ""} alt="" />
          <AvatarFallback>{name[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="min-w-0">
          <span className="block text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Hosted by</span>
          <span className="flex items-center gap-1 font-medium truncate">
            {name}
            {organizer.isVerified && <CheckCircleIcon className="h-4 w-4 text-primary flex-shrink-0" aria-label="Verified organiser" />}
          </span>
        </span>
      </button>
      {canFollow && (
        <Button
          size="sm"
          variant={status?.isFollowing ? "outline" : "default"}
          className="rounded-full min-h-[44px] px-5 flex-shrink-0 active:scale-[0.97] transition-transform"
          onClick={() => toggleFollow.mutate()}
          disabled={toggleFollow.isPending}
        >
          {status?.isFollowing ? "Following" : "Follow"}
        </Button>
      )}
    </div>
  );
}
