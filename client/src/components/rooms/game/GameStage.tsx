// The game stage, in place of the single-holder ScreenStage when the room is a game room. Four views of the same match:
// Versus (one feed per team), Teams (lanes with a roster), Four-way (up to four feeds) and Spotlight (one big feed).
// The view is the viewer's own choice; it changes only what this device receives. Spec: 2026-10-21-rooms-gaming-design.md.
import { useState } from "react";
import { sideOf, SIDES, type GameView, type Side } from "@shared/gameScreen";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import type { GameTracks } from "@/hooks/useGameTracks";
import {
  allPlayers, featuredFor, GAME_LAYOUT_LABEL, GAME_LAYOUTS, SIDE_NAME, spotlightFor, statusText, videoFeeds,
  LANE_BAR_TEXT, LANE_LABEL, laneBarTitle, type AgeLane, type GameLayout,
} from "@/lib/gameScreen";
import GameTile from "./GameTile";
import TeamLane from "./TeamLane";
import "./game.css";

export interface GameStageProps {
  game: GameView;
  tracks: GameTracks;
  me: string | null;
  layout: GameLayout;
  onLayout(l: GameLayout): void;
  nameOf(userId: string): string;
  /** state.serverOffsetMs: server clock minus client clock, so reconnect countdowns match the server's deadline. */
  serverOffsetMs: number;
  /** Sound-only mode (viewer data saver or a weak link): no video is received. */
  audioOnly: boolean;
  /** Players the viewer may spray right now (the server's targets). Empty when spraying isn't available to them. */
  sprayable: readonly string[];
  onSpray(playerId: string): void;
  /** Team spray, only while the server says it exists. */
  onSprayTeam?: (side: Side) => void;
  /** The play button: ask to play / share your screen / withdraw. Absent for a viewer who may not play (listen-only). */
  onPlay?: () => void;
  /** The room's own age lane (only present for a lane's own viewers, and only while lanes are on). Draws the lane bar. */
  ageLane?: AgeLane | null;
  className?: string;
}

const teamLine = (game: GameView, side: Side, nameOf: (u: string) => string, follow: GameTracks["following"]) => {
  const f = featuredFor(game, side, follow);
  return f ? nameOf(f) : "No players yet";
};

export default function GameStage({ game, tracks, me, layout, onLayout, nameOf, serverOffsetMs, audioOnly, sprayable, onSpray, onSprayTeam, onPlay, ageLane, className }: GameStageProps) {
  const away = Object.keys(game.away).length > 0;
  // One tick a second while anyone is away (the countdown), nothing otherwise.
  const now = useNow(away) + serverOffsetMs;
  const follow = tracks.following;
  const [announce, setAnnounce] = useState("");

  const mySide = me ? sideOf(game, me) : null;
  const asked = !!me && game.asks.some((a) => a.userId === me);
  const playLabel = mySide ? (tracks.sharing ? "Your screen" : "Share your screen") : asked ? "Withdraw request" : "Play";

  const tile = (u: string, size: "main" | "thumb") => {
    const side = sideOf(game, u) ?? "A";
    return (
      <GameTile
        key={u} userId={u} name={nameOf(u)} side={side} size={size}
        track={audioOnly || size === "thumb" ? null : tracks.trackFor(u)} status={statusText(game, u, now)} isSelf={u === me}
        hostPick={game.featured[side] === u} hasSound={tracks.soundId === u} onSound={() => tracks.setSound(u)} audioOnly={audioOnly}
        onSpray={sprayable.includes(u) ? () => onSpray(u) : undefined} onFollow={size === "thumb" ? () => { tracks.follow(side, u); setAnnounce(`Watching ${nameOf(u)}`); } : undefined}
        onWidth={tracks.reportWidth}
      />
    );
  };

  const lane = (side: Side, roster: boolean) => (
    <TeamLane key={side} side={side} game={game} tracks={tracks} follow={follow} me={me} nameOf={nameOf} now={now} audioOnly={audioOnly}
      roster={roster} sprayable={sprayable} onSpray={onSpray} onSprayTeam={onSprayTeam} />
  );

  let body;
  if (layout === "grid") {
    const feeds = videoFeeds(game, "grid", follow, false); // the four tiles; sound-only mode still shows their names
    const rest = allPlayers(game).filter((u) => !feeds.includes(u));
    body = (
      <>
        <div className="gs-four" data-testid="game-grid">{feeds.map((u) => <div key={u} style={{ minWidth: 0 }}>{tile(u, "main")}</div>)}</div>
        {rest.length > 0 && <ul className="gs-roster" aria-label="More players" style={{ listStyle: "none", margin: 0, padding: 0 }}>{rest.map((u) => <li key={u} style={{ minWidth: 0 }}>{tile(u, "thumb")}</li>)}</ul>}
      </>
    );
  } else if (layout === "spot") {
    const spot = spotlightFor(game, follow);
    const rest = allPlayers(game).filter((u) => u !== spot);
    body = (
      <div className="gs-spot" data-testid="game-spot">
        {spot ? tile(spot, "main") : <div className="gs-slot gs-slot--main">No players yet. Players join from Play.</div>}
        {rest.length > 0 && <ul className="gs-roster" aria-label="Other players" style={{ listStyle: "none", margin: 0, padding: 0 }}>{rest.map((u) => <li key={u} style={{ minWidth: 0 }}>{tile(u, "thumb")}</li>)}</ul>}
      </div>
    );
  } else {
    body = <div className="gs-lanes gs-lanes--two" data-testid={layout === "team" ? "game-teams" : "game-versus"}>{SIDES.map((s) => lane(s, layout === "team"))}</div>;
  }

  return (
    <div className={`gs ${className ?? ""}`} data-testid="game-stage" data-layout={layout}>
      {ageLane && (
        <div className="gs-lanebar" role="note" data-testid="game-lane-bar">
          <span className="gs-lanebadge">{LANE_LABEL[ageLane]}</span>
          <span><b>{laneBarTitle(ageLane)}.</b> {LANE_BAR_TEXT}</span>
        </div>
      )}
      <div className="gs-score" role="group" aria-label={`Score, ${SIDE_NAME.A} ${game.score[0]}, ${SIDE_NAME.B} ${game.score[1]}`}>
        <div className="gs-who"><b>{SIDE_NAME.A}</b><span>{teamLine(game, "A", nameOf, follow)}</span></div>
        <div className="gs-num" aria-hidden>{game.score[0]}<i>:</i>{game.score[1]}</div>
        <div className="gs-who gs-who--b"><b>{SIDE_NAME.B}</b><span>{teamLine(game, "B", nameOf, follow)}</span></div>
      </div>

      <div className="gs-views" role="group" aria-label="Choose a view">
        {GAME_LAYOUTS.map((l) => (
          <button key={l} type="button" className="gs-view" aria-pressed={layout === l} onClick={() => onLayout(l)} data-testid={`game-view-${l}`}>{GAME_LAYOUT_LABEL[l]}</button>
        ))}
      </div>

      {body}

      {onPlay && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Button type="button" className="min-h-[44px] rounded-full px-5" variant={mySide ? "outline" : "default"} onClick={onPlay} data-testid="game-play">{playLabel}</Button>
          {tracks.shareError && <p role="alert" className="gs-muted" style={{ flexBasis: "100%", margin: 0 }}>{tracks.shareError}</p>}
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </div>
  );
}
