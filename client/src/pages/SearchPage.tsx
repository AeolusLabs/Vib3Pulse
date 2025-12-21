import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Search, 
  UserPlus,
  UserCheck,
  MessageCircle, 
  Calendar, 
  MapPin, 
  Users, 
  Building2, 
  FileText,
  TrendingUp,
  Sparkles,
  Heart,
  Ticket,
  ChevronRight
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { User, Event, Post, Venue, Story } from "@shared/schema";

type SearchResults = {
  users: User[];
  events: Array<Event & { organizer: User }>;
  venues: Venue[];
  posts: Array<Post & { user: User }>;
};

type TrendingPost = Post & { user: User; likeCount: number; commentCount: number };
type TrendingEvent = Event & { organizer: User; rsvpCount: number; ticketCount: number };
type TrendingVenue = Venue & { viewCount: number };
type TrendingStory = Story & { user: User; likeCount: number };

const typeFilters = [
  { key: "all", label: "All", icon: Search },
  { key: "users", label: "Users", icon: Users },
  { key: "events", label: "Events", icon: Calendar },
  { key: "venues", label: "Venues", icon: Building2 },
  { key: "posts", label: "Posts", icon: FileText },
];

export default function SearchPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeType, setActiveType] = useState("all");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: currentUser } = useAuth();

  const { data: searchResults, isLoading: searchLoading } = useQuery<SearchResults>({
    queryKey: ['/api/search', debouncedQuery, activeType],
    queryFn: async () => {
      if (!debouncedQuery.trim() || debouncedQuery.length < 2) {
        return { users: [], events: [], venues: [], posts: [] };
      }
      const types = activeType === "all" ? "" : `&types=${activeType}`;
      const response = await fetch(`/api/search?q=${encodeURIComponent(debouncedQuery)}${types}`);
      if (!response.ok) throw new Error('Search failed');
      return response.json();
    },
    enabled: debouncedQuery.trim().length >= 2,
  });

  const { data: trendingPosts = [], isLoading: trendingPostsLoading } = useQuery<TrendingPost[]>({
    queryKey: ['/api/trending/posts'],
  });

  const { data: trendingEvents = [], isLoading: trendingEventsLoading } = useQuery<TrendingEvent[]>({
    queryKey: ['/api/trending/events'],
  });

  const { data: trendingVenues = [], isLoading: trendingVenuesLoading } = useQuery<TrendingVenue[]>({
    queryKey: ['/api/trending/venues'],
  });

  const { data: suggestedUsers = [], isLoading: suggestedUsersLoading } = useQuery<User[]>({
    queryKey: ['/api/suggested-users'],
    enabled: !!currentUser,
  });

  const isSearching = debouncedQuery.trim().length >= 2;

  // Recommended users based on similar interests and location
  const { data: recommendedUsers = [], isLoading: recommendedUsersLoading } = useQuery<User[]>({
    queryKey: ['/api/recommended-users'],
    enabled: !!currentUser && activeType === "users" && !isSearching,
  });

  // Get list of users the current user is following
  const { data: followingUsers = [] } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: !!currentUser,
  });

  // Local state for optimistic updates
  const [optimisticFollows, setOptimisticFollows] = useState<Set<string>>(new Set());
  const [optimisticUnfollows, setOptimisticUnfollows] = useState<Set<string>>(new Set());

  // Track followed user IDs with optimistic updates
  const followingIds = new Set([
    ...followingUsers.map(u => u.id),
    ...Array.from(optimisticFollows),
  ]);
  // Remove unfollowed users from the set
  Array.from(optimisticUnfollows).forEach(id => followingIds.delete(id));

  const followMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await apiRequest('POST', `/api/follows/${userId}`, {});
    },
    onMutate: (userId: string) => {
      // Optimistically add to following
      setOptimisticFollows(prev => new Set([...Array.from(prev), userId]));
      setOptimisticUnfollows(prev => {
        const next = new Set(Array.from(prev));
        next.delete(userId);
        return next;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suggested-users'] });
      queryClient.invalidateQueries({ queryKey: ['/api/recommended-users'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follows/me/following'] });
      toast({
        title: "Success",
        description: "You are now following this user",
      });
    },
    onError: (_error, userId) => {
      // Rollback optimistic update on error
      setOptimisticFollows(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    },
  });

  const unfollowMutation = useMutation({
    mutationFn: async (userId: string) => {
      return await apiRequest('DELETE', `/api/follows/${userId}`, {});
    },
    onMutate: (userId: string) => {
      // Optimistically remove from following
      setOptimisticUnfollows(prev => new Set([...Array.from(prev), userId]));
      setOptimisticFollows(prev => {
        const next = new Set(Array.from(prev));
        next.delete(userId);
        return next;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/suggested-users'] });
      queryClient.invalidateQueries({ queryKey: ['/api/recommended-users'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follows/me/following'] });
      toast({
        title: "Unfollowed",
        description: "You have unfollowed this user",
      });
    },
    onError: (_error, userId) => {
      // Rollback optimistic update on error
      setOptimisticUnfollows(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    },
  });

  const handleFollowToggle = (userId: string) => {
    if (followingIds.has(userId)) {
      unfollowMutation.mutate(userId);
    } else {
      followMutation.mutate(userId);
    }
  };

  const hasSearchResults = searchResults && (
    searchResults.users.length > 0 ||
    searchResults.events.length > 0 ||
    searchResults.venues.length > 0 ||
    searchResults.posts.length > 0
  );

  const totalResults = searchResults ? 
    searchResults.users.length + 
    searchResults.events.length + 
    searchResults.venues.length + 
    searchResults.posts.length : 0;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold font-serif text-foreground mb-4">Search & Discover</h1>
          
          <div className="relative mb-4">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search users, events, venues, posts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-12 h-12 text-base rounded-full bg-muted/50 border-0 focus-visible:ring-2 focus-visible:ring-primary"
              data-testid="input-universal-search"
            />
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2">
            {typeFilters.map((filter) => (
              <Button
                key={filter.key}
                variant={activeType === filter.key ? "default" : "outline"}
                size="sm"
                onClick={() => setActiveType(filter.key)}
                className="rounded-full whitespace-nowrap"
                data-testid={`button-filter-${filter.key}`}
              >
                <filter.icon className="h-4 w-4 mr-1" />
                {filter.label}
              </Button>
            ))}
          </div>
        </div>

        {isSearching ? (
          <div className="space-y-6">
            {searchLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : !hasSearchResults ? (
              <div className="text-center py-12">
                <Search className="h-16 w-16 mx-auto text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground">No results found for "{debouncedQuery}"</p>
                <p className="text-sm text-muted-foreground mt-1">Try different keywords or filters</p>
              </div>
            ) : (
              <Tabs defaultValue="all" className="w-full">
                <TabsList className="mb-4">
                  <TabsTrigger value="all" data-testid="tab-all">
                    All ({totalResults})
                  </TabsTrigger>
                  {searchResults.users.length > 0 && (
                    <TabsTrigger value="users" data-testid="tab-users">
                      Users ({searchResults.users.length})
                    </TabsTrigger>
                  )}
                  {searchResults.events.length > 0 && (
                    <TabsTrigger value="events" data-testid="tab-events">
                      Events ({searchResults.events.length})
                    </TabsTrigger>
                  )}
                  {searchResults.venues.length > 0 && (
                    <TabsTrigger value="venues" data-testid="tab-venues">
                      Venues ({searchResults.venues.length})
                    </TabsTrigger>
                  )}
                  {searchResults.posts.length > 0 && (
                    <TabsTrigger value="posts" data-testid="tab-posts">
                      Posts ({searchResults.posts.length})
                    </TabsTrigger>
                  )}
                </TabsList>

                <TabsContent value="all" className="space-y-6">
                  {searchResults.users.length > 0 && (
                    <SearchResultSection title="Users" icon={Users}>
                      {searchResults.users.map((user) => (
                        <UserResultCard key={user.id} user={user} sessionUser={currentUser} isFollowing={followingIds.has(user.id)} onFollowToggle={handleFollowToggle} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                  {searchResults.events.length > 0 && (
                    <SearchResultSection title="Events" icon={Calendar}>
                      {searchResults.events.map((event) => (
                        <EventResultCard key={event.id} event={event} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                  {searchResults.venues.length > 0 && (
                    <SearchResultSection title="Venues" icon={Building2}>
                      {searchResults.venues.map((venue) => (
                        <VenueResultCard key={venue.id} venue={venue} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                  {searchResults.posts.length > 0 && (
                    <SearchResultSection title="Posts" icon={FileText}>
                      {searchResults.posts.map((post) => (
                        <PostResultCard key={post.id} post={post} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                </TabsContent>

                <TabsContent value="users" className="space-y-3">
                  {searchResults.users.map((user) => (
                    <UserResultCard key={user.id} user={user} sessionUser={currentUser} isFollowing={followingIds.has(user.id)} onFollowToggle={handleFollowToggle} navigate={navigate} />
                  ))}
                </TabsContent>

                <TabsContent value="events" className="space-y-3">
                  {searchResults.events.map((event) => (
                    <EventResultCard key={event.id} event={event} navigate={navigate} />
                  ))}
                </TabsContent>

                <TabsContent value="venues" className="space-y-3">
                  {searchResults.venues.map((venue) => (
                    <VenueResultCard key={venue.id} venue={venue} navigate={navigate} />
                  ))}
                </TabsContent>

                <TabsContent value="posts" className="space-y-3">
                  {searchResults.posts.map((post) => (
                    <PostResultCard key={post.id} post={post} navigate={navigate} />
                  ))}
                </TabsContent>
              </Tabs>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {/* Recommended users based on interests/location - shown when Users filter is active */}
            {activeType === "users" && currentUser && (
              <section data-testid="section-recommended-users">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <Users className="h-5 w-5 text-primary" />
                    Recommended for You
                  </h2>
                  <p className="text-sm text-muted-foreground">Based on your interests & location</p>
                </div>
                {recommendedUsersLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-24 w-full rounded-lg" />
                    ))}
                  </div>
                ) : recommendedUsers.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {recommendedUsers.map((user) => (
                      <UserResultCard
                        key={user.id}
                        user={user}
                        sessionUser={currentUser}
                        isFollowing={followingIds.has(user.id)}
                        onFollowToggle={handleFollowToggle}
                        navigate={navigate}
                      />
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center">
                      <Users className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                      <p className="text-muted-foreground">No recommendations yet</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Add interests and location to your profile to get personalized recommendations
                      </p>
                    </CardContent>
                  </Card>
                )}
              </section>
            )}

            {/* Suggested users - shown when all or users filter is active */}
            {(activeType === "all" || activeType === "users") && currentUser && suggestedUsers.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    {activeType === "users" ? "More Users to Follow" : "Suggested for You"}
                  </h2>
                </div>
                <ScrollArea className="w-full whitespace-nowrap">
                  <div className="flex gap-4 pb-4">
                    {suggestedUsersLoading ? (
                      [1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-48 w-40 rounded-lg flex-shrink-0" />
                      ))
                    ) : (
                      suggestedUsers.slice(0, 8).map((user) => (
                        <SuggestedUserCard
                          key={user.id}
                          user={user}
                          isFollowing={followingIds.has(user.id)}
                          onFollowToggle={handleFollowToggle}
                          isPending={followMutation.isPending || unfollowMutation.isPending}
                          navigate={navigate}
                        />
                      ))
                    )}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </section>
            )}

            {(activeType === "all" || activeType === "events") && trendingEvents.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    Trending Events
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => navigate('/discover')} data-testid="link-view-all-events">
                    View all <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <ScrollArea className="w-full whitespace-nowrap">
                  <div className="flex gap-4 pb-4">
                    {trendingEventsLoading ? (
                      [1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-64 w-72 rounded-lg flex-shrink-0" />
                      ))
                    ) : (
                      trendingEvents.slice(0, 8).map((event) => (
                        <TrendingEventCard key={event.id} event={event} navigate={navigate} />
                      ))
                    )}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </section>
            )}

            {(activeType === "all" || activeType === "venues") && trendingVenues.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-primary" />
                    Popular Venues
                  </h2>
                </div>
                <ScrollArea className="w-full whitespace-nowrap">
                  <div className="flex gap-4 pb-4">
                    {trendingVenuesLoading ? (
                      [1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-48 w-64 rounded-lg flex-shrink-0" />
                      ))
                    ) : (
                      trendingVenues.slice(0, 8).map((venue) => (
                        <TrendingVenueCard key={venue.id} venue={venue} navigate={navigate} />
                      ))
                    )}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </section>
            )}

            {(activeType === "all" || activeType === "posts") && trendingPosts.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <Heart className="h-5 w-5 text-primary" />
                    Trending Posts
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => navigate('/feed')} data-testid="link-view-all-posts">
                    View all <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {trendingPostsLoading ? (
                    [1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-32 w-full rounded-lg" />
                    ))
                  ) : (
                    trendingPosts.slice(0, 4).map((post) => (
                      <TrendingPostCard key={post.id} post={post} navigate={navigate} />
                    ))
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}

function SearchResultSection({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-3">
        <Icon className="h-5 w-5 text-primary" />
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function UserResultCard({ user, sessionUser, isFollowing, onFollowToggle, navigate }: { user: User; sessionUser?: { id: string } | null; isFollowing: boolean; onFollowToggle: (id: string) => void; navigate: (path: string) => void }) {
  const isSocialUser = user.userType === "social";
  const isOwnProfile = sessionUser?.id === user.id;

  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={() => navigate(`/profile/${user.username}`)}
      data-testid={`search-user-${user.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <Avatar className="h-12 w-12 border-2 border-primary/20">
            <AvatarImage src="" alt={isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username)} />
            <AvatarFallback className="bg-primary/10 text-primary">
              {isSocialUser 
                ? (user.displayName?.charAt(0) || user.username.charAt(0)).toUpperCase()
                : (user.organizationName?.charAt(0) || user.username.charAt(0)).toUpperCase()
              }
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold truncate">
                {isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username)}
              </h4>
              {!isSocialUser && <Badge className="bg-primary text-xs">Organizer</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">@{user.username}</p>
          </div>
          {!isOwnProfile && sessionUser && (
            <Button
              size="sm"
              variant={isFollowing ? "default" : "outline"}
              onClick={(e) => { e.stopPropagation(); onFollowToggle(user.id); }}
              data-testid={`button-follow-${user.id}`}
            >
              {isFollowing ? (
                <>
                  <UserCheck className="h-4 w-4 mr-1" />
                  Following
                </>
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventResultCard({ event, navigate }: { event: Event & { organizer: User }; navigate: (path: string) => void }) {
  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={() => navigate(`/events/${event.id}`)}
      data-testid={`search-event-${event.id}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-4">
          {event.imageUrl && (
            <img src={event.imageUrl} alt={event.title} className="w-20 h-20 rounded-lg object-cover" />
          )}
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold truncate">{event.title}</h4>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              <Calendar className="h-3 w-3" />
              <span>{format(new Date(event.eventDate), "MMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="h-3 w-3" />
              <span className="truncate">{event.location}</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="secondary" className="text-xs">{event.category}</Badge>
              {event.ticketPrice === 0 ? (
                <Badge className="bg-green-500/10 text-green-600 text-xs">Free</Badge>
              ) : (
                <Badge variant="outline" className="text-xs">£{(event.ticketPrice / 100).toFixed(2)}</Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VenueResultCard({ venue, navigate }: { venue: Venue; navigate: (path: string) => void }) {
  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={() => navigate(`/venues/${venue.id}`)}
      data-testid={`search-venue-${venue.id}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-4">
          {venue.imageUrl && (
            <img src={venue.imageUrl} alt={venue.name} className="w-20 h-20 rounded-lg object-cover" />
          )}
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold truncate">{venue.name}</h4>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              <MapPin className="h-3 w-3" />
              <span className="truncate">{venue.location}</span>
            </div>
            <Badge variant="secondary" className="text-xs mt-2">{venue.category}</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PostResultCard({ post, navigate }: { post: Post & { user: User }; navigate: (path: string) => void }) {
  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={() => navigate(`/profile/${post.user.username}`)}
      data-testid={`search-post-${post.id}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-primary/10 text-primary">
              {(post.user.displayName?.charAt(0) || post.user.username.charAt(0)).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">{post.user.displayName || post.user.username}</p>
            <p className="text-sm text-foreground line-clamp-2 mt-1">{post.content}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SuggestedUserCard({ user, isFollowing, onFollowToggle, isPending, navigate }: { user: User; isFollowing: boolean; onFollowToggle: (id: string) => void; isPending: boolean; navigate: (path: string) => void }) {
  const isSocialUser = user.userType === "social";
  
  return (
    <Card 
      className="w-40 flex-shrink-0 hover-elevate cursor-pointer"
      onClick={() => navigate(`/profile/${user.username}`)}
      data-testid={`suggested-user-${user.id}`}
    >
      <CardContent className="p-4 text-center">
        <Avatar className="h-16 w-16 mx-auto mb-3 border-2 border-primary/20">
          <AvatarFallback className="bg-primary/10 text-primary text-lg">
            {isSocialUser 
              ? (user.displayName?.charAt(0) || user.username.charAt(0)).toUpperCase()
              : (user.organizationName?.charAt(0) || user.username.charAt(0)).toUpperCase()
            }
          </AvatarFallback>
        </Avatar>
        <h4 className="font-semibold text-sm truncate">
          {isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username)}
        </h4>
        <p className="text-xs text-muted-foreground truncate mb-3">@{user.username}</p>
        <Button
          size="sm"
          className="w-full"
          variant={isFollowing ? "secondary" : "default"}
          onClick={(e) => { e.stopPropagation(); onFollowToggle(user.id); }}
          disabled={isPending}
          data-testid={`button-follow-suggested-${user.id}`}
        >
          {isFollowing ? (
            <>
              <UserCheck className="h-3 w-3 mr-1" />
              Following
            </>
          ) : (
            <>
              <UserPlus className="h-3 w-3 mr-1" />
              Follow
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function TrendingEventCard({ event, navigate }: { event: TrendingEvent; navigate: (path: string) => void }) {
  return (
    <Card 
      className="w-72 flex-shrink-0 hover-elevate cursor-pointer overflow-hidden"
      onClick={() => navigate(`/events/${event.id}`)}
      data-testid={`trending-event-${event.id}`}
    >
      {event.imageUrl && (
        <div className="relative h-32">
          <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover" />
          <div className="absolute top-2 right-2">
            <Badge className="bg-primary">{format(new Date(event.eventDate), "MMM d")}</Badge>
          </div>
        </div>
      )}
      <CardContent className="p-4">
        <h4 className="font-semibold truncate mb-1">{event.title}</h4>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <MapPin className="h-3 w-3" />
          <span className="truncate">{event.location}</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {event.rsvpCount} RSVPs
            </span>
            <span className="flex items-center gap-1">
              <Ticket className="h-3 w-3" />
              {event.ticketCount} sold
            </span>
          </div>
          {event.ticketPrice === 0 ? (
            <Badge className="bg-green-500/10 text-green-600 text-xs">Free</Badge>
          ) : (
            <Badge variant="outline" className="text-xs">£{(event.ticketPrice / 100).toFixed(2)}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TrendingVenueCard({ venue, navigate }: { venue: TrendingVenue; navigate: (path: string) => void }) {
  return (
    <Card 
      className="w-64 flex-shrink-0 hover-elevate cursor-pointer overflow-hidden"
      onClick={() => navigate(`/venues/${venue.id}`)}
      data-testid={`trending-venue-${venue.id}`}
    >
      {venue.imageUrl && (
        <div className="h-28">
          <img src={venue.imageUrl} alt={venue.name} className="w-full h-full object-cover" />
        </div>
      )}
      <CardContent className="p-4">
        <h4 className="font-semibold truncate mb-1">{venue.name}</h4>
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <MapPin className="h-3 w-3" />
          <span className="truncate">{venue.city || venue.location}</span>
        </div>
        <div className="flex items-center justify-between">
          <Badge variant="secondary" className="text-xs">{venue.category}</Badge>
          <span className="text-xs text-muted-foreground">{venue.viewCount} views</span>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendingPostCard({ post, navigate }: { post: TrendingPost; navigate: (path: string) => void }) {
  return (
    <Card 
      className="hover-elevate cursor-pointer"
      onClick={() => navigate(`/profile/${post.user.username}`)}
      data-testid={`trending-post-${post.id}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-primary/10 text-primary">
              {(post.user.displayName?.charAt(0) || post.user.username.charAt(0)).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <p className="font-medium text-sm">{post.user.displayName || post.user.username}</p>
              <span className="text-xs text-muted-foreground">
                {format(new Date(post.createdAt), "MMM d")}
              </span>
            </div>
            <p className="text-sm text-foreground line-clamp-2">{post.content}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Heart className="h-3 w-3" />
                {post.likeCount}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle className="h-3 w-3" />
                {post.commentCount}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
