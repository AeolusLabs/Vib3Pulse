// The way back from Paystack (img/f-checkout is the hosted page itself; this is our side): /rooms/:id?ref=... lands here,
// we POST verify with the reference, show progress, and hand the ticket up. Retry-safe: one request per reference at a
// time (ticketsApi.verifyTicket), and the server issues at most one ticket per reference whatever we send.
// Shows nothing about the room: verify is bound to this buyer by the reference, so it runs before the room loads.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertCircleIcon, Loader2Icon } from "@/components/ui/icons";
import type { RoomTicketView } from "@/lib/roomsApi";
import { TICKET_COPY, TICKET_ERROR, ticketErrorMessage, verifyOutcome, verifyRetryable } from "@/lib/roomTickets";
import { verifyTicket } from "./ticketsApi";

interface Props {
  roomId: string;
  reference: string;
  onVerified(ticket: RoomTicketView, duplicateRefunded: boolean): void;
  /** Leave the return screen (clears the reference from the address) and show the room again. */
  onBack(): void;
}

type Failure = { text: string; retry: boolean; signIn: boolean };

export default function Checkout({ roomId, reference, onVerified, onBack }: Props) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const verifiedRef = useRef(onVerified);
  verifiedRef.current = onVerified;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setFailure(null);
    void verifyTicket(roomId, reference).then((r) => {
      if (!live) return;
      let f: Failure;
      if (r.ok) {
        const o = verifyOutcome(r.body);
        if (o.kind === "paid") { verifiedRef.current(o.ticket, o.duplicateRefunded); return; }
        f = o.kind === "refunded"
          ? { text: TICKET_ERROR.verifyRefunded, retry: false, signIn: false }
          : { text: ticketErrorMessage({ status: 500 }, "verify"), retry: true, signIn: false };
      } else {
        f = { text: ticketErrorMessage(r, "verify"), retry: verifyRetryable(r), signIn: r.status === 401 };
      }
      setFailure(f);
      requestAnimationFrame(() => headingRef.current?.focus());
    });
    return () => { live = false; };
  }, [roomId, reference, attempt]);

  if (failure) {
    // Back to this same return address after signing in, so verify runs again (it is idempotent).
    const back = `/rooms/${encodeURIComponent(roomId)}?ref=${encodeURIComponent(reference)}`;
    return (
      <Card className="mx-auto max-w-md space-y-4 rounded-2xl p-8 text-center" data-testid="ticket-checkout-error">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/15 text-destructive" aria-hidden><AlertCircleIcon className="h-7 w-7" /></div>
        <h1 ref={headingRef} tabIndex={-1} className="font-serif text-2xl font-bold outline-none">{TICKET_COPY.checkoutTitle}</h1>
        <p role="alert" className="text-sm" data-testid="text-verify-error">{failure.text}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {failure.signIn && (
            <Button asChild className="min-h-[44px]" data-testid="button-verify-signin"><Link href={`/login?redirect=${encodeURIComponent(back)}`}>{TICKET_COPY.signIn}</Link></Button>
          )}
          {failure.retry && <Button className="min-h-[44px]" onClick={() => setAttempt((n) => n + 1)} data-testid="button-verify-retry">{TICKET_COPY.retry}</Button>}
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
