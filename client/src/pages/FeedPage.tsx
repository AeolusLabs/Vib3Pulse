import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { Event, Venue, Community } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import StoriesBar from "@/components/StoriesBar";
import CreateStoryModal from "@/components/CreateStoryModal";
import CreatePostModal from "@/components/CreatePostModal";
import FeedPost from "@/components/FeedPost";
import PostDetailDialog from "@/components/PostDetailDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

import CommunityModal from "@/components/CommunityModal";
import { SparklesIcon, ImageIcon, PlusIcon, UsersIcon } from "@/components/ui/icons";

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

type ShareData = {
  type: "event" | "venue";
  id: string;
  title?: string;
  name?: string;
};

type CommunityWithRole = Community & { memberCount: number; role: string };

export default function FeedPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [createStoryOpen, setCreateStoryOpen] = useState(false);
  const [createPostOpen, setCreatePostOpen] = useState(false);
  const [feedFilter, setFeedFilter] = useState<string>('following'); // 'following', 'all', or community ID
  const [selectedPost, setSelectedPost] = useState<any | null>(null);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const [attachedEvent, setAttachedEvent] = useState<Event | null>(null);
  const [attachedVenue, setAttachedVenue] = useState<Venue | null>(null);
  const [communityModalOpen, setCommunityModalOpen] = useState(false);
  const [selectedCommunityForPost, setSelectedCommunityForPost] = useState<string | null>(null);
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

  // Fetch user's communities
  const { data: myCommunities = [] } = useQuery<CommunityWithRole[]>({
    queryKey: ['/api/communities/my'],
    enabled: !!currentUser,
  });

  // Check for shared event/venue data on mount
  useEffect(() => {
    const shareDataStr = sessionStorage.getItem("shareToFeed");
    if (shareDataStr) {
      try {
        const shareData: ShareData = JSON.parse(shareDataStr);
        sessionStorage.removeItem("shareToFeed");
        
        // Fetch the event or venue details
        if (shareData.type === "event") {
          fetch(`/api/events/${shareData.id}`)
            .then(res => res.json())
            .then(event => {
              setAttachedEvent(event);
              setCreatePostOpen(true);
            })
            .catch(console.error);
        } else if (shareData.type === "venue") {
          fetch(`/api/venues/${shareData.id}`)
            .then(res => res.json())
            .then(venue => {
              setAttachedVenue(venue);
              setCreatePostOpen(true);
            })
            .catch(console.error);
        }
      } catch (e) {
        console.error("Failed to parse share data:", e);
      }
    }
  }, []);

  // Determine if we're viewing a community feed
  const isViewingCommunity = feedFilter !== 'following' && feedFilter !== 'all';
  const selectedCommunity = isViewingCommunity 
    ? myCommunities.find(c => c.id === feedFilter) 
    : null;

  // Use separate queries for main feed vs community feed to ensure proper reactivity
  const { data: mainPosts = [], isLoading: isLoadingMain, isError: isErrorMain } = useQuery<any[]>({
    queryKey: ['/api/posts'],
    enabled: !isViewingCommunity,
  });

  const { data: communityPosts = [], isLoading: isLoadingCommunity, isError: isErrorCommunity } = useQuery<any[]>({
    queryKey: ['/api/communities', feedFilter, 'posts'],
    queryFn: async () => {
      const res = await fetch(`/api/communities/${feedFilter}/posts`);
      if (!res.ok) throw new Error('Failed to fetch community posts');
      return res.json();
    },
    enabled: isViewingCommunity,
  });

  const posts = isViewingCommunity ? communityPosts : mainPosts;
  const isLoading = isViewingCommunity ? isLoadingCommunity : isLoadingMain;
  const isError = isViewingCommunity ? isErrorCommunity : isErrorMain;

  // Open a specific post (and optionally highlight a comment) when arriving
  // from a notification link: /feed?post=<postId>&comment=<commentId>
  // Fetches the post directly by ID so it works regardless of the active feed filter.
  const notificationPostId = new URLSearchParams(search).get("post");
  const notificationCommentId = new URLSearchParams(search).get("comment");
  useEffect(() => {
    if (!notificationPostId) return;
    // Snapshot comment ID before navigate() clears the search string
    const commentId = notificationCommentId;
    navigate("/feed", { replace: true });
    fetch(`/api/posts/${notificationPostId}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((post) => {
        if (post) {
          setSelectedPost(post);
          if (commentId) setHighlightCommentId(commentId);
        }
      })
      .catch(console.error);
  }, [notificationPostId]);

  // Extract unique @usernames from all posts for avatar lookup
  const mentionedUsernames = useMemo(() => {
    const usernames = new Set<string>();
    posts.forEach((post: any) => {
      const matches = post.content?.match(/@(\w+)/g);
      if (matches) {
        matches.forEach((match: string) => usernames.add(match.slice(1).toLowerCase()));
      }
    });
    return Array.from(usernames);
  }, [posts]);

  // Fetch mentioned users' data (avatars) in batch
  const { data: mentionedUsersData = [] } = useQuery<{ username: string; displayName: string | null; avatarUrl: string | null }[]>({
    queryKey: ['/api/users/by-usernames', mentionedUsernames],
    queryFn: async () => {
      if (mentionedUsernames.length === 0) return [];
      const res = await apiRequest('POST', '/api/users/by-usernames', { usernames: mentionedUsernames });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: mentionedUsernames.length > 0,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const { data: storiesData = [] } = useQuery<StoryWithUser[]>({
    queryKey: ['/api/stories'],
  });

  // Set of user IDs who currently have active stories (for avatar story rings)
  const userIdsWithStories = useMemo(
    () => new Set(storiesData.map((s: StoryWithUser) => s.userId)),
    [storiesData]
  );

  // Group stories by user - only keep the most recent story per user
  const groupedStories = storiesData.reduce((acc: Map<string, StoryWithUser[]>, story) => {
    const userId = story.userId;
    if (!acc.has(userId)) {
      acc.set(userId, []);
    }
    acc.get(userId)!.push(story);
    return acc;
  }, new Map());

  // Convert to array format expected by StoriesBar
  const stories = Array.from(groupedStories.values()).map((userStories) => {
    const firstStory = userStories[0];
    return {
      id: firstStory.userId,
      username: firstStory.user.displayName || firstStory.user.organizationName || firstStory.user.username,
      avatar: firstStory.user.avatarUrl || '',
      isViewed: false,
      userType: firstStory.user.userType,
      displayName: firstStory.user.displayName,
      organizationName: firstStory.user.organizationName,
      slides: userStories.map((story: StoryWithUser) => ({
        id: story.id,
        type: (story.type === 'video' ? 'video' : 'image') as "image" | "text" | "video",
        content: story.imageUrl,
        videoUrl: story.videoUrl || null,
        caption: story.caption || null,
        timestamp: story.createdAt,
        likeCount: story.likeCount || 0,
        isLiked: story.isLiked || false,
        isReshare: story.isReshare || false,
        privacy: story.privacy || 'public',
        originalStoryId: story.originalStoryId,
        cropParams: story.cropParams || null,
      })),
      userId: firstStory.userId,
    };
  });

  const createPostMutation = useMutation({
    mutationFn: async (data: { content: string; images?: string[]; eventId?: string; venueId?: string; communityId?: string; videoUrl?: string }) => {
      let imageUrls: string[] | undefined;

      if (data.images && data.images.length > 0) {
        const base64Images = data.images.filter(img => img.startsWith('data:'));
        if (base64Images.length > 0) {
          const uploadRes = await apiRequest('POST', '/api/upload-images', { images: base64Images });
          if (uploadRes.ok) {
            const { urls } = await uploadRes.json();
            imageUrls = urls;
          }
        }
      }
      
      return await apiRequest('POST', '/api/posts', {
        content: data.content,
        imageUrls,
        videoUrl: data.videoUrl,
        eventId: data.eventId,
        venueId: data.venueId,
        communityId: data.communityId,
      });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/communities'] });
      // Also invalidate community-specific posts if posting to a community
      if (variables.communityId) {
        queryClient.invalidateQueries({ queryKey: ['/api/communities', variables.communityId, 'posts'] });
      }
      handleCloseCreatePost();
      toast({
        title: "Post created",
        description: "Your post has been shared successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create post. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleCloseCreatePost = () => {
    setCreatePostOpen(false);
    setAttachedEvent(null);
    setAttachedVenue(null);
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <StoriesBar
        stories={stories}
        onStoryClick={(storyId) => {
          const story = stories.find(s => s.id === storyId);
          const firstSlideId = story?.slides?.[0]?.id;
          if (firstSlideId) navigate(`/stories/${firstSlideId}`);
        }}
        onCreateStory={() => setCreateStoryOpen(true)}
      />

      <main className="max-w-[600px] mx-auto px-4 sm:px-6 py-6">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-2xl font-serif font-semibold">Feed</h1>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCommunityModalOpen(true)}
              data-testid="button-manage-communities"
            >
              <UsersIcon className="h-4 w-4 mr-1" />
              Communities
            </Button>
          </div>
          <ScrollArea className="w-full">
            <div className="flex gap-2 pb-2">
              <Button
                variant={feedFilter === 'following' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFeedFilter('following')}
                data-testid="button-filter-following"
                className="whitespace-nowrap"
              >
                Following
              </Button>
              <Button
                variant={feedFilter === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFeedFilter('all')}
                data-testid="button-filter-all"
                className="whitespace-nowrap"
              >
                <SparklesIcon className="h-4 w-4 mr-1" />
                For You
              </Button>
              {myCommunities.map((community) => (
                <Button
                  key={community.id}
                  variant={feedFilter === community.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setFeedFilter(community.id)}
                  data-testid={`button-filter-community-${community.id}`}
                  className="whitespace-nowrap"
                >
                  {community.name}
                </Button>
              ))}
              {currentUser && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCommunityModalOpen(true)}
                  data-testid="button-add-community"
                  className="whitespace-nowrap"
                >
                  <PlusIcon className="h-4 w-4" />
                </Button>
              )}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>

        {/* Compose prompt */}
        <div
          className="flex gap-3 px-4 py-3 border-b border-border cursor-pointer hover:bg-muted/20 transition-colors mb-0"
          onClick={() => setCreatePostOpen(true)}
          data-testid="card-create-post"
        >
          <Avatar className="h-10 w-10 flex-shrink-0">
            <AvatarImage
              src=""
              alt={
                currentUser?.userType === "social"
                  ? currentUser.displayName || currentUser.username
                  : currentUser?.organizationName || currentUser?.username || "User"
              }
            />
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {currentUser?.userType === "social"
                ? (currentUser.displayName?.charAt(0) || currentUser.username.charAt(0)).toUpperCase()
                : (currentUser?.organizationName?.charAt(0) || currentUser?.username.charAt(0) || "U").toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 flex items-center gap-2">
            <span className="flex-1 py-2 px-4 rounded-full bg-muted/60 text-muted-foreground text-[15px] select-none">
              What's happening?
            </span>
            <button
              className="p-2 rounded-full text-primary hover:bg-primary/10 transition-colors"
              onClick={(e) => { e.stopPropagation(); setCreatePostOpen(true); }}
              data-testid="button-add-image-quick"
            >
              <ImageIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Posts — borderless timeline (A1) */}
        <div className="divide-y divide-border">
          {isLoading ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">Loading posts...</p>
            </div>
          ) : isError ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground text-sm">Failed to load posts. Try refreshing.</p>
            </div>
          ) : posts.length > 0 ? (
            posts.map((post: any) => (
              <FeedPost
                key={post.id}
                id={post.id}
                author={{
                  name: post.user.displayName || post.user.organizationName || post.user.username,
                  username: post.user.username,
                  isOrganizer: post.user.userType === "organizer",
                  isVerified: post.user.isVerified,
                  userId: post.user.id,
                  avatar: post.user.avatarUrl,
                }}
                content={post.content}
                createdAt={post.createdAt}
                likes={0}
                comments={0}
                isLiked={false}
                image={post.imageUrl}
                imageUrls={post.imageUrls || []}
                videoUrl={post.videoUrl}
                eventId={post.eventId}
                venueId={post.venueId}
                community={post.community}
                mentionedUsers={mentionedUsersData}
                hasActiveStory={userIdsWithStories.has(post.user.id)}
                feedMode={true}
                onPostClick={() => setSelectedPost(post)}
              />
            ))
          ) : (
            <div className="text-center py-12">
              <p className="text-muted-foreground text-sm">
                {isViewingCommunity
                  ? "No posts in this community yet. Start the conversation!"
                  : feedFilter === "following"
                  ? "Nothing here yet — follow people to see their posts."
                  : "No posts yet. Be the first to post!"}
              </p>
            </div>
          )}
        </div>

        <div className="text-center py-8">
          <p className="text-muted-foreground text-sm">You're all caught up! 🎉</p>
        </div>
      </main>

      <CreateStoryModal
        open={createStoryOpen}
        onClose={() => setCreateStoryOpen(false)}
        onCreateStory={(type, content) => console.log('Story created:', type, content)}
      />

      <CreatePostModal
        open={createPostOpen}
        onClose={handleCloseCreatePost}
        attachedEvent={attachedEvent}
        attachedVenue={attachedVenue}
        defaultCommunityId={isViewingCommunity ? feedFilter : null}
        onCreatePost={(content, images, eventId, venueId, communityId, _videoDataUrl, videoUrl) => {
          createPostMutation.mutate({
            content,
            images,
            eventId,
            venueId,
            communityId,
            videoUrl,
          });
        }}
      />

      {selectedPost && (
        <PostDetailDialog
          open={!!selectedPost}
          onClose={() => { setSelectedPost(null); setHighlightCommentId(null); }}
          postId={selectedPost.id}
          author={{
            name: selectedPost.user?.displayName || selectedPost.user?.organizationName || selectedPost.user?.username || selectedPost.author?.name || 'Unknown',
            username: selectedPost.user?.username || selectedPost.author?.username || 'unknown',
            avatar: selectedPost.user?.avatarUrl || selectedPost.author?.avatar,
            userId: selectedPost.user?.id || selectedPost.author?.userId,
          }}
          content={selectedPost.content}
          image={selectedPost.imageUrl || selectedPost.image}
          imageUrls={selectedPost.imageUrls}
          videoUrl={selectedPost.videoUrl}
          createdAt={selectedPost.createdAt}
          highlightCommentId={highlightCommentId ?? undefined}
        />
      )}

      <BottomNavigation onCreateClick={() => setCreateStoryOpen(true)} />

      <CommunityModal
        open={communityModalOpen}
        onClose={() => setCommunityModalOpen(false)}
      />
    </div>
  );
}
