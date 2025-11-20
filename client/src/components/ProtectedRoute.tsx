import { useAuth } from "@/hooks/useAuth";
import { Redirect, useLocation } from "wouter";
import { Button } from "@/components/ui/button";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { data: user, isLoading, error } = useAuth();
  const [location] = useLocation();

  const publicRoutes = ["/login", "/signup", "/", "/discover"];
  
  const normalizedLocation = location.split('?')[0].split('#')[0];

  if (publicRoutes.includes(normalizedLocation)) {
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" />
          <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-bold mb-3">Authentication Error</h2>
          <p className="text-muted-foreground mb-4 text-sm">
            We couldn't verify your authentication status. Please try again.
          </p>
          <Button onClick={() => window.location.reload()} data-testid="button-retry" size="sm">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}
