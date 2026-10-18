import { Button } from "@/components/ui/button";
import { AlertTriangleIcon, Loader2Icon, VolumeXIcon, Volume2Icon } from "@/components/ui/icons";
import type { RoomVoice } from "@/hooks/useRoomVoice";

interface Props {
  voice: RoomVoice;
  /** Guests only: ask the host for the microphone. */
  hasHand: boolean;
  canAskToSpeak: boolean;
  onRaise: () => void;
  onLower: () => void;
}

/** The room's audio controls: tap to hear, mic for speakers, raise hand for listeners. Renders nothing while voice is off. */
export default function VoiceBar({ voice, hasHand, canAskToSpeak, onRaise, onLower }: Props) {
  const { status } = voice;
  if (status === "off") return null;
  return (
    <section aria-label="Room audio" className="space-y-2 rounded-2xl border p-3" data-testid="voice-bar" data-status={status}>
      {status === "needs-tap" && (
        <Button className="min-h-[44px] w-full" onClick={() => void voice.unlock()} data-testid="button-hear-room"><Volume2Icon className="mr-2 h-4 w-4" />Tap to hear the room</Button>
      )}
      {status === "connecting" && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2Icon className="h-4 w-4 animate-spin" aria-hidden />Connecting audio…</p>}
      {status === "error" && (
        <div className="flex items-center justify-between gap-3" role="alert">
          <p className="flex items-center gap-2 text-sm"><AlertTriangleIcon className="h-4 w-4 text-destructive" aria-hidden />{voice.error ?? "Audio couldn't connect."}</p>
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => void voice.unlock()}>Try again</Button>
        </div>
      )}
      {(status === "listening" || status === "speaking") && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto flex items-center gap-2 text-sm" role="status" data-testid="voice-status">
            {status === "speaking" ? <><Volume2Icon className="h-4 w-4 text-primary" aria-hidden />You're speaking</> : <><Volume2Icon className="h-4 w-4 text-muted-foreground" aria-hidden />Listening</>}
          </p>
          {voice.canPublish && (
            <Button variant={voice.micOn ? "default" : "outline"} className="min-h-[44px]" aria-pressed={voice.micOn} onClick={() => void voice.toggleMic()} data-testid="button-mic">
              {voice.micOn ? <Volume2Icon className="mr-2 h-4 w-4" aria-hidden /> : <VolumeXIcon className="mr-2 h-4 w-4" aria-hidden />}{voice.micOn ? "Mute mic" : "Turn on mic"}
            </Button>
          )}
          {!voice.canPublish && canAskToSpeak && (
            <Button variant="outline" className="min-h-[44px]" aria-pressed={hasHand} onClick={hasHand ? onLower : onRaise} data-testid="button-hand">
              <span aria-hidden className="mr-2">✋</span>{hasHand ? "Lower hand" : "Ask to speak"}
            </Button>
          )}
        </div>
      )}
      {voice.micError && <p role="alert" className="text-xs text-destructive" data-testid="mic-error">{voice.micError}</p>}
    </section>
  );
}
