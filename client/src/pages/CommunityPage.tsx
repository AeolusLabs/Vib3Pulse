import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import FeedPost from "@/components/FeedPost";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Community, CommunityMembership, User, Event, CommunityType } from "@shared/schema";
import { communityTypes } from "@shared/schema";
import { CommunityTypeBadge } from "@/components/CommunityModal";
import {
  UsersIcon,
  CalendarIcon,
  MoreHorizontalIcon,
  ArrowLeftIcon,
  EditIcon,
  Trash2Icon,
  UserXIcon,
  CrownIcon,
  SettingsIcon,
  MapPinIcon,
  BellIcon,
  BellOffIcon,
  ShieldIcon,
} from "@/components/ui/icons";
import { Pin, PinOff, FlagOff } from "lucide-react";
import { format } from "date-fns";

const POST_TYPE_FILTERS = ["all", "text", "photo", "video", "event", "venue"] as const;

type CommunityWithDetails = Community & {
  memberCount: number;
  creator: User;
};

type MemberWithUser = CommunityMembership & { user: User };

export default function CommunityPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editType, setEditType] = useState<CommunityType>("general");
  const [editRules, setEditRules] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [kickConfirmMember, setKickConfirmMember] = useState<MemberWithUser | null>(null);
  const [postTypeFilter, setPostTypeFilter] = useState<typeof POST_TYPE_FILTERS[number]>("all");
  const [removeConfirmPost, setRemoveConfirmPost] = useState<any | null>(null);

  const {
    data: community,
    isLoading: communityLoading,
    error: communityError,
  } = useQuery<CommunityWithDetails>({
    queryKey: [`/api/communities/slug/${slug}`],
    enabled: !!slug,
  });

  const { data: membershipData } = useQuery<{ isMember: boolean; membership: CommunityMembership | null }>({
    queryKey: [`/api/communities/${community?.id}/membership`],
    enabled: !!community?.id && !!currentUser,
  });

  const { data: posts = [], isLoading: postsLoading } = useQuery<any[]>({
    queryKey: [`/api/communities/${community?.id}/posts`, postTypeFilter],
    queryFn: async () => {
      const res = await fetch(`/api/communities/${community!.id}/posts?type=${postTypeFilter}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load posts");
      return res.json();
    },
    enabled: !!community?.id,
  });

  const { data: members = [], isLoading: membersLoading } = useQuery<MemberWithUser[]>({
    queryKey: [`/api/communities/${community?.id}/members`],
    enabled: !!community?.id,
  });

  const { data: events = [], isLoading: eventsLoading } = useQuery<Event[]>({
    queryKey: [`/api/communities/${community?.id}/events`],
    enabled: !!community?.id,
  });

  const isMember = membershipData?.isMember ?? false;
  const myRole = membershipData?.membership?.role ?? null;
  const isOwner = myRole === "owner";
  const isMod = myRole === "moderator";
  const notificationsEnabled = membershipData?.membership?.notificationsEnabled ?? true;

  const joinMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/communities/${community!.id}/join`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/membership`] });
      queryClient.invalidateQueries({ queryKey: [`/api/communities/slug/${slug}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/members`] });
      toast({ title: `Joined ${community!.name}` });
    },
    onError: () => toast({ title: "Failed to join community", variant: "destructive" }),
  });

  const leaveMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/communities/${community!.id}/leave`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/membership`] });
      queryClient.invalidateQueries({ queryKey: [`/api/communities/slug/${slug}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/members`] });
      toast({ title: `Left ${community!.name}` });
    },
    onError: (err: any) => {
      const msg = err?.message || "Failed to leave community";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; description: string; type: string; rules: string }) =>
      apiRequest("PUT", `/api/communities/${community!.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/slug/${slug}`] });
      setEditOpen(false);
      toast({ title: "Community updated" });
    },
    onError: () => toast({ title: "Failed to update community", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/communities/${community!.id}`, {}),
    onSuccess: () => {
      toast({ title: "Community deleted" });
      navigate("/feed");
    },
    onError: () => toast({ title: "Failed to delete community", variant: "destructive" }),
  });

  const kickMutation = useMutation({
    mutationFn: (userId: string) =>
      apiRequest("DELETE", `/api/communities/${community!.id}/members/${userId}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/members`] });
      queryClient.invalidateQueries({ queryKey: [`/api/communities/slug/${slug}`] });
      setKickConfirmMember(null);
      toast({ title: "Member removed" });
    },
    onError: () => toast({ title: "Failed to remove member", variant: "destructive" }),
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      apiRequest("PATCH", `/api/communities/${community!.id}/members/${userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/members`] });
      toast({ title: "Role updated" });
    },
    onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
  });

  const pinPostMutation = useMutation({
    mutationFn: ({ postId, pin }: { postId: string; pin: boolean }) =>
      apiRequest(pin ? "POST" : "DELETE", `/api/communities/${community!.id}/posts/${postId}/pin`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/posts`] });
    },
    onError: () => toast({ title: "Failed to update pin", variant: "destructive" }),
  });

  const removePostMutation = useMutation({
    mutationFn: (postId: string) => apiRequest("DELETE", `/api/communities/${community!.id}/posts/${postId}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/posts`] });
      setRemoveConfirmPost(null);
      toast({ title: "Post removed" });
    },
    onError: () => toast({ title: "Failed to remove post", variant: "destructive" }),
  });

  const toggleNotificationsMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("PATCH", `/api/communities/${community!.id}/notifications`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/communities/${community!.id}/membership`] });
    },
    onError: () => toast({ title: "Failed to update notification preference", variant: "destructive" }),
  });

  function openEdit() {
    setEditName(community!.name);
    setEditDescription(community!.description ?? "");
    setEditType((community!.type as CommunityType) ?? "general");
    setEditRules(community!.rules ?? "");
    setEditOpen(true);
  }

  function roleBadge(role: string) {
    if (role === "owner") return <Badge variant="default" className="text-[10px] py-0 px-1.5 bg-amber-500 hover:bg-amber-500">Owner</Badge>;
    if (role === "moderator") return <Badge variant="secondary" className="text-[10px] py-0 px-1.5">Mod</Badge>;
    return null;
  }

  if (communityLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-24 w-full" />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (communityError || !community) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation onSearch={() => {}} />
        <main className="max-w-2xl mx-auto px-4 py-12 text-center">
          <p className="text-muted-foreground">Community not found.</p>
          <Button variant="ghost" className="mt-4" onClick={() => navigate("/feed")}>
            Back to Feed
          </Button>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation onSearch={() => {}} />

      <main className="max-w-2xl mx-auto px-4 py-4">
        {/* Back */}
        <button
          onClick={() => navigate("/feed")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Feed
        </button>

        {/* Hero — full-bleed within the page's own padding, gradient overlay,
            overlapping content card. Same structure as VenueDetailPage's hero. */}
        <div className="-mx-4 relative h-44 md:h-56 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/10 to-transparent z-10" />
          {community.coverImageUrl ? (
            <img src={community.coverImageUrl} alt={community.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-primary/25 via-primary/10 to-transparent flex items-center justify-center">
              <UsersIcon className="h-14 w-14 text-primary/30" />
            </div>
          )}
        </div>

        <div className="relative z-20 -mt-10 mb-4">
          {/* Type badge */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <CommunityTypeBadge type={community.type} />
          </div>

          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold truncate">{community.name}</h1>
              <div className="flex items-center gap-2 mt-1.5">
                {members.length > 0 && (
                  <div className="flex -space-x-2">
                    {members.slice(0, 5).map((m) => (
                      <Avatar key={m.id} className="h-6 w-6 border-2 border-background">
                        <AvatarImage src={m.user.avatarUrl ?? undefined} />
                        <AvatarFallback className="text-[9px]">
                          {(m.user.displayName || m.user.username).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                  </div>
                )}
                <p className="text-sm text-muted-foreground">
                  {community.memberCount.toLocaleString()} {community.memberCount === 1 ? "member" : "members"} · {posts.length} posts · by @{community.creator.username}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0 mt-1">
              {currentUser && isMember && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={notificationsEnabled ? "Mute community notifications" : "Unmute community notifications"}
                  onClick={() => toggleNotificationsMutation.mutate(!notificationsEnabled)}
                  disabled={toggleNotificationsMutation.isPending}
                >
                  {notificationsEnabled
                    ? <BellIcon className="h-4 w-4" />
                    : <BellOffIcon className="h-4 w-4 text-muted-foreground" />
                  }
                </Button>
              )}
              {currentUser && (
                isMember ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => leaveMutation.mutate()}
                    disabled={leaveMutation.isPending || isOwner}
                    title={isOwner ? "Transfer ownership before leaving" : undefined}
                  >
                    {leaveMutation.isPending ? "Leaving..." : "Leave"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => joinMutation.mutate()}
                    disabled={joinMutation.isPending}
                  >
                    {joinMutation.isPending ? "Joining..." : "Join"}
                  </Button>
                )
              )}

              {isOwner && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <SettingsIcon className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={openEdit}>
                      <EditIcon className="h-4 w-4 mr-2" />
                      Edit community
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteConfirmOpen(true)}
                    >
                      <Trash2Icon className="h-4 w-4 mr-2" />
                      Delete community
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Description */}
          {community.description && (
            <p className="text-sm text-muted-foreground mt-2">{community.description}</p>
          )}

          {/* Rules */}
          {community.rules && (
            <Card className="mt-3 bg-muted/30">
              <CardContent className="p-3">
                <p className="text-xs font-semibold flex items-center gap-1.5 mb-1">
                  <ShieldIcon className="h-3.5 w-3.5" />
                  Community Rules
                </p>
                <p className="text-sm text-muted-foreground whitespace-pre-line">{community.rules}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Tabs */}
        <Tabs defaultValue="posts">
          <TabsList className="w-full mb-4">
            <TabsTrigger value="posts" className="flex-1">Posts</TabsTrigger>
            <TabsTrigger value="members" className="flex-1">Members</TabsTrigger>
            <TabsTrigger value="events" className="flex-1">Events</TabsTrigger>
          </TabsList>

          {/* Posts tab */}
          <TabsContent value="posts">
            {/* Post-type filter */}
            <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
              {POST_TYPE_FILTERS.map((t) => (
                <button
                  key={t}
                  onClick={() => setPostTypeFilter(t)}
                  className={`px-3 h-8 rounded-full text-xs font-medium capitalize whitespace-nowrap flex-shrink-0 transition-colors ${
                    postTypeFilter === t
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                  data-testid={`button-filter-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {postsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
              </div>
            ) : posts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground text-sm">
                  {postTypeFilter === "all" ? "No posts yet. Be the first to post in this community!" : `No ${postTypeFilter} posts yet.`}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {posts.map((post: any) => {
                  const canModerate = isOwner || isMod;
                  return (
                    <div
                      key={post.id}
                      className={post.isPinned ? "rounded-xl bg-primary/5 border border-primary/20 overflow-hidden" : "border-b border-border last:border-b-0"}
                    >
                      {post.isPinned && (
                        <div className="flex items-center gap-1.5 px-4 pt-2.5 text-[11px] font-medium text-primary">
                          <Pin className="h-3 w-3" />Pinned
                        </div>
                      )}
                      <div className="relative">
                        <FeedPost
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
                          updatedAt={post.updatedAt}
                          likes={0}
                          comments={0}
                          isLiked={false}
                          image={post.imageUrl}
                          imageUrls={post.imageUrls || []}
                          videoUrl={post.videoUrl}
                          eventId={post.eventId}
                          venueId={post.venueId}
                          community={post.community}
                          feedMode={true}
                        />
                        {canModerate && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 absolute top-2 right-2 bg-background/80 backdrop-blur-sm" data-testid={`button-mod-post-${post.id}`}>
                                <MoreHorizontalIcon className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => pinPostMutation.mutate({ postId: post.id, pin: !post.isPinned })}>
                                {post.isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
                                {post.isPinned ? "Unpin post" : "Pin post"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => setRemoveConfirmPost(post)}>
                                <Trash2Icon className="h-4 w-4 mr-2" />
                                Remove post
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Members tab */}
          <TabsContent value="members">
            {membersLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
              </div>
            ) : members.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground text-sm">No members yet.</p>
              </div>
            ) : (
              <div className="space-y-1">
                {members.map((member) => {
                  const canManage = isOwner || (isMod && member.role === "member");
                  const isSelf = member.userId === currentUser?.id;
                  return (
                    <div key={member.id} className="flex items-center gap-3 py-2 px-1">
                      <Link href={`/profile/${member.user.username}`}>
                        <Avatar className="h-9 w-9 cursor-pointer">
                          <AvatarImage src={member.user.avatarUrl ?? undefined} />
                          <AvatarFallback>
                            {(member.user.displayName || member.user.username).charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </Link>
                      <div className="flex-1 min-w-0">
                        <Link href={`/profile/${member.user.username}`} className="hover:underline">
                          <span className="text-sm font-medium truncate block">
                            {member.user.displayName || member.user.username}
                          </span>
                        </Link>
                        <span className="text-xs text-muted-foreground">@{member.user.username}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {roleBadge(member.role)}
                        {canManage && !isSelf && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreHorizontalIcon className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {isOwner && member.role === "member" && (
                                <DropdownMenuItem
                                  onClick={() => changeRoleMutation.mutate({ userId: member.userId, role: "moderator" })}
                                >
                                  <CrownIcon className="h-4 w-4 mr-2" />
                                  Make moderator
                                </DropdownMenuItem>
                              )}
                              {isOwner && member.role === "moderator" && (
                                <DropdownMenuItem
                                  onClick={() => changeRoleMutation.mutate({ userId: member.userId, role: "member" })}
                                >
                                  Demote to member
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setKickConfirmMember(member)}
                              >
                                <UserXIcon className="h-4 w-4 mr-2" />
                                Remove from community
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Events tab */}
          <TabsContent value="events">
            {eventsLoading ? (
              <div className="space-y-3">
                {[1, 2].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground text-sm">No events linked to this community yet.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {events.map((event) => (
                  <Card
                    key={event.id}
                    className="cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => navigate(`/event/${event.id}`)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        {event.imageUrl && (
                          <img
                            src={event.imageUrl}
                            alt={event.title}
                            className="h-14 w-14 rounded-lg object-cover flex-shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm leading-tight">{event.title}</p>
                          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                            <CalendarIcon className="h-3.5 w-3.5" />
                            <span>{format(new Date(event.eventDate), "d MMM yyyy")}</span>
                          </div>
                          {event.location && (
                            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                              <MapPinIcon className="h-3.5 w-3.5" />
                              <span className="truncate">{event.location}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Edit community dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit community</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <select
                className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm capitalize"
                value={editType}
                onChange={(e) => setEditType(e.target.value as CommunityType)}
                data-testid="select-edit-community-type"
              >
                {communityTypes.map((t) => (
                  <option key={t} value={t} className="capitalize">{t}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Rules</Label>
              <Textarea
                value={editRules}
                onChange={(e) => setEditRules(e.target.value)}
                rows={3}
                placeholder="Set expectations for members..."
                data-testid="input-edit-community-rules"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              onClick={() => updateMutation.mutate({ name: editName, description: editDescription, type: editType, rules: editRules })}
              disabled={updateMutation.isPending || !editName.trim()}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete community confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete community?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{community.name}" and remove all members. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Kick member confirmation */}
      <AlertDialog open={!!kickConfirmMember} onOpenChange={(open) => { if (!open) setKickConfirmMember(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove @{kickConfirmMember?.user.username} from this community?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => kickConfirmMember && kickMutation.mutate(kickConfirmMember.userId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove post confirmation */}
      <AlertDialog open={!!removeConfirmPost} onOpenChange={(open) => { if (!open) setRemoveConfirmPost(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the post from {community.name}. The author keeps it on their own profile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeConfirmPost && removePostMutation.mutate(removeConfirmPost.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removePostMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BottomNavigation />
    </div>
  );
}
