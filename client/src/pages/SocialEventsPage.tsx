import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon, MapPinIcon, PlusIcon, UsersIcon } from "@/components/ui/icons";
import { SOCIAL_TYPE_LABEL, type SocialEventType } from "@/components/social/SocialEventForm";

export type SocialEventSummary = {
  id: string;
  title: string;
  socialType: SocialEventType;
  eventDate: string;
  location: string;
  capacity: number;
  headcount: number;
  yesCount: number;
  declinedCount: number;
  isCancelled: boolean;
};

export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function SocialEventsPage() {
  const { data, isLoading, isError } = useQuery<SocialEventSummary[]>({ queryKey: ["/api/social-events"] });
  const now = Date.now();
  const upcoming = (data ?? []).filter((e) => new Date(e.eventDate).getTime() >= now && !e.isCancelled);
  const past = (data ?? []).filter((e) => new Date(e.eventDate).getTime() < now || e.isCancelled);

  const Row = ({ e }: { e: SocialEventSummary }) => (
    <li>
      <Link href={`/social-events/${e.id}`}>
        <a className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none" data-testid={`link-social-event-${e.id}`}>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{e.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1"><CalendarIcon className="h-3.5 w-3.5" />{formatWhen(e.eventDate)}</span>
              <span className="inline-flex items-center gap-1"><MapPinIcon className="h-3.5 w-3.5" />{e.location}</span>
            </p>
          </div>
          <div className="shrink-0 text-right text-sm">
            {e.isCancelled ? (
              <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">Cancelled</span>
            ) : (
              <>
                <p className="inline-flex items-center gap-1 font-medium"><UsersIcon className="h-3.5 w-3.5" />{e.headcount}/{e.capacity}</p>
                <p className="text-xs text-muted-foreground">{SOCIAL_TYPE_LABEL[e.socialType] ?? "Event"}</p>
              </>
            )}
          </div>
        </a>
      </Link>
    </li>
  );

  const List = ({ items }: { items: SocialEventSummary[] }) => (
    <ul className="divide-y overflow-hidden rounded-2xl border bg-card">{items.map((e) => <Row key={e.id} e={e} />)}</ul>
  );

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="heading-social-events">Your invitations</h1>
            <p className="mt-1 text-sm text-muted-foreground">Private events for the people you invite.</p>
          </div>
          <Link href="/social-events/new">
            <Button className="min-h-[44px] rounded-full" data-testid="button-new-social-event"><PlusIcon className="mr-2 h-4 w-4" />New event</Button>
          </Link>
        </div>

        {isLoading && <div className="space-y-3"><Skeleton className="h-20 rounded-2xl" /><Skeleton className="h-20 rounded-2xl" /></div>}
        {isError && <p className="rounded-2xl border px-6 py-10 text-center text-sm text-muted-foreground">Couldn't load your events. Please refresh.</p>}

        {!isLoading && !isError && (data?.length ?? 0) === 0 && (
          <div className="rounded-2xl border border-dashed px-6 py-14 text-center">
            <p className="font-medium">Nothing planned yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Set up a birthday, party or wedding, then share one link. Guests answer without needing an account.</p>
            <Link href="/social-events/new">
              <Button className="mt-5 min-h-[44px] rounded-full"><PlusIcon className="mr-2 h-4 w-4" />Plan your first event</Button>
            </Link>
          </div>
        )}

        {upcoming.length > 0 && <section className="mb-8"><h2 className="mb-3 text-sm font-medium text-muted-foreground">Upcoming</h2><List items={upcoming} /></section>}
        {past.length > 0 && <section><h2 className="mb-3 text-sm font-medium text-muted-foreground">Past and cancelled</h2><List items={past} /></section>}
      </main>
      <BottomNavigation />
    </div>
  );
}
