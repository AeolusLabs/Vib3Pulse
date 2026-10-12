import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ChevronLeft, Share2, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import UnifiedShareModal, { type ShareData } from "@/components/UnifiedShareModal";
import { useAuth } from "@/hooks/useAuth";
import TicketDeck from "@/components/tickets/TicketDeck";
import { useWalletTickets } from "@/components/tickets/useWalletTickets";
import { isPast, ticketState } from "@/components/tickets/ticketModel";

/** Full-screen ticket: swipe between tickets, QR drawn on the phone, screen kept awake. */
export default function TicketViewPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const [, navigate] = useLocation();
  const { data: user } = useAuth();
  const { tickets, isLoading } = useWalletTickets();
  const [share, setShare] = useState<ShareData | null>(null);
  const [activeId, setActiveId] = useState(ticketId);

  // Usable tickets in date order. A past ticket opened from the Past list shows on its own.
  const deck = useMemo(() => {
    const requested = tickets.find((t) => t.id === ticketId);
    if (requested && isPast(requested)) return [requested];
    return tickets.filter((t) => !isPast(t) && ticketState(t) !== "cancelled");
  }, [tickets, ticketId]);

  const holder = user?.displayName || user?.username || "Ticket holder";
  const active = deck.find((t) => t.id === activeId) ?? deck[0];

  return (
    <div className="flex h-dvh flex-col bg-background" data-testid="page-ticket-view">
      <header className="flex flex-shrink-0 items-center gap-2 px-2 py-2">
        <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate("/ticket-wallet")} aria-label="Back to Tickets" data-testid="button-back">
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <h1 className="flex-1 text-center font-semibold">Ticket</h1>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          disabled={!active || active.kind !== "event"}
          onClick={() => active && setShare({ type: "event", id: active.targetId, title: active.title, imageUrl: active.imageUrl })}
          aria-label="Share event"
        >
          <Share2 className="h-5 w-5" />
        </Button>
      </header>

      {isLoading ? (
        <div className="space-y-3 p-4"><Skeleton className="h-[460px] w-full rounded-[22px]" /></div>
      ) : deck.length === 0 || !active ? (
        <div className="m-auto max-w-xs px-6 text-center">
          <p className="font-serif text-xl font-bold">Ticket not found</p>
          <p className="mt-1 text-sm text-muted-foreground">It may have been refunded, or it belongs to another account.</p>
          <Button className="mt-4 h-11" onClick={() => navigate("/ticket-wallet")}>Back to Tickets</Button>
        </div>
      ) : (
        <>
          <TicketDeck tickets={deck} startId={ticketId} holderName={holder} onActiveChange={(t) => setActiveId(t.id)} />
          <p className="flex flex-shrink-0 items-center justify-center gap-1.5 px-4 pb-4 text-[13px] text-muted-foreground">
            <Sun className="h-4 w-4" />Screen stays on while this is open. Works offline.
          </p>
        </>
      )}

      {share && <UnifiedShareModal open={!!share} onClose={() => setShare(null)} shareData={share} />}
    </div>
  );
}
