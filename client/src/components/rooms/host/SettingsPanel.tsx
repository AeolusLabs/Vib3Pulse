import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTROLS_COPY, PINNED_MAX, RECONCILE_MS, SLOW_MODE_OPTIONS, controlsFor, isEmptyPatch, mergeOptimistic, normalizePinned, pendingSettled,
  settingsErrorMessage, settingsPatch, slowModeLabel, type ControlsRole, type HostSettings, type SettingsPatch,
} from "@/lib/hostControls";

export interface SettingsPanelProps {
  role: ControlsRole;
  /** What the server last said (room:state / room:settings, then the room details). */
  settings: HostSettings;
  /** PATCH /api/rooms/:id with only the changed fields. Null when saved, else the server's message. */
  onSave(patch: SettingsPatch): Promise<string | null>;
  voiceEnabled: boolean;
  liveVideo: boolean;
  onSwitchVoice(on: boolean): Promise<boolean>;
  onSwitchLive(on: boolean): Promise<boolean>;
  /** The money placeholder (moneyPlaceholderVisible). False renders nothing. */
  showMoney: boolean;
  /** Host only: the existing host block (invite link, Invite an adult in a minors' room, waves switch). */
  hostExtras?: ReactNode;
  /** One plain line for a failure. */
  onMessage(message: string): void;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const ROW = "flex min-h-[56px] items-center justify-between gap-4 rounded-2xl border bg-muted px-3.5 py-2";

/**
 * Room settings. Changes show at once and settle on the server's room:settings (which everyone in the room gets); if that
 * has not arrived within about a second the server's value shows again, and a refused save puts it back with a plain line.
 */
export default function SettingsPanel({ role, settings, onSave, voiceEnabled, liveVideo, onSwitchVoice, onSwitchLive, showMoney, hostExtras, onMessage }: SettingsPanelProps) {
  const can = controlsFor(role);
  const ids = useId();
  const [pending, setPending] = useState<SettingsPatch | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (pending && pendingSettled(settings, pending)) { clearTimeout(timer.current); setPending(null); } }, [settings, pending]);
  const shown = mergeOptimistic(settings, pending);

  const save = async (draft: SettingsPatch) => {
    const patch = settingsPatch(shown, draft, role);
    if (isEmptyPatch(patch)) return true;
    clearTimeout(timer.current);
    setPending((p) => ({ ...(p ?? {}), ...patch }));
    const err = await onSave(patch);
    if (err !== null) {
      setPending(null);
      onMessage(settingsErrorMessage(err));
      return false;
    }
    timer.current = setTimeout(() => setPending(null), RECONCILE_MS);
    return true;
  };

  // Pinned message draft: follows the server while you are not editing it.
  const [draft, setDraft] = useState(shown.pinnedMessage ?? "");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(shown.pinnedMessage ?? ""); }, [shown.pinnedMessage, editing]);
  const unchanged = normalizePinned(draft) === shown.pinnedMessage;
  const savePinned = async (value: string | null) => {
    const ok = await save({ pinnedMessage: value });
    if (ok) { setEditing(false); if (value === null) setDraft(""); }
  };

  // Voice and live video keep their own endpoints and events (room:voice / room:livevideo); the switch shows the asked-for value meanwhile.
  const [voiceAsk, setVoiceAsk] = useState<boolean | null>(null);
  const [liveAsk, setLiveAsk] = useState<boolean | null>(null);
  const switchVoice = async (on: boolean) => {
    setVoiceAsk(on);
    if (!(await onSwitchVoice(on))) onMessage(on ? "Voice isn't available right now." : "Couldn't switch voice off.");
    setVoiceAsk(null);
  };
  const switchLive = async (on: boolean) => {
    setLiveAsk(on);
    if (!(await onSwitchLive(on))) onMessage(on ? "Live video isn't available for this room." : "Couldn't switch live video off.");
    setLiveAsk(null);
  };

  return (
    <div className="space-y-4" data-testid="settings-panel">
      <section aria-labelledby={`${ids}-pin`} className="space-y-2">
        <Label id={`${ids}-pin`} htmlFor={`${ids}-pin-text`} className="text-sm font-semibold">{CONTROLS_COPY.pinnedLabel}</Label>
        <Textarea
          id={`${ids}-pin-text`}
          value={draft}
          maxLength={PINNED_MAX}
          rows={3}
          placeholder="House rules, a link to the playlist, what's on tonight"
          onChange={(e) => { setEditing(true); setDraft(e.target.value.slice(0, PINNED_MAX)); }}
          aria-describedby={`${ids}-pin-note ${ids}-pin-count`}
          className="resize-none rounded-2xl text-base"
          data-testid="input-pinned"
        />
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span id={`${ids}-pin-note`}>{CONTROLS_COPY.pinnedNote}</span>
          <span id={`${ids}-pin-count`} className={draft.length >= PINNED_MAX ? "font-semibold text-destructive" : undefined} data-testid="pinned-count">{draft.length}/{PINNED_MAX}</span>
        </div>
        <div className="flex gap-2">
          <Button className={`min-h-[44px] rounded-full px-5 ${FOCUS}`} disabled={unchanged} onClick={() => void savePinned(normalizePinned(draft))} data-testid="button-save-pinned">{CONTROLS_COPY.pinnedSave}</Button>
          {shown.pinnedMessage !== null && (
            <Button variant="outline" className={`min-h-[44px] rounded-full px-5 ${FOCUS}`} onClick={() => void savePinned(null)} data-testid="button-clear-pinned">{CONTROLS_COPY.pinnedClear}</Button>
          )}
        </div>
      </section>

      {!can.editSlowMode && <p className="text-sm text-muted-foreground" data-testid="cohost-settings-note">{CONTROLS_COPY.cohostSettingsNote}</p>}

      {can.editSlowMode && (
        <section aria-labelledby={`${ids}-slow`} className="space-y-2">
          <h3 id={`${ids}-slow`} className="text-sm font-semibold">{CONTROLS_COPY.slowModeLabel}</h3>
          <div role="group" aria-labelledby={`${ids}-slow`} aria-describedby={`${ids}-slow-note`} className="flex flex-wrap gap-2">
            {SLOW_MODE_OPTIONS.map((sec) => {
              const on = shown.slowModeSec === sec;
              return (
                <button
                  key={sec} type="button" aria-pressed={on} onClick={() => void save({ slowModeSec: sec })}
                  className={`min-h-[44px] min-w-[56px] rounded-full border px-4 text-sm font-semibold motion-safe:transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary"} ${FOCUS}`}
                  data-testid={`chip-slow-${sec}`}
                >
                  {slowModeLabel(sec)}
                </button>
              );
            })}
          </div>
          <p id={`${ids}-slow-note`} className="text-xs text-muted-foreground">{CONTROLS_COPY.slowModeNote}</p>
        </section>
      )}

      {can.lockRoom && (
        <div className={ROW}>
          <div className="min-w-0">
            <Label htmlFor={`${ids}-lock`} className="font-semibold">{CONTROLS_COPY.lockLabel}</Label>
            <p id={`${ids}-lock-note`} className="text-xs text-muted-foreground">{CONTROLS_COPY.lockNote}</p>
          </div>
          <Switch id={`${ids}-lock`} checked={shown.locked} onCheckedChange={(v) => void save({ locked: v })} aria-describedby={`${ids}-lock-note`} data-testid="switch-lock" />
        </div>
      )}

      {can.switchVoice && (
        <div className={ROW}>
          <div className="min-w-0">
            <Label htmlFor={`${ids}-voice`} className="font-semibold">{CONTROLS_COPY.voiceLabel}</Label>
            <p className="text-xs text-muted-foreground">{voiceEnabled ? "The room can hear the host, co-hosts and whoever has the mic." : "Switch on to talk to the room."}</p>
          </div>
          <Switch id={`${ids}-voice`} checked={voiceAsk ?? voiceEnabled} disabled={voiceAsk !== null} onCheckedChange={(v) => void switchVoice(v)} data-testid="switch-voice" />
        </div>
      )}

      {can.switchLive && (
        <div className={ROW}>
          <div className="min-w-0">
            <Label htmlFor={`${ids}-live`} className="font-semibold">{CONTROLS_COPY.liveLabel}</Label>
            <p className="text-xs text-muted-foreground">{!voiceEnabled ? "Needs voice on first." : liveVideo ? "One person at a time streams their camera and mic." : "Switch on to let someone stream to the room."}</p>
          </div>
          <Switch id={`${ids}-live`} checked={liveAsk ?? liveVideo} disabled={liveAsk !== null || (!voiceEnabled && !liveVideo)} onCheckedChange={(v) => void switchLive(v)} data-testid="switch-live-video" />
        </div>
      )}

      {showMoney && (
        // Placeholder only: money controls are not built in this phase. Never rendered while the money flags are off.
        <div className={`${ROW} opacity-60`} aria-disabled="true" data-testid="money-placeholder">
          <div className="min-w-0">
            <span className="block font-semibold">{CONTROLS_COPY.moneyLabel}</span>
            <span className="block text-xs text-muted-foreground">{CONTROLS_COPY.moneyNote}</span>
          </div>
          <Switch checked={false} disabled aria-label={CONTROLS_COPY.moneyLabel} />
        </div>
      )}

      {can.hostExtras && hostExtras}
    </div>
  );
}
