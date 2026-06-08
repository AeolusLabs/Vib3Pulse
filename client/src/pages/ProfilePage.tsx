import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { differenceInYears } from "date-fns";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProfileHeaderSkeleton, PostSkeleton } from "@/components/ui/skeleton-layouts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Card, CardContent } from "@/components/ui/card";
import { format } from "date-fns";
import type { User, Event, Rsvp, Post } from "@shared/schema";
import EditProfileDialog from "@/components/EditProfileDialog";
import FollowersFollowingDialog from "@/components/FollowersFollowingDialog";
import FeedPost from "@/components/FeedPost";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getBannerStyle } from "@/lib/bannerUtils";
import { CalendarIcon, MapPinIcon, PoundSterlingIcon, Building2Icon, MailIcon, UserPlusIcon, UserMinusIcon, CameraIcon, HeartIcon, Repeat2Icon, Loader2Icon, Trash2Icon, Link2Icon } from "@/components/ui/icons";
import { FileText, BadgeCheck, Cake } from "lucide-react";
import { useOrganizerRating } from "@/hooks/use-ratings";
import RatingDisplay from "@/components/RatingDisplay";

type ProfileResponse = Omit<User, "password"> & {
  events?: Event[];
  rsvps?: Array<Rsvp & { event: Event }>;
};

type PostWithUser = Post & {
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    isVerified?: boolean | null;
  };
};


