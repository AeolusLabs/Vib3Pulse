import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "framer-motion";
import StoryViewer from "@/components/StoryViewer";
import { queryClient } from "@/lib/queryClient";

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
  cropParams?: { x: number; y: number; w: number; h: number } | null;
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
  const [direction, setDirection] = useState<"next" | "prev">("next");

  // Seed from the all-stories cache (populated by FeedPage) — avoids a serial waterfall fetch
  const cachedStory = (queryClient.getQueryData<StoryWithUser[]>(["/api/stories"]) ?? [])
    .find((s) => s.id === storyId);

  // Only hit the network when the story isn't already in the all-stories cache.
  // Falls back to the individual endpoint for expired/private stories from deep links.
  const { data: targetStory, isLoading: isStoryLoading } = useQuery<StoryWithUser | null>({
    queryKey: ["/api/stories", storyId],
    queryFn: async () => {
      const res = await fetch(`/api/stories/${storyId}`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch story");
      return res.json();
    },
    initialData: cachedStory,
    enabled: !cachedStory,
    retry: false,
  });

  // Run in parallel with targetStory — no longer gated on it resolving first
  const { data: allStories = [] } = useQuery<StoryWithUser[]>({
    queryKey: ["/api/stories"],
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

  // Start at the correct slide for deep-linked story IDs mid-group
  const initialSlide = Math.max(0, currentGroup.findIndex((s: StoryWithUser) => s.id === storyId));

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
    cropParams: story.cropParams || null,
  }));

  const handleNext = () => {
    if (currentGroupIndex === -1) { navigate("/feed"); return; }
    const nextGroup = groupedList[currentGroupIndex + 1];
    if (nextGroup) {
      setDirection("next");
      navigate(`/stories/${nextGroup[0].id}`);
    } else {
      navigate("/feed");
    }
  };

  const handlePrevious = () => {
    if (currentGroupIndex === -1) return;
    const prevGroup = groupedList[currentGroupIndex - 1];
    if (prevGroup) {
      setDirection("prev");
      navigate(`/stories/${prevGroup[0].id}`);
    }
  };

  return (
    <AnimatePresence custom={direction} initial={false}>
      <StoryViewer
        key={targetStory.userId}
        direction={direction}
        username={targetStory.user.username}
        avatar={targetStory.user.avatarUrl ?? undefined}
        slides={slides}
        initialSlide={initialSlide}
        onClose={() => navigate("/feed")}
        onNext={handleNext}
        onPrevious={currentGroupIndex > 0 ? handlePrevious : undefined}
        storyOwnerId={targetStory.userId}
        displayName={targetStory.user.displayName}
        userType={targetStory.user.userType}
      />
    </AnimatePresence>
  );
}
