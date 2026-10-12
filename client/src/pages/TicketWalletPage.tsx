import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, Ticket, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { AutoSetupTimerDialog } from "@/components/safety/AutoSetupTimerDialog";
import UnifiedShareModal, { type ShareData } from "@/components/UnifiedShareModal";
import NextUpCard from "@/components/tickets/NextUpCard";
import TicketRow from "@/components/tickets/TicketRow";
import { useWalletTickets } from "@/components/tickets/useWalletTickets";
import { groupTickets, isPast, type WalletTicket } from "@/components/tickets/ticketModel";
import type { Ticket as TicketType, Event } from "@shared/schema";

interface Buddy { confirmationStatus: string }

// Mirrors the "+3h if no end date" fallback used elsewhere (EventDetailsModal.tsx,
// rating-routes.ts) — events aren't guaranteed to have eventEndDate set.
function computeDefaultCheckinExpiry(event: Event): Date {
  const end = event.eventEndDate
    ? new Date(event.eventEndDate)
    : new Date(new Date(event.eventDate).getTime() + 3 * 60 * 60_000);
  return new Date(end.getTime() + 60 * 60_000); // +1h per PRD
}

export default function TicketWalletPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: user } = useAuth();
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [autoSetupTarget, setAutoSetupTarget] = useState<{ eventId: string; eventName: string; defaultExpiry: Date } | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareData | null>(null);

  const { tickets, isLoading, offline } = useWalletTickets();

  const { data: buddiesData } = useQuery<{ buddies: Buddy[] }>({ queryKey: ["/api/safety/buddies"] });
  const hasConfirmedBuddy = (buddiesData?.buddies ?? []).some((b) => b.confirmationStatus === "confirmed");

  // Handle the success redirect from event ticket checkout (see
  // /api/payments/event/checkout's successUrl in server/payment-routes.ts,
  // which appends session_id and provider — both are required by verify).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const provider = params.get("provider");

    if (params.get("success") === "true" && sessionId && provider && !isVerifyingPayment) {
      setIsVerifyingPayment(true);
      apiRequest("POST", "/api/payments/event/verify", { sessionId, provider })
        .then(async (response) => {
          const body: { ticket: TicketType; event?: Event } = await response.json();
          queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
          // staleTime is Infinity, so availability on every event list/modal
          // stays frozen unless invalidated here.
          queryClient.invalidateQueries({
            predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/events"),
          });
          toast({ title: "Ticket purchased!", description: "Your ticket has been added to your wallet." });
          if (body.event && hasConfirmedBuddy) {
            setAutoSetupTarget({
              eventId: body.event.id,
              eventName: body.event.title,
              defaultExpiry: computeDefaultCheckinExpiry(body.event),
            });
          }
        })
        .catch(() => {
          toast({ title: "Verification failed", description: "Unable to verify your purchase. Please contact support.", variant: "destructive" });
        })
        .finally(() => {
          setIsVerifyingPayment(false);
          window.history.replaceState({}, "", "/ticket-wallet");
        });
    }
  }, [toast, isVerifyingPayment, hasConfirmedBuddy]);

  const { upcoming, past } = useMemo(() => {
    const now = new Date();
    const up = tickets.filter((t) => !isPast(t, now));
    const pa = tickets.filter((t) => isPast(t, now)).sort((a, b) => +b.startsAt - +a.startsAt);
    return { upcoming: groupTickets(up), past: groupTickets(pa) };
  }, [tickets]);

  const open = (t: WalletTicket) => navigate(`/ticket-wallet/${t.id}`);
  const share = (t: WalletTicket) => setShareTarget({ type: t.kind === "event" ? "event" : "venue", id: t.kind === "event" ? t.targetId : t.targetId, title: t.title, imageUrl: t.imageUrl });
  const [next, ...later] = upcoming;
  const isSocial = user?.userType === "social";

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="mx-auto max-w-xl px-4 pb-8 pt-5">
        <div className="mb-2 flex items-end gap-3">
          <div className="flex-1">
            <h1 className="font-serif text-4xl font-bold leading-none" data-testid="heading-ticket-wallet">Tickets</h1>
            <p className="mt-1.5 text-sm text-muted-foreground" data-testid="text-wallet-sub">
              {isLoading ? "Loading…" : `${upcoming.length} upcoming`} · works offline
            </p>
          </div>
        </div>

        {offline && (
          <p className="mb-3 flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm text-muted-foreground" data-testid="banner-offline">
            <WifiOff className="h-4 w-4 flex-none" />No connection. Showing the tickets saved on this phone.
          </p>
        )}
        {isVerifyingPayment && (
          <p className="mb-3 flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm" data-testid="banner-verifying">
            <Loader2 className="h-4 w-4 flex-none animate-spin" />Confirming your purchase…
          </p>
        )}

        <div className="mb-3 flex gap-2" role="group" aria-label="Show tickets">
          {(["upcoming", "past"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-[background-color,transform] active:scale-[0.97] ${tab === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover-elevate"}`}
              data-testid={`tab-${k}`}
            >
              {k === "upcoming" ? "Upcoming" : "Past"}
              <small className="text-xs opacity-85">{k === "upcoming" ? upcoming.length : past.length}</small>
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3"><Skeleton className="h-72 w-full rounded-[18px]" /><Skeleton className="h-20 w-full rounded-xl" /></div>
        ) : tab === "upcoming" ? (
          upcoming.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center" data-testid="empty-upcoming">
              <span className="mb-4 grid h-16 w-16 place-items-center rounded-full bg-primary/10"><Ticket className="h-7 w-7 text-primary" /></span>
              <p className="font-serif text-xl font-bold">No tickets yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Find something on tonight and your ticket will be waiting here.</p>
              <Button className="mt-5 h-11" onClick={() => navigate("/search")}>Discover events</Button>
            </div>
          ) : (
            <>
              <NextUpCard
                ticket={next.lead}
                quantity={next.tickets.length}
                onShow={() => open(next.lead)}
                onShare={() => share(next.lead)}
                showSafety={isSocial}
              />
              {later.length > 0 && (
                <>
                  <h2 className="mb-2 mt-5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Coming up</h2>
                  <div className="border-t">
                    {later.map((g) => <TicketRow key={g.key} ticket={g.lead} quantity={g.tickets.length} onOpen={() => open(g.lead)} />)}
                  </div>
                </>
              )}
            </>
          )
        ) : past.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground" data-testid="empty-past">Your past tickets will show up here.</p>
        ) : (
          <div className="border-t">
            {past.map((g) => <TicketRow key={g.key} ticket={g.lead} quantity={g.tickets.length} onOpen={() => open(g.lead)} dim />)}
          </div>
        )}
      </main>

      <BottomNavigation />

      {autoSetupTarget && (
        <AutoSetupTimerDialog
          open={!!autoSetupTarget}
          onOpenChange={(o) => { if (!o) setAutoSetupTarget(null); }}
          eventId={autoSetupTarget.eventId}
          eventName={autoSetupTarget.eventName}
          defaultExpiry={autoSetupTarget.defaultExpiry}
        />
      )}
      {shareTarget && <UnifiedShareModal open={!!shareTarget} onClose={() => setShareTarget(null)} shareData={shareTarget} />}
    </div>
  );
}