export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("posts");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarViewOpen, setAvatarViewOpen] = useState(false);

  const { data: sessionUser, isLoading: sessionLoading } = useAuth();

  const {
    data: profile,
    isLoading: profileLoading,
    error,
  } = useQuery<ProfileResponse>({
    queryKey: [`/api/users/${username}`],
    queryFn: async () => {
      const res = await fetch(`/api/users/${username}`);
      if (!res.ok) {
        const err = new Error(res.status === 404 ? "not_found" : "fetch_failed");
        (err as any).status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!username,
  });

  const { data: followStats, isLoading: followStatsLoading } = useQuery<{
    followersCount: number;
    followingCount: number;
    isFollowing: boolean;
  }>({
    queryKey: [`/api/users/${profile?.id}/follow-stats`],
    queryFn: async () => {
      const res = await fetch(`/api/users/${profile?.id}/follow-stats`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch follow stats");
      return res.json();
    },
    enabled: !!profile?.id,
  });

  const { data: organizerRating } = useOrganizerRating(
    profile?.userType === "organizer" ? profile?.id : undefined
  );

  const { data: userPosts, isLoading: postsLoading } = useQuery<PostWithUser[]>({
    queryKey: ["/api/users", profile?.id, "posts"],
    queryFn: async () => {
      const res = await fetch(`/api/users/${profile?.id}/posts`);
      if (!res.ok) throw new Error("Failed to fetch posts");
      return res.json();
    },
    enabled: !!profile?.id && activeTab === "posts",
  });

  const { data: likedPosts, isLoading: likedLoading } = useQuery<PostWithUser[]>({
    queryKey: ["/api/users", profile?.id, "liked-posts"],
    queryFn: async () => {
      const res = await fetch(`/api/users/${profile?.id}/liked-posts`);
      if (!res.ok) throw new Error("Failed to fetch liked posts");
      return res.json();
    },
    enabled: !!profile?.id && activeTab === "likes",
  });

  const { data: repostedPosts, isLoading: repostsLoading } = useQuery<PostWithUser[]>({
    queryKey: ["/api/users", profile?.id, "reposted-posts"],
    queryFn: async () => {
      const res = await fetch(`/api/users/${profile?.id}/reposted-posts`);
      if (!res.ok) throw new Error("Failed to fetch reposted posts");
      return res.json();
    },
    enabled: !!profile?.id && activeTab === "reposts",
  });

  useEffect(() => {
    if (profile?.userType === "organizer") {
      setActiveTab("events");
    }
  }, [profile?.userType]);

  const followMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/users/${profile?.id}/follow`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/users/${profile?.id}/follow-stats`],
      });
      if (sessionUser?.id) {
        queryClient.invalidateQueries({
          queryKey: [`/api/users/${sessionUser.id}/follow-stats`],
        });
      }
      toast({
        title: "Following",
        description: `You're now following ${profile?.displayName || profile?.organizationName || profile?.username}`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to follow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const unfollowMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/users/${profile?.id}/unfollow`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/users/${profile?.id}/follow-stats`],
      });
      if (sessionUser?.id) {
        queryClient.invalidateQueries({
          queryKey: [`/api/users/${sessionUser.id}/follow-stats`],
        });
      }
      toast({
        title: "Unfollowed",
        description: `You unfollowed ${profile?.displayName || profile?.organizationName || profile?.username}`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to unfollow. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleDeleteAvatar = async () => {
    try {
      await apiRequest("DELETE", "/api/users/me/avatar");
      queryClient.invalidateQueries({ queryKey: [`/api/users/${username}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      toast({ title: "Removed", description: "Profile picture removed" });
    } catch {
      toast({
        title: "Error",
        description: "Failed to remove profile picture",
        variant: "destructive",
      });
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Error", description: "Please select an image file", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Error", description: "Image must be less than 5MB", variant: "destructive" });
      return;
    }

    setIsUploadingAvatar(true);
    try {
      const reader = new FileReader();
      const imageData = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      await apiRequest("POST", "/api/users/me/avatar", { imageData });
      queryClient.invalidateQueries({ queryKey: [`/api/users/${username}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      toast({ title: "Updated", description: "Profile picture updated" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to upload. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (profileLoading || sessionLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-[680px] mx-auto">
          <ProfileHeaderSkeleton />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (error || !profile) {
    const is404 = !error || (error as any)?.status === 404;
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-[680px] mx-auto px-4 py-16 text-center">
          {is404 ? (
            <>
              <p className="text-muted-foreground text-lg">This account doesn't exist</p>
              <p className="text-sm text-muted-foreground mt-1">Try searching for another.</p>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-lg">Couldn't load this profile</p>
              <p className="text-sm text-muted-foreground mt-1">Try refreshing the page.</p>
            </>
          )}
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const isSocialUser = profile.userType === "social";
  const isOrganizer = profile.userType === "organizer";
  const isOwnProfile = sessionUser?.id === profile.id;
  const displayName = isSocialUser
    ? profile.displayName || profile.username
    : profile.organizationName || profile.username;
  const avatarUrl = profile.avatarUrl || undefined;
  const avatarFallback = displayName.charAt(0).toUpperCase();

  const isFollowing = followStats?.isFollowing ?? false;

  function PostsList({
    posts,
    loading,
    emptyIcon: EmptyIcon,
    emptyText,
  }: {
    posts: PostWithUser[] | undefined;
    loading: boolean;
    emptyIcon: React.ElementType;
    emptyText: string;
  }) {
    if (loading) {
      return (
        <div className="divide-y divide-border">
          {[0, 1, 2].map((i) => <PostSkeleton key={i} index={i} />)}
        </div>
      );
    }
    if (!posts || posts.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
          <EmptyIcon className="h-12 w-12 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground font-medium">{emptyText}</p>
        </div>
      );
    }
    return (
      <div>
        {posts.map((post) => (
          <FeedPost
            key={post.id}
            id={post.id}
            author={{
              name: post.user.displayName || post.user.username,
              username: post.user.username,
              avatar: post.user.avatarUrl || undefined,
              userId: post.user.id,
              isVerified: post.user.isVerified ?? false,
            }}
            content={post.content}
            image={post.imageUrl || undefined}
            videoUrl={post.videoUrl || undefined}
            createdAt={post.createdAt}
            likes={0}
            comments={0}
            feedMode
          />
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-[680px] mx-auto border-x border-border min-h-screen">
        {/* Banner */}
        <div
          className="h-36 md:h-48 w-full relative overflow-hidden"
          style={{ background: getBannerStyle(profile) }}
        >
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage:
                "radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)",
              backgroundSize: "32px 32px",
            }}
          />
        </div>

        {/* Profile info */}
        <div className="px-4 pb-0">
          {/* Avatar row */}
          <div className="flex justify-between items-end -mt-14 md:-mt-16 mb-3">
            <div className="relative group">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleAvatarUpload}
                data-testid="input-avatar-upload"
              />

              {isOwnProfile ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="relative cursor-pointer rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      data-testid="button-avatar-menu"
                    >
                      <Avatar className="h-24 w-24 md:h-28 md:w-28 ring-4 ring-background shadow-lg">
                        <AvatarImage src={avatarUrl} alt={displayName} />
                        <AvatarFallback className="text-3xl bg-primary/15 text-primary font-semibold">
                          {avatarFallback}
                        </AvatarFallback>
                      </Avatar>
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        {isUploadingAvatar ? (
                          <Loader2Icon className="h-7 w-7 text-white animate-spin" />
                        ) : (
                          <CameraIcon className="h-7 w-7 text-white" />
                        )}
                      </div>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuItem
                      onClick={() => fileInputRef.current?.click()}
                      className="cursor-pointer"
                      data-testid="menu-change-photo"
                    >
                      <CameraIcon className="h-4 w-4 mr-2" />
                      Change photo
                    </DropdownMenuItem>
                    {profile.avatarUrl && (
                      <DropdownMenuItem
                        onClick={handleDeleteAvatar}
                        className="text-destructive focus:text-destructive cursor-pointer"
                        data-testid="menu-remove-photo"
                      >
                        <Trash2Icon className="h-4 w-4 mr-2" />
                        Remove photo
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <button
                  type="button"
                  onClick={() => avatarUrl && setAvatarViewOpen(true)}
                  className={cn(
                    "rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                    avatarUrl ? "cursor-pointer" : "cursor-default"
                  )}
                  data-testid="button-avatar-view"
                >
                  <Avatar className="h-24 w-24 md:h-28 md:w-28 ring-4 ring-background shadow-lg">
                    <AvatarImage src={avatarUrl} alt={displayName} />
                    <AvatarFallback className="text-3xl bg-primary/15 text-primary font-semibold">
                      {avatarFallback}
                    </AvatarFallback>
                  </Avatar>
                </button>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pb-1">
              {isOwnProfile ? (
                <div className="flex gap-2">
                  <EditProfileDialog user={profile as User} />
                </div>
              ) : sessionUser ? (
                isFollowing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => unfollowMutation.mutate()}
                    disabled={unfollowMutation.isPending || followStatsLoading}
                    className="rounded-full font-semibold px-5"
                    data-testid="button-unfollow"
                  >
                    <UserMinusIcon className="h-4 w-4 mr-1.5" />
                    {unfollowMutation.isPending ? "..." : "Following"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => followMutation.mutate()}
                    disabled={followMutation.isPending || followStatsLoading}
                    className="rounded-full font-semibold px-5"
                    data-testid="button-follow"
                  >
                    <UserPlusIcon className="h-4 w-4 mr-1.5" />
                    {followMutation.isPending ? "..." : "Follow"}
                  </Button>
                )
              ) : null}
            </div>
          </div>

          {/* Name + handle + badges */}
          <div className="mb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl md:text-2xl font-bold text-foreground leading-tight" data-testid="text-display-name">
                {displayName}
              </h1>
              {profile.isVerified && (
                <BadgeCheck className="h-5 w-5 text-blue-500 fill-blue-500 flex-shrink-0" data-testid="badge-verified" />
              )}
              {isOrganizer && (
                <Badge className="text-xs bg-primary/10 text-primary border border-primary/20 font-medium" data-testid="badge-organizer">
                  <Building2Icon className="h-3 w-3 mr-1" />
                  Organizer
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm" data-testid="text-username">
              @{profile.username}
            </p>
          </div>

          {/* Bio */}
          {profile.bio && (
            <p className="text-foreground text-[15px] leading-relaxed mb-3 whitespace-pre-wrap" data-testid="text-bio">
              {profile.bio}
            </p>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground mb-3">
            {isSocialUser && profile.dateOfBirth && (
              <span className="flex items-center gap-1">
                <Cake className="h-4 w-4" />
                {differenceInYears(new Date(), new Date(profile.dateOfBirth))} years old
              </span>
            )}
            {profile.location && (
              <span className="flex items-center gap-1" data-testid="text-location">
                <MapPinIcon className="h-4 w-4" />
                {profile.location}
              </span>
            )}
            {isOrganizer && profile.contactEmail && (
              <span className="flex items-center gap-1" data-testid="text-contact-email">
                <MailIcon className="h-4 w-4" />
                {profile.contactEmail}
              </span>
            )}
            {profile.socialMediaLinks && profile.socialMediaLinks.length > 0 && (
              <a
                href={profile.socialMediaLinks[0]}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
              >
                <Link2Icon className="h-4 w-4" />
                {profile.socialMediaLinks[0].replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>

          {/* Interests */}
          {isSocialUser && profile.interests && profile.interests.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3" data-testid="interests-section">
              {profile.interests.map((interest, i) => (
                <Badge
                  key={i}
                  variant="secondary"
                  className="text-xs bg-primary/10 text-primary border-0 font-medium"
                  data-testid={`badge-interest-${i}`}
                >
                  {interest}
                </Badge>
              ))}
            </div>
          )}

          {/* Follow stats */}
          {!followStatsLoading && followStats && (
            <div className="flex gap-5 text-sm mb-1" data-testid="follow-stats">
              <FollowersFollowingDialog
                userId={profile.id}
                username={profile.username}
                followersCount={followStats.followersCount}
                followingCount={followStats.followingCount}
                initialTab="following"
                trigger={
                  <button className="hover:underline cursor-pointer" data-testid="button-show-following">
                    <span className="font-bold text-foreground">{followStats.followingCount}</span>
                    <span className="text-muted-foreground ml-1">Following</span>
                  </button>
                }
              />
              <FollowersFollowingDialog
                userId={profile.id}
                username={profile.username}
                followersCount={followStats.followersCount}
                followingCount={followStats.followingCount}
                initialTab="followers"
                trigger={
                  <button className="hover:underline cursor-pointer" data-testid="button-show-followers">
                    <span className="font-bold text-foreground">{followStats.followersCount}</span>
                    <span className="text-muted-foreground ml-1">
                      {followStats.followersCount === 1 ? "Follower" : "Followers"}
                    </span>
                  </button>
                }
              />
            </div>
          )}

          {/* Organizer average rating */}
          {isOrganizer && organizerRating !== undefined && (
            <div className="flex items-center gap-2 text-sm mt-1" data-testid="organizer-rating">
              <RatingDisplay
                averageRating={organizerRating.averageRating}
                totalRatings={organizerRating.totalRatings}
              />
              {organizerRating.eventsRated > 0 && (
                <span className="text-muted-foreground text-xs">
                  from {organizerRating.eventsRated} {organizerRating.eventsRated === 1 ? "event" : "events"}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Tabs */}
        {isSocialUser ? (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full mt-2">
            <TabsList
              className="w-full grid grid-cols-3 rounded-none border-b border-border bg-transparent h-auto p-0"
              data-testid="profile-tabs"
            >
              {[
                { value: "posts", label: "Posts", icon: FileText },
                { value: "likes", label: "Likes", icon: HeartIcon },
                { value: "reposts", label: "Reposts", icon: Repeat2Icon },
              ].map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    "flex items-center gap-2 rounded-none border-b-2 border-transparent py-3 text-sm font-medium text-muted-foreground transition-colors",
                    "data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-transparent",
                    "hover:bg-muted/50 hover:text-foreground"
                  )}
                  data-testid={`tab-${value}`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="posts" className="mt-0" data-testid="content-posts">
              <PostsList
                posts={userPosts}
                loading={postsLoading}
                emptyIcon={FileText}
                emptyText="No posts yet"
              />
            </TabsContent>

            <TabsContent value="likes" className="mt-0" data-testid="content-likes">
              <PostsList
                posts={likedPosts}
                loading={likedLoading}
                emptyIcon={HeartIcon}
                emptyText="No liked posts yet"
              />
            </TabsContent>

            <TabsContent value="reposts" className="mt-0" data-testid="content-reposts">
              <PostsList
                posts={repostedPosts}
                loading={repostsLoading}
                emptyIcon={Repeat2Icon}
                emptyText="No reposts yet"
              />
            </TabsContent>
          </Tabs>
        ) : (
          /* Organizer profile tabs — same visual treatment as social user */
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full mt-2">
            <TabsList
              className="w-full grid grid-cols-2 rounded-none border-b border-border bg-transparent h-auto p-0"
              data-testid="profile-tabs"
            >
              {[
                { value: "events", label: "Events", icon: CalendarIcon },
                { value: "posts", label: "Posts", icon: FileText },
              ].map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    "flex items-center gap-2 rounded-none border-b-2 border-transparent py-3 text-sm font-medium text-muted-foreground transition-colors",
                    "data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-transparent",
                    "hover:bg-muted/50 hover:text-foreground"
                  )}
                  data-testid={`tab-${value}`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="events" className="mt-0" data-testid="content-events">
              {profile.events && profile.events.length > 0 ? (
                <div className="divide-y divide-border">
                  {profile.events.map((event) => (
                    <Link key={event.id} href={`/event/${event.id}`}>
                      <div
                        className="flex gap-4 p-4 hover:bg-muted/40 transition-colors cursor-pointer"
                        data-testid={`card-event-${event.id}`}
                      >
                        {event.imageUrl && (
                          <div className="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0 bg-muted">
                            <img
                              src={event.imageUrl}
                              alt={event.title}
                              className="w-full h-full object-cover"
                            />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-foreground line-clamp-1 mb-1" data-testid="text-event-title">
                            {event.title}
                          </p>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                            <CalendarIcon className="h-3.5 w-3.5" />
                            {format(new Date(event.eventDate), "MMM d, yyyy · h:mm a")}
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
                            <MapPinIcon className="h-3.5 w-3.5" />
                            <span className="line-clamp-1">{event.location}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {event.ticketPrice === 0 ? (
                              <Badge variant="secondary" className="text-xs h-5">FREE</Badge>
                            ) : (
                              <span className="flex items-center gap-0.5 text-xs text-primary font-semibold">
                                <PoundSterlingIcon className="h-3 w-3" />
                                {(event.ticketPrice / 100).toFixed(2)}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {event.ticketsAvailable} available
                            </span>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                  <CalendarIcon className="h-12 w-12 text-muted-foreground/40 mb-3" />
                  <p className="text-muted-foreground font-medium" data-testid="text-no-events">
                    No events created yet
                  </p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="posts" className="mt-0" data-testid="content-posts">
              <PostsList
                posts={userPosts}
                loading={postsLoading}
                emptyIcon={FileText}
                emptyText="No posts yet"
              />
            </TabsContent>
          </Tabs>
        )}
      </main>

      {/* Profile picture viewer */}
      <Dialog open={avatarViewOpen} onOpenChange={setAvatarViewOpen}>
        <DialogContent className="max-w-sm p-2 rounded-2xl border-0 bg-transparent shadow-2xl">
          {avatarUrl && (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-full aspect-square object-cover rounded-xl"
            />
          )}
        </DialogContent>
      </Dialog>

      <BottomNavigation />
    </div>
  );
}
