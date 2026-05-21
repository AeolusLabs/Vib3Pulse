import { useAuth } from "@/hooks/useAuth";
import { Redirect } from "wouter";
import { Button } from "@/components/ui/button";
import { EmergencyFAB } from "@/components/safety/EmergencyFAB";

interface AuthenticatedLayoutProps {
  children: React.ReactNode;
}

export default function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const { data: user, isLoading, error } = useAuth();

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
      {children}
      {user.userType === "social" && <EmergencyFAB />}
    </>
  );
}
