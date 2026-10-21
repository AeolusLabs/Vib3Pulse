// Earnings (flows.html board 8, img/f-earn): the period's total on the amber card (a money moment, amber fill with its
// own text colour, 4.5:1 on both themes), then what has settled, what is on its way and what is held for tickets, a
// reversed payment if there is one, and the rooms it came from. Every number is the server's, read from stored rows for
// the signed-in user only; "settled" is the server's word for money Paystack reported as settled, everything else is
// "on its way". Nothing is added up here except the headline and each room's line (spray plus ticket, both from the server).
import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon, ChevronRightIcon, Loader2Icon, SparklesIcon } from "@/components/ui/icons";
import { AMBER, formatDeduction, formatNairaWhole } from "@/lib/roomTickets";
import { formatWhen, useRoomsConfig } from "@/lib/roomsApi";
import { earningsKey, fetchEarnings, fetchPayoutStatus, payoutStatusKey } from "@/lib/earningsApi";
import {
  EARNINGS_COPY, EARNINGS_RANGES, canLinkHere, earningsEmpty, earningsHeadline, payoutStage, readFailureMessage, roomKindLine,
  type Earnings, type EarningsRange,
} from "./earningsUi";

/** Earnings are never overstated: whole naira, rounded down. */
const money = (kobo: number) => formatNairaWhole(kobo, "floor");

function Row({ label, help, value, testId }: { label: string; help?: string | null; value: string; testId: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">
        {label}
        {help && <span className="block text-xs">{help}</span>}
      </dt>
      <dd className="font-semibold tabular-nums text-foreground" data-testid={testId}>{value}</dd>
    </div>
  );
}

