import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlusIcon } from "@/components/ui/icons";

interface StoryCircleProps {
  username: string;
  avatar?: string;
  hasStory?: boolean;
  isViewed?: boolean;
  isOwn?: boolean;
  onClick?: () => void;
  userType?: string;
  displayName?: string | null;
  organizationName?: string | null;
}

export default function StoryCircle({
  username,
  avatar,
  hasStory = true,
  isViewed = false,
  isOwn = false,
  onClick,
  userType,
  displayName,
  organizationName,
}: StoryCircleProps) {
  // Calculate avatar initials using the same pattern as profile/navigation
  const getAvatarInitial = () => {
    if (userType === 'social') {
      return displayName?.charAt(0) || username.charAt(0);
    } else if (userType === 'organizer') {
      return organizationName?.charAt(0) || username.charAt(0);
    }
    // Fallback for when userType is not provided (backward compatibility)
    return (displayName || organizationName || username).charAt(0);
  };
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 min-w-[70px] group"
      data-testid={`story-${username}`}
    >
      <div className="relative">
        <div
          className={`rounded-full p-0.5 ${
            hasStory && !isViewed
              ? "bg-gradient-to-tr from-primary via-accent to-primary"
              : isViewed
              ? "bg-muted"
              : "bg-transparent"
          }`}
        >
          <div className="bg-background rounded-full p-0.5">
            <Avatar className="h-16 w-16 border-2 border-background">
              <AvatarImage src={avatar} alt={username} />
              <AvatarFallback className="bg-primary/10 text-primary">
                {getAvatarInitial().toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
        {isOwn && (
          <div className="absolute bottom-0 right-0 bg-primary rounded-full p-1 border-2 border-background">
            <PlusIcon className="h-3 w-3 text-primary-foreground" />
          </div>
        )}
      </div>
      <span className="text-xs text-center line-clamp-1 max-w-[70px] group-hover:text-primary transition-colors">
        {isOwn ? "Your Story" : username}
      </span>
    </button>
  );
}
