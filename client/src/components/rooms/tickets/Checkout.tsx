// The way back from Paystack (img/f-checkout is the hosted page itself; this is our side): /rooms/:id?ref=... lands here,
// we POST verify with the reference, show progress, and hand the ticket up. Retry-safe: one request per reference at a
// time (ticketsApi.verifyTicket), and the server issues at most one ticket per reference whatever we send.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertCircleIcon, Loader2Icon } from "@/components/ui/icons";
import type { RoomTicketView } from "@/lib/roomsApi";
import { TICKET_COPY, ticketErrorMessage } from "@/lib/roomTickets";
import { verifyTicket } from "./ticketsApi";

interface Props {
  roomId: string;
  reference: string;
  onVerified(ticket: RoomTicketView): void;
  /** Leave the return screen (clears the reference from the address) and show the room again. */
  onBack(): void;
}

export default function Checkout({ roomId, reference, onVerified, onBack }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const verifiedRef = useRef(onVerified);
  verifiedRef.current = onVerified;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    void verifyTicket(roomId, reference).then((r) => {
      if (!live) return;
      if (r.ok && r.body?.ticket && typeof r.body.ticket.code === "string") verifiedRef.current(r.body.ticket);
      else {
        setError(ticketErrorMessage(r.ok ? { status: 500 } : r, "verify"));
        requestAnimationFrame(() => headingRef.current?.focus());
      }
    });
    return () => { live = false; };
  }, [roomId, reference, attempt]);

  if (error) {
    return (
      <Card className="mx-auto max-w-md space-y-4 rounded-2xl p-8 text-center" data-testid="ticket-checkout-error">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/15 text-destructive" aria-hidden><AlertCircleIcon className="h-7 w-7" /></div>
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-2xl font-bold outline-none">{TICKET_COPY.checkoutTitle}</h1>
        <p role="alert" className="text-sm">{error}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button className="min-h-[44px]" onClick={() => setAttempt((n) => n + 1)} data-testid="button-verify-retry">{TICKET_COPY.retry}</Button>
          <Button className="min-h-[44px]" variant="outline" onClick={onBack} data-testid="button-verify-back">{TICKET_COPY.backToTicket}</Button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="mx-auto max-w-md space-y-3 rounded-2xl p-8 text-center" role="status" aria-live="polite" data-testid="ticket-checkout">
      <Loader2Icon className="mx-auto h-8 w-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
      <h1 className="font-serif text-2xl font-bold">{TICKET_COPY.checkoutTitle}</h1>
      <p className="text-sm text-muted-foreground">{TICKET_COPY.checkoutBody}</p>
    </Card>
  );
}
