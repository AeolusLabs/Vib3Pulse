import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { Event, Venue } from "@shared/schema";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import StoriesBar from "@/components/StoriesBar";
import StoryViewer from "@/components/StoryViewer";
import CreateStoryModal from "@/components/CreateStoryModal";
import CreatePostModal from "@/components/CreatePostModal";
import FeedPost from "@/components/FeedPost";
import PostDetailDialog from "@/components/PostDetailDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sparkles, Image as ImageIcon } from "lucide-react";
import musicFestival from '@assets/generated_images/Outdoor_music_festival_event_179040d3.png';
import foodTasting from '@assets/generated_images/Food_and_wine_tasting_69928d9e.png';
import techConf from '@assets/generated_images/Tech_conference_presentation_2bcf2c35.png';
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import artGallery from '@assets/generated_images/Art_gallery_opening_8b389604.png';
import charityRun from '@assets/generated_images/Charity_run_event_5c615e65.png';

//todo: remove mock functionality
const mockStories = [
  { 
    id: '1', 
    username: 'Live Events Co', 
    isViewed: false,
    slides: [
      { id: '1-1', type: 'image' as const, content: musicFestival, timestamp: '2h ago' },
      { id: '1-2', type: 'text' as const, content: '🎵 Summer Festival lineup announced!', backgroundColor: 'hsl(262 80% 87%)', timestamp: '2h ago' }
    ]
  },
  { 
    id: '2', 
    username: 'Wellness Warriors', 
    isViewed: true,
    slides: [
      { id: '2-1', type: 'image' as const, content: yogaEvent, timestamp: '5h ago' },
      { id: '2-2', type: 'text' as const, content: 'Join us every morning for sunrise yoga 🧘', backgroundColor: 'hsl(127 63% 49%)', timestamp: '5h ago' }
    ]
  },
  { 
    id: '3', 
    username: 'TechForward', 
    isViewed: false,
    slides: [
      { id: '3-1', type: 'image' as const, content: techConf, timestamp: '1h ago' }
    ]
  },
  { 
    id: '4', 
    username: 'Art Collective LA', 
    isViewed: false,
    slides: [
      { id: '4-1', type: 'image' as const, content: artGallery, timestamp: '3h ago' },
      { id: '4-2', type: 'text' as const, content: 'New exhibition opening this Friday!', backgroundColor: 'hsl(340 70% 60%)', timestamp: '3h ago' }
    ]
  },
  { 
    id: '5', 
    username: 'Community Champions', 
    isViewed: true,
    slides: [
      { id: '5-1', type: 'image' as const, content: charityRun, timestamp: '8h ago' }
    ]
  },
];

