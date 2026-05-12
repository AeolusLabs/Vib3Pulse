import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { CheckInTimer } from "./CheckInTimer";
import type { User } from "@shared/schema";
import { Shield, X, Search, Clock, CheckCircle, XCircle } from "lucide-react";

interface BuddyResponse { buddy: User | null; status: string | null; }
interface BuddyRequest { id: string; requester: User; requestedAt: string; }

export function BuddySettings() {
  const { toast } = useToast();
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [distressMessage, setDistressMessage] = useState("");
  const { data: currentUser } = useAuth();

  const { data: buddyData, isLoading: buddyLoading } = useQuery<BuddyResponse>({
    queryKey: ["/api/safety/buddy"],
  });

  const { data: requestsData } = useQuery<{ requests: BuddyRequest[] }>({
    queryKey: ["/api/safety/buddy/requests"],
  });

  const { data: distressMsgData } = useQuery<{ message: string | null }>({
    queryKey: ["/api/safety/distress-message"],
    select: (d) => d,
  });

  useEffect(() => {
    if (distressMsgData?.message) setDistressMessage(distressMsgData.message);
  }, [distressMsgData]);

  const { data: followingList = [], isLoading: followingLoading, refetch: refetchFollowing } = useQuery<User[]>({
    queryKey: ["/api/follows/me/following"],
    enabled: !!currentUser?.id,
    staleTime: 30_000,
  });

  const { data: searchResults = [], isLoading: searchLoading } = useQuery<User[]>({
    queryKey: [`/api/users/search?q=${debouncedSearch}`],
    enabled: debouncedSearch.length >= 2,
  });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    if (showPicker && currentUser?.id) refetchFollowing();
  }, [showPicker]);

  const setBuddyMutation = useMutation({
    mutationFn: (buddyId: string) => apiRequest("POST", "/api/safety/buddy", { buddyId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy"] });
      setShowPicker(false);
      setSearchQuery("");
      setDebouncedSearch("");
      toast({ title: "Request sent", description: "Waiting for them to accept." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeBuddyMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/safety/buddy"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy"] });
      toast({ title: "Buddy removed" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const respondMutation = useMutation({
    mutationFn: ({ requesterId, accept }: { requesterId: string; accept: boolean }) =>
      apiRequest("POST", "/api/safety/buddy/respond", { requesterId, accept }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy/requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/safety/buddy"] });
      toast({ title: vars.accept ? "Request accepted — you're their buddy" : "Request declined" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveMessageMutation = useMutation({
    mutationFn: (message: string) => apiRequest("POST", "/api/safety/distress-message", { message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety/distress-message"] });
      toast({ title: "Message saved" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (buddyLoading) return <div>Loading…</div>;

  const buddy = buddyData?.buddy;
  const buddyStatus = buddyData?.status;
  const hasAcceptedBuddy = buddy && buddyStatus === "accepted";
  const pendingRequests = requestsData?.requests ?? [];

  const initials = (u: User) =>
    ((u.displayName || u.username) ?? "?").charAt(0).toUpperCase();

  const UserRow = ({ user, onSelect }: { user: User; onSelect: (u: User) => void }) => (
    <div
      className="flex items-center justify-between p-3 border rounded-md hover:bg-muted/40 cursor-pointer"
      onClick={() => onSelect(user)}
    >
      <div className="flex items-center gap-3">
        <Avatar className="h-9 w-9">
          <AvatarImage src={user.avatarUrl ?? ""} alt={user.username} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm">{initials(user)}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium text-sm">{user.displayName || user.username}</p>
          <p className="text-xs text-muted-foreground">@{user.username}</p>
        </div>
      </div>
      <Button variant="ghost" size="sm" disabled={setBuddyMutation.isPending}>Select</Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {pendingRequests.length > 0 && (
        <Card data-testid="card-buddy-requests">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4 text-primary" />
              Buddy Requests
            </CardTitle>
            <CardDescription>People who want you as their safety buddy</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingRequests.map((req) => (
              <div key={req.id} className="flex items-center justify-between p-3 border rounded-md">
                <div className="flex items-center gap-3">
                  <Avatar className="h-9 w-9">
                    <AvatarImage src={req.requester.avatarUrl ?? ""} />
                    <AvatarFallback className="bg-primary/10 text-primary text-sm">{initials(req.requester)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-sm">{req.requester.displayName || req.requester.username}</p>
                    <p className="text-xs text-muted-foreground">@{req.requester.username}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => respondMutation.mutate({ requesterId: req.requester.id, accept: true })} disabled={respondMutation.isPending}>
                    <CheckCircle className="h-3.5 w-3.5 mr-1" />Accept
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => respondMutation.mutate({ requesterId: req.requester.id, accept: false })} disabled={respondMutation.isPending}>
                    <XCircle className="h-3.5 w-3.5 mr-1" />Decline
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-buddy-settings">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Safety Buddy
          </CardTitle>
          <CardDescription>
            Your buddy receives your SOS alerts and timer-expiry notifications.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {buddy ? (
            <div className="flex items-center justify-between p-4 border rounded-md">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={buddy.avatarUrl ?? ""} />
                  <AvatarFallback className="bg-primary/10 text-primary">{initials(buddy)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium">{buddy.displayName || buddy.username}</p>
                    {buddyStatus === "pending" && (
                      <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
                    )}
                    {buddyStatus === "accepted" && (
                      <Badge variant="default"><CheckCircle className="h-3 w-3 mr-1" />Active</Badge>
                    )}
                    {buddyStatus === "declined" && (
                      <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Declined</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">@{buddy.username}</p>
                  {buddyStatus === "pending" && (
                    <p className="text-xs text-muted-foreground mt-0.5">Waiting for them to accept</p>
                  )}
                  {buddyStatus === "declined" && (
                    <p className="text-xs text-muted-foreground mt-0.5">They declined — remove and try someone else</p>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => removeBuddyMutation.mutate()} disabled={removeBuddyMutation.isPending}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : showPicker ? (
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search by username…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  autoFocus
                />
              </div>

              {debouncedSearch.length >= 2 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Search results</p>
                  {searchLoading ? (
                    <Skeleton className="h-14 w-full" />
                  ) : searchResults.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">No users found</p>
                  ) : (
                    <ScrollArea className="h-40">
                      <div className="space-y-2 pr-2">
                        {searchResults
                          .filter((u) => u.id !== currentUser?.id)
                          .map((u) => <UserRow key={u.id} user={u} onSelect={(u) => setBuddyMutation.mutate(u.id)} />)}
                      </div>
                    </ScrollArea>
                  )}
                  <Separator />
                </div>
              )}

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">People you follow</p>
                {followingLoading ? (
                  <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
                ) : followingList.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">You're not following anyone yet.</p>
                ) : (
                  <ScrollArea className="h-48">
                    <div className="space-y-2 pr-2">
                      {followingList.map((u) => <UserRow key={u.id} user={u} onSelect={(u) => setBuddyMutation.mutate(u.id)} />)}
                    </div>
                  </ScrollArea>
                )}
              </div>

              <Button variant="outline" onClick={() => { setShowPicker(false); setSearchQuery(""); setDebouncedSearch(""); }}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => setShowPicker(true)} data-testid="button-set-buddy">
              <Shield className="h-4 w-4 mr-2" />
              Set Emergency Buddy
            </Button>
          )}
        </CardContent>
      </Card>

      {hasAcceptedBuddy && <CheckInTimer />}

      <Card data-testid="card-distress-message">
        <CardHeader>
          <CardTitle className="text-base">Distress Message</CardTitle>
          <CardDescription>
            Sent to your buddy with every SOS alert. Default: "I need help! Please check on me."
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="distress-message">Your message</Label>
            <Textarea
              id="distress-message"
              placeholder="I need help! Please check on me."
              value={distressMessage}
              onChange={(e) => setDistressMessage(e.target.value)}
              maxLength={500}
              className="min-h-[80px]"
            />
            <p className="text-xs text-muted-foreground text-right">{distressMessage.length}/500</p>
          </div>
          <Button
            onClick={() => saveMessageMutation.mutate(distressMessage)}
            disabled={!distressMessage.trim() || saveMessageMutation.isPending}
          >
            Save Message
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
