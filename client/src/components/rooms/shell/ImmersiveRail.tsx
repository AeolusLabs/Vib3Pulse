import type { ReactNode } from "react";
import { CameraIcon, MinimizeIcon, MoreHorizontalIcon, SettingsIcon, Volume2Icon, VolumeXIcon, XIcon } from "@/components/ui/icons";
import { railPrimary, type RailAction } from "@/lib/videoViewState";

interface Props {
  /** Short current quality, e.g. "Auto" or "Sound only" (see qualityLabel in lib/videoViewState). */
  qualityLabel: string;
  soundOnly: boolean;
  onQuality(): void;
  onSoundOnly(): void;
  onExit(): void;
  /** Chrome is hidden (tap the picture): fades out and stops taking taps. Focus reaching it brings it back. */
  hidden?: boolean;
  onReveal?(): void;
  /** The holder's first button opens "Live controls" (camera, quality, Stop live) instead of "Video quality". */
  isHolder?: boolean;
  /** One-tap extra from railAction(): Stop live for a live holder, Ask or Cancel request for a viewer who may ask. */
  action?: RailAction;
  onAction?(): void;
  /** Room options in one tap: the controls for a host or co-host, the options sheet for a viewer. `waiting` is the count of requests to answer. */
  onOptions?(): void;
  waiting?: number;
  /** Overrides the default placement (bottom right, above the dock, inside the safe area). */
  className?: string;
}

function RailButton({ label, caption, pressed, danger, badge, onClick, testId, children }: { label: string; caption: string; pressed?: boolean; danger?: boolean; badge?: number; onClick(): void; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        aria-label={badge ? `${label}, ${badge} waiting` : label}
        aria-pressed={pressed}
        className={`relative flex h-11 w-11 items-center justify-center rounded-full ${danger ? "bg-destructive text-destructive-foreground" : "bg-black/50 text-white"} backdrop-blur-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground`}
        data-testid={testId}
      >
        {children}
        {badge ? <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1 text-[11px] font-bold text-secondary-foreground" aria-hidden>{badge}</span> : null}
      </button>
      <span className="max-w-[64px] truncate text-center text-[11px] font-semibold text-white [text-shadow:0_1px_4px_rgba(0,0,0,.8)]" aria-hidden>{caption}</span>
    </div>
  );
}

/** The immersive view's three tools: quality (Live controls for the holder), sound only, exit; plus an optional one-tap action. Every one is a real 44 px button with a spoken name. */
export default function ImmersiveRail({ qualityLabel, soundOnly, onQuality, onSoundOnly, onExit, hidden = false, onReveal, isHolder = false, action = null, onAction, onOptions, waiting = 0, className }: Props) {
  const primary = railPrimary(isHolder, qualityLabel);
  return (
    <div
      role="group"
      aria-label="Video tools"
      onFocus={hidden ? onReveal : undefined}
      className={`${className ?? "absolute bottom-[calc(76px+env(safe-area-inset-bottom,0px))] right-[max(10px,env(safe-area-inset-right,0px))] z-10"} flex flex-col gap-2 transition-opacity duration-200 ease-out motion-reduce:transition-none ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
      data-hidden={hidden ? "true" : "false"}
      data-testid="immersive-rail"
    >
      {action && onAction && (
        <RailButton label={action.label} caption={action.kind === "stop" ? "Stop" : action.kind === "withdraw" ? "Cancel" : "Ask"} pressed={action.kind === "withdraw" ? true : undefined} danger={action.kind === "stop"} onClick={onAction} testId={`button-rail-${action.kind}`}>
          {action.kind === "stop" ? <XIcon className="h-5 w-5" aria-hidden /> : <CameraIcon className="h-5 w-5" aria-hidden />}
        </RailButton>
      )}
      {onOptions && (
        <RailButton label="Room options" caption="Options" badge={waiting} onClick={onOptions} testId="button-rail-options">
          <MoreHorizontalIcon className="h-5 w-5" aria-hidden />
        </RailButton>
      )}
      <RailButton label={primary.label} caption={primary.caption} onClick={onQuality} testId="button-rail-quality">
        <SettingsIcon className="h-5 w-5" aria-hidden />
      </RailButton>
      <RailButton label="Sound only" caption="Sound only" pressed={soundOnly} onClick={onSoundOnly} testId="button-rail-sound">
        {soundOnly ? <VolumeXIcon className="h-5 w-5" aria-hidden /> : <Volume2Icon className="h-5 w-5" aria-hidden />}
      </RailButton>
      <RailButton label="Exit immersive view" caption="Exit" onClick={onExit} testId="button-rail-exit">
        <MinimizeIcon className="h-5 w-5" aria-hidden />
      </RailButton>
    </div>
  );
}
