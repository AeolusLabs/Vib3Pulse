import { format } from "date-fns";
import { stateLabel, ticketState, type WalletTicket } from "./ticketModel";

const tone = { ok: "text-emerald-600 dark:text-emerald-400", muted: "text-muted-foreground", warn: "text-amber-600 dark:text-amber-400", bad: "text-destructive" } as const;

/** One line in the wallet: date tile, title, place, and what state the ticket is in. */
export default function TicketRow({ ticket, quantity, onOpen, dim }: { ticket: WalletTicket; quantity: number; onOpen: () => void; dim?: boolean }) {
  const state = ticketState(ticket);
  const s = stateLabel[state];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid min-h-[76px] w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-left transition-[background-color,transform] duration-150 hover-elevate active:scale-[0.99] ${dim ? "opacity-85" : ""}`}
      data-testid={`ticket-row-${ticket.id}`}
    >
      <span className="rounded-xl border bg-card py-1.5 text-center leading-none">
        <b className="block font-serif text-[22px]">{format(ticket.startsAt, "d")}</b>
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{format(ticket.startsAt, "MMM")}</span>
      </span>
      <span className="min-w-0">
        <b className="block truncate font-semibold leading-tight">{ticket.title}</b>
        <small className="block truncate text-sm text-muted-foreground">
          {ticket.kind === "venue" ? `${ticket.place} · Venue entry` : `${format(ticket.startsAt, "EEE · h:mm a")} · ${ticket.place}`}
        </small>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <span className={`text-[11px] font-semibold uppercase tracking-[0.07em] ${tone[s.tone]}`} data-testid={`ticket-state-${ticket.id}`}>{s.label}</span>
        <small className="text-sm text-muted-foreground">
          {state === "checked_in" && ticket.checkedInAt ? `Checked in ${format(ticket.checkedInAt, "HH:mm")}` : quantity > 1 ? `${quantity} tickets` : ticket.kind === "venue" ? "Entry" : "1 ticket"}
        </small>
      </span>
    </button>
  );
}
