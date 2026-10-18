import { ArrowLeftIcon, MoreHorizontalIcon, SettingsIcon, UsersIcon } from "@/components/ui/icons";

export interface RoomTopBarProps {
  title: string;
  ageLabel: string;
  hostName: string;
  isLive: boolean;
  /** Replaces "Hosted by <host> · <age>" (task 1.5 uses "<holder> is live, <n> watching" in immersive). */
  subtitle?: string;
  count: number;
  /** Over the picture: light text, translucent chips. */
  immersive: boolean;
  onBack(): void;
  onPeople(): void;
  onMore(): void;
  /** Host and co-host only: a Controls chip. Omit for everyone else. */
  onControls?: () => void;
}

/** Hover only where hover is real (fine pointers); touch screens get no sticky hover state. */
const HOVER = "[@media(hover:hover)_and_(pointer:fine)]:hover:border-primary";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const PRESS = "motion-safe:transition-transform motion-safe:active:scale-[0.97]";

/** One line: back, title (ellipsis) with LIVE and the host underneath, the people chip, More. */
export default function RoomTopBar({ title, ageLabel, hostName, isLive, subtitle, count, immersive, onBack, onPeople, onMore, onControls }: RoomTopBarProps) {
  const chip = immersive ? "border-transparent bg-white/15 text-white" : "border-border bg-muted text-foreground";
  const muted = immersive ? "text-white/80" : "text-muted-foreground";
  return (
    <header className="flex min-w-0 items-center gap-1.5" data-testid="room-header">
      <button type="button" onClick={onBack} aria-label="Leave the room and go back to Rooms" className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${FOCUS} ${PRESS}`} data-testid="room-back">
        <ArrowLeftIcon className="h-5 w-5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <h1 className={`truncate font-sans font-semibold leading-tight ${immersive ? "text-[15px]" : "text-base"}`} data-testid="text-room-title">{title}</h1>
        <p className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] ${muted}`}>
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-600 px-2 py-px text-[11px] font-semibold tracking-[0.1em] text-white" data-testid="badge-room-live">
              <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />LIVE
            </span>
          )}
          <span className="truncate" data-testid="text-room-meta">{subtitle ?? `Hosted by ${hostName} · ${ageLabel}`}</span>
        </p>
      </div>
      {onControls && (
        <button type="button" onClick={onControls} className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${chip} ${HOVER} ${FOCUS} ${PRESS}`} data-testid="room-controls">
          <SettingsIcon className="h-4 w-4" aria-hidden /><span className="sr-only sm:not-sr-only">Controls</span>
        </button>
      )}
      <button type="button" onClick={onPeople} aria-label={`People in the room, ${count}`} className={`inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium tabular-nums ${chip} ${HOVER} ${FOCUS} ${PRESS}`} data-testid="room-people">
        <UsersIcon className="h-5 w-5" aria-hidden /><span>{count}</span>
      </button>
      <button type="button" onClick={onMore} aria-label="Room options" className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${FOCUS} ${PRESS}`} data-testid="room-more">
        <MoreHorizontalIcon className="h-5 w-5" aria-hidden />
      </button>
    </header>
  );
}
