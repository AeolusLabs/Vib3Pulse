// Payments (task 6.3): what the signed-in person paid for in rooms (tickets, sprays) and refunds back to their card, newest
// first, with a printable receipt for each. The server lists the viewer's own rows only and pages them by a stable
// (created_at, id) cursor; rows are drawn in the order they arrive, each once. A receipt opens in a new tab as the
// server's own HTML page (escaped and locked down there); nothing of it is read or drawn here.
import { Link } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ChevronRightIcon, CreditCardIcon, ExternalLinkIcon, Loader2Icon, SparklesIcon, TicketIcon } from "@/components/ui/icons";
import { formatNaira } from "@/lib/roomTickets";
import { formatWhen } from "@/lib/roomsApi";
import { fetchPayments, paymentsKey } from "@/lib/earningsApi";
import {
  PAYMENTS_COPY, PAYMENT_KIND_LABEL, mergePayments, paymentStatusWord, readFailureMessage, receiptIdOk, receiptUrl,
  type PaymentItem, type PaymentsPage,
} from "./earningsUi";

/** A failed page, with the status so the words can say offline or signed out. */
class PageError extends Error {
  constructor(readonly status: number) { super(`payments page ${status}`); }
}

function KindIcon({ kind }: { kind: PaymentItem["kind"] }) {
  const cls = "h-5 w-5 shrink-0 text-primary";
  if (kind === "ticket") return <TicketIcon className={cls} aria-hidden />;
  if (kind === "spray") return <SparklesIcon className={cls} aria-hidden />;
  return <CreditCardIcon className={cls} aria-hidden />;
}

/** One row: what, when, the amount (a refund shows with a minus sign), the VAT inside it, the status and the receipt. */
export function PaymentRow({ item }: { item: PaymentItem }) {
  const status = paymentStatusWord(item.kind, item.status);
  return (
    <li className="flex items-start gap-3 rounded-2xl bg-muted/60 px-4 py-3" data-testid={`payment-${item.id}`} data-kind={item.kind}>
      <KindIcon kind={item.kind} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-semibold">{item.title}</p>
        <p className="text-sm text-muted-foreground">{[PAYMENT_KIND_LABEL[item.kind], formatWhen(item.at), status].filter(Boolean).join(" · ")}</p>
        {item.vatKobo !== 0 && <p className="text-xs text-muted-foreground">{PAYMENTS_COPY.vat(formatNaira(Math.abs(item.vatKobo)))}</p>}
        {receiptIdOk(item.id) && (
          <a
            href={receiptUrl(item.id)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
            aria-label={PAYMENTS_COPY.receiptLabel(item.title)}
            className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            data-testid={`payment-receipt-${item.id}`}
          >
            {PAYMENTS_COPY.receipt}<ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </div>
      <p className="shrink-0 font-semibold tabular-nums" data-testid={`payment-amount-${item.id}`}>{formatNaira(item.amountKobo)}</p>
    </li>
  );
}

/** The whole Payments body (the page adds the app's navigation; the dev fixture draws this on its own). */
export default function PaymentsView() {
  const q = useInfiniteQuery({
    queryKey: paymentsKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<PaymentsPage> => {
      const r = await fetchPayments(pageParam);
      if (!r.ok) throw new PageError(r.status);
      return r.data;
    },
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 0,
  });
  const items = q.data ? mergePayments(q.data.pages) : [];
  const failStatus = q.error instanceof PageError ? q.error.status : 500;

  return (
    <section className="space-y-5" aria-labelledby="payments-title" data-testid="room-payments">
      <header className="space-y-1">
        <h1 id="payments-title" className="font-serif text-3xl font-bold">{PAYMENTS_COPY.title}</h1>
        <p className="text-sm text-muted-foreground">{PAYMENTS_COPY.intro}</p>
      </header>

      {q.isLoading ? (
        <div className="grid place-items-center py-10">
          <span role="status" aria-label={PAYMENTS_COPY.loading}><Loader2Icon className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden /></span>
        </div>
      ) : q.isError && items.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-border p-6 text-center">
          <p role="alert" className="text-sm text-muted-foreground">{readFailureMessage(failStatus, PAYMENTS_COPY.loadFailed)}</p>
          <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => q.refetch()}>{PAYMENTS_COPY.retry}</Button>
        </div>
      ) : items.length === 0 ? (
        <div className="space-y-2 rounded-2xl border border-dashed border-border p-8 text-center" data-testid="payments-empty">
          <h2 className="font-serif text-2xl font-semibold">{PAYMENTS_COPY.emptyTitle}</h2>
          <p className="text-sm text-muted-foreground">{PAYMENTS_COPY.emptyBody}</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2" aria-label={PAYMENTS_COPY.title} data-testid="payments-list">
            {items.map((it) => <PaymentRow key={it.id} item={it} />)}
          </ul>
          {q.isFetchNextPageError && (
            <p role="alert" className="text-sm text-destructive">{readFailureMessage(failStatus, PAYMENTS_COPY.loadFailed)}</p>
          )}
          {q.hasNextPage && (
            <Button
              variant="outline" className="min-h-[44px] w-full rounded-full"
              onClick={() => { if (!q.isFetchingNextPage) void q.fetchNextPage(); }}
              aria-disabled={q.isFetchingNextPage || undefined} aria-busy={q.isFetchingNextPage || undefined} data-testid="button-payments-more"
            >
              {q.isFetchingNextPage && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {q.isFetchingNextPage ? PAYMENTS_COPY.loadingMore : PAYMENTS_COPY.more}
            </Button>
          )}
        </>
      )}

      <nav aria-label="Money" className="border-t border-border pt-4 text-sm">
        <Link href="/rooms/earnings" className="inline-flex min-h-[44px] items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid="link-earnings">
          {PAYMENTS_COPY.earningsLink}<ChevronRightIcon className="h-4 w-4" aria-hidden />
        </Link>
      </nav>
    </section>
  );
}
