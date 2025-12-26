import { useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Users, CheckCircle, XCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";

export default function JoinGroupPage() {
  const { code } = useParams<{ code: string }>();
  const [, navigate] = useLocation();
  const { data: user, isLoading: authLoading } = useAuth();

  const joinGroupMutation = useMutation({
    mutationFn: async (inviteCode: string) => {
      const response = await apiRequest("POST", `/api/conversations/join/${inviteCode}`);
      if (!response.ok) {
        throw new Error("Invalid or expired invite code");
      }
      const data = await response.json();
      if (!data || !data.id) {
        throw new Error("Failed to join group");
      }
      return data;
    },
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      navigate(`/messages/${conversation.id}`);
    },
  });

  useEffect(() => {
    if (!authLoading && user && code && !joinGroupMutation.isPending && !joinGroupMutation.isSuccess && !joinGroupMutation.isError) {
      joinGroupMutation.mutate(code);
    }
  }, [authLoading, user, code]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <Users className="h-12 w-12 mx-auto text-primary mb-4" />
            <h2 className="text-xl font-semibold mb-2">Join Group</h2>
            <p className="text-muted-foreground mb-4">
              You need to be logged in to join this group.
            </p>
            <Button onClick={() => navigate("/auth")} data-testid="button-login">
              Log In to Continue
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (joinGroupMutation.isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary mb-4" />
            <h2 className="text-xl font-semibold mb-2">Joining Group...</h2>
            <p className="text-muted-foreground">
              Please wait while we add you to the group.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (joinGroupMutation.isError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
            <h2 className="text-xl font-semibold mb-2">Could Not Join Group</h2>
            <p className="text-muted-foreground mb-4">
              This invite link may be invalid or expired.
            </p>
            <Button onClick={() => navigate("/messages")} data-testid="button-go-messages">
              Go to Messages
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full">
        <CardContent className="p-6 text-center">
          <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
          <h2 className="text-xl font-semibold mb-2">Joined Successfully!</h2>
          <p className="text-muted-foreground mb-4">
            Redirecting you to the group chat...
          </p>
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}
