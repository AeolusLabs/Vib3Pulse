import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import HostAvatar from "@/components/rooms/HostAvatar";
import type { RoomMemberView } from "@/lib/roomReducer";
import type { StageAction } from "@shared/stage";
import type { LiveAction } from "@shared/liveScreen";
import { formatMmSs } from "@/lib/voiceState";

interface Props {
  members: RoomMemberView[];
  stage: string[];
  hands: string[];
  voiceEnabled: boolean;
  /** Only the host can switch voice on and off. */
  canSwitchVoice: boolean;
  onSwitch: (enabled: boolean) => void;
  onStage: (action: StageAction, targetId: string) => void;
  /** Live screen: the room has live video on, who holds the screen, who asked, and the host-only switch. */
  liveVideo: boolean;
  holder: string | null;
  liveAsks: string[];
  canSwitchLive: boolean;
  onSwitchLive: (enabled: boolean) => void;
  onLive: (action: LiveAction, targetId: string) => void;
  /** About how long the holder's spot is still held while their connection is down (ms), null while they are present. */
  holderAwayLeftMs: number | null;
  /**
   * Inside the Controls sheet's Stage tab: the requests have their own tab and the switches live in Settings, so both are
   * left out here. Everything else (on the mic, on the screen, take the mic, stop) is the same panel.
   */
  inTabs?: boolean;
  /** Extra buttons on a speaker's row (the Controls sheet adds Make co-host for the host). */
  speakerExtra?: (m: RoomMemberView) => ReactNode;
}

const nameOf = (m?: RoomMemberView) => (m ? m.displayName || m.organizationName || m.username || "Guest" : "Someone");

/** Host and co-host view of the mic: who is asking, who is speaking. You can also give the mic to anyone from the member list. */
export default function StagePanel({ members, stage, hands, voiceEnabled, canSwitchVoice, onSwitch, onStage, liveVideo, holder, liveAsks, canSwitchLive, onSwitchLive, onLive, holderAwayLeftMs, inTabs = false, speakerExtra }: Props) {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const speakers = stage.map((id) => byId.get(id)).filter(Boolean) as RoomMemberView[];
  const asking = hands.map((id) => byId.get(id)).filter(Boolean) as RoomMemberView[];
  const askingLive = liveAsks.map((id) => byId.get(id)).filter(Boolean) as RoomMemberView[];
  const onScreen = holder ? byId.get(holder) : undefined;
  return (
    <section aria-label="Stage" className="space-y-3 rounded-2xl border p-3" data-testid="stage-panel">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Voice</h2>
          <p className="text-xs text-muted-foreground">{voiceEnabled ? "The room can hear you. Give the mic to anyone you choose." : inTabs ? "Voice is off. The host can switch it on in Settings." : "Switch on to talk to the room."}</p>
        </div>
        {canSwitchVoice && !inTabs && <><Label htmlFor="voice-switch" className="sr-only">Voice</Label><Switch id="voice-switch" checked={voiceEnabled} onCheckedChange={onSwitch} data-testid="switch-voice" /></>}
      </div>
      {voiceEnabled && (
        <>
          {!inTabs && <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Asking to speak ({asking.length})</h3>
            {asking.length === 0 ? <p className="py-1 text-sm text-muted-foreground">Nobody right now.</p> : (
              <ul className="space-y-1">
                {asking.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2" data-testid={`hand-${m.userId}`}>
                    <HostAvatar person={m} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{nameOf(m)}</span>
                    <Button size="sm" className="min-h-[44px]" onClick={() => onStage("accept", m.userId)} data-testid={`button-give-mic-${m.userId}`}>Give mic</Button>
                    <Button size="sm" variant="ghost" className="min-h-[44px]" onClick={() => onStage("remove", m.userId)}>Dismiss</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">On the mic ({speakers.length})</h3>
            {speakers.length === 0 ? <p className="py-1 text-sm text-muted-foreground">Only you and the co-hosts.</p> : (
              <ul className="space-y-1">
                {speakers.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2" data-testid={`speaker-${m.userId}`}>
                    <HostAvatar person={m} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{nameOf(m)}</span>
                    {speakerExtra?.(m)}
                    <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => onStage("remove", m.userId)} data-testid={`button-take-mic-${m.userId}`}>Take mic away</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2 border-t pt-3" data-testid="live-panel">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">Live video</h3>
                <p className="text-xs text-muted-foreground">{liveVideo ? "One person at a time can stream their camera and mic to the screen." : inTabs ? "Live video is off. The host can switch it on in Settings." : "Switch on to let someone stream to the room."}</p>
              </div>
              {canSwitchLive && !inTabs && <><Label htmlFor="live-switch" className="sr-only">Live video</Label><Switch id="live-switch" checked={liveVideo} onCheckedChange={onSwitchLive} data-testid="switch-live-video" /></>}
            </div>
            {liveVideo && (
              <>
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">On the screen</h4>
                  {onScreen ? (
                    <div className="flex items-center gap-2" data-testid="live-holder">
                      <HostAvatar person={onScreen} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{nameOf(onScreen)}{holderAwayLeftMs !== null && <span className="ml-2 text-xs text-muted-foreground" data-testid="holder-away-left">Reconnecting, {formatMmSs(holderAwayLeftMs)} left</span>}</span>
                      <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => onLive("revoke", onScreen.userId)} data-testid="button-stop-holder">Stop</Button>
                    </div>
                  ) : <p className="py-1 text-sm text-muted-foreground">No one yet.</p>}
                </div>
                {!inTabs && <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Asking to go live ({askingLive.length})</h4>
                  {askingLive.length === 0 ? <p className="py-1 text-sm text-muted-foreground">Nobody right now. Only people on the mic can ask.</p> : (
                    <ul className="space-y-1">
                      {askingLive.map((m) => (
                        <li key={m.userId} className="flex items-center gap-2" data-testid={`live-ask-${m.userId}`}>
                          <HostAvatar person={m} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{nameOf(m)}</span>
                          <Button size="sm" className="min-h-[44px]" onClick={() => onLive("grant", m.userId)} data-testid={`button-grant-live-${m.userId}`}>Put on screen</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