//todo: remove mock functionality
const mockPosts = [
  {
    id: '1',
    author: {
      name: 'Live Events Co',
      username: 'liveeventsco',
      isOrganizer: true
    },
    content: '🎵 Excited to announce our Summer Music Festival lineup! Get your tickets now before they sell out. This is going to be the event of the year! #MusicFestival #LiveMusic',
    image: musicFestival,
    timestamp: '2h ago',
    likes: 234,
    comments: 45,
    isLiked: false
  },
  {
    id: '2',
    author: {
      name: 'Sarah Johnson',
      username: 'sarahj'
    },
    content: 'Just got my tickets for the yoga retreat next month! Can\'t wait to disconnect and recharge 🧘‍♀️✨',
    timestamp: '5h ago',
    likes: 89,
    comments: 12,
    isLiked: true
  },
  {
    id: '3',
    author: {
      name: 'TechForward',
      username: 'techforward',
      isOrganizer: true
    },
    content: 'Innovation never stops! Join us at the Tech Summit 2025 where we\'ll explore AI, blockchain, and the future of technology. Early bird tickets available now.',
    image: techConf,
    timestamp: '1h ago',
    likes: 456,
    comments: 78,
    isLiked: false
  },
  {
    id: '4',
    author: {
      name: 'Michael Chen',
      username: 'mchen'
    },
    content: 'Had an amazing time at the food & wine tasting last night! The culinary experience was incredible. Highly recommend checking out their upcoming events!',
    image: foodTasting,
    timestamp: '3h ago',
    likes: 124,
    comments: 23,
    isLiked: false
  },
  {
    id: '5',
    author: {
      name: 'Art Collective LA',
      username: 'artcollectivela',
      isOrganizer: true
    },
    content: 'Opening reception this Friday! Come experience our new contemporary art exhibition featuring local artists. Free entry, all are welcome 🎨',
    image: artGallery,
    timestamp: '6h ago',
    likes: 167,
    comments: 34,
    isLiked: true
  },
  {
    id: '6',
    author: {
      name: 'Emma Rodriguez',
      username: 'emmarodriguez'
    },
    content: 'Training for the charity 5K run next month! Who else is participating? Let\'s make a difference together 🏃‍♀️💪',
    timestamp: '8h ago',
    likes: 93,
    comments: 19,
    isLiked: false
  },
  {
    id: '7',
    author: {
      name: 'Wellness Warriors',
      username: 'wellnesswarriors',
      isOrganizer: true
    },
    content: 'Morning yoga sessions are now open for registration! Join us every Saturday at sunrise for a peaceful practice in the park. First class is free 🌅',
    timestamp: '10h ago',
    likes: 201,
    comments: 41,
    isLiked: false
  },
  {
    id: '8',
    author: {
      name: 'David Park',
      username: 'dpark'
    },
    content: 'Just discovered VibePulse and I\'m loving it! So many cool events happening in the city. Already RSVP\'d to three events this month 🎉',
    timestamp: '12h ago',
    likes: 67,
    comments: 8,
    isLiked: true
  }
];

type StoryWithUser = {
  id: string;
  userId: string;
  imageUrl: string;
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
  };
};

type ShareData = {
  type: "event" | "venue";
  id: string;
  title?: string;
  name?: string;
};

