import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { communityTypeStyle } from "@/lib/communityTypes";
import { cn } from "@/lib/utils";

interface CommunityChipProps {
  name: string;
  coverImageUrl?: string | null;
  type?: string | null;
  active?: boolean;
  hasUnread?: boolean;
  onClick?: () => void;
  "data-testid"?: string;
}

export default function CommunityChip({
  name,
  coverImageUrl,
  type,
  active = false,
  hasUnread = false,
  onClick,
  "data-testid": testId,
}: CommunityChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 w-16 flex-shrink-0 group"
      data-testid={testId}
    >
      <div className="relative">
        <Avatar
          className={cn(
            "h-14 w-14 transition-all",
            active
              ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
              : "ring-1 ring-border group-hover:ring-primary/50"
          )}
        >
          <AvatarImage src={coverImageUrl || ""} alt={name} />
          <AvatarFallback className={cn("text-sm font-semibold", communityTypeStyle(type))}>
            {name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {hasUnread && (
          <span
            className="absolute top-0 right-0 h-3 w-3 rounded-full bg-primary ring-2 ring-background"
            aria-label="New activity"
          />
        )}
      </div>
      <span
        className={cn(
          "text-xs w-full truncate text-center",
          active ? "font-semibold text-foreground" : "text-muted-foreground"
        )}
      >
        {name}
      </span>
    </button>
  );
}
