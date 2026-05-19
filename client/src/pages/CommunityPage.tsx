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
import type { Community, CommunityMembership, User, Event } from "@shared/schema";
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
} from "@/components/ui/icons";
import { format } from "date-fns";

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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [kickConfirmMember, setKickConfirmMember] = useState<MemberWithUser | null>(null);

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
    queryKey: [`/api/communities/${community?.id}/posts`],
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
    mutationFn: (data: { name: string; description: string }) =>
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

        {/* Cover image */}
        {community.coverImageUrl ? (
          <div className="h-36 md:h-48 rounded-xl overflow-hidden mb-4">
            <img
              src={community.coverImageUrl}
              alt={community.name}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          <div className="h-36 md:h-48 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 mb-4 flex items-center justify-center">
            <UsersIcon className="h-12 w-12 text-primary/30" />
          </div>
        )}

        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{community.name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {community.memberCount} {community.memberCount === 1 ? "member" : "members"} · by @{community.creator.username}
            </p>
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
          <p className="text-sm text-muted-foreground mb-4">{community.description}</p>
        )}

        {/* Tabs */}
        <Tabs defaultValue="posts">
          <TabsList className="w-full mb-4">
            <TabsTrigger value="posts" className="flex-1">Posts</TabsTrigger>
            <TabsTrigger value="members" className="flex-1">Members</TabsTrigger>
            <TabsTrigger value="events" className="flex-1">Events</TabsTrigger>
          </TabsList>

          {/* Posts tab */}
          <TabsContent value="posts">
            {postsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
              </div>
            ) : posts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground text-sm">No posts yet. Be the first to post in this community!</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {posts.map((post: any) => (
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
                    feedMode={true}
                  />
                ))}
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
              <Label>Description</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              onClick={() => updateMutation.mutate({ name: editName, description: editDescription })}
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

      <BottomNavigation />
    </div>
  );
}
