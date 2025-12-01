import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Shield, Key, User, Mail, Lock, CheckCircle, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface SetupStatus {
  setupRequired: boolean;
  message: string;
}

export default function AdminSetup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    setupKey: "",
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
    displayName: "",
  });

  const { data: status, isLoading: checkingStatus } = useQuery<SetupStatus>({
    queryKey: ["/api/admin/setup/status"],
  });

  const setupMutation = useMutation({
    mutationFn: async (data: {
      setupKey: string;
      username: string;
      email: string;
      password: string;
      displayName: string;
    }) => {
      const response = await apiRequest("POST", "/api/admin/setup", data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Setup Complete!",
        description: "Your Super Admin account has been created. You can now log in.",
      });
      setLocation("/admin");
    },
    onError: (error: any) => {
      toast({
        title: "Setup Failed",
        description: error.message || "Failed to create admin account",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (formData.password !== formData.confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Please make sure your passwords match",
        variant: "destructive",
      });
      return;
    }

    if (formData.password.length < 8) {
      toast({
        title: "Password too short",
        description: "Password must be at least 8 characters",
        variant: "destructive",
      });
      return;
    }

    setupMutation.mutate({
      setupKey: formData.setupKey,
      username: formData.username,
      email: formData.email,
      password: formData.password,
      displayName: formData.displayName,
    });
  };

  if (checkingStatus) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
        <div className="text-white">Checking setup status...</div>
      </div>
    );
  }

  if (!status?.setupRequired) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-slate-800/50 border-purple-500/20 backdrop-blur">
          <CardContent className="pt-6">
            <Alert className="bg-green-500/10 border-green-500/30">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <AlertDescription className="text-green-300">
                Admin accounts already exist. Setup is complete.
              </AlertDescription>
            </Alert>
            <Button
              onClick={() => setLocation("/admin")}
              className="w-full mt-4 bg-purple-600 hover:bg-purple-700"
              data-testid="button-go-to-login"
            >
              Go to Admin Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-slate-800/50 border-purple-500/20 backdrop-blur">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto w-16 h-16 bg-purple-600/20 rounded-full flex items-center justify-center">
            <Shield className="w-8 h-8 text-purple-400" />
          </div>
          <CardTitle className="text-2xl text-white">VibePulse Admin Setup</CardTitle>
          <CardDescription className="text-slate-400">
            Create your first Super Admin account to access the admin panel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert className="mb-4 bg-amber-500/10 border-amber-500/30">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <AlertDescription className="text-amber-300 text-sm">
              This setup is only available once. After creating the first admin, 
              additional admins must be created from within the admin panel.
            </AlertDescription>
          </Alert>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="setupKey" className="text-slate-300">Setup Key</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="setupKey"
                  type="password"
                  placeholder="Enter the setup key"
                  value={formData.setupKey}
                  onChange={(e) => setFormData({ ...formData, setupKey: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-key"
                  required
                />
              </div>
              <p className="text-xs text-slate-500">
                The setup key is stored in your environment secrets as ADMIN_SETUP_KEY
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-slate-300">Display Name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="displayName"
                  type="text"
                  placeholder="Your full name"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-displayname"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username" className="text-slate-300">Username</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="username"
                  type="text"
                  placeholder="Choose a username"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-username"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-slate-300">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="email"
                  type="email"
                  placeholder="your.email@example.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-email"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-300">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Minimum 8 characters"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-password"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-slate-300">Confirm Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm your password"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-setup-confirm-password"
                  required
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full bg-purple-600 hover:bg-purple-700"
              disabled={setupMutation.isPending}
              data-testid="button-create-admin"
            >
              {setupMutation.isPending ? "Creating Account..." : "Create Super Admin Account"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <a 
              href="/admin" 
              className="text-sm text-slate-400 hover:text-purple-400"
              data-testid="link-back-to-login"
            >
              Already have an account? Go to login
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
