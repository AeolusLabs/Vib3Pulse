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
import { User } from "@shared/schema";
import { Shield, X, Search, Clock, CheckCircle, XCircle, Timer } from "lucide-react";

interface BuddyResponse {
  buddy: User | null;
  status: string | null;
}

interface BuddyRequest {
  id: string;
  requester: User;
  createdAt: string;
}

export function BuddySettings() {
  const { toast } = useToast();
  const [showFollowingList, setShowFollowingList] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [customMinutes, setCustomMinutes] = useState("");

  const { data: currentUser } = useAuth();

  const { data: buddyData, isLoading: buddyLoading } = useQuery<BuddyResponse>({
    queryKey: ["/api/buddy"],
  });

  const { data: buddyRequests } = useQuery<{ requests: BuddyRequest[] }>({
    queryKey: ["/api/buddy/requests"],
  });

  const { data: timerData, isLoading: timerLoading } = useQuery<{ timer: any }>({
    queryKey: ["/api/checkin-timer"],
    refetchInterval: 10000,
  });

  const currentUserId = currentUser?.id;
  const { data: followingList = [], isLoading: followingLoading, refetch: refetchFollowing } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: !!currentUserId,
    staleTime: 30000,
    refetchOnMount: true,
  });

  useEffect(() => {
    if (showFollowingList && currentUserId) {
      refetchFollowing();
    }
  }, [showFollowingList, currentUserId, refetchFollowing]);

  const { data: searchResults = [], isLoading: searchLoading } = useQuery<User[]>({
    queryKey: [`/api/users/search?q=${debouncedSearchQuery}`],
    enabled: debouncedSearchQuery.length >= 2,
  });

  const { data: distressMessageData } = useQuery<{ message: string }>({
    queryKey: ["/api/buddy/distress-message"],
  });

  const [distressMessage, setDistressMessage] = useState(distressMessageData?.message || "");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const setBuddyMutation = useMutation({
    mutationFn: async (buddyId: string) => {
      return apiRequest("POST", "/api/buddy/set", { buddyId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy"] });
      setShowFollowingList(false);
      setSearchQuery("");
      setDebouncedSearchQuery("");
      toast({
        title: "Request sent",
        description: "Your buddy request has been sent. They'll need to accept it.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to set buddy",
        variant: "destructive",
      });
    },
  });

  const removeBuddyMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", "/api/buddy", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy"] });
      toast({
        title: "Buddy removed",
        description: "Your emergency contact has been removed.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove buddy",
        variant: "destructive",
      });
    },
  });

  const respondMutation = useMutation({
    mutationFn: async ({ requesterId, accept }: { requesterId: string; accept: boolean }) => {
      return apiRequest("POST", "/api/buddy/respond", { requesterId, accept });
    },
    onSuccess: (_data: any, variables: { requesterId: string; accept: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy/requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/buddy"] });
      toast({
        title: variables.accept ? "Request accepted" : "Request declined",
        description: variables.accept
          ? "You are now their safety buddy."
          : "The buddy request has been declined.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to respond",
        variant: "destructive",
      });
    },
  });

  const setDistressMessageMutation = useMutation({
    mutationFn: async (message: string) => {
      return apiRequest("POST", "/api/buddy/distress-message", { message });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy/distress-message"] });
      toast({
        title: "Message saved",
        description: "Your distress message has been updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save message",
        variant: "destructive",
      });
    },
  });

  const createTimerMutation = useMutation({
    mutationFn: async (durationMinutes: number) => {
      return apiRequest("POST", "/api/checkin-timer", { durationMinutes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checkin-timer"] });
      toast({
        title: "Timer started",
        description: "Your check-in timer is now active. Remember to check in!",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to start timer",
        variant: "destructive",
      });
    },
  });

  const checkInMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/checkin-timer/checkin", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checkin-timer"] });
      toast({
        title: "Checked in",
        description: "You've marked yourself as safe. Timer cancelled.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to check in",
        variant: "destructive",
      });
    },
  });

  const cancelTimerMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", "/api/checkin-timer");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checkin-timer"] });
      toast({
        title: "Timer cancelled",
        description: "Your check-in timer has been cancelled.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to cancel timer",
        variant: "destructive",
      });
    },
  });

  const handleUserSelect = (user: User) => {
    setBuddyMutation.mutate(user.id);
  };

  const handleSaveMessage = () => {
    if (distressMessage.trim()) {
      setDistressMessageMutation.mutate(distressMessage);
    }
  };

  const handleStartTimer = (minutes: number) => {
    createTimerMutation.mutate(minutes);
  };

  const handleCustomTimer = () => {
    const mins = parseInt(customMinutes);
    if (isNaN(mins) || mins < 1 || mins > 1440) {
      toast({
        title: "Invalid duration",
        description: "Please enter a duration between 1 and 1440 minutes.",
        variant: "destructive",
      });
      return;
    }
    handleStartTimer(mins);
    setCustomMinutes("");
  };

  if (buddyLoading) {
    return <div data-testid="loading-buddy-settings">Loading...</div>;
  }

  const buddy = buddyData?.buddy;
  const buddyStatus = buddyData?.status;
  const hasAcceptedBuddy = buddy && buddyStatus === "accepted";
  const activeTimer = timerData?.timer;
  const pendingRequests = buddyRequests?.requests || [];

  return (
    <div className="space-y-4">
      {pendingRequests.length > 0 && (
        <Card data-testid="card-buddy-requests">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Buddy Requests
            </CardTitle>
            <CardDescription>
              People who want you as their safety buddy
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingRequests.map((request) => (
              <div
                key={request.id}
                className="flex items-center justify-between p-3 border rounded-md"
                data-testid={`buddy-request-${request.id}`}
              >
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarImage src="" alt={request.requester.displayName || request.requester.username} />
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {(request.requester.displayName || request.requester.username).charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{request.requester.displayName || request.requester.username}</p>
                    <p className="text-sm text-muted-foreground">@{request.requester.username}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => respondMutation.mutate({ requesterId: request.requester.id, accept: true })}
                    disabled={respondMutation.isPending}
                    data-testid={`button-accept-request-${request.id}`}
                  >
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Accept
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => respondMutation.mutate({ requesterId: request.requester.id, accept: false })}
                    disabled={respondMutation.isPending}
                    data-testid={`button-decline-request-${request.id}`}
                  >
                    <XCircle className="h-4 w-4 mr-1" />
                    Decline
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
            Set a trusted friend as your emergency contact. They'll be notified if you trigger a distress alert.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {buddy ? (
            <div className="flex items-center justify-between p-4 border rounded-md" data-testid="current-buddy">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src="" alt={buddy.displayName || buddy.username} />
                  <AvatarFallback className="bg-primary/10 text-primary">
                    {(buddy.displayName || buddy.username).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium" data-testid="text-buddy-name">
                      {buddy.displayName || buddy.username}
                    </p>
                    {buddyStatus === "pending" && (
                      <Badge variant="secondary" data-testid="badge-buddy-pending">
                        <Clock className="h-3 w-3 mr-1" />
                        Pending
                      </Badge>
                    )}
                    {buddyStatus === "accepted" && (
                      <Badge variant="default" data-testid="badge-buddy-accepted">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground" data-testid="text-buddy-username">
                    @{buddy.username}
                  </p>
                  {buddyStatus === "pending" && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Waiting for them to accept your request
                    </p>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeBuddyMutation.mutate()}
                disabled={removeBuddyMutation.isPending}
                data-testid="button-remove-buddy"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div>
              {showFollowingList ? (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder="Search for a user..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                      data-testid="input-search-buddy"
                    />
                  </div>

                  {debouncedSearchQuery.length >= 2 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-muted-foreground">Search Results</p>
                      {searchLoading ? (
                        <div className="space-y-2">
                          {[1, 2].map((i) => (
                            <Skeleton key={i} className="h-14 w-full" />
                          ))}
                        </div>
                      ) : searchResults.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-2">No users found</p>
                      ) : (
                        <ScrollArea className="h-[150px]">
                          <div className="space-y-2 pr-4">
                            {searchResults
                              .filter(user => user.id !== currentUser?.id)
                              .map((user) => (
                              <div
                                key={user.id}
                                className="flex items-center justify-between p-3 border rounded-md hover-elevate cursor-pointer"
                                onClick={() => handleUserSelect(user)}
                                data-testid={`search-result-${user.id}`}
                              >
                                <div className="flex items-center gap-3">
                                  <Avatar className="h-10 w-10">
                                    <AvatarImage src="" alt={user.displayName || user.username} />
                                    <AvatarFallback className="bg-primary/10 text-primary">
                                      {(user.displayName || user.username).charAt(0).toUpperCase()}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <p className="font-medium">
                                      {user.displayName || user.username}
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                      @{user.username}
                                    </p>
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={setBuddyMutation.isPending}
                                  data-testid={`button-select-search-${user.id}`}
                                >
                                  Select
                                </Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      )}
                      <Separator />
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">People You Follow</p>
                    {followingLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-14 w-full" />
                        ))}
                      </div>
                    ) : followingList.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">
                        You're not following anyone yet. Use the search above to find users.
                      </p>
                    ) : (
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-2 pr-4">
                          {followingList.map((user) => (
                            <div
                              key={user.id}
                              className="flex items-center justify-between p-3 border rounded-md hover-elevate cursor-pointer"
                              onClick={() => handleUserSelect(user)}
                              data-testid={`following-user-${user.id}`}
                            >
                              <div className="flex items-center gap-3">
                                <Avatar className="h-10 w-10">
                                  <AvatarImage src="" alt={user.displayName || user.username} />
                                  <AvatarFallback className="bg-primary/10 text-primary">
                                    {(user.displayName || user.username).charAt(0).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                                <div>
                                  <p className="font-medium">
                                    {user.displayName || user.username}
                                  </p>
                                  <p className="text-sm text-muted-foreground">
                                    @{user.username}
                                  </p>
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={setBuddyMutation.isPending}
                                data-testid={`button-select-buddy-${user.id}`}
                              >
                                Select
                              </Button>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                  
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowFollowingList(false);
                      setSearchQuery("");
                      setDebouncedSearchQuery("");
                    }}
                    data-testid="button-cancel-selection"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => setShowFollowingList(true)}
                  data-testid="button-set-buddy"
                >
                  Set Emergency Buddy
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {hasAcceptedBuddy && (
        <CheckInTimerCard
          activeTimer={activeTimer}
          timerLoading={timerLoading}
          onStartTimer={handleStartTimer}
          onCheckIn={() => checkInMutation.mutate()}
          onCancelTimer={() => cancelTimerMutation.mutate()}
          checkInPending={checkInMutation.isPending}
          cancelPending={cancelTimerMutation.isPending}
          createPending={createTimerMutation.isPending}
          customMinutes={customMinutes}
          onCustomMinutesChange={setCustomMinutes}
          onCustomTimerSubmit={handleCustomTimer}
        />
      )}

      <Card data-testid="card-distress-message">
        <CardHeader>
          <CardTitle>Distress Message</CardTitle>
          <CardDescription>
            This message will be sent to your buddy when you trigger an alert.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="distress-message">Message</Label>
            <Textarea
              id="distress-message"
              placeholder="I need help! Please check on me."
              value={distressMessage}
              onChange={(e) => setDistressMessage(e.target.value)}
              className="min-h-[100px]"
              data-testid="textarea-distress-message"
            />
          </div>
          <Button
            onClick={handleSaveMessage}
            disabled={!distressMessage.trim() || setDistressMessageMutation.isPending}
            data-testid="button-save-message"
          >
            Save Message
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function CheckInTimerCard({
  activeTimer,
  timerLoading,
  onStartTimer,
  onCheckIn,
  onCancelTimer,
  checkInPending,
  cancelPending,
  createPending,
  customMinutes,
  onCustomMinutesChange,
  onCustomTimerSubmit,
}: {
  activeTimer: any;
  timerLoading: boolean;
  onStartTimer: (minutes: number) => void;
  onCheckIn: () => void;
  onCancelTimer: () => void;
  checkInPending: boolean;
  cancelPending: boolean;
  createPending: boolean;
  customMinutes: string;
  onCustomMinutesChange: (val: string) => void;
  onCustomTimerSubmit: () => void;
}) {
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (!activeTimer) {
      setCountdown("");
      return;
    }
    const update = () => {
      const now = Date.now();
      const expires = new Date(activeTimer.expiresAt).getTime();
      const diff = expires - now;
      if (diff <= 0) {
        setCountdown("Expired");
        return;
      }
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      if (hours > 0) {
        setCountdown(`${hours}h ${mins}m ${secs}s`);
      } else if (mins > 0) {
        setCountdown(`${mins}m ${secs}s`);
      } else {
        setCountdown(`${secs}s`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeTimer]);

  return (
    <Card data-testid="card-checkin-timer">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="h-5 w-5" />
          Check-In Timer
        </CardTitle>
        <CardDescription>
          Set a timer. If you don't check in before it expires, your buddy will be alerted automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {timerLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : activeTimer ? (
          <div className="space-y-4">
            <div className="text-center p-6 border rounded-md bg-muted/30">
              <p className="text-sm text-muted-foreground mb-1">Time remaining</p>
              <p className="text-3xl font-bold font-mono" data-testid="text-countdown">
                {countdown}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={onCheckIn}
                disabled={checkInPending}
                data-testid="button-checkin"
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {checkInPending ? "Checking in..." : "I'm Safe"}
              </Button>
              <Button
                variant="outline"
                onClick={onCancelTimer}
                disabled={cancelPending}
                data-testid="button-cancel-timer"
              >
                {cancelPending ? "Cancelling..." : "Cancel Timer"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Quick presets:</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartTimer(30)}
                disabled={createPending}
                data-testid="button-timer-30"
              >
                30 min
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartTimer(60)}
                disabled={createPending}
                data-testid="button-timer-60"
              >
                1 hour
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartTimer(120)}
                disabled={createPending}
                data-testid="button-timer-120"
              >
                2 hours
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStartTimer(240)}
                disabled={createPending}
                data-testid="button-timer-240"
              >
                4 hours
              </Button>
            </div>
            <Separator />
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="custom-timer" className="text-sm">Custom (minutes)</Label>
                <Input
                  id="custom-timer"
                  type="number"
                  min="1"
                  max="1440"
                  placeholder="e.g. 90"
                  value={customMinutes}
                  onChange={(e) => onCustomMinutesChange(e.target.value)}
                  data-testid="input-custom-timer"
                />
              </div>
              <Button
                onClick={onCustomTimerSubmit}
                disabled={createPending || !customMinutes}
                data-testid="button-start-custom-timer"
              >
                Start
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
