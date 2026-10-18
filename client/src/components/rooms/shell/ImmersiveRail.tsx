import type { ReactNode } from "react";
import { CameraIcon, MinimizeIcon, SettingsIcon, Volume2Icon, VolumeXIcon, XIcon } from "@/components/ui/icons";
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
  /** Overrides the default placement (bottom right, above the dock, inside the safe area). */
  className?: string;
}

function RailButton({ label, caption, pressed, danger, onClick, testId, children }: { label: string; caption: string; pressed?: boolean; danger?: boolean; onClick(): void; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className={`flex h-11 w-11 items-center justify-center rounded-full ${danger ? "bg-destructive text-destructive-foreground" : "bg-black/50 text-white"} backdrop-blur-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground`}
        data-testid={testId}
      >
        {children}
      </button>
      <span className="max-w-[64px] truncate text-center text-[11px] font-semibold text-white [text-shadow:0_1px_4px_rgba(0,0,0,.8)]" aria-hidden>{caption}</span>
    </div>
  );
}

/** The immersive view's three tools: quality (Live controls for the holder), sound only, exit; plus an optional one-tap action. Every one is a real 44 px button with a spoken name. */
export default function ImmersiveRail({ qualityLabel, soundOnly, onQuality, onSoundOnly, onExit, hidden = false, onReveal, isHolder = false, action = null, onAction, className }: Props) {
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