/** The numbers on their own (the page and the dev fixture both draw this). */
export function EarningsBody({ e, range }: { e: Earnings; range: EarningsRange }) {
  if (earningsEmpty(e)) {
    return (
      <div className="space-y-2 rounded-2xl border border-dashed border-border p-8 text-center" data-testid="earnings-empty">
        <SparklesIcon className="mx-auto h-8 w-8 text-primary" aria-hidden />
        <h2 className="font-serif text-2xl font-semibold">{EARNINGS_COPY.emptyTitle}</h2>
        <p className="text-sm text-muted-foreground">{EARNINGS_COPY.emptyBody}</p>
      </div>
    );
  }
  return (
    <div className="space-y-5" data-testid="earnings-body">
      <div className={`rounded-2xl p-5 ${AMBER.fill}`} data-testid="earnings-headline-card">
        <p className="text-sm">{EARNINGS_COPY.range[range]}</p>
        <p className="font-sans text-5xl font-bold tabular-nums" data-testid="earnings-headline">{money(earningsHeadline(e))}</p>
      </div>

      <dl className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
        <Row label={EARNINGS_COPY.settled} value={money(e.settledKobo)} testId="earnings-settled" />
        {e.split ? (
          <>
            {/* The server's split: onItsWay = sprayDirect + ticketSending. Failed payouts and shares being clawed back
                are separate figures (their own card and row), never counted as on their way or in the bank. */}
            <Row
              label={range === "week" ? EARNINGS_COPY.sprayDirect : EARNINGS_COPY.sprayDirectLong}
              help={range === "week" ? EARNINGS_COPY.sprayDirectHelp : EARNINGS_COPY.sprayDirectLongHelp}
              value={money(e.split.sprayDirectKobo)} testId="earnings-spray-direct"
            />
            {e.split.ticketSendingKobo > 0 && <Row label={EARNINGS_COPY.ticketSending} value={money(e.split.ticketSendingKobo)} testId="earnings-ticket-sending" />}
            {e.split.sprayReturnedKobo > 0 && (
              <Row label={EARNINGS_COPY.sprayReturned} help={EARNINGS_COPY.sprayReturnedHelp} value={money(e.split.sprayReturnedKobo)} testId="earnings-spray-returned" />
            )}
          </>
        ) : (
          // An older server with no split. Month and all time hold older spray money that is often already in the bank:
          // never "next business day" for it.
          <Row
            label={range === "week" ? EARNINGS_COPY.onItsWay : EARNINGS_COPY.onItsWayLong}
            help={range === "week" ? EARNINGS_COPY.onItsWayHelp : EARNINGS_COPY.onItsWayLongHelp}
            value={money(e.onItsWayKobo)} testId="earnings-on-its-way"
          />
        )}
        <Row
          label={EARNINGS_COPY.held}
          help={e.nextTicketReleaseAt ? EARNINGS_COPY.nextRelease(formatWhen(e.nextTicketReleaseAt)) : null}
          value={money(e.heldTicketKobo)} testId="earnings-held"
        />
      </dl>

      {e.split && e.split.needsAttentionKobo > 0 && (
        <div role="status" className="space-y-1 rounded-2xl border border-destructive/60 p-4" data-testid="earnings-needs-attention">
          <dl className="text-sm"><Row label={EARNINGS_COPY.needsAttention} value={money(e.split.needsAttentionKobo)} testId="earnings-needs-attention-amount" /></dl>
          <p className="text-sm">{EARNINGS_COPY.needsAttentionHelp}</p>
        </div>
      )}

      {e.clawbackOpenKobo > 0 && (
        <div role="status" className="space-y-2 rounded-2xl border border-destructive/60 p-4" data-testid="earnings-clawback">
          <h2 className="flex items-center gap-2 font-semibold"><AlertTriangleIcon className="h-5 w-5 text-destructive" aria-hidden />{EARNINGS_COPY.clawbackTitle}</h2>
          <p className="text-sm">{EARNINGS_COPY.clawbackBody(formatNairaWhole(e.clawbackOpenKobo, "ceil"))}</p>
          <dl className="text-sm"><Row label={EARNINGS_COPY.clawbackLabel} value={formatDeduction(e.clawbackOpenKobo)} testId="earnings-clawback-amount" /></dl>
        </div>
      )}

      {e.byRoom.length > 0 && (
        <section aria-labelledby="earnings-by-room" className="space-y-2">
          <h2 id="earnings-by-room" className="font-semibold">{EARNINGS_COPY.byRoom}</h2>
          <ul className="space-y-2">
            {e.byRoom.map((r) => (
              <li key={r.roomId}>
                <Link
                  href={`/rooms/${encodeURIComponent(r.roomId)}`}
                  className="flex min-h-[56px] items-center gap-3 rounded-2xl bg-muted/60 px-4 py-3 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  data-testid={`earnings-room-${r.roomId}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{r.title}</span>
                    <span className="block text-sm text-muted-foreground">{roomKindLine(r)}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(r.sprayKobo + r.ticketKobo)}</span>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const linkCls = "inline-flex min-h-[44px] items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

/** The whole Earnings body (the page adds the app's navigation; the dev fixture draws this on its own). */
export default function EarningsView({ initialRange = "week" }: { initialRange?: EarningsRange }) {
  const [range, setRange] = useState<EarningsRange>(initialRange);
  const tabs = useRef<Record<string, HTMLButtonElement | null>>({});
  const q = useQuery({ queryKey: earningsKey(range), queryFn: () => fetchEarnings(range), staleTime: 0 });
  const status = useQuery({ queryKey: payoutStatusKey, queryFn: fetchPayoutStatus, staleTime: 0 });
  const res = q.data;
  const config = useRoomsConfig();
  const moneyOn = config.data?.features.paidRooms === true || config.data?.features.spray === true;
  // Only when the server says this person cannot be paid yet. A set-up account ("setup", "ready") and one Paystack is still
  // finishing ("pending") are never told to add one.
  const stage = status.data?.ok === true ? payoutStage(status.data.data, moneyOn) : null;
  const needsAccount = stage === "unverified" || stage === "none" || stage === "soon" || stage === "mismatch";
  const canLink = status.data?.ok === true && canLinkHere(status.data.data, moneyOn);

  const onKey = (ev: KeyboardEvent) => {
    const i = EARNINGS_RANGES.indexOf(range);
    const next = ev.key === "ArrowRight" ? EARNINGS_RANGES[(i + 1) % EARNINGS_RANGES.length]
      : ev.key === "ArrowLeft" ? EARNINGS_RANGES[(i + EARNINGS_RANGES.length - 1) % EARNINGS_RANGES.length] : null;
    if (!next) return;
    ev.preventDefault();
    setRange(next);
    tabs.current[next]?.focus();
  };

  return (
    <section className="space-y-5" aria-labelledby="earnings-title" data-testid="room-earnings">
      <header className="space-y-1">
        <h1 id="earnings-title" className="font-serif text-3xl font-bold">{EARNINGS_COPY.title}</h1>
        <p className="text-sm text-muted-foreground">{EARNINGS_COPY.intro}</p>
      </header>

      {needsAccount && (
        <div className="space-y-2 rounded-2xl border border-border p-4" data-testid="earnings-no-account">
          <h2 className="font-semibold">{EARNINGS_COPY.noAccountTitle}</h2>
          <p className="text-sm text-muted-foreground">{canLink ? EARNINGS_COPY.noAccountBody : EARNINGS_COPY.noAccountSoonBody}</p>
          <Button asChild className="min-h-[44px] rounded-full"><Link href="/rooms/payouts" data-testid="link-setup-payouts">{EARNINGS_COPY.noAccountCta}</Link></Button>
        </div>
      )}

      <div role="tablist" aria-label={EARNINGS_COPY.rangeLabel} className="flex gap-1 rounded-full border border-border p-1" onKeyDown={onKey}>
        {EARNINGS_RANGES.map((r) => {
          const on = r === range;
          return (
            <button
              key={r} ref={(el) => { tabs.current[r] = el; }} type="button" role="tab" id={`earnings-tab-${r}`} aria-selected={on} aria-controls="earnings-panel"
              tabIndex={on ? 0 : -1} onClick={() => setRange(r)} data-testid={`tab-earnings-${r}`}
              className={`flex min-h-[44px] flex-1 items-center justify-center rounded-full px-3 text-sm transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {EARNINGS_COPY.range[r]}
            </button>
          );
        })}
      </div>

      <div id="earnings-panel" role="tabpanel" aria-labelledby={`earnings-tab-${range}`} aria-busy={q.isLoading}>
        {q.isLoading || !res ? (
          <div className="grid place-items-center py-10">
            <span role="status" aria-label={EARNINGS_COPY.loading}><Loader2Icon className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden /></span>
          </div>
        ) : !res.ok ? (
          <div className="space-y-3 rounded-2xl border border-border p-6 text-center">
            <p role="alert" className="text-sm text-muted-foreground">{readFailureMessage(res.status, EARNINGS_COPY.loadFailed)}</p>
            <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => q.refetch()}>{EARNINGS_COPY.retry}</Button>
          </div>
        ) : (
          <EarningsBody e={res.data} range={range} />
        )}
      </div>

      <nav aria-label="Money" className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
        <Link href="/rooms/payouts" className={linkCls} data-testid="link-payouts">{EARNINGS_COPY.payoutLink}<ChevronRightIcon className="h-4 w-4" aria-hidden /></Link>
        <Link href="/rooms/payments" className={linkCls} data-testid="link-payments">{EARNINGS_COPY.paymentsLink}<ChevronRightIcon className="h-4 w-4" aria-hidden /></Link>
      </nav>
    </section>
  );
}
