import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { format, differenceInYears } from "date-fns";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, MapPin, PoundSterling, Users, MessageCircle, UserCheck, UserPlus } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User, Post, Event, Rsvp } from "@shared/schema";
import EditProfileDialog from "@/components/EditProfileDialog";
import FollowersFollowingDialog from "@/components/FollowersFollowingDialog";

type UserProfileResponse = {
  user: User;
  posts: Post[];
  events: Array<Rsvp & { event: Event }>;
};

type SocialStats = {
  followersCount: number;
  followingCount: number;
  isFollowing: boolean;
};

export default function UserProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: sessionUser } = useQuery<{ user: User }>({
    queryKey: ['/api/auth/session'],
  });

  const { data: profile, isLoading, error } = useQuery<UserProfileResponse>({
    queryKey: [`/api/users/${userId}/profile`],
    enabled: !!userId,
  });

  const { data: followStatus } = useQuery<{ isFollowing: boolean }>({
    queryKey: [`/api/follows/${userId}/status`],
    enabled: !!userId && !!sessionUser,
  });

  const { data: socialStats } = useQuery<SocialStats>({
    queryKey: [`/api/users/${userId}/follow-stats`],
    enabled: !!userId,
  });

  const followMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', `/api/follows/${userId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/follows/${userId}/status`] });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/follow-stats`] });
      if (sessionUser?.user?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/users/${sessionUser.user.id}/follow-stats`] });
      }
      toast({
        title: "Success",
        description: "You are now following this user",
      });
    },
  });

  const unfollowMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', `/api/follows/${userId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/follows/${userId}/status`] });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${userId}/follow-stats`] });
      if (sessionUser?.user?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/users/${sessionUser.user.id}/follow-stats`] });
      }
      toast({
        title: "Success",
        description: "Unfollowed successfully",
      });
    },
  });

  const handleMessage = () => {
    navigate(`/messages/${userId}`);
  };

  if (isLoading) {
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

  if (!profile) {
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

  const { user } = profile;
  const isSocialUser = user.userType === "social";
  const isOwnProfile = sessionUser?.user?.id === userId;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Profile Header */}
        <Card className="mb-8">
          <CardContent className="p-8">
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <Avatar className="h-24 w-24 border-4 border-primary/20" data-testid="avatar-user">
                <AvatarImage src="" alt={isSocialUser ? (user.displayName || user.username) : (user.organizationName || user.username)} />
                <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                  {isSocialUser 
                    ? user.displayName?.charAt(0) || user.username.charAt(0).toUpperCase()
                    : user.organizationName?.charAt(0) || user.username.charAt(0).toUpperCase()
                  }
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 space-y-4">
                {isSocialUser ? (
                  <>
                    <div>
                      <h1 className="text-3xl font-bold font-serif text-foreground" data-testid="text-display-name">
                        {user.displayName || user.username}
                      </h1>
                      <p className="text-muted-foreground" data-testid="text-username">
                        @{user.username}
                      </p>
                    </div>
                    
                    {user.bio && (
                      <p className="text-foreground leading-relaxed" data-testid="text-bio">
                        {user.bio}
                      </p>
                    )}

                    {user.interests && user.interests.length > 0 && (
                      <div data-testid="interests-section">
                        <p className="text-sm font-medium text-muted-foreground mb-2">Interests</p>
                        <div className="flex flex-wrap gap-2">
                          {user.interests.map((interest, index) => (
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
                    <div className="flex gap-6" data-testid="social-stats">
                      <FollowersFollowingDialog
                        userId={userId!}
                        username={user.username}
                        followersCount={socialStats?.followersCount ?? 0}
                        followingCount={socialStats?.followingCount ?? 0}
                        initialTab="followers"
                        trigger={
                          <button className="text-center hover-elevate rounded-md px-3 py-2 transition-colors" data-testid="button-show-followers">
                            <p className="font-bold text-foreground text-[17px]" data-testid="text-followers-count">
                              {socialStats?.followersCount ?? 0}
                            </p>
                            <p className="text-sm text-muted-foreground">Followers</p>
                          </button>
                        }
                      />
                      <FollowersFollowingDialog
                        userId={userId!}
                        username={user.username}
                        followersCount={socialStats?.followersCount ?? 0}
                        followingCount={socialStats?.followingCount ?? 0}
                        initialTab="following"
                        trigger={
                          <button className="text-center hover-elevate rounded-md px-3 py-2 transition-colors" data-testid="button-show-following">
                            <p className="text-xl font-bold text-foreground" data-testid="text-following-count">
                              {socialStats?.followingCount ?? 0}
                            </p>
                            <p className="text-sm text-muted-foreground">Following</p>
                          </button>
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <h1 className="text-3xl font-bold font-serif text-foreground" data-testid="text-organization-name">
                          {user.organizationName || user.username}
                        </h1>
                        <Badge variant="default" className="bg-primary" data-testid="badge-organizer">
                          Event Organizer
                        </Badge>
                      </div>
                      <p className="text-muted-foreground" data-testid="text-username">
                        @{user.username}
                      </p>
                    </div>

                    {/* Follower/Following Stats for Organizers */}
                    <div className="flex gap-6" data-testid="social-stats-organizer">
                      <FollowersFollowingDialog
                        userId={userId!}
                        username={user.username}
                        followersCount={socialStats?.followersCount ?? 0}
                        followingCount={socialStats?.followingCount ?? 0}
                        initialTab="followers"
                        trigger={
                          <button className="text-center hover-elevate rounded-md px-3 py-2 transition-colors" data-testid="button-show-followers-organizer">
                            <p className="text-xl font-bold text-foreground" data-testid="text-followers-count">
                              {socialStats?.followersCount ?? 0}
                            </p>
                            <p className="text-sm text-muted-foreground">Followers</p>
                          </button>
                        }
                      />
                      <FollowersFollowingDialog
                        userId={userId!}
                        username={user.username}
                        followersCount={socialStats?.followersCount ?? 0}
                        followingCount={socialStats?.followingCount ?? 0}
                        initialTab="following"
                        trigger={
                          <button className="text-center hover-elevate rounded-md px-3 py-2 transition-colors" data-testid="button-show-following-organizer">
                            <p className="text-xl font-bold text-foreground" data-testid="text-following-count">
                              {socialStats?.followingCount ?? 0}
                            </p>
                            <p className="text-sm text-muted-foreground">Following</p>
                          </button>
                        }
                      />
                    </div>

                    {user.bio && (
                      <p className="text-foreground leading-relaxed" data-testid="text-bio">
                        {user.bio}
                      </p>
                    )}

                    {user.contactEmail && (
                      <p className="text-sm text-muted-foreground" data-testid="text-contact-email">
                        Contact: {user.contactEmail}
                      </p>
                    )}
                  </>
                )}

                {/* Action Buttons */}
                {isOwnProfile && (
                  <div className="pt-4">
                    <EditProfileDialog user={user} />
                  </div>
                )}
                
                {!isOwnProfile && sessionUser && (
                  <div className="flex gap-3 pt-4">
                    {followStatus?.isFollowing ? (
                      <Button
                        variant="outline"
                        onClick={() => unfollowMutation.mutate()}
                        disabled={unfollowMutation.isPending}
                        data-testid="button-unfollow"
                      >
                        <UserCheck className="h-4 w-4 mr-2" />
                        Following
                      </Button>
                    ) : (
                      <Button
                        onClick={() => followMutation.mutate()}
                        disabled={followMutation.isPending}
                        data-testid="button-follow"
                      >
                        <UserPlus className="h-4 w-4 mr-2" />
                        Follow
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={handleMessage}
                      data-testid="button-message"
                    >
                      <MessageCircle className="h-4 w-4 mr-2" />
                      Message
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Posts Section */}
        {profile.posts.length > 0 && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Posts</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {profile.posts.map((post) => (
                  <div key={post.id} className="border-b last:border-0 pb-4 last:pb-0" data-testid={`post-${post.id}`}>
                    <p className="text-foreground mb-2">{post.content}</p>
                    {post.imageUrl && (
                      <img 
                        src={post.imageUrl} 
                        alt="Post image" 
                        className="rounded-md max-h-96 w-auto"
                      />
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      {format(new Date(post.createdAt), 'PPp')}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Events Attending Section */}
        {profile.events.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Events Attending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                {profile.events.map(({ event }) => (
                  <Card key={event.id} className="hover-elevate cursor-pointer" onClick={() => navigate(`/events/${event.id}`)} data-testid={`event-${event.id}`}>
                    <CardHeader>
                      <CardTitle className="text-lg">{event.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Calendar className="h-4 w-4" />
                          <span>{format(new Date(event.eventDate), 'PPP')}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <MapPin className="h-4 w-4" />
                          <span>{event.location}</span>
                        </div>
                        {event.ticketPrice > 0 && (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <PoundSterling className="h-4 w-4" />
                            <span>£{(event.ticketPrice / 100).toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
      <BottomNavigation />
    </div>
  );
}
