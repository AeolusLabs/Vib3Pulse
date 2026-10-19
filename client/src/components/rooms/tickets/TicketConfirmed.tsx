// "You are in" (img/f-ticketok): the ticket with the room, the time, the host and a short code. No QR in this phase.
// The ticket card is amber (a money moment) with its own text colour, which meets 4.5:1 on both themes.
// Shown only for a ticket whose status is "paid" (verifyOutcome). The room may not have loaded yet (the return from
// Paystack verifies first); the card then shows the ticket without the room's details.
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CheckIcon, TicketIcon } from "@/components/ui/icons";
import { formatWhen, type RoomTicketView } from "@/lib/roomsApi";
import { AMBER, TICKET_COPY, formatNaira } from "@/lib/roomTickets";

interface Props {
  ticket: Pick<RoomTicketView, "code" | "amountKobo">;
  room: { title: string; scheduledFor: string | null } | null;
  hostName: string | null;
  /** The verify said this buyer already had a ticket: the second payment is being refunded. */
  duplicateRefunded?: boolean;
  onContinue(): void;
}

export default function TicketConfirmed({ ticket, room, hostName, duplicateRefunded = false, onContinue }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const when = room?.scheduledFor ? formatWhen(room.scheduledFor) : null;
  return (
    <section className="mx-auto max-w-md space-y-5" aria-labelledby="ticket-ok-title" data-testid="ticket-confirmed">
      <div className="grid justify-items-center gap-2 pt-2 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-primary text-primary-foreground" aria-hidden><CheckIcon className="h-7 w-7" /></div>
        <h1 id="ticket-ok-title" ref={headingRef} tabIndex={-1} className="font-serif text-3xl font-bold outline-none">{TICKET_COPY.confirmedTitle}</h1>
      </div>
      {duplicateRefunded && <p role="status" className="rounded-xl border border-border p-3 text-sm" data-testid="ticket-duplicate-refunded">{TICKET_COPY.duplicateRefunded}</p>}
      <div className={`space-y-3 rounded-2xl p-5 ${AMBER.fill}`} data-testid="ticket-card">
        <span className="inline-flex items-center gap-1 rounded-full bg-black/10 px-2.5 py-0.5 text-xs font-semibold"><TicketIcon className="h-3.5 w-3.5" aria-hidden />{TICKET_COPY.ticketTag}</span>
        {room?.title && <p className="font-serif text-2xl font-bold leading-tight">{room.title}</p>}
        <p className="text-sm">{[when, hostName, formatNaira(ticket.amountKobo)].filter(Boolean).join(" · ")}</p>
        <hr className="border-dashed border-current opacity-40" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">{TICKET_COPY.codeLabel}</p>
          <p className="font-mono text-3xl font-bold tracking-[0.2em]" data-testid="ticket-code">{ticket.code}</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{TICKET_COPY.codeHelp}</p>
      <Button className="h-12 w-full rounded-full text-base" onClick={onContinue} data-testid="button-ticket-continue">{TICKET_COPY.continue}</Button>
    </section>
  );
}
