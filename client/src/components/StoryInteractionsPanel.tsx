import { useQuery } from "@tanstack/react-query";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { apiRequest } from "@/lib/queryClient";
import { HeartIcon, EyeIcon, Loader2Icon } from "@/components/ui/icons";

interface Viewer {
  user: {
    id: string;
    username: string;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
  viewedAt: string;
  hasLiked: boolean;
}

interface StoryInteractionsData {
  viewers: Viewer[];
  viewCount: number;
  likeCount: number;
}

interface StoryInteractionsPanelProps {
  storyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function StoryInteractionsPanel({
  storyId,
  open,
  onOpenChange,
}: StoryInteractionsPanelProps) {
  const { data, isLoading } = useQuery<StoryInteractionsData>({
    queryKey: [`/api/stories/${storyId}/interactions`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/stories/${storyId}/interactions`);
      return res.json();
    },
    enabled: open,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-zinc-900 border-zinc-700 text-white rounded-t-2xl max-h-[70vh] overflow-y-auto"
      >
        <SheetHeader className="pb-4">
          <SheetTitle className="text-white text-base font-semibold">
            Story Interactions
          </SheetTitle>
        </SheetHeader>

        {/* Summary row */}
        <div className="flex items-center gap-6 mb-5 px-1">
          <div className="flex items-center gap-2">
            <EyeIcon className="h-5 w-5 text-white/70" />
            <span className="text-white font-semibold text-lg">
              {data?.viewCount ?? 0}
            </span>
            <span className="text-white/50 text-sm">
              {data?.viewCount === 1 ? "view" : "views"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <HeartIcon className="h-5 w-5 text-red-500 fill-red-500" />
            <span className="text-white font-semibold text-lg">
              {data?.likeCount ?? 0}
            </span>
            <span className="text-white/50 text-sm">
              {data?.likeCount === 1 ? "like" : "likes"}
            </span>
          </div>
        </div>

        <div className="h-px bg-zinc-700 mb-4" />

        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2Icon className="h-6 w-6 animate-spin text-white/40" />
          </div>
        ) : data?.viewers.length === 0 ? (
          <div className="flex flex-col items-center py-10 gap-2">
            <EyeIcon className="h-10 w-10 text-white/20" />
            <p className="text-white/40 text-sm">No views yet</p>
          </div>
        ) : (
          <ul className="space-y-3 pb-4">
            {data?.viewers.map((viewer) => {
              const displayName =
                viewer.user.displayName || viewer.user.username;
              return (
                <li
                  key={viewer.user.id}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarImage
                        src={viewer.user.avatarUrl ?? undefined}
                        alt={displayName}
                      />
                      <AvatarFallback className="bg-zinc-700 text-white text-sm">
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-white text-sm font-medium">
                      {displayName}
                    </span>
                  </div>
                  {viewer.hasLiked && (
                    <HeartIcon className="h-4 w-4 text-red-500 fill-red-500 flex-shrink-0" />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