export default function FeedPage() {
  const [viewingStory, setViewingStory] = useState<number | null>(null);
  const [createStoryOpen, setCreateStoryOpen] = useState(false);
  const [createPostOpen, setCreatePostOpen] = useState(false);
  const [feedFilter, setFeedFilter] = useState<'following' | 'all'>('following');
  const [selectedPost, setSelectedPost] = useState<any | null>(null);
  const [attachedEvent, setAttachedEvent] = useState<Event | null>(null);
  const [attachedVenue, setAttachedVenue] = useState<Venue | null>(null);
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

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

  const { data: posts = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/posts'],
  });

  const { data: storiesData = [] } = useQuery<StoryWithUser[]>({
    queryKey: ['/api/stories'],
  });

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
      avatar: '',
      isViewed: false,
      userType: firstStory.user.userType,
      displayName: firstStory.user.displayName,
      organizationName: firstStory.user.organizationName,
      slides: userStories.map((story: StoryWithUser) => ({
        id: story.id,
        type: 'image' as const,
        content: story.imageUrl,
        timestamp: new Date(story.createdAt).toLocaleString(),
        likeCount: story.likeCount || 0,
        isLiked: story.isLiked || false,
        isReshare: story.isReshare || false,
        privacy: story.privacy || 'public',
        originalStoryId: story.originalStoryId,
      })),
      userId: firstStory.userId,
    };
  });

  const createPostMutation = useMutation({
    mutationFn: async (data: { content: string; imageUrl?: string; eventId?: string; venueId?: string }) => {
      return await apiRequest('POST', '/api/posts', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/posts'] });
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

  const handleNextStory = () => {
    if (viewingStory !== null && viewingStory < stories.length - 1) {
      setViewingStory(viewingStory + 1);
    } else {
      setViewingStory(null);
    }
  };

  const handlePreviousStory = () => {
    if (viewingStory !== null && viewingStory > 0) {
      setViewingStory(viewingStory - 1);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <StoriesBar
        stories={stories}
        onStoryClick={(storyId) => {
          const index = stories.findIndex(s => s.id === storyId);
          setViewingStory(index);
        }}
        onCreateStory={() => setCreateStoryOpen(true)}
      />

      <main className="max-w-[600px] mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-serif font-semibold">Feed</h1>
          <div className="flex gap-2">
            <Button
              variant={feedFilter === 'following' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFeedFilter('following')}
              data-testid="button-filter-following"
            >
              Following
            </Button>
            <Button
              variant={feedFilter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFeedFilter('all')}
              data-testid="button-filter-all"
            >
              <Sparkles className="h-4 w-4 mr-1" />
              For You
            </Button>
          </div>
        </div>

        <Card className="mb-4 hover-elevate cursor-pointer" onClick={() => setCreatePostOpen(true)} data-testid="card-create-post">
          <CardContent className="p-4">
            <div className="flex gap-3">
              <Avatar className="h-10 w-10 flex-shrink-0">
                <AvatarImage 
                  src="" 
                  alt={currentUser?.userType === 'social' 
                    ? (currentUser.displayName || currentUser.username) 
                    : (currentUser?.organizationName || currentUser?.username || 'User')
                  } 
                />
                <AvatarFallback className="bg-primary/10 text-primary">
                  {currentUser?.userType === 'social'
                    ? (currentUser.displayName?.charAt(0) || currentUser.username.charAt(0)).toUpperCase()
                    : (currentUser?.organizationName?.charAt(0) || currentUser?.username.charAt(0) || 'U').toUpperCase()
                  }
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 flex items-center gap-2">
                <div className="flex-1 py-2 px-4 rounded-full bg-muted text-muted-foreground">
                  What's happening?
                </div>
                <Button variant="ghost" size="icon" data-testid="button-add-image-quick">
                  <ImageIcon className="h-5 w-5 text-primary" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {isLoading ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">Loading posts...</p>
            </div>
          ) : posts.length > 0 ? (
            posts.map((post: any) => (
              <FeedPost
                key={post.id}
                id={post.id}
                author={{
                  name: post.user.displayName || post.user.organizationName || post.user.username,
                  username: post.user.username,
                  isOrganizer: post.user.userType === 'organizer',
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
                eventId={post.eventId}
                venueId={post.venueId}
                onPostClick={() => setSelectedPost(post)}
              />
            ))
          ) : (
            <>
              {mockPosts.map((post) => (
                <FeedPost key={post.id} {...post} onPostClick={() => setSelectedPost(post)} />
              ))}
            </>
          )}
        </div>

        <div className="text-center py-8">
          <p className="text-muted-foreground text-sm">You're all caught up! 🎉</p>
        </div>
      </main>

      {viewingStory !== null && stories[viewingStory] && (
        <StoryViewer
          username={stories[viewingStory].username}
          slides={stories[viewingStory].slides}
          onClose={() => setViewingStory(null)}
          onNext={handleNextStory}
          onPrevious={handlePreviousStory}
          storyOwnerId={stories[viewingStory].userId}
          displayName={stories[viewingStory].displayName}
          userType={stories[viewingStory].userType}
        />
      )}

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
        onCreatePost={(content, image, eventId, venueId) => {
          createPostMutation.mutate({
            content,
            imageUrl: image,
            eventId,
            venueId,
          });
        }}
      />

      {selectedPost && (
        <PostDetailDialog
          open={!!selectedPost}
          onClose={() => setSelectedPost(null)}
          postId={selectedPost.id}
          author={{
            name: selectedPost.user?.displayName || selectedPost.user?.organizationName || selectedPost.user?.username || selectedPost.author?.name || 'Unknown',
            username: selectedPost.user?.username || selectedPost.author?.username || 'unknown',
            avatar: selectedPost.user?.avatarUrl || selectedPost.author?.avatar,
            userId: selectedPost.user?.id || selectedPost.author?.userId,
          }}
          content={selectedPost.content}
          image={selectedPost.imageUrl || selectedPost.image}
          createdAt={selectedPost.createdAt}
        />
      )}

      <BottomNavigation onCreateClick={() => setCreateStoryOpen(true)} />
    </div>
  );
}
