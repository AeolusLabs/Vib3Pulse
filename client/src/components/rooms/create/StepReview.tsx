import { KIND_LABEL, VISIBILITY_LABEL, ageLimitLabel, formatWhen } from "@/lib/roomsApi";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY, slowModeLabel } from "@/lib/createRoomWizardUi";
import { AMBER, PRICE_COPY } from "@/lib/roomTickets";
import { ReviewLine } from "./parts";

interface Props {
  state: WizardState;
  /** The age option's label from wizardOptions ("All ages", "18+"); the raw limit while the options are still loading. */
  ageText: string;
  linkedText: string | null;
  error: string | null;
  /** "₦5,000 · 100 tickets" for a paid room (price step on); null for a free room. */
  ticketText?: string | null;
  /** The ticket count of a paid room: the people line shows it instead of the free room's "up to 50". */
  ticketCount?: number | null;
}

export default function StepReview({ state, ageText, linkedText, error, ticketText = null, ticketCount = null }: Props) {
  const parsed = state.scheduledFor ? Date.parse(state.scheduledFor) : NaN;
  const features = [state.voice ? COPY.voiceLabel : null, state.voice && state.liveVideo ? COPY.videoLabel : null, state.voice && state.liveVideo && state.gameFormat ? `Game room, ${state.gameFormat}v${state.gameFormat}${state.lanes ? ", separate age groups" : ""}` : null].filter(Boolean).join(", ");
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border p-4">
        <p className="break-words text-base font-semibold">{state.title.trim()}</p>
        {state.description.trim() && <p className="mt-1 break-words text-sm text-muted-foreground">{state.description.trim()}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs">{ageLimitLabel(state.ageLimit)}</span>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">{KIND_LABEL[state.kind]}</span>
          {ticketText && <span className={AMBER.chip} data-testid="review-ticket-chip">{ticketText}</span>}
        </div>
      </div>

      <dl className="divide-y divide-border rounded-2xl border border-border px-4 py-1">
        <ReviewLine label={COPY.reviewAge} value={ageText} />
        <ReviewLine label={COPY.reviewVisibility} value={VISIBILITY_LABEL[state.visibility]} />
        <ReviewLine label={COPY.reviewPeople} value={ticketCount !== null ? PRICE_COPY.reviewTickets(ticketCount) : `up to ${state.capacity}`} />
        <ReviewLine label={COPY.reviewWhen} value={state.when === "now" ? COPY.reviewNow : Number.isNaN(parsed) ? "" : formatWhen(new Date(parsed).toISOString())} />
        <ReviewLine label={COPY.reviewFeatures} value={state.when === "later" ? COPY.scheduledFeatures : features || COPY.reviewNone} />
        <ReviewLine label={COPY.reviewSlow} value={slowModeLabel(state.slowModeSec)} />
        {state.pinned.trim() && <ReviewLine label={COPY.reviewPinned} value={<span className="break-words">{state.pinned.trim()}</span>} />}
        {linkedText && <ReviewLine label={COPY.reviewLinked} value={linkedText} />}
        {ticketText && <ReviewLine label={PRICE_COPY.reviewTicket} value={ticketText} />}
      </dl>

      <p className="text-sm text-muted-foreground">{COPY.reviewSafety}</p>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="text-create-room-error">{error}</p>}
    </div>
  );
}
