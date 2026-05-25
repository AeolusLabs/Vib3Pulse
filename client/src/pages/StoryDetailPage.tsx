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

  // Fetch the story directly by ID — bypasses the 24-hour expiry filter on /api/stories
  const { data: targetStory, isLoading: isStoryLoading } = useQuery<StoryWithUser | null>({
    queryKey: ["/api/stories", storyId],
    queryFn: async () => {
      const res = await fetch(`/api/stories/${storyId}`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch story");
      return res.json();
    },
    retry: false,
  });

  // Active stories list — used only for prev/next group navigation
  const { data: allStories = [] } = useQuery<StoryWithUser[]>({
    queryKey: ["/api/stories"],
    enabled: !!targetStory,
  });

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
    if (!isStoryLoading && targetStory === null) {
      navigate("/feed");
    }
  }, [isStoryLoading, targetStory, navigate]);

  if (isStoryLoading || targetStory === undefined) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <p className="text-white/60 text-sm">Loading...</p>
      </div>
    );
  }

  if (!targetStory) return null;

  // If the story is in the active list, use its full group for slides; otherwise show it standalone
  const currentGroup = currentGroupIndex !== -1 ? groupedList[currentGroupIndex] : [targetStory];

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
    if (currentGroupIndex === -1) { navigate("/feed"); return; }
    const nextGroup = groupedList[currentGroupIndex + 1];
    if (nextGroup) {
      navigate(`/stories/${nextGroup[0].id}`);
    } else {
      navigate("/feed");
    }
  };

  const handlePrevious = () => {
    if (currentGroupIndex === -1) return;
    const prevGroup = groupedList[currentGroupIndex - 1];
    if (prevGroup) navigate(`/stories/${prevGroup[0].id}`);
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
