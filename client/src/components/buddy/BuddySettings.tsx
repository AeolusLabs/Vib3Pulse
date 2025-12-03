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
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { User } from "@shared/schema";
import { Shield, X, UserCheck, Search } from "lucide-react";

export function BuddySettings() {
  const { toast } = useToast();
  const [showFollowingList, setShowFollowingList] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  const { data: currentUser } = useAuth();

  const { data: buddy, isLoading: buddyLoading } = useQuery<{ buddy: User | null }>({
    queryKey: ["/api/buddy"],
  });

  // Fetch user's following list using stable endpoint (requires auth)
  const currentUserId = currentUser?.id;
  const { data: followingList = [], isLoading: followingLoading, refetch: refetchFollowing } = useQuery<User[]>({
    queryKey: ['/api/follows/me/following'],
    enabled: !!currentUserId,
    staleTime: 30000,
    refetchOnMount: true,
  });

  // Refetch following list when panel is shown
  useEffect(() => {
    if (showFollowingList && currentUserId) {
      refetchFollowing();
    }
  }, [showFollowingList, currentUserId, refetchFollowing]);

  // Search for users
  const { data: searchResults = [], isLoading: searchLoading } = useQuery<User[]>({
    queryKey: [`/api/users/search?q=${debouncedSearchQuery}`],
    enabled: debouncedSearchQuery.length >= 2,
  });

  const { data: distressMessageData } = useQuery<{ message: string }>({
    queryKey: ["/api/buddy/distress-message"],
  });

  const [distressMessage, setDistressMessage] = useState(distressMessageData?.message || "");

  // Debounce search query
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
        title: "Buddy set!",
        description: "Your emergency contact has been updated.",
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

  const handleUserSelect = (user: User) => {
    setBuddyMutation.mutate(user.id);
  };

  const handleSaveMessage = () => {
    if (distressMessage.trim()) {
      setDistressMessageMutation.mutate(distressMessage);
    }
  };

  if (buddyLoading) {
    return <div data-testid="loading-buddy-settings">Loading...</div>;
  }

  return (
    <div className="space-y-4">
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
          {buddy?.buddy ? (
            <div className="flex items-center justify-between p-4 border rounded-md" data-testid="current-buddy">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src="" alt={buddy.buddy.displayName || buddy.buddy.username} />
                  <AvatarFallback className="bg-primary/10 text-primary">
                    {(buddy.buddy.displayName || buddy.buddy.username).charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium" data-testid="text-buddy-name">
                    {buddy.buddy.displayName || buddy.buddy.username}
                  </p>
                  <p className="text-sm text-muted-foreground" data-testid="text-buddy-username">
                    @{buddy.buddy.username}
                  </p>
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
                  {/* Search Bar */}
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

                  {/* Search Results */}
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

                  {/* Following List */}
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
