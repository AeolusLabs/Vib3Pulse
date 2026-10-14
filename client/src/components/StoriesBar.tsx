import { useState } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import YourVibeSheet from "@/components/YourVibeSheet";
import CreateRoomDialog from "@/components/rooms/CreateRoomDialog";
import StoryCircle from "./StoryCircle";
import { StoryCircleSkeleton } from "@/components/ui/skeleton-layouts";

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
  isLoading?: boolean;
  onStoryClick?: (storyId: string) => void;
  onCreateStory?: () => void;
}

export default function StoriesBar({ stories, isLoading, onStoryClick, onCreateStory }: StoriesBarProps) {
  const [choosing, setChoosing] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  return (
    <>
    <div className="bg-background border-b">
      <ScrollArea className="w-full">
        <div className="flex gap-4 p-4 max-w-[1200px] mx-auto">
          <StoryCircle
            username="Your Vib3"
            isOwn={true}
            onClick={() => setChoosing(true)}
          />
          {isLoading
            ? [0, 1, 2, 3].map((i) => <StoryCircleSkeleton key={i} index={i} />)
            : stories.map((story) => (
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
    <YourVibeSheet open={choosing} onOpenChange={setChoosing} onStory={() => onCreateStory?.()} onRoom={() => setCreatingRoom(true)} />
    <CreateRoomDialog open={creatingRoom} onOpenChange={setCreatingRoom} />
    </>
  );
}
