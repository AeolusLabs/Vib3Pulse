import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { format, differenceInYears } from "date-fns";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, MapPin, PoundSterling, Users, Heart, Building2, Mail, Cake, UserPlus, UserMinus } from "lucide-react";
import type { User, Event, Rsvp } from "@shared/schema";
import EditProfileDialog from "@/components/EditProfileDialog";
import { OrganizerStatsModal } from "@/components/OrganizerStatsModal";
import FollowersFollowingDialog from "@/components/FollowersFollowingDialog";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type ProfileResponse = Omit<User, 'password'> & {
  events?: Event[];
  rsvps?: Array<Rsvp & { event: Event }>;
};

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { toast } = useToast();

  // Use the shared useAuth hook for consistent session cache management
  const { data: sessionUser, isLoading: sessionLoading } = useAuth();

  const { data: profile, isLoading: profileLoading, error } = useQuery<ProfileResponse>({
    queryKey: [`/api/users/${username}`],
    queryFn: async () => {
      const response = await fetch(`/api/users/${username}`);
      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }
      return response.json();
    },
    enabled: !!username,
  });

  // Fetch follow stats for the profile user
  const { data: followStats, isLoading: followStatsLoading } = useQuery<{
    followersCount: number;
    followingCount: number;
    isFollowing: boolean;
  }>({
    queryKey: [`/api/users/${profile?.id}/follow-stats`],
    queryFn: async () => {
      const response = await fetch(`/api/users/${profile?.id}/follow-stats`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to fetch follow stats');
      }
      return response.json();
    },
    enabled: !!profile?.id,
  });

  // Follow mutation
  const followMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/users/${profile?.id}/follow`, {});
    },
    onSuccess: () => {
      // Invalidate target user's stats
      queryClient.invalidateQueries({ queryKey: [`/api/users/${profile?.id}/follow-stats`] });
      // Also invalidate current user's stats (their following count changed)
      if (sessionUser?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/users/${sessionUser.id}/follow-stats`] });
      }
      toast({
        title: "Success",
        description: `You are now following ${profile?.displayName || profile?.organizationName || profile?.username}`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to follow user. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Unfollow mutation
  const unfollowMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/users/${profile?.id}/unfollow`, {});
    },
    onSuccess: () => {
      // Invalidate target user's stats
      queryClient.invalidateQueries({ queryKey: [`/api/users/${profile?.id}/follow-stats`] });
      // Also invalidate current user's stats (their following count changed)
      if (sessionUser?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/users/${sessionUser.id}/follow-stats`] });
      }
      toast({
        title: "Success",
        description: `You unfollowed ${profile?.displayName || profile?.organizationName || profile?.username}`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to unfollow user. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Wait for both queries to finish before rendering
  if (profileLoading || sessionLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="space-y-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">User not found</p>
            </CardContent>
          </Card>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const isSocialUser = profile.userType === "social";
  const isOrganizer = profile.userType === "organizer";
  // Compare by ID - sessionUser is the user object directly (not wrapped)
  const isOwnProfile = sessionUser?.id === profile.id;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Profile Header */}
        <Card className="mb-8">
          <CardContent className="p-8">
            <div className="flex flex-col md:flex-row gap-6 items-start">
              {/* Avatar */}
              <Avatar className="h-24 w-24 border-4 border-primary/20">
                <AvatarImage src="" alt={isSocialUser ? (profile.displayName || profile.username) : (profile.organizationName || profile.username)} />
                <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                  {isSocialUser 
                    ? profile.displayName?.charAt(0) || profile.username.charAt(0).toUpperCase()
                    : profile.organizationName?.charAt(0) || profile.username.charAt(0).toUpperCase()
                  }
                </AvatarFallback>
              </Avatar>

              {/* Profile Info */}
              <div className="flex-1 space-y-4">
                {isSocialUser ? (
                  <>
                    {/* Social User Info */}
                    <div>
                      <h1 className="text-3xl font-bold font-serif text-foreground" data-testid="text-display-name">
                        {profile.displayName || profile.username}
                      </h1>
                      <p className="text-muted-foreground" data-testid="text-username">
                        @{profile.username}
                      </p>
                      {profile.dateOfBirth && (
                        <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2" data-testid="text-age">
                          <Cake className="h-4 w-4" />
                          {differenceInYears(new Date(), new Date(profile.dateOfBirth))} years old
                        </p>
                      )}
                    </div>
                    
                    {profile.bio && (
                      <p className="text-foreground leading-relaxed" data-testid="text-bio">
                        {profile.bio}
                      </p>
                    )}

                    {profile.interests && profile.interests.length > 0 && (
                      <div data-testid="interests-section">
                        <p className="text-sm font-medium text-muted-foreground mb-2">Interests</p>
                        <div className="flex flex-wrap gap-2">
                          {profile.interests.map((interest, index) => (
                            <Badge 
                              key={index} 
                              variant="secondary"
                              className="bg-primary/10 text-primary hover:bg-primary/20"
                              data-testid={`badge-interest-${index}`}
                            >
                              {interest}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Follower/Following Stats */}
                    {!followStatsLoading && followStats && (
                      <div className="flex gap-4 text-sm" data-testid="follow-stats">
                        <FollowersFollowingDialog
                          userId={profile.id}
                          username={profile.username}
                          followersCount={followStats.followersCount}
                          followingCount={followStats.followingCount}
                          initialTab="followers"
                          trigger={
                            <button className="hover-elevate rounded-md px-2 py-1 transition-colors" data-testid="button-show-followers">
                              <span className="font-bold text-foreground" data-testid="text-followers-count">
                                {followStats.followersCount}
                              </span>
                              <span className="text-muted-foreground ml-1">
                                {followStats.followersCount === 1 ? 'Follower' : 'Followers'}
                              </span>
                            </button>
                          }
                        />
                        <FollowersFollowingDialog
                          userId={profile.id}
                          username={profile.username}
                          followersCount={followStats.followersCount}
                          followingCount={followStats.followingCount}
                          initialTab="following"
                          trigger={
                            <button className="hover-elevate rounded-md px-2 py-1 transition-colors" data-testid="button-show-following">
                              <span className="font-bold text-foreground" data-testid="text-following-count">
                                {followStats.followingCount}
                              </span>
                              <span className="text-muted-foreground ml-1">Following</span>
                            </button>
                          }
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Event Organizer Info */}
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Building2 className="h-5 w-5 text-primary" />
                        <h1 className="text-3xl font-bold font-serif text-foreground" data-testid="text-organization-name">
                          {profile.organizationName || profile.username}
                        </h1>
                      </div>
                      <p className="text-muted-foreground" data-testid="text-username">
                        @{profile.username}
                      </p>
                      <Badge className="mt-2 bg-accent text-accent-foreground" data-testid="badge-organizer">
                        Event Organizer
                      </Badge>
                    </div>

                    {profile.bio && (
                      <p className="text-foreground leading-relaxed" data-testid="text-organization-description">
                        {profile.bio}
                      </p>
                    )}

                    {profile.contactEmail && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-contact-email">
                        <Mail className="h-4 w-4" />
                        {profile.contactEmail}
                      </div>
                    )}

                    {/* Follower/Following Stats for Organizers */}
                    {!followStatsLoading && followStats && (
                      <div className="flex gap-4 text-sm" data-testid="follow-stats-organizer">
                        <FollowersFollowingDialog
                          userId={profile.id}
                          username={profile.username}
                          followersCount={followStats.followersCount}
                          followingCount={followStats.followingCount}
                          initialTab="followers"
                          trigger={
                            <button className="hover-elevate rounded-md px-2 py-1 transition-colors" data-testid="button-show-followers-organizer">
                              <span className="font-bold text-foreground" data-testid="text-followers-count">
                                {followStats.followersCount}
                              </span>
                              <span className="text-muted-foreground ml-1">
                                {followStats.followersCount === 1 ? 'Follower' : 'Followers'}
                              </span>
                            </button>
                          }
                        />
                        <FollowersFollowingDialog
                          userId={profile.id}
                          username={profile.username}
                          followersCount={followStats.followersCount}
                          followingCount={followStats.followingCount}
                          initialTab="following"
                          trigger={
                            <button className="hover-elevate rounded-md px-2 py-1 transition-colors" data-testid="button-show-following-organizer">
                              <span className="font-bold text-foreground" data-testid="text-following-count">
                                {followStats.followingCount}
                              </span>
                              <span className="text-muted-foreground ml-1">Following</span>
                            </button>
                          }
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Action Buttons */}
                {isOwnProfile && (
                  <div className="pt-2 flex flex-wrap gap-2">
                    <EditProfileDialog user={profile as User} />
                    {isOrganizer && (
                      <OrganizerStatsModal 
                        organizerId={profile.id} 
                        organizerName={profile.organizationName || profile.username}
                      />
                    )}
                  </div>
                )}
                
                {!isOwnProfile && sessionUser && (
                  <div className="pt-2">
                    {followStats?.isFollowing ? (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => unfollowMutation.mutate()}
                        disabled={unfollowMutation.isPending}
                        data-testid="button-unfollow"
                      >
                        <UserMinus className="h-4 w-4 mr-2" />
                        {unfollowMutation.isPending ? "Unfollowing..." : "Following"}
                      </Button>
                    ) : (
                      <Button 
                        variant="default" 
                        size="sm"
                        onClick={() => followMutation.mutate()}
                        disabled={followMutation.isPending}
                        data-testid="button-follow"
                      >
                        <UserPlus className="h-4 w-4 mr-2" />
                        {followMutation.isPending ? "Following..." : "Follow"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Content Section */}
        {isSocialUser ? (
          <div>
            <h2 className="text-2xl font-bold font-serif mb-6" data-testid="heading-rsvps">
              Events I'm Attending
            </h2>
            {profile.rsvps && profile.rsvps.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {profile.rsvps.map((rsvp) => (
                  <Link key={rsvp.id} href={`/event/${rsvp.event.id}`}>
                    <Card className="overflow-hidden hover-elevate cursor-pointer" data-testid={`card-event-${rsvp.event.id}`}>
                    {rsvp.event.imageUrl && (
                      <div className="aspect-video relative overflow-hidden bg-muted">
                        <img 
                          src={rsvp.event.imageUrl} 
                          alt={rsvp.event.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <CardHeader className="pb-3">
                      <CardTitle className="text-xl line-clamp-2" data-testid="text-event-title">
                        {rsvp.event.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        <span data-testid="text-event-date">
                          {format(new Date(rsvp.event.eventDate), 'MMM d, yyyy • h:mm a')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span className="line-clamp-1" data-testid="text-event-location">
                          {rsvp.event.location}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {rsvp.event.ticketPrice === 0 ? (
                          <Badge variant="secondary" data-testid="badge-free">
                            FREE
                          </Badge>
                        ) : (
                          <div className="flex items-center gap-1 text-primary font-semibold" data-testid="text-event-price">
                            <PoundSterling className="h-4 w-4" />
                            {(rsvp.event.ticketPrice / 100).toFixed(2)}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  </Link>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="p-8 text-center">
                  <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground" data-testid="text-no-rsvps">
                    No events attended yet
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <div>
            <h2 className="text-2xl font-bold font-serif mb-6" data-testid="heading-events">
              Events Created
            </h2>
            {profile.events && profile.events.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {profile.events.map((event) => (
                  <Link key={event.id} href={`/event/${event.id}`}>
                    <Card className="overflow-hidden hover-elevate cursor-pointer" data-testid={`card-event-${event.id}`}>
                    {event.imageUrl && (
                      <div className="aspect-video relative overflow-hidden bg-muted">
                        <img 
                          src={event.imageUrl} 
                          alt={event.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <CardHeader className="pb-3">
                      <CardTitle className="text-xl line-clamp-2" data-testid="text-event-title">
                        {event.title}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        <span data-testid="text-event-date">
                          {format(new Date(event.eventDate), 'MMM d, yyyy • h:mm a')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span className="line-clamp-1" data-testid="text-event-location">
                          {event.location}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        {event.ticketPrice === 0 ? (
                          <Badge variant="secondary" data-testid="badge-free">
                            FREE
                          </Badge>
                        ) : (
                          <div className="flex items-center gap-1 text-primary font-semibold" data-testid="text-event-price">
                            <PoundSterling className="h-4 w-4" />
                            {(event.ticketPrice / 100).toFixed(2)}
                          </div>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {event.ticketsAvailable} tickets available
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                  </Link>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="p-8 text-center">
                  <Calendar className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground" data-testid="text-no-events">
                    No events created yet
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}
