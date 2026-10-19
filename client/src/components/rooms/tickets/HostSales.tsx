// The host's ticket sales (img/f-hostsales): tickets sold of capacity, gross, the costs line, the platform share, what
// the host earns, and when it is paid out. Every sum comes from GET /api/rooms/:id/tickets/summary (host only), which
// answers { summary: {...} } with the stored ticketBreakdown sums over paid tickets. The capacity is the host's own room's
// ticketCapacity (the summary does not carry it), so "sold out" is worked out here. Whole naira, earnings rounded down.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { Loader2Icon, TicketIcon } from "@/components/ui/icons";
import { formatWhen, type RoomTicketSummary } from "@/lib/roomsApi";
import { AMBER, SALES_COPY, cancelNeedsRefetch, salesLines, salesReleaseLine, salesSoldOut, ticketErrorMessage } from "@/lib/roomTickets";
import { cancelTicketedRoom, fetchTicketSummary } from "./ticketsApi";

export const summaryKey = (roomId: string) => ["/api/rooms", roomId, "tickets", "summary"] as const;

/** The numbers on their own (the sheet body; the dev fixture draws it too). */
export function HostSalesBody({ summary, capacity }: { summary: RoomTicketSummary; capacity: number | null }) {
  const l = salesLines(summary);
  const soldOut = salesSoldOut(summary.sold, capacity);
  return (
    <div className="space-y-4" data-testid="host-sales">
      <div className={`rounded-2xl p-4 ${AMBER.fill}`}>
        <p className="text-sm">{SALES_COPY.sold}</p>
        <p className="font-serif text-5xl font-bold tabular-nums" data-testid="host-sales-sold">
          {summary.sold}{capacity ? <> <span className="font-sans text-lg font-semibold">{SALES_COPY.of(capacity)}</span></> : null}
        </p>
        {soldOut && <p className="mt-1 text-sm font-semibold">{SALES_COPY.soldOut}</p>}
        {summary.refunded > 0 && <p className="mt-1 text-sm" data-testid="host-sales-refunded">{SALES_COPY.refunded(summary.refunded)}</p>}
      </div>
      <dl className="space-y-2 rounded-2xl bg-muted/60 p-4 text-sm">
        <Line label={SALES_COPY.gross} value={l.gross} testId="host-sales-gross" />
        <Line label={SALES_COPY.costs} value={l.costs} testId="host-sales-costs" />
        <Line label={SALES_COPY.platform} value={l.platform} testId="host-sales-platform" />
        <div className="border-t border-border pt-2"><Line label={SALES_COPY.earn} value={l.earn} testId="host-sales-earn" strong /></div>
      </dl>
      <p className="text-sm text-muted-foreground" data-testid="host-sales-release">{salesReleaseLine(summary.payout, formatWhen)}</p>
    </div>
  );
}

function Line({ label, value, testId, strong }: { label: string; value: string; testId?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</dt>
      <dd className="font-semibold tabular-nums" data-testid={testId}>{value}</dd>
    </div>
  );
}

interface Props {
  room: { id: string; status: "scheduled" | "live" | "ended" };
  /** The room's ticket capacity, from the host's own room object (room.ticketCapacity). */
  capacity: number | null;
  /** The invite token the page was opened with, for the token-gated routes. */
  token?: string;
  /** After a cancel, so the page reloads the room. */
  onChanged(): void;
}

/** "Tickets" for the host: opens the sales sheet. A scheduled room also offers Cancel and refund everyone (POST /cancel). */
export default function HostSales({ room, capacity, token, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const q = useQuery({
    queryKey: summaryKey(room.id),
    queryFn: () => fetchTicketSummary(room.id, token),
    enabled: open,
    staleTime: 0,
    refetchInterval: open && room.status !== "ended" ? 30_000 : false, // late sales change the numbers
  });
  const res = q.data;

  const cancel = async () => {
    if (cancelBusy) return;
    setCancelBusy(true); setNote(null);
    const r = await cancelTicketedRoom(room.id, token);
    setCancelBusy(false); setConfirm(false);
    if (r.ok) { setNote({ text: SALES_COPY.cancelled, error: false }); onChanged(); }
    else {
      setNote({ text: ticketErrorMessage(r, "cancel"), error: true });
      if (cancelNeedsRefetch(r)) onChanged(); // it went live or ended meanwhile: show the room as it is now
    }
  };

  return (
    <>
      <Button ref={btn} type="button" variant="outline" className="min-h-[44px]" onClick={() => setOpen(true)} data-testid="button-host-sales">
        <TicketIcon className="mr-2 h-4 w-4" aria-hidden />{SALES_COPY.open}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <RoomSheetContent side="bottom" returnFocusTo={() => btn.current} className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="host-sales-sheet">
          <SheetHeader className="pr-10 text-left">
            <SheetTitle className="font-sans text-lg font-semibold">{SALES_COPY.title}</SheetTitle>
            <SheetDescription className="sr-only">{SALES_COPY.desc}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            {q.isLoading || !res ? (
              <div className="grid place-items-center py-8"><span role="status" aria-label="Loading"><Loader2Icon className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden /></span></div>
            ) : res.ok ? (
              <HostSalesBody summary={res.body} capacity={capacity} />
            ) : (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">{ticketErrorMessage(res, "summary")}</p>
                <Button variant="outline" className="min-h-[44px]" onClick={() => q.refetch()}>Try again</Button>
              </div>
            )}
            {room.status === "scheduled" && (
              <Button variant="destructive" className="min-h-[44px] w-full" onClick={() => setConfirm(true)} disabled={cancelBusy} data-testid="button-cancel-ticketed">
                {SALES_COPY.cancel}
              </Button>
            )}
            {note && <p role={note.error ? "alert" : "status"} className={`text-sm ${note.error ? "text-destructive" : ""}`}>{note.text}</p>}
          </div>
        </RoomSheetContent>
      </Sheet>
      <AlertDialog open={confirm} onOpenChange={(o) => { if (!cancelBusy) setConfirm(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{SALES_COPY.cancelTitle}</AlertDialogTitle>
            <AlertDialogDescription>{SALES_COPY.cancelBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]" disabled={cancelBusy}>{SALES_COPY.cancelNo}</AlertDialogCancel>
            <Button variant="destructive" className="min-h-[44px]" onClick={cancel} disabled={cancelBusy} aria-busy={cancelBusy || undefined} data-testid="button-cancel-ticketed-confirm">
              {cancelBusy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {SALES_COPY.cancelYes}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
