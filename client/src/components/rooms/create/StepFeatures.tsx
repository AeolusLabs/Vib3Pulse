import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { resolveScreen } from "@shared/screen";
import { LINK_SCREENS, PROVIDER_LABEL } from "@/lib/roomsApi";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY, PINNED_MAX, SLOW_MODE_CHOICES, slowModeLabel } from "@/lib/createRoomWizardUi";
import { ChipGroup, SwitchRow } from "./parts";
import { FieldErr, type FieldError } from "./StepBasics";

interface Props {
  state: WizardState;
  set(patch: Partial<WizardState>): void;
  error: FieldError | null;
  directInteractions: boolean;
  setDirectInteractions(v: boolean): void;
  screenUrl: string;
  setScreenUrl(v: string): void;
  /** True only when a money flag is on AND the room is money-eligible (18+/21+, adult host). Never true while flags are off. */
  moneyPlaceholder: boolean;
}

export default function StepFeatures({ state, set, error, directInteractions, setDirectInteractions, screenUrl, setScreenUrl, moneyPlaceholder }: Props) {
  const pinnedLen = Array.from(state.pinned).length;
  const screenPreview = useMemo(() => {
    if (!LINK_SCREENS || !screenUrl.trim()) return null;
    const r = resolveScreen(screenUrl);
    return r.ok
      ? { ok: true as const, text: r.screen.embedUrl ? `Plays in the room: ${PROVIDER_LABEL[r.screen.provider]}` : r.screen.provider === "image" ? "Shows as an image" : "Shows as a link card" }
      : { ok: false as const, text: COPY.screenBad };
  }, [screenUrl]);

  return (
    <div className="space-y-4">
      <SwitchRow
        id="wiz-voice" label={COPY.voiceLabel} help={COPY.voiceHelp} checked={state.voice}
        // Live video rides on voice: switching voice off switches video off too.
        onChange={(v) => set(v ? { voice: true } : { voice: false, liveVideo: false })} testId="switch-room-voice"
      />
      <SwitchRow
        id="wiz-video" label={COPY.videoLabel} help={COPY.videoHelp} checked={state.liveVideo && state.voice}
        onChange={(v) => set({ liveVideo: v })} disabledReason={state.voice ? undefined : COPY.videoNeedsVoice} testId="switch-room-live-video"
      />

      <ChipGroup<number>
        legend={COPY.slowLegend} name="wiz-slow" value={state.slowModeSec} testId="chips-slow-mode"
        options={SLOW_MODE_CHOICES.map((s) => ({ value: s, label: slowModeLabel(s) }))}
        onPick={(s) => set({ slowModeSec: s })} help={COPY.slowHelp}
      />
      <FieldErr id="wiz-slow-err" error={error} field="slowModeSec" />

      <div className="space-y-2">
        <Label htmlFor="wiz-pinned">{COPY.pinnedLabel}</Label>
        <Textarea
          id="wiz-pinned" value={state.pinned} rows={3} placeholder={COPY.pinnedPlaceholder}
          onChange={(e) => set({ pinned: e.target.value })}
          aria-describedby="wiz-pinned-count" className="text-[16px]" data-testid="input-room-pinned"
        />
        <p id="wiz-pinned-count" className={`text-right text-xs ${pinnedLen > PINNED_MAX ? "text-destructive" : "text-muted-foreground"}`}>
          {pinnedLen} / {PINNED_MAX}
        </p>
        <FieldErr id="wiz-pinned-err" error={error} field={["pinned", "pinnedMessage"]} />
      </div>

      <SwitchRow
        id="wiz-direct" label={COPY.directLabel} help={COPY.directHelp} checked={directInteractions}
        onChange={setDirectInteractions} testId="switch-room-direct"
      />

      {LINK_SCREENS && (
        <div className="space-y-2">
          <Label htmlFor="wiz-screen">{COPY.screenLabel}</Label>
          <Input
            id="wiz-screen" value={screenUrl} onChange={(e) => setScreenUrl(e.target.value)} placeholder={COPY.screenPlaceholder}
            inputMode="url" className="h-11 text-[16px]" data-testid="input-room-screen"
          />
          {screenPreview && <p className={`text-xs ${screenPreview.ok ? "text-muted-foreground" : "text-destructive"}`} role="status">{screenPreview.text}</p>}
          <p className="text-xs text-muted-foreground">{COPY.screenHelp}</p>
        </div>
      )}

      {moneyPlaceholder && (
        <p aria-disabled="true" className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="money-placeholder">
          {COPY.moneyPlaceholder}
        </p>
      )}
    </div>
  );
}
