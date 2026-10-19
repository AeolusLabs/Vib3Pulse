import type { AgeLimit } from "@shared/age";
import type { RoomVisibility } from "@shared/rooms";
import TeenHostNote from "@/components/rooms/TeenHostNote";
import { VISIBILITY_LABEL } from "@/lib/roomsApi";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY, VISIBILITY_HELP } from "@/lib/createRoomWizardUi";
import { ChipGroup, ChoiceRow } from "./parts";
import { FieldErr, type FieldError } from "./StepBasics";

export interface AgeOption { value: AgeLimit; label: string; sub: string; disabledReason?: string }
export interface VisibilityOption { value: RoomVisibility; disabledReason?: string }

interface Props {
  state: WizardState;
  set(patch: Partial<WizardState>): void;
  error: FieldError | null;
  ageOptions: AgeOption[];
  visibilityOptions: VisibilityOption[];
  /** The teen host note, already filtered to "not seen yet" by the wizard. */
  showTeenNote: boolean;
  onDismissTeenNote(): void;
}

export default function StepAudience({ state, set, error, ageOptions, visibilityOptions, showTeenNote, onDismissTeenNote }: Props) {
  return (
    <div className="space-y-5">
      {showTeenNote && <TeenHostNote onDismiss={onDismissTeenNote} />}

      <fieldset className="space-y-2" data-testid="radio-age-limit">
        <legend className="mb-2 text-sm font-medium">{COPY.ageLegend}</legend>
        {ageOptions.map((o) => (
          <ChoiceRow
            key={o.value} name="wiz-age" value={o.value} checked={state.ageLimit === o.value}
            label={o.label} sub={o.sub} disabledReason={o.disabledReason}
            onPick={() => set({ ageLimit: o.value })} testId={`radio-age-${o.value}`}
          />
        ))}
        <p className="text-sm text-muted-foreground">{COPY.ageHelp}</p>
        <FieldErr id="wiz-age-err" error={error} field="ageLimit" />
      </fieldset>

      <ChipGroup<RoomVisibility>
        legend={COPY.visibilityLegend} name="wiz-visibility" value={state.visibility} testId="radio-visibility"
        options={visibilityOptions.map((o) => ({ value: o.value, label: VISIBILITY_LABEL[o.value], disabledReason: o.disabledReason }))}
        onPick={(v) => set({ visibility: v })}
        help={VISIBILITY_HELP[state.visibility]}
      />
      <FieldErr id="wiz-visibility-err" error={error} field="visibility" />
    </div>
  );
}
