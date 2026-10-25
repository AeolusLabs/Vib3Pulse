// "Set the price" (img/f-price). Only drawn when GET /api/rooms/config says paidRooms is on AND the wizard's moneyLocked
// is null (18+ or 21+, adult host) AND the host switched Paid room on. Price in whole naira (ROOM_LIMITS ticket limits),
// the refund-before-start switch, and a live earnings estimate from shared/money.ts ticketBreakdown in whole naira,
// rounded down. The server checks everything again (canSellTickets, the limits) and charges its own stored price.
// A refusal that names none of this step's fields (NO_PAYOUT_ACCOUNT, HOST_NOT_VERIFIED, FEATURE_OFF, ROOM_NOT_ADULT,
// NOT_SCHEDULED) is shown in a general alert at the top, so it is never invisible.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MinusIcon, PlusIcon } from "@/components/ui/icons";
import {
  AMBER, PRICE_COPY, TICKET_CREATE_ERROR, TICKET_LIMITS, clampPriceNaira, clampTicketCapacity, earningsEstimate, estimateText, isPriceStepField,
  ticketsTooManyForVideo, type TicketDraft,
} from "@/lib/roomTickets";
import { DEFAULT_RATES } from "@shared/money";
import { useRoomsConfig } from "@/lib/roomsApi";
import VerifyAgeLink from "@/components/age-review/VerifyAgeLink";
import { SwitchRow } from "./parts";
import { FieldErr, type FieldError } from "./StepBasics";

interface Props {
  draft: TicketDraft;
  set(patch: Partial<TicketDraft>): void;
  error: FieldError | null;
  /** The host picked live video in the features step: say when the ticket count rules it out (above ROOM_LIMITS.liveVideoMax). */
  liveVideo?: boolean;
}

const stepBtn = "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

/** Whole numbers only: anything else in the box reads as NaN, so the step's check names it instead of guessing. */
const readWhole = (raw: string) => {
  const t = raw.replace(/[,\s₦]/g, "");
  return /^\d{1,7}$/.test(t) ? Number(t) : NaN;
};

