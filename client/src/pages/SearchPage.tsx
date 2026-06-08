import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchResultSkeleton } from "@/components/ui/skeleton-layouts";
import FeedPost from "@/components/FeedPost";
import EventDetailsModal from "@/components/EventDetailsModal";

import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import type { User, Event, Post, Venue, Story, VenueEntryNight } from "@shared/schema";
import { SearchIcon, UserPlusIcon, UserCheckIcon, CalendarIcon, MapPinIcon, UsersIcon, Building2Icon, TrendingUpIcon, SparklesIcon, HeartIcon, TicketIcon, ChevronRightIcon } from "@/components/ui/icons";
import { FileText } from "lucide-react";

type SearchResults = {
  users: User[];
  events: Array<Event & { organizer: User }>;
  venueEvents: Array<VenueEntryNight & { venue: Venue }>;
  venues: Venue[];
  posts: Array<Post & { user: User }>;
};

type TrendingPost = Post & { user: User; likeCount: number; commentCount: number };
type TrendingEvent = Event & { organizer: User; rsvpCount: number; ticketCount: number };
type TrendingVenue = Venue & { viewCount: number };
type TrendingStory = Story & { user: User; likeCount: number };

const typeFilters = [
  { key: "all", label: "All", icon: SearchIcon },
  { key: "users", label: "Users", icon: UsersIcon },
  { key: "events", label: "Events", icon: CalendarIcon },
  { key: "venues", label: "Venues", icon: Building2Icon },
  { key: "posts", label: "Posts", icon: FileText },
];

