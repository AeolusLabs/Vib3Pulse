// One team: a header, the featured feed, and (in the lane view) a roster of small tiles for everyone else. Open slots are drawn
// as dashed empty tiles so a 4v4 always reads as four places per side.
import type { GameView, Side } from "@shared/gameScreen";
import { featuredFor, hostPick, isFollowing, SIDE_NAME, statusText, thumbsOf, type Follow } from "@/lib/gameScreen";
import type { GameTracks } from "@/hooks/useGameTracks";
import { Button } from "@/components/ui/button";
import GameTile from "./GameTile";
import "./game.css";

export interface TeamLaneProps {
  side: Side;
  game: GameView;
  tracks: GameTracks;
  follow: Follow;
  me: string | null;
  nameOf(userId: string): string;
  /** Server clock now (client time plus the server offset), for the reconnect countdowns. */
  now: number;
  audioOnly: boolean;
  /** false in the versus view: just the featured feed. */
  roster: boolean;
  sprayable: readonly string[];
  onSpray(playerId: string): void;
  /** Present only when team spray is available. */
  onSprayTeam?: (side: Side) => void;
}

export default function TeamLane({ side, game, tracks, follow, me, nameOf, now, audioOnly, roster, sprayable, onSpray, onSprayTeam }: TeamLaneProps) {
  const members = game.teams[side];
  const featured = featuredFor(game, side, follow);
  const others = thumbsOf(game, side, follow);
  const following = isFollowing(game, side, follow);
  const open = Math.max(0, game.format - members.length);
  const pick = hostPick(game, side);
  const title = SIDE_NAME[side];

  return (
    <section className="gs-lane" aria-label={`${title}, ${members.length} of ${game.format} players`} data-testid={`lane-${side}`}>
      <div className="gs-lane-h">
        <span className="gs-side" data-side={side} aria-hidden>{side}</span>
        <b>{title}</b>
        <span className="gs-muted">{members.length}/{game.format}</span>
        <span className="gs-grow" />
        {following && pick && (
          <button type="button" className="gs-chip" onClick={() => tracks.unfollow(side)} aria-label={`Back to the host's pick, ${nameOf(pick)}`} data-testid={`lane-unfollow-${side}`}>
            Back to host pick
          </button>
        )}
        {onSprayTeam && members.length > 0 && (
          <Button type="button" size="sm" className="min-h-[44px] rounded-full px-4" onClick={() => onSprayTeam(side)} aria-label={`Spray ${title}`} data-testid={`lane-spray-${side}`}>Spray team</Button>
        )}
      </div>

      {featured ? (
        <GameTile
          userId={featured} name={nameOf(featured)} side={side} size="main"
          track={audioOnly ? null : tracks.trackFor(featured)} status={statusText(game, featured, now)} isSelf={featured === me}
          hostPick={featured === pick} hasSound={tracks.soundId === featured} onSound={() => tracks.setSound(featured)} audioOnly={audioOnly}
          onSpray={sprayable.includes(featured) ? () => onSpray(featured) : undefined} onWidth={tracks.reportWidth}
        />
      ) : (
        <div className="gs-slot gs-slot--main">No players yet. Players join from Play.</div>
      )}

      {roster && members.length > 0 && (others.length > 0 || open > 0) && (
        <ul className="gs-roster" aria-label={`${title} roster`} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {others.map((u) => (
            <li key={u} style={{ minWidth: 0 }}>
              <GameTile
                userId={u} name={nameOf(u)} side={side} size="thumb" track={null} status={statusText(game, u, now)} isSelf={u === me}
                onFollow={() => tracks.follow(side, u)}
              />
            </li>
          ))}
          {Array.from({ length: open }, (_, i) => (
            <li key={`open-${i}`} style={{ minWidth: 0 }}><div className="gs-slot">Open slot</div></li>
          ))}
        </ul>
      )}
    </section>
  );
}
