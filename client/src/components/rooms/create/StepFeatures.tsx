import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { resolveScreen } from "@shared/screen";
import { LINK_SCREENS, PROVIDER_LABEL } from "@/lib/roomsApi";
import type { WizardState } from "@/lib/createRoomRules";
import { COPY, PINNED_MAX, SLOW_MODE_CHOICES, slowModeLabel } from "@/lib/createRoomWizardUi";
import { PRICE_COPY } from "@/lib/roomTickets";
import { DEFAULT_DROP_TIMEOUT_MS, DROP_TIMEOUTS_MS } from "@shared/gameScreen";
import { DROP_TIMEOUT_LABEL, GAME_COPY, GAME_FORMATS } from "@/lib/gameScreen";
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
  /**
   * The Paid room switch. Null (not drawn) unless the paidRooms flag is on and money is unlocked for this room. A host
   * who is not ID-verified sees it off with the reason (the server refuses HOST_NOT_VERIFIED anyway).
   */
  paid?: { on: boolean; set(on: boolean): void; needsId: boolean } | null;
  /** Why live video is off for this paid room (more tickets than ROOM_LIMITS.liveVideoMax), or null. */
  videoBlocked?: string | null;
  /** Gamers live: the server's flag is on, so the game format choice is offered (only for a room that goes live now with video). */
  gaming?: boolean;
  /** config.game.lanes: the "Separate age groups" switch is offered once a format is chosen. */
  gameLanes?: boolean;
}

export default function StepFeatures({ state, set, error, directInteractions, setDirectInteractions, screenUrl, setScreenUrl, moneyPlaceholder, paid = null, videoBlocked = null, gaming = false, gameLanes = false }: Props) {
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
      {/* A scheduled room can't store voice or live video yet: the host switches them on when they start it. */}
      {state.when === "later" && <p className="text-sm text-muted-foreground" data-testid="text-scheduled-features">{COPY.scheduledFeatures}</p>}
      <SwitchRow
        id="wiz-voice" label={COPY.voiceLabel} help={COPY.voiceHelp} checked={state.voice}
        // Live video rides on voice: switching voice off switches video off too.
        onChange={(v) => set(v ? { voice: true } : { voice: false, liveVideo: false })} testId="switch-room-voice"
      />
      <SwitchRow
        id="wiz-video" label={COPY.videoLabel} help={COPY.videoHelp} checked={state.liveVideo && state.voice && !videoBlocked}
        onChange={(v) => set({ liveVideo: v })} disabledReason={!state.voice ? COPY.videoNeedsVoice : videoBlocked ?? undefined} testId="switch-room-live-video"
      />

      {gaming && state.voice && state.liveVideo && !videoBlocked && (
        <div className="space-y-4" data-testid="game-format">
          <ChipGroup<number>
            legend={GAME_COPY.formatLegend} name="wiz-game-format" value={state.gameFormat ?? 0} testId="chips-game-format"
            options={[{ value: 0, label: GAME_COPY.formatOff }, ...GAME_FORMATS.map((n) => ({ value: n, label: `${n}v${n}` }))]}
            onPick={(n) => set({ gameFormat: n === 0 ? null : (n as 1 | 2 | 3 | 4) })} help={GAME_COPY.formatHelp}
          />
          {state.gameFormat && gameLanes && (
            <SwitchRow
              id="wiz-lanes" label={GAME_COPY.lanesLabel} help={GAME_COPY.lanesHelp} checked={state.lanes === true}
              onChange={(v) => set({ lanes: v })} testId="switch-game-lanes"
            />
          )}
          {state.gameFormat && (
            <ChipGroup<number>
              legend={GAME_COPY.dropLegend} name="wiz-game-drop" value={state.gameDropTimeoutMs ?? DEFAULT_DROP_TIMEOUT_MS} testId="chips-game-drop"
              options={DROP_TIMEOUTS_MS.map((ms) => ({ value: ms, label: DROP_TIMEOUT_LABEL[ms] }))}
              onPick={(ms) => set({ gameDropTimeoutMs: ms as 30000 | 120000 | 0 })} help={GAME_COPY.dropHelp}
            />
          )}
        </div>
      )}

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

      {paid && (
        <SwitchRow
          id="wiz-paid" label={PRICE_COPY.paidLabel} help={PRICE_COPY.paidHelp} checked={paid.on && !paid.needsId}
          onChange={paid.set} disabledReason={paid.needsId ? PRICE_COPY.paidNeedsId : undefined} testId="switch-room-paid"
        />
      )}

      {moneyPlaceholder && (
        <p aria-disabled="true" className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="money-placeholder">
          {COPY.moneyPlaceholder}
        </p>
      )}
    </div>
  );
}
