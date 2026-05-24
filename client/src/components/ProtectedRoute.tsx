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

  if (error?.message === "ACCOUNT_SUSPENDED") {
    return (
      <div className="min-h-screen bg-[#090909] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-5">
            <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-3 font-serif">Account Suspended</h1>
          <p className="text-white/45 text-sm leading-relaxed">
            Your account has been suspended. If you believe this is an error, please contact support.
          </p>
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
