// A ticket holder's own refund (task 4.5 route). A confirm dialog first; off, with the reason under it, once the window
// has closed (1 hour before the start, or the host turned refunds off). The server decides; "already" and "not_allowed"
// are shown as they are, never as a success.
import { useRef, useState } from "react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import type { RoomView } from "@/lib/roomsApi";
import { REFUND_COPY, formatNaira, refundWindow, ticketErrorMessage } from "@/lib/roomTickets";
import { refundMyTicket } from "./ticketsApi";

interface Props {
  room: Pick<RoomView, "id" | "status" | "scheduledFor" | "refundBeforeStart">;
  priceKobo: number;
  /** Clock seam for the fixture; defaults to Date.now(). */
  now?: number;
  /** Called after the server answered refunded or already, with the line to show, so the page can say it and reload the room. */
  onRefunded(message: string): void;
}

export default function RefundButton({ room, priceKobo, now, onRefunded }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const pending = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const win = refundWindow(room, "paid", now ?? Date.now());

  const refund = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    const r = await refundMyTicket(room.id);
    pending.current = false; setBusy(false); setOpen(false);
    if (r.ok && r.body?.result === "refunded") { setMessage({ text: REFUND_COPY.done, error: false }); onRefunded(REFUND_COPY.done); return; }
    if (r.ok && r.body?.result === "already") { setMessage({ text: REFUND_COPY.already, error: false }); onRefunded(REFUND_COPY.already); return; }
    if (r.ok) { setMessage({ text: ticketErrorMessage({ status: 409, code: "NOT_ALLOWED" }, "refund"), error: true }); return; }
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
