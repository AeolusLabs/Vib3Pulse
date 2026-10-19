// A ticket holder's own refund (task 4.5 route). A confirm dialog first; off, with the reason under it, once the shared
// rule (buyerRefundCheck) says the window has closed. The server decides; each refusal code gets its own plain line,
// "already" is never shown as a fresh success, and a refund the provider has not confirmed yet is "on its way".
import { useRef, useState } from "react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import type { RoomView } from "@/lib/roomsApi";
import { REFUND_COPY, formatNaira, refundOutcome, refundWindow, ticketErrorMessage } from "@/lib/roomTickets";
import { refundMyTicket } from "./ticketsApi";

interface Props {
  /** refundBeforeStart comes from the ticket block (the viewer's room object does not carry it); undefined leaves it to the server. */
  room: Pick<RoomView, "id" | "status" | "scheduledFor" | "refundBeforeStart">;
  priceKobo: number;
  /** The invite token (invite-only rooms): the refund route is gated on it like the room page. */
  token?: string;
  /** Clock seam for the fixture; defaults to Date.now(). */
  now?: number;
  /** Called after the server answered refunded, already or pending, with the line to show, so the page can say it and reload the room. */
  onRefunded(message: string): void;
}

export default function RefundButton({ room, priceKobo, token, now, onRefunded }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const pending = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const win = refundWindow(room, "paid", now ?? Date.now());

  const refund = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    const r = await refundMyTicket(room.id, token);
    pending.current = false; setBusy(false); setOpen(false);
    if (r.ok) {
      const o = refundOutcome(r.body);
      if (o) { setMessage({ text: o.text, error: false }); onRefunded(o.text); return; }
      setMessage({ text: ticketErrorMessage({ status: 500 }, "refund"), error: true });
      return;
    }
    setMessage({ text: ticketErrorMessage(r, "refund"), error: true });
  };

  return (
    <div className="space-y-2" data-testid="ticket-refund">
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <Button
          ref={triggerRef} type="button" variant="outline"
          className="min-h-[44px] border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={!win.open || busy} aria-describedby={!win.open ? "ticket-refund-why" : undefined}
          onClick={() => setOpen(true)} data-testid="button-refund-ticket"
        >
          {REFUND_COPY.button}
        </Button>
        <AlertDialogContent onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{REFUND_COPY.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{REFUND_COPY.confirmBody(formatNaira(priceKobo))}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]" disabled={busy}>{REFUND_COPY.confirmNo}</AlertDialogCancel>
            {/* Not AlertDialogAction: that closes the dialog at once, before the server has answered. */}
            <Button className="min-h-[44px]" variant="destructive" onClick={refund} disabled={busy} aria-busy={busy || undefined} data-testid="button-refund-confirm">
              {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {busy ? REFUND_COPY.working : REFUND_COPY.confirmYes}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!win.open && <p id="ticket-refund-why" className="text-sm text-muted-foreground">{win.reason}</p>}
      {message && <p role={message.error ? "alert" : "status"} className={`text-sm ${message.error ? "text-destructive" : ""}`}>{message.text}</p>}
    </div>
  );
}
