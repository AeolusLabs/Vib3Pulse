import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Redirect } from "wouter";
import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
}

export default function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const { data: user, isLoading, error } = useAuth();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const { toast } = useToast();

  const resendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/resend-verification"),
    onSuccess: () => toast({ title: "Verification email sent", description: "Check your inbox for the link." }),
    onError: (err: any) => toast({
      title: "Couldn't send email",
      description: err?.message || "Please try again later.",
      variant: "destructive",
    }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 min-h-screen">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" />
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 min-h-screen">
        <div className="text-center max-w-md">
          <h2 className="text-2xl font-bold mb-4">Authentication Error</h2>
          <p className="text-muted-foreground mb-6">
            We couldn't verify your authentication status. Please try again.
          </p>
          <Button onClick={() => window.location.reload()} data-testid="button-retry">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!user) {
    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    return <Redirect to={`/login?redirect=${encodeURIComponent(currentPath)}`} />;
  }

  return (
    <>
      {user && !user.isVerified && !bannerDismissed && (
        <div className="sticky top-0 z-50 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5 flex items-center justify-between gap-4 text-sm">
          <span className="text-amber-300/90 leading-snug">
            Please verify your email address to unlock all features.
          </span>
          <div className="flex items-center gap-4 flex-shrink-0">
            <button
              onClick={() => resendMutation.mutate()}
              disabled={resendMutation.isPending || resendMutation.isSuccess}
              className="text-amber-300 underline hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm"
            >
              {resendMutation.isPending ? "Sending…" : resendMutation.isSuccess ? "Sent!" : "Resend email"}
            </button>
            <button
              onClick={() => setBannerDismissed(true)}
              aria-label="Dismiss"
              className="text-amber-300/50 hover:text-amber-300 transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {children}
    </>
  );
}
