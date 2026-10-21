// One player's screen. "main" is a full-size feed (with the sound switch, expand and Spray); "thumb" is a small roster tile that
// shows no video at all (a viewer receives featured feeds only) and is one big button: tap to watch this player.
import { useEffect, useRef } from "react";
import type { Side } from "@shared/gameScreen";
import type { ScreenTrack } from "@/hooks/useRoomVoice";
import { MaximizeIcon, Volume2Icon } from "@/components/ui/icons";
import "./game.css";

export interface GameTileProps {
  userId: string;
  name: string;
  side: Side;
  size: "main" | "thumb";
  /** null when this feed is not being received (a thumbnail, sound only, or the player has not started yet). */
  track: ScreenTrack | null;
  /** The words on the status overlay ("Reconnecting… 0:24", "Dropped out"); null for a live player. */
  status: string | null;
  isSelf: boolean;
  /** The host's pick for this team (shown as a pill on the main tile). */
  hostPick?: boolean;
  /** This feed's game sound is the one playing. */
  hasSound?: boolean;
  onSound?: () => void;
  /** Sound-only mode: the picture is not downloaded. */
  audioOnly?: boolean;
  /** Spray this player; absent when they can't be sprayed (not payable, not allowed, you). */
  onSpray?: () => void;
  /** Thumbnail tap. */
  onFollow?: () => void;
  /** Main tile width, so a small tile asks for a smaller layer. */
  onWidth?: (userId: string, px: number) => void;
}

export default function GameTile({ userId, name, side, size, track, status, isSelf, hostPick, hasSound, onSound, audioOnly, onSpray, onFollow, onWidth }: GameTileProps) {
  const box = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const thumb = size === "thumb";

  // The <video> belongs to this tile: the track is attached to it and detached again.
  useEffect(() => {
    const el = videoEl.current;
    if (!el || !track) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);

  // Tell the media layer how wide the tile is (it picks 720 / 360 / 180 p from this).
  useEffect(() => {
    const el = box.current;
    if (!el || thumb || !onWidth || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w) onWidth(userId, w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [userId, thumb, onWidth]);

  const expand = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  const shown = status === null && !!track && !thumb;
  const label = `${name}${isSelf ? " (you)" : ""}, team ${side}`;
  return (
    <div ref={box} className={`gt ${thumb ? "gt--thumb" : ""}`} data-self={isSelf} data-status={status ? "away" : "live"} data-testid={`strip-${userId}`} role="group" aria-label={label}>
      {shown ? <video ref={videoEl} className="gt-video" autoPlay playsInline muted aria-label={`${name}'s screen`} /> : (
        <div className="gt-empty">
          <span className="gt-initial" aria-hidden>{name.trim().charAt(0).toUpperCase() || "?"}</span>
          {!thumb && status === null && <span>{audioOnly ? "Sound only" : "Waiting for their screen"}</span>}
        </div>
      )}

      <div className="gt-top">
        <span className="gs-side" data-side={side} aria-hidden>{side}</span>
        <span className="gt-name">{name}{isSelf ? " (you)" : ""}</span>
        <span className="gt-grow" />
        {hostPick && !thumb && <span className="gt-pill gt-pill--opt">Host pick</span>}
        {!thumb && (
          <>
            {onSound && (
              <button type="button" className="gt-act" aria-pressed={!!hasSound} aria-label={hasSound ? `Hearing ${name}'s game sound` : `Hear ${name}'s game sound`} onClick={hasSound ? undefined : onSound} data-testid={`tile-sound-${userId}`}>
                <Volume2Icon className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
            {shown && (
              <button type="button" className="gt-act" aria-label={`Full screen, ${name}`} onClick={expand} data-testid={`tile-expand-${userId}`}>
                <MaximizeIcon className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
          </>
        )}
      </div>

      {!thumb && onSpray && status === null && (
        <div className="gt-bottom">
          <button type="button" className="gt-spray" onClick={onSpray} aria-label={`Spray ${name}`} data-testid={`tile-spray-${userId}`}>Spray</button>
        </div>
      )}

      {status && <div className="gt-stat" role="status" data-testid={`tile-status-${userId}`}>{status}</div>}

      {thumb && onFollow && (
        <button type="button" className="gt-hit" onClick={onFollow} aria-label={`Watch ${name}`} data-testid={`tile-follow-${userId}`} />
      )}
    </div>
  );
}
