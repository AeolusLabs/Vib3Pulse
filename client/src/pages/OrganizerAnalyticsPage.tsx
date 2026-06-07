import { useLocation } from "wouter";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { OrganizerAnalyticsDashboard } from "@/components/OrganizerAnalyticsDashboard";
import { useAuth } from "@/hooks/useAuth";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldOffIcon } from "lucide-react";

export default function OrganizerAnalyticsPage() {
  const { data: user, isLoading } = useAuth();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 pb-24 space-y-6">
          <Skeleton className="h-10 w-48" />
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[88px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!user || user.userType !== "organizer") {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="max-w-6xl mx-auto px-4 py-24 text-center">
          <div className="flex flex-col items-center gap-4">
            <ShieldOffIcon className="h-10 w-10 text-muted-foreground opacity-50" />
            <h2 className="text-lg font-semibold">Organizer access only</h2>
            <p className="text-muted-foreground text-sm">
              Analytics are available to event organizer accounts.
            </p>
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const displayName = user.organizationName || user.displayName || user.username;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 pb-28">
        <OrganizerAnalyticsDashboard
          organizerId={user.id}
          organizerName={displayName || user.username}
        />
      </main>
      <BottomNavigation />
    </div>
  );
}