export default function StepPrice({ draft, set, error, liveVideo = false }: Props) {
  const { data: config } = useRoomsConfig();
  const rates = config?.rates;
  const est = earningsEstimate(draft.priceNaira, draft.capacity, rates);
  const minN = TICKET_LIMITS.minKobo / 100, maxN = TICKET_LIMITS.maxKobo / 100;
  const priceErr = error?.field === "ticketPriceKobo";
  const capErr = error?.field === "ticketCapacity";
  const generalErr = error && !isPriceStepField(error.field) ? error.reason : null;
  return (
    <div className="space-y-5" data-testid="step-price">
      {generalErr && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="price-general-error">{generalErr}{generalErr === TICKET_CREATE_ERROR.HOST_NOT_VERIFIED && <> <VerifyAgeLink /></>}</p>}
      <div className="space-y-2">
        <Label htmlFor="wiz-price">{PRICE_COPY.priceLabel}</Label>
        <div className="flex items-center gap-2 rounded-2xl bg-muted/50 p-2">
          <button type="button" className={stepBtn} aria-label={PRICE_COPY.lower} disabled={Number.isFinite(draft.priceNaira) && draft.priceNaira <= minN}
            onClick={() => set({ priceNaira: clampPriceNaira((Number.isFinite(draft.priceNaira) ? draft.priceNaira : TICKET_LIMITS.defaultPriceNaira) - TICKET_LIMITS.priceStepNaira) })}
            data-testid="button-price-down"><MinusIcon className="h-5 w-5" aria-hidden /></button>
          <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
            <span className="text-3xl font-bold" aria-hidden>₦</span>
            <Input
              id="wiz-price" inputMode="numeric" autoComplete="off"
              value={Number.isFinite(draft.priceNaira) ? draft.priceNaira.toLocaleString("en-US") : ""}
              onChange={(e) => set({ priceNaira: readWhole(e.target.value) })}
              aria-invalid={priceErr || undefined} aria-describedby={`wiz-price-help${priceErr ? " wiz-price-err" : ""}`}
              className="h-12 w-40 border-0 bg-transparent text-center text-3xl font-bold shadow-none focus-visible:ring-2"
              data-testid="input-ticket-price"
            />
          </div>
          <button type="button" className={stepBtn} aria-label={PRICE_COPY.raise} disabled={Number.isFinite(draft.priceNaira) && draft.priceNaira >= maxN}
            onClick={() => set({ priceNaira: clampPriceNaira((Number.isFinite(draft.priceNaira) ? draft.priceNaira : TICKET_LIMITS.defaultPriceNaira) + TICKET_LIMITS.priceStepNaira) })}
            data-testid="button-price-up"><PlusIcon className="h-5 w-5" aria-hidden /></button>
        </div>
        <p id="wiz-price-help" className="text-xs text-muted-foreground">{PRICE_COPY.priceRange}</p>
        <FieldErr id="wiz-price-err" error={error} field="ticketPriceKobo" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="wiz-ticket-cap">{PRICE_COPY.capacityLabel}</Label>
        <div className="flex items-center gap-2 rounded-2xl bg-muted/50 p-2">
          <button type="button" className={stepBtn} aria-label={PRICE_COPY.fewer} disabled={draft.capacity <= TICKET_LIMITS.capacityMin}
            onClick={() => set({ capacity: clampTicketCapacity(draft.capacity - TICKET_LIMITS.capacityStep) })}
            data-testid="button-cap-down"><MinusIcon className="h-5 w-5" aria-hidden /></button>
          <Input
            id="wiz-ticket-cap" inputMode="numeric" autoComplete="off"
            value={Number.isFinite(draft.capacity) ? String(draft.capacity) : ""}
            onChange={(e) => set({ capacity: readWhole(e.target.value) })}
            aria-invalid={capErr || undefined} aria-describedby={capErr ? "wiz-ticket-cap-err" : undefined}
            className="h-12 flex-1 border-0 bg-transparent text-center text-3xl font-bold shadow-none focus-visible:ring-2"
            data-testid="input-ticket-capacity"
          />
          <button type="button" className={stepBtn} aria-label={PRICE_COPY.more} disabled={draft.capacity >= TICKET_LIMITS.capacityMax}
            onClick={() => set({ capacity: clampTicketCapacity(draft.capacity + TICKET_LIMITS.capacityStep) })}
            data-testid="button-cap-up"><PlusIcon className="h-5 w-5" aria-hidden /></button>
        </div>
        <FieldErr id="wiz-ticket-cap-err" error={error} field="ticketCapacity" />
        {liveVideo && ticketsTooManyForVideo(draft) && <p className="text-xs text-muted-foreground" data-testid="price-video-note">{PRICE_COPY.videoOver}</p>}
      </div>

      {/* The live estimate. Amber is a fill with its own text colour (never amber text on the page). Only the two numbers
          are live regions (always mounted, so a change is read out), not the labels or the note. */}
      <div className="space-y-2 rounded-2xl border border-border p-4 text-sm" data-testid="price-estimate">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{PRICE_COPY.perTicket}</span>
          <span aria-live="polite" aria-atomic="true" data-testid="estimate-per-ticket">
            {est && <span className={AMBER.chip}>{estimateText(est.perTicketKobo)}</span>}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{est ? PRICE_COPY.ifHalf(est.half) : null}</span>
          <span className="font-semibold tabular-nums" aria-live="polite" aria-atomic="true" data-testid="estimate-half">{est ? estimateText(est.halfKobo) : null}</span>
        </div>
        <p className="text-xs text-muted-foreground">{PRICE_COPY.feesNote(rates?.ticketPlatformPct ?? DEFAULT_RATES.ticket_platform)}</p>
      </div>

      <SwitchRow
        id="wiz-refund" label={PRICE_COPY.refundLabel} help={PRICE_COPY.refundHelp} checked={draft.refundBeforeStart}
        onChange={(v) => set({ refundBeforeStart: v })} testId="switch-refund-before-start"
      />

      <div className="rounded-xl border border-border p-3 text-sm">
        <p className="font-medium">{PRICE_COPY.payoutTitle}</p>
        <p className="text-muted-foreground">{PRICE_COPY.payoutBody}</p>
      </div>
    </div>
  );
}
