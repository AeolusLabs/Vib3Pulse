import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY, maxScheduleInput, minScheduleInput, toLocalInput } from "@/lib/createRoomWizardUi";
import { ChipGroup } from "./parts";
import { FieldErr, type FieldError } from "./StepBasics";

interface Props {
  state: WizardState;
  set(patch: Partial<WizardState>): void;
  error: FieldError | null;
  now: Date;
}

export default function StepWhen({ state, set, error, now }: Props) {
  const err = error?.field === "scheduledFor" || error?.field === "when";
  return (
    <div className="space-y-5">
      <ChipGroup<"now" | "later">
        legend={COPY.reviewWhen} name="wiz-when" value={state.when} testId="radio-when"
        options={[{ value: "now", label: COPY.whenNow }, { value: "later", label: COPY.whenLater }]}
        onPick={(w) => set(w === "later"
          // Offer a sensible start an hour from now, on the hour, instead of an empty box.
          ? { when: "later", scheduledFor: state.scheduledFor ?? toLocalInput(new Date(Math.ceil((now.getTime() + 3_600_000) / 3_600_000) * 3_600_000)) }
          : { when: "now" })}
      />
      {state.when === "later" && (
        <div className="space-y-2">
          <Label htmlFor="wiz-schedule">{COPY.whenInputLabel}</Label>
          <Input
            id="wiz-schedule" type="datetime-local" value={state.scheduledFor ?? ""}
            min={minScheduleInput(now)} max={maxScheduleInput(now)}
            onChange={(e) => set({ scheduledFor: e.target.value || null })}
            required aria-invalid={err || undefined} aria-describedby={err ? "wiz-schedule-err wiz-schedule-help" : "wiz-schedule-help"}
            className="h-11 text-[16px]" data-testid="input-room-schedule"
          />
          <p id="wiz-schedule-help" className="text-sm text-muted-foreground">{COPY.whenHelp}</p>
          <FieldErr id="wiz-schedule-err" error={error} field={["scheduledFor", "when"]} />
          <p className="text-sm text-muted-foreground">{COPY.scheduledFeatures}</p>
        </div>
      )}
    </div>
  );
}
