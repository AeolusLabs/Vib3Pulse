import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Lock, User, AlertCircle, Loader2, CheckCircle, Bell, BellOff } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { Switch } from "@/components/ui/switch";
import type { User as UserType } from "@shared/schema";

export default function AccountSettingsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const push = usePushNotifications();
  const { data: sessionUser, isLoading: sessionLoading } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");

  const { data: userProfile } = useQuery<UserType>({
    queryKey: ["/api/users/me"],
    queryFn: async () => {
      const response = await fetch("/api/users/me", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch user profile");
      return response.json();
    },
    enabled: !!sessionUser,
  });

  const changePasswordMutation = useMutation({
    mutationFn: async (data: { currentPassword: string; newPassword: string }) => {
      const response = await apiRequest("PATCH", "/api/auth/change-password", data);
      return response;
    },
    onSuccess: () => {
      toast({
        title: "Password Changed",
        description: "Your password has been updated successfully.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to change password",
        variant: "destructive",
      });
    },
  });

  const changeUsernameMutation = useMutation({
    mutationFn: async (data: { newUsername: string }) => {
      const response = await apiRequest("PATCH", "/api/users/me/username", data);
      return response;
    },
    onSuccess: (data: any) => {
      toast({
        title: "Username Changed",
        description: `Your username has been updated to @${data.user?.username || newUsername}`,
      });
      setNewUsername("");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users/me"] });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to change username",
        variant: "destructive",
      });
    },
  });

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({
        title: "Error",
        description: "New passwords do not match",
        variant: "destructive",
      });
      return;
    }
    if (newPassword.length < 8) {
      toast({
        title: "Error",
        description: "Password must be at least 8 characters",
        variant: "destructive",
      });
      return;
    }
    changePasswordMutation.mutate({ currentPassword, newPassword });
  };

  const handleChangeUsername = (e: React.FormEvent) => {
    e.preventDefault();
    if (newUsername.length < 3) {
      toast({
        title: "Error",
        description: "Username must be at least 3 characters",
        variant: "destructive",
      });
      return;
    }
    changeUsernameMutation.mutate({ newUsername });
  };

  if (sessionLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!sessionUser) {
    navigate("/login");
    return null;
  }

  const usernameChangesRemaining = userProfile?.usernameChangesRemaining ?? 2;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      
      <main className="container mx-auto px-4 py-6 max-w-2xl">
        <h1 className="text-2xl font-bold mb-6">Account Settings</h1>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="h-5 w-5" />
                Change Password
              </CardTitle>
              <CardDescription>
                Update your password to keep your account secure
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current-password">Current Password</Label>
                  <Input
                    id="current-password"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter your current password"
                    data-testid="input-current-password"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">New Password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter your new password"
                    data-testid="input-new-password"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm New Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your new password"
                    data-testid="input-confirm-password"
                    required
                  />
                </div>
                <Button 
                  type="submit" 
                  disabled={changePasswordMutation.isPending}
                  data-testid="button-change-password"
                >
                  {changePasswordMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Changing...
                    </>
                  ) : (
                    "Change Password"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Change Username
              </CardTitle>
              <CardDescription className="flex items-center gap-2 flex-wrap">
                <span>Your current username is</span>
                <Badge variant="secondary">@{sessionUser.username}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4 p-3 bg-muted rounded-lg flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div className="text-sm text-muted-foreground">
                  <p>You can only change your username <strong>{usernameChangesRemaining}</strong> more time{usernameChangesRemaining !== 1 ? 's' : ''}.</p>
                  <p className="mt-1">Choose wisely as this limit cannot be reset.</p>
                </div>
              </div>

              {usernameChangesRemaining > 0 ? (
                <form onSubmit={handleChangeUsername} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="new-username">New Username</Label>
                    <Input
                      id="new-username"
                      type="text"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="Enter your new username"
                      data-testid="input-new-username"
                      required
                    />
                  </div>
                  <Button 
                    type="submit" 
                    disabled={changeUsernameMutation.isPending}
                    data-testid="button-change-username"
                  >
                    {changeUsernameMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Changing...
                      </>
                    ) : (
                      "Change Username"
                    )}
                  </Button>
                </form>
              ) : (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  <p className="text-sm text-destructive">You have used all your username changes.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Push Notifications
              </CardTitle>
              <CardDescription>
                Get notified about messages, likes, and activity even when VibePulse isn't open.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!push.isSupported ? (
                <div className="flex items-start gap-3 p-4 bg-muted rounded-lg">
                  <BellOff className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Not supported on this browser</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Push notifications require a modern browser with HTTPS. Try Chrome, Edge, or Firefox on a secure connection.
                    </p>
                  </div>
                </div>
              ) : push.permission === "denied" ? (
                <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <BellOff className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-destructive">Notifications blocked</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      You've blocked notifications for this site. To enable them, update your browser's site settings and reload the page.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Enable push notifications</p>
                    <p className="text-sm text-muted-foreground">
                      {push.isSubscribed ? "You'll receive notifications on this device." : "Turn on to receive notifications on this device."}
                    </p>
                  </div>
                  <Switch
                    checked={push.isSubscribed}
                    disabled={push.isLoading}
                    onCheckedChange={async (checked) => {
                      if (checked) {
                        const ok = await push.subscribe();
                        if (!ok) {
                          toast({ title: "Could not enable notifications", description: "Please check your browser permissions.", variant: "destructive" });
                        } else {
                          toast({ title: "Notifications enabled" });
                        }
                      } else {
                        await push.unsubscribe();
                        toast({ title: "Notifications disabled" });
                      }
                    }}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <BottomNavigation />
    </div>
  );
}
