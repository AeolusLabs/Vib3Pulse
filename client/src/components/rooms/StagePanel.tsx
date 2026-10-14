import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import HostAvatar from "@/components/rooms/HostAvatar";
import type { RoomMemberView } from "@/lib/roomReducer";
import type { StageAction } from "@shared/stage";

interface Props {
  members: RoomMemberView[];
  stage: string[];
  hands: string[];
  voiceEnabled: boolean;
  /** Only the host can switch voice on and off. */
  canSwitchVoice: boolean;
  onSwitch: (enabled: boolean) => void;
  onStage: (action: StageAction, targetId: string) => void;
}

const nameOf = (m?: RoomMemberView) => (m ? m.displayName || m.organizationName || m.username || "Guest" : "Someone");

/** Host and co-host view of the mic: who is asking, who is speaking. You can also give the mic to anyone from the member list. */
export default function StagePanel({ members, stage, hands, voiceEnabled, canSwitchVoice, onSwitch, onStage }: Props) {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const speakers = stage.map((id) => byId.get(id)).filter(Boolean) as RoomMemberView[];
  const asking = hands.map((id) => byId.get(id)).filter(Boolean) as RoomMemberView[];
  return (
    <section aria-label="Stage" className="space-y-3 rounded-2xl border p-3" data-testid="stage-panel">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Voice</h2>
          <p className="text-xs text-muted-foreground">{voiceEnabled ? "The room can hear you. Give the mic to anyone you choose." : "Switch on to talk to the room."}</p>
        </div>
        {canSwitchVoice && <><Label htmlFor="voice-switch" className="sr-only">Voice</Label><Switch id="voice-switch" checked={voiceEnabled} onCheckedChange={onSwitch} data-testid="switch-voice" /></>}
      </div>
      {voiceEnabled && (
        <>
          <div>
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
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">On the mic ({speakers.length})</h3>
            {speakers.length === 0 ? <p className="py-1 text-sm text-muted-foreground">Only you and the co-hosts.</p> : (
              <ul className="space-y-1">
                {speakers.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2" data-testid={`speaker-${m.userId}`}>
                    <HostAvatar person={m} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{nameOf(m)}</span>
                    <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => onStage("remove", m.userId)} data-testid={`button-take-mic-${m.userId}`}>Take mic away</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
