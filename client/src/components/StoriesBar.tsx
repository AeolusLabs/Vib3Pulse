import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import StoryCircle from "./StoryCircle";

interface Story {
  id: string;
  username: string;
  avatar?: string;
  isViewed?: boolean;
  userType?: string;
  displayName?: string | null;
  organizationName?: string | null;
}

interface StoriesBarProps {
  stories: Story[];
  onStoryClick?: (storyId: string) => void;
  onCreateStory?: () => void;
}

export default function StoriesBar({ stories, onStoryClick, onCreateStory }: StoriesBarProps) {
  return (
    <div className="bg-card border-b">
      <ScrollArea className="w-full">
        <div className="flex gap-4 p-4 max-w-[1200px] mx-auto">
          <StoryCircle
            username="Your Story"
            isOwn={true}
            onClick={onCreateStory}
          />
          {stories.map((story) => (
            <StoryCircle
              key={story.id}
              username={story.username}
              avatar={story.avatar}
              hasStory={true}
              isViewed={story.isViewed}
              onClick={() => onStoryClick?.(story.id)}
              userType={story.userType}
              displayName={story.displayName}
              organizationName={story.organizationName}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
