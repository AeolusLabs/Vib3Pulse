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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { useAuth } from "@/hooks/useAuth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { Switch } from "@/components/ui/switch";
import type { User as UserType } from "@shared/schema";
import { LockIcon, UserIcon, AlertCircleIcon, Loader2Icon, CheckCircleIcon, BellIcon, BellOffIcon, CheckCheckIcon, Trash2Icon } from "@/components/ui/icons";

export default function AccountSettingsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const push = usePushNotifications();
  const { data: sessionUser, isLoading: sessionLoading } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data: userProfile } = useQuery<UserType>({
    queryKey: ["/api/users/me"],
    queryFn: async () => {
      const response = await fetch("/api/users/me", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch user profile");
      return response.json();
    },
    enabled: !!sessionUser,
  });

  const readReceiptsMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return await apiRequest("PATCH", "/api/users/me", { readReceiptsEnabled: enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/me"] });
    },
    onError: () => {
      toast({ title: "Couldn't update setting", variant: "destructive" });
    },
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
      return response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Username Changed",
        description: `Your username has been updated to @${data.user?.username || newUsername}`,
      });
      setNewUsername("");
      // setQueryData, not invalidateQueries: an invalidated query refetches
      // immediately, and that refetch can beat the server's session-cookie
      // update to the browser. Hydrating the cache directly from the
      // mutation's own response (which reflects the now-current session)
      // avoids that race entirely. See feedback_auth_pattern.md.
      if (data.user) queryClient.setQueryData(["/api/auth/session"], data.user);
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

  const deleteAccountMutation = useMutation({
    mutationFn: async (data: { confirmation: string; password?: string }) => {
      const response = await apiRequest("POST", "/api/auth/delete-account", data);
      return response;
    },
    onSuccess: async () => {
      toast({ title: "Account deleted", description: "Sorry to see you go." });
      queryClient.clear();
      navigate("/");
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't delete account",
        description: error.message || "Please try again.",
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
        <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
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
                <LockIcon className="h-5 w-5" />
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
                      <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
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
                <UserIcon className="h-5 w-5" />
                Change Username
              </CardTitle>
              <CardDescription className="flex items-center gap-2 flex-wrap">
                <span>Your current username is</span>
                <Badge variant="secondary">@{sessionUser.username}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4 p-3 bg-muted rounded-lg flex items-start gap-2">
                <AlertCircleIcon className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
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
                        <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
                        Changing...
                      </>
                    ) : (
                      "Change Username"
                    )}
                  </Button>
                </form>
              ) : (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2">
                  <AlertCircleIcon className="h-5 w-5 text-destructive" />
                  <p className="text-sm text-destructive">You have used all your username changes.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BellIcon className="h-5 w-5" />
                Push Notifications
              </CardTitle>
              <CardDescription>
                Get notified about messages, likes, and activity even when Vib3Pulse isn't open.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!push.isSupported ? (
                <div className="flex items-start gap-3 p-4 bg-muted rounded-lg">
                  <BellOffIcon className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Not supported on this browser</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Push notifications require a modern browser with HTTPS. Try Chrome, Edge, or Firefox on a secure connection.
                    </p>
                  </div>
                </div>
              ) : push.permission === "denied" ? (
                <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <BellOffIcon className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
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

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCheckIcon className="h-5 w-5" />
                Privacy
              </CardTitle>
              <CardDescription>
                Control what other people can see about your activity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">Read receipts</p>
                  <p className="text-sm text-muted-foreground">
                    Let people you message see when you've read their messages. Turning this off also hides theirs from you.
                  </p>
                </div>
                <Switch
                  checked={userProfile?.readReceiptsEnabled ?? true}
                  disabled={readReceiptsMutation.isPending}
                  onCheckedChange={(checked) => readReceiptsMutation.mutate(checked)}
                  data-testid="switch-read-receipts"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <Trash2Icon className="h-5 w-5" />
                Delete Account
              </CardTitle>
              <CardDescription>
                Permanently delete your account. This cannot be undone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4 p-3 bg-muted rounded-lg flex items-start gap-2">
                <AlertCircleIcon className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-sm text-muted-foreground">
                  Your profile, email, and login details are removed and can't be recovered.
                  Posts, comments, and tickets tied to your account stay visible to others (attributed
                  to "Deleted user") so their history isn't affected.
                  {sessionUser.userType === "organizer" && (
                    <> You'll need to cancel or reassign any upcoming events first.</>
                  )}
                </p>
              </div>

              <AlertDialog onOpenChange={(open) => { if (!open) { setDeletePassword(""); setDeleteConfirmText(""); } }}>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" data-testid="button-delete-account">
                    Delete My Account
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently deletes your account. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-4 py-2">
                    {sessionUser.hasPassword && (
                      <div className="space-y-2">
                        <Label htmlFor="delete-password">Enter your password</Label>
                        <Input
                          id="delete-password"
                          type="password"
                          value={deletePassword}
                          onChange={(e) => setDeletePassword(e.target.value)}
                          data-testid="input-delete-password"
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="delete-confirm">Type <strong>DELETE</strong> to confirm</Label>
                      <Input
                        id="delete-confirm"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder="DELETE"
                        data-testid="input-delete-confirm"
                      />
                    </div>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={deleteConfirmText !== "DELETE" || deleteAccountMutation.isPending || (sessionUser.hasPassword && !deletePassword)}
                      onClick={(e) => {
                        e.preventDefault();
                        deleteAccountMutation.mutate({
                          confirmation: deleteConfirmText,
                          password: sessionUser.hasPassword ? deletePassword : undefined,
                        });
                      }}
                      data-testid="button-confirm-delete"
                    >
                      {deleteAccountMutation.isPending ? (
                        <>
                          <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
                          Deleting…
                        </>
                      ) : (
                        "Delete Account"
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </div>
      </main>

      <BottomNavigation />
    </div>
  );
}
