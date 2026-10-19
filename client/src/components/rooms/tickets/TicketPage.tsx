// The ticket page (flows board 3, img/f-ticket): cover, age tag, title, host, tickets left, what is included, the refund
// promise, and "Get ticket · ₦5,000" with "Price includes VAT" under it. Shown ONLY when the server sent a ticket block for
// this viewer (an eligible adult who can view the room). The price is the server's priceKobo, never computed here.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import { ClockIcon, Loader2Icon, ShieldIcon, TicketIcon } from "@/components/ui/icons";
import { KIND_LABEL, ageLimitLabel, formatWhen, hostName, type RoomHostSummary, type RoomTicketBlock, type RoomView } from "@/lib/roomsApi";
import {
  AMBER, TICKET_COPY, checkoutNeedsRefetch, formatNaira, refundPromise, rememberInviteToken, safeCheckoutUrl, ticketErrorMessage, ticketsLeftText,
} from "@/lib/roomTickets";
import { startCheckout } from "./ticketsApi";

interface Props {
  room: Pick<RoomView, "id" | "title" | "kind" | "ageLimit" | "status" | "scheduledFor" | "liveVideo" | "refundBeforeStart">;
  host: RoomHostSummary | null;
  ticket: RoomTicketBlock;
  /** The invite token this page was opened with (invite-only rooms). Sent with checkout and kept for the way back. */
  token?: string;
  /** Any 409 from checkout (sold out, ended, already ticketed, you host it...): reload the room so the page moves on. */
  onRefetch?: () => void;
  /** Test seam for the dev fixture: where to send the browser. Defaults to window.location.assign. */
  go?: (url: string) => void;
}

const sessionStore = () => { try { return window.sessionStorage; } catch { return null; } };

export default function TicketPage({ room, host, ticket, token, onRefetch, go }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as state: two taps in the same frame both see busy=false in their closure, the ref stops the second.
  const pending = useRef(false);
  const price = formatNaira(ticket.priceKobo);
  const soldOut = ticket.soldOut;
  // The refund promise comes from the ticket block (the viewer's room object does not carry it).
  const refundBeforeStart = ticket.refundBeforeStart ?? room.refundBeforeStart;

  // Back from Paystack with the browser's back button: the page comes out of the back/forward cache with the button
  // still busy. Reset it so the buyer can try again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { pending.current = false; setBusy(false); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const buy = async () => {
    if (pending.current || soldOut) return;
    pending.current = true; setBusy(true); setError(null);
    const r = await startCheckout(room.id, token);
    if (r.ok) {
      const url = safeCheckoutUrl(r.body?.url, window.location.origin);
      if (url) {
        // The server keeps the invite token out of the Paystack return URL: keep it here for the way back.
        rememberInviteToken(sessionStore(), room.id, token);
        // Stay busy: the page is leaving. If the browser blocks the move, the button stays off until a reload.
        (go ?? ((u: string) => window.location.assign(u)))(url);
        return;
      }
      setError(ticketErrorMessage({ status: 500 }, "checkout")); // no usable checkout link: never follow an unknown one
    } else {
      setError(ticketErrorMessage(r, "checkout"));
      if (checkoutNeedsRefetch(r)) onRefetch?.();
    }
    pending.current = false; setBusy(false);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" aria-label={TICKET_COPY.pageLabel} data-testid="ticket-page">
      {/* Decorative cover: rooms have no cover image yet, so a soft band in the violet primary (amber is for money only). */}
      <div className="flex h-32 items-center justify-center bg-gradient-to-br from-primary/40 via-primary/15 to-primary/5" aria-hidden>
        <TicketIcon className="h-12 w-12 text-foreground/70" />
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        <ul className="flex flex-wrap gap-2 text-xs font-semibold" aria-label="Room details">
          <li className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1" data-testid="ticket-age-tag">
            <ShieldIcon className="h-3.5 w-3.5" aria-hidden />{ageLimitLabel(room.ageLimit)}
          </li>
          <li className="rounded-full border border-border px-2.5 py-1">{room.liveVideo ? "Live video" : KIND_LABEL[room.kind]}</li>
          {room.scheduledFor && room.status === "scheduled" && (
            <li className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1"><ClockIcon className="h-3.5 w-3.5" aria-hidden />{formatWhen(room.scheduledFor)}</li>
          )}
        </ul>
        <h1 className="font-serif text-3xl font-bold leading-tight tracking-tight" data-testid="ticket-title">{room.title}</h1>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <HostAvatar person={host ?? {}} className="h-6 w-6 rounded-full" />
          {TICKET_COPY.hostedBy(hostName(host))}
        </p>
        <dl className="space-y-2 rounded-2xl bg-muted/60 p-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{TICKET_COPY.ticketsLeft}</dt>
            <dd className="font-semibold" data-testid="ticket-left">{ticketsLeftText(ticket)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{TICKET_COPY.includes}</dt>
            <dd className="text-right font-semibold">{TICKET_COPY.includesWhat}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground" data-testid="ticket-refund-promise">{refundPromise({ scheduledFor: room.scheduledFor, refundBeforeStart })}</p>

        {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="ticket-error">{error}</p>}

        <div className="space-y-2 pt-2">
          <Button
            type="button" onClick={buy} disabled={busy || soldOut} aria-busy={busy || undefined}
            className={`h-12 w-full rounded-full text-base font-semibold ${AMBER.button}`}
            data-testid="button-get-ticket"
          >
            {busy ? <><Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />{TICKET_COPY.redirecting}</>
              : soldOut ? TICKET_COPY.soldOut : TICKET_COPY.getTicket(price)}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{TICKET_COPY.includesVat}</p>
        </div>
      </div>
    </section>
  );
}
