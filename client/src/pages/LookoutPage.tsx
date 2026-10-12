import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { CheckInTimer } from "@/components/safety/CheckInTimer";
import { AlertTriangleIcon, ChevronRightIcon } from "@/components/ui/icons";

interface Buddy {
  id: string;
  name: string;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
  isPrimary: boolean;
}
interface WatchingEntry {
  buddyRecord: { id: string };
  protectedUser: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
  activeTimer: { status: string } | null;
  recentAlerts: { status: string }[];
}

const initial = (s: string) => s.charAt(0).toUpperCase() || "?";

function SectionHead({ title, to, action }: { title: string; to: string; action: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold">{title}</h2>
      <Link href={to} className="text-xs text-muted-foreground hover:text-foreground">{action}</Link>
    </div>
  );
}

export default function LookoutPage() {
  const { data: buddyData, isLoading: buddiesLoading } = useQuery<{ buddies: Buddy[] }>({ queryKey: ["/api/safety/buddies"] });
  const { data: watchData, isLoading: watchLoading } = useQuery<{ watching: WatchingEntry[] }>({
    queryKey: ["/api/safety/watching-over"],
    refetchInterval: 30_000,
  });

  const buddies = (buddyData?.buddies ?? []).filter((b) => b.confirmationStatus !== "declined" && b.confirmationStatus !== "expired");
  const confirmed = buddies.filter((b) => b.confirmationStatus === "confirmed").length;
  const watching = watchData?.watching ?? [];

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        <header>
          <p className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-primary">Safety</p>
          <h1 className="mt-1 font-serif text-4xl font-bold tracking-tight">Lookout</h1>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="text-lookout-summary">
            {confirmed > 0
              ? `${confirmed} ${confirmed === 1 ? "person has" : "people have"} your back tonight.`
              : "Add a buddy and they can be alerted if you don't check in."}
          </p>
        </header>

        <CheckInTimer />

        <Card className="space-y-3 rounded-2xl p-4">
          <SectionHead title="Watching you" to="/buddy/settings" action="Manage" />
          {buddiesLoading ? <Skeleton className="h-12 w-full" /> : buddies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No buddies yet. Pick someone you trust in Manage.</p>
          ) : buddies.map((b) => (
            <div key={b.id} className="flex items-center gap-3" data-testid={`lookout-buddy-${b.id}`}>
              <Avatar className="h-9 w-9"><AvatarFallback className="bg-primary/15 text-primary">{initial(b.name)}</AvatarFallback></Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{b.name}</p>
                <p className="text-xs text-muted-foreground">{b.isPrimary ? "Primary buddy" : "Buddy"}</p>
              </div>
              <Badge variant={b.confirmationStatus === "confirmed" ? "secondary" : "outline"} className="text-[10px]">
                {b.confirmationStatus === "confirmed" ? "Confirmed" : "Waiting to confirm"}
              </Badge>
            </div>
          ))}
        </Card>

        <Card className="space-y-3 rounded-2xl p-4">
          <SectionHead title="You are watching" to="/buddy/dashboard" action="Open" />
          {watchLoading ? <Skeleton className="h-12 w-full" /> : watching.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has made you their buddy yet.</p>
          ) : watching.map((w) => {
            const name = w.protectedUser.displayName || w.protectedUser.username;
            const alerting = w.recentAlerts.some((a) => a.status === "active");
            return (
              <Link key={w.buddyRecord.id} href="/buddy/dashboard" className="flex items-center gap-3" data-testid={`lookout-watching-${w.buddyRecord.id}`}>
                <Avatar className="h-9 w-9">
                  <AvatarImage src={w.protectedUser.avatarUrl || undefined} alt="" />
                  <AvatarFallback className="bg-primary/15 text-primary">{initial(name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  <p className="text-xs text-muted-foreground">{alerting ? "Alert active" : w.activeTimer ? "Check-in timer running" : "No timer running"}</p>
                </div>
                {alerting && <AlertTriangleIcon className="h-4 w-4 text-destructive" />}
                <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
              </Link>
            );
          })}
        </Card>

        <Link href="/buddy/alerts" className="flex items-center justify-between rounded-2xl border px-4 py-3 text-sm" data-testid="link-lookout-alert-history">
          Alert history
          <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
        </Link>
      </main>
      <BottomNavigation />
    </div>
  );
}
