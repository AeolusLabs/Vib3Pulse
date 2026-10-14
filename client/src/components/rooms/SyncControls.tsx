import { Button } from "@/components/ui/button";
import type { Screen } from "@shared/screen";
import type { ScreenSync } from "@/hooks/useScreenSync";

interface Props {
  screen: Screen | null;
  sync: ScreenSync;
  /** True for the one player that reports playback (the host); everyone else follows. */
  canControl: boolean;
  /** Host or co-host: may count the room in. */
  canCue: boolean;
  /** Host: ask everyone to press play together in `inMs`. */
  onCue: (inMs: number) => void;
}

const CUE_PROVIDERS = ["spotify", "apple_music", "soundcloud"];

/** The small control row under the screen: follow-the-host controls for video, and "start together" for audio providers. */
export default function SyncControls({ screen, sync, canControl, canCue, onCue }: Props) {
  if (!screen) return null;
  const isCueProvider = CUE_PROVIDERS.includes(screen.provider);
  const isVideo = screen.provider === "youtube" || screen.provider === "vimeo";
  const cue = sync.cueRemainingMs;
  if (!isCueProvider && !isVideo && cue === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="sync-controls">
      {cue !== null && (
        <p role="status" className="rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-foreground" data-testid="cue-countdown">
          {cue > 0 ? `Press play together in ${Math.ceil(cue / 1000)}…` : "Press play now"}
        </p>
      )}
      {isCueProvider && canCue && (
        <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => onCue(5000)} data-testid="button-cue">Start together in 5 s</Button>
      )}
      {isCueProvider && !canCue && cue === null && <span>Everyone presses play on their own account; the host can count you in.</span>}

      {isVideo && !canControl && sync.available === false && <span data-testid="sync-unavailable">Syncing isn't available for this video right now.</span>}
      {isVideo && !canControl && sync.available && (
        <>
          <Button variant={sync.watchOwn ? "default" : "outline"} size="sm" className="min-h-[44px]" aria-pressed={sync.watchOwn} onClick={() => sync.setWatchOwn(!sync.watchOwn)} data-testid="button-watch-own">Watch on my own</Button>
          {sync.watchOwn && <Button variant="outline" size="sm" className="min-h-[44px]" onClick={sync.catchUp} data-testid="button-catch-up">Catch up</Button>}
          {sync.needsTap && <Button size="sm" className="min-h-[44px]" onClick={sync.tapToPlay} data-testid="button-tap-to-play">Tap to start the video</Button>}
        </>
      )}
    </div>
  );
}