export default function SearchPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeType, setActiveType] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<TrendingEvent | null>(null);
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
        return { users: [], events: [], venueEvents: [], venues: [], posts: [] };
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

  const { data: allEvents = [] } = useQuery<Event[]>({
    queryKey: ['/api/events'],
    enabled: !isSearching && (activeType === 'all' || activeType === 'events'),
  });

  const { data: allVenueEvents = [] } = useQuery<Array<VenueEntryNight & { venue: Venue }>>({
    queryKey: ['/api/venue-events/upcoming'],
    enabled: !isSearching && (activeType === 'all' || activeType === 'events'),
  });

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
    searchResults.venueEvents.length > 0 ||
    searchResults.venues.length > 0 ||
    searchResults.posts.length > 0
  );

  const totalResults = searchResults ?
    searchResults.users.length +
    searchResults.events.length +
    searchResults.venueEvents.length +
    searchResults.venues.length +
    searchResults.posts.length : 0;

  type CombinedEvent =
    | { kind: 'event'; date: Date; data: Event }
    | { kind: 'venueEvent'; date: Date; data: VenueEntryNight & { venue: Venue } };

  const combinedAllEvents: CombinedEvent[] = [
    ...allEvents.map(e => ({ kind: 'event' as const, date: new Date(e.eventDate), data: e })),
    ...allVenueEvents.map(e => ({ kind: 'venueEvent' as const, date: new Date(e.date), data: e })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold font-serif text-foreground mb-4">Search & Discover</h1>
          
          <div className="relative mb-4">
            <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
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
              <div className="space-y-1">
                {[0, 1, 2, 3].map((i) => <SearchResultSkeleton key={i} index={i} />)}
              </div>
            ) : !hasSearchResults ? (
              <div className="text-center py-12">
                <SearchIcon className="h-16 w-16 mx-auto text-muted-foreground/30 mb-4" />
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
                  {(searchResults.events.length > 0 || searchResults.venueEvents.length > 0) && (
                    <TabsTrigger value="events" data-testid="tab-events">
                      Events ({searchResults.events.length + searchResults.venueEvents.length})
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
                    <SearchResultSection title="Users" icon={UsersIcon}>
                      {searchResults.users.map((user) => (
                        <UserResultCard key={user.id} user={user} sessionUser={currentUser} isFollowing={followingIds.has(user.id)} onFollowToggle={handleFollowToggle} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                  {(searchResults.events.length > 0 || searchResults.venueEvents.length > 0) && (
                    <SearchResultSection title="Events" icon={CalendarIcon}>
                      {searchResults.events.map((event) => (
                        <EventResultCard key={`event-${event.id}`} event={event} navigate={navigate} />
                      ))}
                      {searchResults.venueEvents.map((ve) => (
                        <VenueEventResultCard key={`ve-${ve.id}`} venueEvent={ve} navigate={navigate} />
                      ))}
                    </SearchResultSection>
                  )}
                  {searchResults.venues.length > 0 && (
                    <SearchResultSection title="Venues" icon={Building2Icon}>
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
                    <EventResultCard key={`event-${event.id}`} event={event} navigate={navigate} />
                  ))}
                  {searchResults.venueEvents.map((ve) => (
                    <VenueEventResultCard key={`ve-${ve.id}`} venueEvent={ve} navigate={navigate} />
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
                    <UsersIcon className="h-5 w-5 text-primary" />
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
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                      <UsersIcon className="h-6 w-6 text-primary/50" />
                    </div>
                    <p className="text-muted-foreground text-sm font-medium">No recommendations yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Add interests and location to your profile to get personalized recommendations
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* Suggested users - shown when all or users filter is active */}
            {(activeType === "all" || activeType === "users") && currentUser && suggestedUsers.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <SparklesIcon className="h-5 w-5 text-primary" />
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
                    <TrendingUpIcon className="h-5 w-5 text-primary" />
                    Trending Events
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => navigate('/discover')} data-testid="link-view-all-events">
                    View all <ChevronRightIcon className="h-4 w-4 ml-1" />
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
                        <TrendingEventCard key={event.id} event={event} onSelect={setSelectedEvent} />
                      ))
                    )}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </section>
            )}

            {(activeType === "all" || activeType === "events") && combinedAllEvents.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <CalendarIcon className="h-5 w-5 text-primary" />
                    All Events
                  </h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {combinedAllEvents.map((item) =>
                    item.kind === 'event' ? (
                      <EventResultCard key={`event-${item.data.id}`} event={item.data as Event & { organizer: User }} navigate={navigate} />
                    ) : (
                      <VenueEventResultCard key={`ve-${item.data.id}`} venueEvent={item.data} navigate={navigate} />
                    )
                  )}
                </div>
              </section>
            )}

            {(activeType === "all" || activeType === "venues") && trendingVenues.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold font-serif flex items-center gap-2">
                    <Building2Icon className="h-5 w-5 text-primary" />
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
                    <HeartIcon className="h-5 w-5 text-primary" />
                    Trending Posts
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => navigate('/feed')} data-testid="link-view-all-posts">
                    View all <ChevronRightIcon className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <div className="space-y-3">
                  {trendingPostsLoading ? (
                    [1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-32 w-full rounded-lg" />
                    ))
                  ) : (
                    trendingPosts.slice(0, 6).map((post) => (
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

      {selectedEvent && (
        <EventDetailsModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function SearchResultSection({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-base font-semibold font-serif flex items-center gap-2 mb-3 text-foreground/80">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function UserResultCard({ user, sessionUser, isFollowing, onFollowToggle, navigate }: { user: User; sessionUser?: { id: string } | null; isFollowing: boolean; onFollowToggle: (id: string) => void; navigate: (path: string) => void }) {
  const isSocialUser = user.userType === "social";
  const isOwnProfile = sessionUser?.id === user.id;
  const displayName = isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username);
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40 bg-card hover:border-primary/30 hover:bg-muted/20 transition-all duration-200 cursor-pointer"
      onClick={() => navigate(`/profile/${user.username}`)}
      data-testid={`search-user-${user.id}`}
    >
      <div className={`rounded-full p-[2px] flex-shrink-0 ${!isSocialUser ? "bg-gradient-to-br from-violet-500 to-purple-700" : "bg-border"}`}>
        <Avatar className="h-12 w-12 ring-2 ring-background">
          <AvatarImage src={user.avatarUrl || ""} alt={displayName} />
          <AvatarFallback className="bg-primary/10 text-primary font-semibold">{initial}</AvatarFallback>
        </Avatar>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-sm text-foreground truncate">{displayName}</span>
          {!isSocialUser && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-600/10 text-violet-400 border border-violet-600/20 flex-shrink-0">
              Organizer
            </span>
          )}
          {user.isOfficial && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 flex-shrink-0">
              Verified
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">@{user.username}</p>
      </div>
      {!isOwnProfile && sessionUser && (
        <button
          className={`flex-shrink-0 text-xs font-semibold px-4 py-1.5 rounded-full transition-colors ${
            isFollowing
              ? "bg-muted text-foreground hover:bg-muted/70 border border-border"
              : "bg-violet-600 text-white hover:bg-violet-500"
          }`}
          onClick={(e) => { e.stopPropagation(); onFollowToggle(user.id); }}
          data-testid={`button-follow-${user.id}`}
        >
          {isFollowing ? (
            <span className="flex items-center gap-1"><UserCheckIcon className="h-3 w-3" />Following</span>
          ) : (
            <span className="flex items-center gap-1"><UserPlusIcon className="h-3 w-3" />Follow</span>
          )}
        </button>
      )}
    </div>
  );
}

function EventResultCard({ event, navigate }: { event: Event & { organizer?: User }; navigate: (path: string) => void }) {
  return (
    <div
      className="rounded-xl border border-border/40 bg-card hover:border-primary/30 hover:bg-muted/10 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => navigate(`/events/${event.id}`)}
      data-testid={`search-event-${event.id}`}
    >
      {event.imageUrl && (
        <div className="relative aspect-[16/7] overflow-hidden">
          <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <span className="absolute bottom-2 left-3 text-xs font-semibold text-white/90 bg-black/40 px-2 py-0.5 rounded-full backdrop-blur-sm">
            {format(new Date(event.eventDate), "EEE, MMM d")}
          </span>
          {event.ticketPrice === 0 ? (
            <span className="absolute top-2 right-2 text-xs font-semibold text-green-400 bg-black/50 px-2 py-0.5 rounded-full backdrop-blur-sm">Free</span>
          ) : (
            <span className="absolute top-2 right-2 text-xs font-semibold text-white bg-black/50 px-2 py-0.5 rounded-full backdrop-blur-sm">£{(event.ticketPrice / 100).toFixed(2)}</span>
          )}
        </div>
      )}
      <div className="p-3">
        <h4 className="font-semibold text-sm text-foreground truncate mb-1">{event.title}</h4>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 truncate"><MapPinIcon className="h-3 w-3 flex-shrink-0" />{event.location}</span>
          <span className="flex-shrink-0 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{event.category}</span>
        </div>
      </div>
    </div>
  );
}

function VenueEventResultCard({ venueEvent, navigate }: { venueEvent: VenueEntryNight & { venue: Venue }; navigate: (path: string) => void }) {
  const imageUrl = venueEvent.imageUrl || venueEvent.venue?.coverImageUrl || venueEvent.venue?.imageUrl;
  return (
    <div
      className="rounded-xl border border-border/40 bg-card hover:border-primary/30 hover:bg-muted/10 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => navigate(`/venue-events/${venueEvent.id}`)}
      data-testid={`search-venue-event-${venueEvent.id}`}
    >
      {imageUrl && (
        <div className="relative aspect-[16/7] overflow-hidden">
          <img src={imageUrl} alt={venueEvent.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <span className="absolute bottom-2 left-3 text-xs font-semibold text-white/90 bg-black/40 px-2 py-0.5 rounded-full backdrop-blur-sm">
            {format(new Date(venueEvent.date), "EEE, MMM d")}
          </span>
          <span className="absolute top-2 right-2 text-xs font-semibold text-white bg-black/50 px-2 py-0.5 rounded-full backdrop-blur-sm">
            £{(venueEvent.coverPriceCents / 100).toFixed(2)}
          </span>
        </div>
      )}
      <div className="p-3">
        <h4 className="font-semibold text-sm text-foreground truncate mb-1">{venueEvent.name}</h4>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {venueEvent.venue?.name && (
            <span className="flex items-center gap-1 truncate"><Building2Icon className="h-3 w-3 flex-shrink-0" />{venueEvent.venue.name}</span>
          )}
          <span className="flex-shrink-0 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Venue Event</span>
        </div>
      </div>
    </div>
  );
}

function VenueResultCard({ venue, navigate }: { venue: Venue; navigate: (path: string) => void }) {
  return (
    <div
      className="rounded-xl border border-border/40 bg-card hover:border-primary/30 hover:bg-muted/10 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => navigate(`/venue/${venue.id}`)}
      data-testid={`search-venue-${venue.id}`}
    >
      {venue.imageUrl && (
        <div className="relative aspect-[16/7] overflow-hidden">
          <img src={venue.imageUrl} alt={venue.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <span className="absolute bottom-2 left-3 text-xs font-semibold text-white/90 bg-black/40 px-2 py-0.5 rounded-full backdrop-blur-sm capitalize">{venue.category}</span>
        </div>
      )}
      <div className="p-3">
        <h4 className="font-semibold text-sm text-foreground truncate mb-1">{venue.name}</h4>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPinIcon className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{venue.city || venue.location}</span>
        </div>
      </div>
    </div>
  );
}

function PostResultCard({ post }: { post: Post & { user: User }; navigate: (path: string) => void }) {
  return (
    <div data-testid={`search-post-${post.id}`}>
      <FeedPost
        id={post.id}
        author={{
          name: post.user.displayName || post.user.organizationName || post.user.username,
          username: post.user.username,
          avatar: post.user.avatarUrl || undefined,
          isOrganizer: post.user.userType !== "social",
          isVerified: post.user.isOfficial || false,
          userId: post.user.id,
        }}
        content={post.content}
        imageUrls={post.imageUrls || []}
        image={post.imageUrl || undefined}
        videoUrl={post.videoUrl}
        createdAt={post.createdAt}
        likes={0}
        comments={0}
        feedMode={true}
      />
    </div>
  );
}

function SuggestedUserCard({ user, isFollowing, onFollowToggle, isPending, navigate }: { user: User; isFollowing: boolean; onFollowToggle: (id: string) => void; isPending: boolean; navigate: (path: string) => void }) {
  const isSocialUser = user.userType === "social";
  const displayName = isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username);
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div
      className="w-44 flex-shrink-0 rounded-xl border border-border/40 bg-card hover:border-primary/30 hover:bg-muted/20 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => navigate(`/profile/${user.username}`)}
      data-testid={`suggested-user-${user.id}`}
    >
      <div className="p-4 flex flex-col items-center text-center">
        <div className={`rounded-full p-[2px] mb-3 ${!isSocialUser ? "bg-gradient-to-br from-violet-500 to-purple-700" : "bg-border"}`}>
          <Avatar className="h-16 w-16 ring-2 ring-background">
            <AvatarImage src={user.avatarUrl || ""} alt={displayName} />
            <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">{initial}</AvatarFallback>
          </Avatar>
        </div>
        <p className="font-semibold text-sm text-foreground truncate w-full">{displayName}</p>
        <p className="text-xs text-muted-foreground truncate w-full mb-3">@{user.username}</p>
        <button
          className={`w-full text-xs font-semibold py-1.5 rounded-full transition-colors ${
            isFollowing
              ? "bg-muted text-foreground border border-border hover:bg-muted/70"
              : "bg-violet-600 text-white hover:bg-violet-500"
          }`}
          onClick={(e) => { e.stopPropagation(); onFollowToggle(user.id); }}
          disabled={isPending}
          data-testid={`button-follow-suggested-${user.id}`}
        >
          {isFollowing ? (
            <span className="flex items-center justify-center gap-1"><UserCheckIcon className="h-3 w-3" />Following</span>
          ) : (
            <span className="flex items-center justify-center gap-1"><UserPlusIcon className="h-3 w-3" />Follow</span>
          )}
        </button>
      </div>
    </div>
  );
}

function TrendingEventCard({ event, onSelect }: { event: TrendingEvent; onSelect: (event: TrendingEvent) => void }) {
  return (
    <div
      className="w-72 flex-shrink-0 rounded-xl border border-border/40 bg-card hover:border-primary/30 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => onSelect(event)}
      data-testid={`trending-event-${event.id}`}
    >
      <div className="relative h-36 bg-muted">
        {event.imageUrl ? (
          <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-violet-900/40 to-purple-900/20">
            <CalendarIcon className="h-8 w-8 text-violet-400/50" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
        <span className="absolute bottom-2 left-3 text-xs font-semibold text-white bg-violet-600/80 px-2 py-0.5 rounded-full backdrop-blur-sm">
          {format(new Date(event.eventDate), "MMM d")}
        </span>
        {event.ticketPrice === 0 ? (
          <span className="absolute top-2 right-2 text-xs font-semibold text-green-400 bg-black/50 px-2 py-0.5 rounded-full backdrop-blur-sm">Free</span>
        ) : (
          <span className="absolute top-2 right-2 text-xs font-semibold text-white bg-black/50 px-2 py-0.5 rounded-full backdrop-blur-sm">£{(event.ticketPrice / 100).toFixed(2)}</span>
        )}
      </div>
      <div className="p-3">
        <h4 className="font-semibold text-sm text-foreground truncate mb-1">{event.title}</h4>
        <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2">
          <MapPinIcon className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{event.location}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><UsersIcon className="h-3 w-3" />{event.rsvpCount} RSVPs</span>
          <span className="flex items-center gap-1"><TicketIcon className="h-3 w-3" />{event.ticketCount} sold</span>
        </div>
      </div>
    </div>
  );
}

function TrendingVenueCard({ venue, navigate }: { venue: TrendingVenue; navigate: (path: string) => void }) {
  return (
    <div
      className="w-60 flex-shrink-0 rounded-xl border border-border/40 bg-card hover:border-primary/30 transition-all duration-200 cursor-pointer overflow-hidden"
      onClick={() => navigate(`/venue/${venue.id}`)}
      data-testid={`trending-venue-${venue.id}`}
    >
      <div className="relative h-32 bg-muted">
        {venue.imageUrl ? (
          <img src={venue.imageUrl} alt={venue.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800/60 to-slate-900/40">
            <Building2Icon className="h-8 w-8 text-slate-400/50" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <span className="absolute bottom-2 left-3 text-[10px] font-semibold text-white/90 bg-black/40 px-2 py-0.5 rounded-full backdrop-blur-sm capitalize">{venue.category}</span>
      </div>
      <div className="p-3">
        <h4 className="font-semibold text-sm text-foreground truncate mb-1">{venue.name}</h4>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
            <MapPinIcon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{venue.city || venue.location}</span>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">{venue.viewCount} views</span>
        </div>
      </div>
    </div>
  );
}

function TrendingPostCard({ post, navigate }: { post: TrendingPost; navigate: (path: string) => void }) {
  return (
    <div data-testid={`trending-post-${post.id}`}>
      <FeedPost
        id={post.id}
        author={{
          name: post.user.displayName || post.user.organizationName || post.user.username,
          username: post.user.username,
          avatar: post.user.avatarUrl || undefined,
          isOrganizer: post.user.userType !== "social",
          isVerified: post.user.isOfficial || false,
          userId: post.user.id,
        }}
        content={post.content}
        imageUrls={post.imageUrls || []}
        image={post.imageUrl || undefined}
        videoUrl={post.videoUrl}
        createdAt={post.createdAt}
        likes={post.likeCount}
        comments={post.commentCount}
        feedMode={true}
      />
    </div>
  );
}
