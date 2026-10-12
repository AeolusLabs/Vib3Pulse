import { useEffect, useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { CalendarPlus, Navigation, Share2, ShieldCheck, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadIcs } from "./ics";
import { whenLabel, type WalletTicket } from "./ticketModel";

interface NextUpCardProps {
  ticket: WalletTicket;
  quantity: number;
  onShow: () => void;
  onShare: () => void;
  showSafety: boolean;
}

/** The ticket you will need next: when, where, one big button to open it, and the few things people do before leaving. */
export default function NextUpCard({ ticket, quantity, onShow, onShare, showSafety }: NextUpCardProps) {
  // Re-evaluate every minute so "in 3 h" and "Happening now" stay true on a page left open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const when = whenLabel(ticket, now);

  return (
    <section className="overflow-hidden rounded-[18px] border bg-card" data-testid="card-next-up">
      <div className="relative h-24 bg-muted">
        {ticket.imageUrl && <img src={ticket.imageUrl} alt="" className="h-full w-full object-cover" />}
        <span
          className={`absolute left-3.5 top-2.5 rounded-full bg-background px-3 py-0.5 text-xs font-semibold uppercase tracking-[0.05em] ${when.live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
          data-testid="text-next-up-when"
        >
          {when.label}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 pb-4 pt-3.5">
        <div>
          <h2 className="font-serif text-[26px] font-bold leading-[1.1]">{ticket.title}</h2>
          <p className="text-[15px] text-muted-foreground">{ticket.place}</p>
        </div>
        <p className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-sm text-muted-foreground">
          <span>{ticket.kind === "venue" ? "Starts" : "Doors"} <b className="font-medium text-foreground">{format(ticket.doorsAt ?? ticket.startsAt, "h:mm a")}</b></span>
          <span>{quantity > 1 ? `${quantity} tickets` : "1 ticket"} <b className="font-medium text-foreground">{ticket.tierName ?? "General"}</b></span>
        </p>
        <Button className="h-12 w-full text-base font-semibold" onClick={onShow} data-testid="button-show-ticket">
          <Ticket className="mr-2 h-5 w-5" />Show ticket
        </Button>
        <div className="grid grid-cols-3 gap-2">
          {ticket.directionsUrl ? (
            <a href={ticket.directionsUrl} target="_blank" rel="noopener noreferrer" data-testid="link-directions">
              <Button variant="outline" className="h-11 w-full px-2 text-sm"><Navigation className="mr-1.5 h-4 w-4" />Directions</Button>
            </a>
          ) : (
            <Button variant="outline" className="h-11 px-2 text-sm" disabled><Navigation className="mr-1.5 h-4 w-4" />Directions</Button>
          )}
          <Button variant="outline" className="h-11 px-2 text-sm" onClick={() => downloadIcs(ticket)} data-testid="button-add-calendar">
            <CalendarPlus className="mr-1.5 h-4 w-4" />Calendar
          </Button>
          <Button variant="outline" className="h-11 px-2 text-sm" onClick={onShare} data-testid="button-share-ticket">
            <Share2 className="mr-1.5 h-4 w-4" />Share
          </Button>
        </div>
        {showSafety && (
          <Link href="/buddy/settings" className="flex items-center gap-3 rounded-xl border bg-background p-3 text-sm text-muted-foreground" data-testid="link-safety-buddy">
            <ShieldCheck className="h-6 w-6 flex-none text-primary" />
            <span><b className="block text-[15px] font-semibold text-foreground">Going out tonight?</b>Share your plans with your Safety Buddy.</span>
          </Link>
        )}
      </div>
    </section>
  );
}
