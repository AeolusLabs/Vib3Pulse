import { format } from "date-fns";
import { Check } from "lucide-react";
import QrCode from "./QrCode";
import { stateLabel, ticketState, type WalletTicket } from "./ticketModel";

/** The ticket itself: event details on top, perforation, QR and short code below. */
export default function TicketPass({ ticket, holderName, index, total }: { ticket: WalletTicket; holderName: string; index: number; total: number }) {
  const state = ticketState(ticket);
  const usable = state === "valid" || state === "checked_in";
  const facts: Array<[string, string]> = [
    ["Date", format(ticket.startsAt, "EEE d MMM")],
    [ticket.kind === "venue" ? "Starts" : "Doors", format(ticket.doorsAt ?? ticket.startsAt, "h:mm a")],
    ...(total > 1 ? ([["Admit", `${index + 1} of ${total}`]] as Array<[string, string]>) : []),
    ["Holder", holderName],
    ["Type", ticket.tierName ?? "General"],
    ["Paid", ticket.priceLabel],
  ];

  return (
    <article className="relative flex flex-col rounded-[22px] border bg-card" data-testid={`pass-${ticket.id}`}>
      <div className="px-5 pb-4 pt-[18px]">
        <div className="mb-3 flex items-center justify-between">
          <b className="font-serif text-lg text-primary">Vib3Pulse</b>
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-primary">{ticket.kind === "venue" ? "Venue entry" : "Event ticket"}</span>
        </div>
        <h2 className="mb-1.5 font-serif text-[28px] font-bold leading-[1.08]" data-testid="pass-title">{ticket.title}</h2>
        <p className="text-[15px] text-muted-foreground">{ticket.place}</p>
        <dl className="mt-3.5 grid grid-cols-3 gap-x-3 gap-y-2.5">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{k}</dt>
              <dd className="break-words text-[15px] font-semibold leading-snug">{v}</dd>
            </div>
          ))}
        </dl>
        {ticket.policy && (
          <div className="mt-3 flex flex-col gap-1 rounded-xl border bg-background px-3.5 py-3 text-sm text-muted-foreground" data-testid="pass-policy">
            {ticket.policy.age ? <span><b className="font-medium text-foreground">{ticket.policy.age}+ only.</b> Bring photo ID.</span> : null}
            {ticket.policy.dress ? <span><b className="font-medium text-foreground">Dress code:</b> {ticket.policy.dress}</span> : null}
          </div>
        )}
      </div>

      {/* perforation */}
      <div className="relative mx-[18px] border-t-[1.5px] border-dashed" aria-hidden="true">
        <span className="absolute -left-[30px] -top-[13px] h-6 w-6 rounded-full border bg-background [clip-path:inset(0_0_0_50%)]" />
        <span className="absolute -right-[30px] -top-[13px] h-6 w-6 rounded-full border bg-background [clip-path:inset(0_50%_0_0)]" />
      </div>

      <div className="flex flex-col items-center gap-3 px-5 pb-5 pt-[18px]">
        {usable ? (
          <>
            <QrCode value={ticket.validationCode} label={`QR code for ${ticket.title}`} />
            <span className="font-mono text-[19px] tracking-[0.14em]" data-testid="pass-short-code">{ticket.shortCode}</span>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {state === "pending" ? "The host has not approved this RSVP yet." : state === "cancelled" ? "This ticket was cancelled or refunded and cannot be used." : "This ticket was never scanned."}
          </p>
        )}
        <span
          className={`inline-flex items-center gap-2 rounded-full border bg-background px-3.5 py-1.5 text-sm font-semibold ${state === "valid" ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
          data-testid="pass-state"
        >
          {state === "valid" && <Check className="h-4 w-4" />}
          {state === "valid" ? "Valid · not scanned yet" : state === "checked_in" ? `Checked in ${format(ticket.checkedInAt as Date, "HH:mm")}` : stateLabel[state].label}
        </span>
      </div>
    </article>
  );
}
