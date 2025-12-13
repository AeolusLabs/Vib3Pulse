import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Lock, Eye, EyeOff, CheckCircle, AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

export default function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const { toast } = useToast();

  const form = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: {
      newPassword: "",
      confirmPassword: "",
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("token");
    setToken(tokenParam);
  }, []);

  const onSubmit = async (data: ResetPasswordFormData) => {
    if (!token) {
      toast({
        title: "Error",
        description: "Invalid reset link. Please request a new password reset.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    
    try {
      await apiRequest("POST", "/api/auth/reset-password", {
        token,
        newPassword: data.newPassword,
      });
      setIsSuccess(true);
      toast({
        title: "Password reset successful",
        description: "You can now sign in with your new password.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to reset password. The link may have expired.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="font-playfair text-4xl font-bold text-primary mb-2">
              VibePulse
            </h1>
          </div>

          <Card>
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <div className="flex justify-center">
                  <div className="p-3 bg-destructive/10 rounded-full">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                  </div>
                </div>
                <h2 className="text-xl font-semibold">Invalid Reset Link</h2>
                <p className="text-muted-foreground text-sm">
                  This password reset link is invalid or has expired.
                </p>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Link href="/forgot-password" className="w-full">
                <Button className="w-full" data-testid="button-request-new-reset">
                  Request New Reset Link
                </Button>
              </Link>
              <Link href="/login" className="w-full">
                <Button variant="outline" className="w-full" data-testid="button-back-to-login">
                  Back to Sign In
                </Button>
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="font-playfair text-4xl font-bold text-primary mb-2">
              VibePulse
            </h1>
          </div>

          <Card>
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <div className="flex justify-center">
                  <div className="p-3 bg-primary/10 rounded-full">
                    <CheckCircle className="h-8 w-8 text-primary" />
                  </div>
                </div>
                <h2 className="text-xl font-semibold">Password Reset Complete</h2>
                <p className="text-muted-foreground text-sm">
                  Your password has been successfully reset. You can now sign in with your new password.
                </p>
              </div>
            </CardContent>
            <CardFooter>
              <Link href="/login" className="w-full">
                <Button className="w-full" data-testid="button-go-to-login">
                  Sign In
                </Button>
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-playfair text-4xl font-bold text-primary mb-2">
            VibePulse
          </h1>
          <p className="text-muted-foreground">
            Create your new password
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Reset Password</CardTitle>
            <CardDescription>
              Enter your new password below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="newPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>New Password</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-2 border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                          <Input
                            type={showPassword ? "text" : "password"}
                            placeholder="Enter your new password"
                            className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                            {...field}
                            data-testid="input-new-password"
                          />
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground transition-colors p-2 mr-1"
                            onClick={() => setShowPassword(!showPassword)}
                            data-testid="button-toggle-password"
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm Password</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-2 border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                          <Input
                            type={showConfirmPassword ? "text" : "password"}
                            placeholder="Confirm your new password"
                            className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 flex-1"
                            {...field}
                            data-testid="input-confirm-password"
                          />
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground transition-colors p-2 mr-1"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            data-testid="button-toggle-confirm-password"
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isLoading}
                  data-testid="button-reset-password"
                >
                  {isLoading ? (
                    "Resetting..."
                  ) : (
                    <>
                      <Lock className="w-4 h-4 mr-2" />
                      Reset Password
                    </>
                  )}
                </Button>
              </form>
            </Form>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <div className="text-sm text-center text-muted-foreground">
              Remember your password?{" "}
              <Link 
                href="/login"
                className="text-primary hover:underline font-medium" 
                data-testid="link-login"
              >
                Sign in
              </Link>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
