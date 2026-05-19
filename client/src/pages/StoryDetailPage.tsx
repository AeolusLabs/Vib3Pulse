import { useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import StoryViewer from "@/components/StoryViewer";

type StoryWithUser = {
  id: string;
  userId: string;
  imageUrl: string;
  videoUrl?: string | null;
  caption?: string | null;
  type: string;
  privacy: string;
  originalStoryId: string | null;
  createdAt: string;
  likeCount: number;
  isLiked?: boolean;
  isReshare?: boolean;
  user: {
    id: string;
    username: string;
    displayName?: string | null;
    organizationName?: string | null;
    userType: string;
    avatarUrl?: string | null;
  };
};

export default function StoryDetailPage() {
  const { storyId } = useParams<{ storyId: string }>();
  const [, navigate] = useLocation();

  const { data: allStories = [], isLoading } = useQuery<StoryWithUser[]>({
    queryKey: ["/api/stories"],
  });

  const targetStory = useMemo(
    () => allStories.find((s) => s.id === storyId),
    [allStories, storyId]
  );

  // Stories grouped by user, preserving insertion order
  const groupedList = useMemo(() => {
    const map = allStories.reduce((acc: Map<string, StoryWithUser[]>, story) => {
      if (!acc.has(story.userId)) acc.set(story.userId, []);
      acc.get(story.userId)!.push(story);
      return acc;
    }, new Map());
    return Array.from(map.values());
  }, [allStories]);

  const currentGroupIndex = useMemo(
    () => groupedList.findIndex((group) => group.some((s) => s.id === storyId)),
    [groupedList, storyId]
  );

  useEffect(() => {
    if (!isLoading && allStories.length > 0 && !targetStory) {
      navigate("/feed");
    }
  }, [isLoading, allStories.length, targetStory, navigate]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <p className="text-white/60 text-sm">Loading...</p>
      </div>
    );
  }

  if (!targetStory || currentGroupIndex === -1) return null;

  const currentGroup = groupedList[currentGroupIndex];

  const slides = currentGroup.map((story) => ({
    id: story.id,
    type: (story.type === "video" ? "video" : "image") as "image" | "text" | "video",
    content: story.imageUrl,
    videoUrl: story.videoUrl || null,
    caption: story.caption || null,
    timestamp: story.createdAt,
    likeCount: story.likeCount || 0,
    viewCount: (story as any).viewCount || 0,
    isLiked: story.isLiked || false,
    isReshare: story.isReshare || false,
    privacy: story.privacy || "public",
    originalStoryId: story.originalStoryId,
  }));

  const handleNext = () => {
    const nextGroup = groupedList[currentGroupIndex + 1];
    if (nextGroup) {
      navigate(`/stories/${nextGroup[0].id}`);
    } else {
      navigate("/feed");
    }
  };

  const handlePrevious = () => {
    const prevGroup = groupedList[currentGroupIndex - 1];
    if (prevGroup) {
      navigate(`/stories/${prevGroup[0].id}`);
    }
  };

  return (
    <StoryViewer
      username={targetStory.user.username}
      avatar={targetStory.user.avatarUrl ?? undefined}
      slides={slides}
      onClose={() => navigate("/feed")}
      onNext={handleNext}
      onPrevious={currentGroupIndex > 0 ? handlePrevious : undefined}
      storyOwnerId={targetStory.userId}
      displayName={targetStory.user.displayName}
      userType={targetStory.user.userType}
    />
  );
}
