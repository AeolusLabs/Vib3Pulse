import { format } from "date-fns";
import { daysLeftLabel, salesDaysLeft, salesEndInstant } from "@shared/ticketSales";
import { Button } from "@/components/ui/button";
import { MinusIcon, PlusIcon, TicketIcon } from "@/components/ui/icons";
import { formatPrice } from "./format";

export interface PickerTier {
  id: string;
  name: string;
  description?: string | null;
  priceSmallestUnit: number;
  currency?: string | null;
  quantity: number;
  sold: number;
  salesEndDate?: string | Date | null;
}

export interface Quote {
  baseAmount: number;
  fee: number;
  total: number;
}

interface Props {
  tiers: PickerTier[];
  currency?: string | null;
  selectedTier: string | null;
  onSelectTier: (id: string) => void;
  quantity: number;
  onQuantity: (n: number) => void;
  maxQuantity: number;
  quote?: Quote;
  fallbackTotal: number;
}

const LOW_STOCK = 10;
const SALES_URGENT_DAYS = 3;

export interface TierStatus {
  label: string; // stock state: Available / Only N left / Sold out / Sales ended
  available: boolean;
  urgent: boolean; // low stock
  salesNote?: string; // "Sales end Tue 20 Oct · 13 days left" — shown whenever the tier has an end date
  salesUrgent?: boolean; // ending within a few days
}

// Availability copy never relies on colour alone — the words carry the state.
export function tierStatus(t: PickerTier, now = Date.now()): TierStatus {
  const remaining = t.quantity - t.sold;
  const end = salesEndInstant(t.salesEndDate);
  const ended = end !== null && now >= end;
  const days = t.salesEndDate && !ended ? salesDaysLeft(t.salesEndDate, new Date(now)) : null;
  const salesNote = t.salesEndDate && days !== null && days >= 0
    ? `Sales end ${format(new Date(t.salesEndDate), "EEE d MMM")} · ${daysLeftLabel(days)}`
    : undefined;
  const salesUrgent = days !== null && days <= SALES_URGENT_DAYS;

  if (ended) return { label: "Sales ended", available: false, urgent: false };
  if (remaining <= 0) return { label: "Sold out", available: false, urgent: false };
  if (remaining <= LOW_STOCK) return { label: `Only ${remaining} left`, available: true, urgent: true, salesNote, salesUrgent };
  return { label: "Available", available: true, urgent: false, salesNote, salesUrgent };
}

// Earliest upcoming sales deadline across tiers still on sale — drives the section summary.
export function nextSalesDeadline(tiers: PickerTier[], now = Date.now()): { date: Date; days: number } | null {
  const ends = tiers
    .filter((t) => t.salesEndDate && tierStatus(t, now).available)
    .map((t) => new Date(t.salesEndDate as string | Date))
    .sort((a, b) => +a - +b);
  if (!ends.length) return null;
  return { date: ends[0], days: salesDaysLeft(ends[0], new Date(now)) };
}

export default function TicketPicker({
  tiers, currency, selectedTier, onSelectTier, quantity, onQuantity, maxQuantity, quote, fallbackTotal,
}: Props) {
  const showSummary = selectedTier !== null;
  const total = quote?.total ?? fallbackTotal;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Ticket type" className="space-y-2" data-testid="ticket-tiers-list">
        {tiers.map((t, i) => {
          const st = tierStatus(t);
          const selected = selectedTier === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!st.available}
              disabled={!st.available}
              onClick={() => onSelectTier(t.id)}
              data-testid={`ticket-tier-${i}`}
              className={[
                "w-full flex items-center justify-between gap-3 rounded-xl border p-3.5 text-left min-h-[56px]",
                "transition-[border-color,background-color,transform] duration-150 ease-out active:scale-[0.99]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/40",
                !st.available ? "opacity-55 cursor-not-allowed active:scale-100" : "cursor-pointer",
              ].join(" ")}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium truncate" data-testid={`tier-name-${i}`}>{t.name}</span>
                {t.description && <span className="block text-xs text-muted-foreground line-clamp-2">{t.description}</span>}
                <span className={`block text-xs mt-0.5 ${st.urgent ? "text-amber-500 font-medium" : "text-muted-foreground"}`}>
                  {st.label}
                </span>
                {st.salesNote && (
                  <span className={`block text-xs ${st.salesUrgent ? "text-amber-500 font-medium" : "text-muted-foreground"}`}>
                    {st.salesNote}
                  </span>
                )}
              </span>
              <span className="font-semibold flex-shrink-0" data-testid={`tier-price-${i}`}>
                {formatPrice(t.priceSmallestUnit, t.currency ?? currency)}
              </span>
            </button>
          );
        })}
      </div>

      {showSummary && (
        <div className="rounded-xl border p-3.5 space-y-3" data-testid="ticket-summary">
          <div className="flex items-center justify-between">
            <span id="qty-label" className="text-sm font-medium">Quantity</span>
            <div className="flex items-center gap-1" role="group" aria-labelledby="qty-label">
              <Button
                type="button" variant="outline" size="icon" className="h-11 w-11 rounded-full active:scale-[0.95] transition-transform"
                onClick={() => onQuantity(Math.max(1, quantity - 1))} disabled={quantity <= 1}
                aria-label="Fewer tickets" data-testid="button-quantity-decrease"
              >
                <MinusIcon className="h-4 w-4" />
              </Button>
              <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite" data-testid="text-quantity">{quantity}</span>
              <Button
                type="button" variant="outline" size="icon" className="h-11 w-11 rounded-full active:scale-[0.95] transition-transform"
                onClick={() => onQuantity(Math.min(maxQuantity, quantity + 1))} disabled={quantity >= maxQuantity}
                aria-label="More tickets" data-testid="button-quantity-increase"
              >
                <PlusIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {quote && quote.fee > 0 && (
            <div className="space-y-1 text-sm text-muted-foreground">
              <div className="flex justify-between"><span>Tickets</span><span className="tabular-nums">{formatPrice(quote.baseAmount, currency)}</span></div>
              <div className="flex justify-between"><span>Booking fee</span><span className="tabular-nums">{formatPrice(quote.fee, currency)}</span></div>
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1.5"><TicketIcon className="h-4 w-4" />Total</span>
            <span className="font-bold text-base tabular-nums" data-testid="text-purchase-total">{formatPrice(total, currency)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
