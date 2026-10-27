// A ticket holder before the host goes live (flows board 3, "Waiting room"): "Ticket confirmed", a countdown to
// scheduledFor, "until Dayo goes live", and the refund button while the window is open. When the clock runs out it asks
// the page to check the room again (the page also polls every 15 s while the room is scheduled, and joins once it is live).
import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "@/components/ui/icons";
import type { RoomView } from "@/lib/roomsApi";
import { TICKET_COPY, waitingClock, waitingTickMs } from "@/lib/roomTickets";
import RefundButton from "./RefundButton";

interface Props {
  /** refundBeforeStart from the ticket block (the viewer's room object does not carry it); undefined leaves it to the server. */
  room: Pick<RoomView, "id" | "title" | "status" | "scheduledFor" | "refundBeforeStart">;
  hostName: string;
  /** The invite token (invite-only rooms), passed on to the refund call. */
  token?: string;
  priceKobo: number;
  refundKobo?: number;
  /** Ask the page to load the room again (start time reached). */
  onRecheck(): void;
  onRefunded(message: string): void;
  /** Clock seam for the fixture; defaults to Date.now(). */
  nowFn?: () => number;
}

export default function WaitingRoom({ room, hostName, token, priceKobo, refundKobo, onRecheck, onRefunded, nowFn = Date.now }: Props) {
  const [now, setNow] = useState(nowFn);
  const start = room.scheduledFor ? Date.parse(room.scheduledFor) : NaN;
  const left = Number.isNaN(start) ? null : start - now;
  useEffect(() => {
    const t = setInterval(() => setNow(nowFn()), waitingTickMs(left));
    return () => clearInterval(t);
  }, [left === null ? null : waitingTickMs(left)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once, when the clock reaches zero: re-check the room so a host who started on time is joined at once.
  const asked = useRef(false);
  useEffect(() => {
    if (left !== null && left <= 0 && !asked.current) { asked.current = true; onRecheck(); }
  }, [left !== null && left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const line = left === null ? TICKET_COPY.waitingNoTime(hostName) : left > 0 ? TICKET_COPY.waitingUntil(hostName) : TICKET_COPY.waitingSoon(hostName);
  return (
    <section className="mx-auto max-w-md space-y-5 rounded-2xl border border-border p-6 text-center" aria-labelledby="ticket-waiting-title-h" data-testid="ticket-waiting">
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold">
        <CheckIcon className="h-3.5 w-3.5" aria-hidden />{TICKET_COPY.waitingTag}
      </span>
      <h1 className="font-serif text-2xl font-bold leading-tight" id="ticket-waiting-title-h" data-testid="ticket-waiting-title">{room.title}</h1>
      {left !== null && (
        // Not a live region: a ticking clock read out every second is noise. The line under it says what it means.
        <p className="font-serif text-6xl font-bold tabular-nums" data-testid="ticket-countdown" aria-live="off">{waitingClock(left)}</p>
      )}
      <p className="text-sm text-muted-foreground" data-testid="ticket-waiting-line">{line}</p>
      <div className="flex justify-center"><RefundButton room={room} priceKobo={priceKobo} refundKobo={refundKobo} token={token} now={now} onRefunded={onRefunded} /></div>
    </section>
  );
}
