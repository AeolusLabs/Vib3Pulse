// After a room ends (phase 6, task 6.5): the viewer's own recap, from GET /api/rooms/:id/recap. A guest sees their own
// minutes and messages, the host's next room and a Follow button; the host also sees how the room went and what it earned.
// The server decides every field (a guest's response never carries host numbers); nothing here is computed from money.
import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeftIcon, CalendarIcon, CheckIcon, UserPlusIcon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatWhen } from "@/lib/roomsApi";
import { AMBER, formatNaira } from "@/lib/roomTickets";
import type { RoomRecapResponse } from "@shared/roomRecap";

function Stat({ label, value, money = false, testId }: { label: string; value: string; money?: boolean; testId: string }) {
  return (
    // Amber only for the money moment, and only as the shared fill with its own text colour (4.5:1 on both themes).
    <div className={`rounded-xl p-3 ${money ? AMBER.fill : "border border-border"}`} data-testid={testId}>
      <p className={`text-xs ${money ? "" : "text-muted-foreground"}`}>{label}</p>
      <p className="mt-1 font-serif text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

const mins = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n} min`);
/** Rooms that ended before tracking existed send null: shown as "--", never as a made-up 0. */
export const NOT_TRACKED = "--";
const known = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export const statText = (v: unknown, fmt: (n: number) => string) => (known(v) ? fmt(v) : NOT_TRACKED);

export default function RoomRecapPage() {
  const { id } = useParams<{ id: string }>();
  const key = [`/api/rooms/${encodeURIComponent(id ?? "")}/recap`];
  const { data, isLoading, error } = useQuery<RoomRecapResponse>({ queryKey: key, enabled: !!id, retry: false, staleTime: 0 });
  const [following, setFollowing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const follow = async () => {
    if (!data?.host || following) return;
    setFollowError(null);
    setFollowing(true);
    try {
      await apiRequest("POST", `/api/users/${encodeURIComponent(data.host.id)}/follow`, {});
      await queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ["/api/follows/me/following"] });
    } catch {
      setFollowing(false);
      setFollowError("Couldn't follow right now. Try again.");
    }
  };

  let content: React.ReactNode;
  if (isLoading) {
    content = <div className="space-y-3"><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
  } else if (error || !data) {
    content = (
      <Card className="mx-auto max-w-md space-y-3 rounded-2xl p-8 text-center" role="status">
        <h1 className="font-serif text-2xl font-bold">No recap here</h1>
        <p className="text-sm text-muted-foreground">Recaps are for people who were in the room, once it has ended.</p>
        <Button asChild variant="outline" className="min-h-[44px]"><Link href="/rooms">Back to Rooms</Link></Button>
      </Card>
    );
  } else {
    const r = data.recap;
    const hostName = data.host ? data.host.displayName || data.host.organizationName || data.host.username || "the host" : "the host";
    const followsNow = r.follow || following;
    content = (
      <div className="space-y-4">
        <header className="space-y-1">
          <p className="text-sm text-muted-foreground">Room recap</p>
          <h1 className="font-serif text-2xl font-bold break-words" data-testid="recap-title">{data.room.title}</h1>
          {!data.isHost && <p className="text-sm text-muted-foreground">Hosted by {hostName}</p>}
        </header>

        <section aria-label="Your time in the room" className="grid grid-cols-2 gap-3">
          <Stat label="You were in for" value={statText(r.minutesIn, mins)} testId="recap-minutes-in" />
          <Stat label="Messages you sent" value={statText(r.messages, String)} testId="recap-messages" />
        </section>

        {data.isHost && (
          <section aria-label="How your room went" className="space-y-3" data-testid="recap-host">
            <h2 className="text-base font-semibold">How your room went</h2>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Live for" value={statText(r.minutes, mins)} testId="recap-room-minutes" />
              {r.peak !== null && r.peak !== undefined && <Stat label="Most people at once" value={String(r.peak)} testId="recap-peak" />}
              <Stat label="Tickets sold" value={String(r.ticketsSold ?? 0)} testId="recap-tickets" />
              {r.followersGained !== null && r.followersGained !== undefined && <Stat label="New followers from the room" value={String(r.followersGained)} testId="recap-followers" />}
              <Stat label="You earned" value={formatNaira(r.earnedKobo ?? 0)} money testId="recap-earned" />
            </div>
            <p className="text-xs text-muted-foreground">Your share of tickets and sprays in this room, before refunds and reversals. Payouts and what has settled are on your earnings page.</p>
            <Button asChild variant="outline" className="min-h-[44px]"><Link href="/rooms/earnings">See your earnings</Link></Button>
          </section>
        )}

        {r.next && (
          <Card className="flex items-center gap-3 rounded-2xl p-4" data-testid="recap-next">
            <CalendarIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{data.isHost ? "Your next room" : `${hostName}'s next room`}</p>
              <p className="text-sm text-muted-foreground">{formatWhen(r.next.scheduledFor)}</p>
            </div>
            <Button asChild className="min-h-[44px]"><Link href={`/rooms/${encodeURIComponent(r.next.roomId)}`}>Open</Link></Button>
          </Card>
        )}

        {!data.isHost && data.host && (
          <div className="space-y-2">
            <Button className="min-h-[44px] w-full" variant={followsNow ? "outline" : "default"} onClick={follow} disabled={followsNow} aria-pressed={followsNow} data-testid="recap-follow">
              {followsNow ? <CheckIcon className="mr-2 h-4 w-4" aria-hidden /> : <UserPlusIcon className="mr-2 h-4 w-4" aria-hidden />}
              {followsNow ? `You follow ${hostName}` : `Follow ${hostName}`}
            </Button>
            {followError && <p className="text-sm text-destructive" role="alert">{followError}</p>}
          </div>
        )}

        <Button asChild variant="ghost" className="min-h-[44px]">
          <Link href="/rooms"><ArrowLeftIcon className="mr-2 h-4 w-4" aria-hidden />Back to Rooms</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Navigation />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">{content}</main>
      <BottomNavigation />
    </div>
  );
}
