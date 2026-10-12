import { useEffect, useRef, useState } from "react";
import TicketPass from "./TicketPass";
import { useWakeLock } from "./useWakeLock";
import type { WalletTicket } from "./ticketModel";

/**
 * Swipe sideways between tickets. Tickets for the same event number themselves "1 of 2", "2 of 2".
 * Keeps the screen awake while open.
 */
export default function TicketDeck({ tickets, startId, holderName, onActiveChange }: {
  tickets: WalletTicket[];
  startId: string;
  holderName: string;
  onActiveChange?: (ticket: WalletTicket) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(Math.max(tickets.findIndex((t) => t.id === startId), 0));
  useWakeLock(true);

  // Jump to the tapped ticket on open (no animation).
  useEffect(() => {
    const el = track.current;
    if (el) el.scrollTo({ left: Math.max(tickets.findIndex((t) => t.id === startId), 0) * el.clientWidth });
    // Only when the requested ticket changes, not on every refetch of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startId]);

  useEffect(() => {
    if (tickets[active]) onActiveChange?.(tickets[active]);
  }, [active, tickets, onActiveChange]);

  return (
    <>
      <div
        ref={track}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto scrollbar-none"
        onScroll={(e) => {
          const el = e.currentTarget;
          setActive(Math.min(Math.round(el.scrollLeft / el.clientWidth), tickets.length - 1));
        }}
        data-testid="ticket-deck"
      >
        {tickets.map((t) => {
          const group = tickets.filter((x) => x.groupKey === t.groupKey);
          return (
            <div key={t.id} className="flex w-full flex-none snap-center flex-col overflow-y-auto px-4 pb-2 pt-2.5">
              <TicketPass ticket={t} holderName={holderName} index={group.findIndex((g) => g.id === t.id)} total={group.length} />
            </div>
          );
        })}
      </div>
      {tickets.length > 1 && (
        <div className="flex justify-center gap-1.5 py-1.5" data-testid="deck-dots">
          {tickets.map((t, i) => (
            <button
              key={t.id}
              type="button"
              aria-label={`Show ticket ${i + 1} of ${tickets.length}`}
              aria-current={i === active ? "true" : undefined}
              onClick={() => track.current?.scrollTo({ left: i * (track.current?.clientWidth ?? 0), behavior: "smooth" })}
              className={`h-[7px] rounded-full transition-all ${i === active ? "w-[18px] bg-primary" : "w-[7px] bg-border"}`}
            />
          ))}
        </div>
      )}
    </>
  );
}
