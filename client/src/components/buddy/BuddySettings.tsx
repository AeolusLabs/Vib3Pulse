import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { UserSearch } from "../UserSearch";
import { User } from "@shared/schema";
import { Shield, X } from "lucide-react";

export function BuddySettings() {
  const { toast } = useToast();
  const [showUserSearch, setShowUserSearch] = useState(false);

  const { data: buddy, isLoading: buddyLoading } = useQuery<{ buddy: User | null }>({
    queryKey: ["/api/buddy"],
  });

  const { data: distressMessageData } = useQuery<{ message: string }>({
    queryKey: ["/api/buddy/distress-message"],
  });

  const [distressMessage, setDistressMessage] = useState(distressMessageData?.message || "");

  const setBuddyMutation = useMutation({
    mutationFn: async (buddyId: string) => {
      return apiRequest("POST", "/api/buddy/set", { buddyId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/buddy"] });
      setShowUserSearch(false);
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
              <div>
                <p className="font-medium" data-testid="text-buddy-name">
                  {buddy.buddy.displayName || buddy.buddy.username}
                </p>
                <p className="text-sm text-muted-foreground" data-testid="text-buddy-username">
                  @{buddy.buddy.username}
                </p>
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
              {showUserSearch ? (
                <div className="space-y-2">
                  <UserSearch
                    onUserSelect={handleUserSelect}
                    filterUserType="social"
                    placeholder="Search for a friend to set as your buddy..."
                  />
                  <Button
                    variant="outline"
                    onClick={() => setShowUserSearch(false)}
                    data-testid="button-cancel-search"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => setShowUserSearch(true)}
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
