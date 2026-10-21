// Spray a whole team: the Player / Team toggle and the team tier list. A team spray is one charge split equally between the
// players still in the match (the few kobo left over go to the featured player). It tips people; it is never a bet on the result.
// Owner ruling 2026-10-22: the team minimum is 500 NGN x players, so only tiers at or above it are offered.
// This is the client half. The server call arrives with backend job B, so the shell draws this only when the config says team
// spray exists AND hands it `onThrow`.
import { SIDES, type GameView, type Side } from "@shared/gameScreen";
import { SPRAY_CATALOGUE, formatV3c, type SprayTier } from "@shared/money";
import { sprayPrice } from "@shared/spray";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { TierMark } from "@/components/rooms/spray/SprayTray";
import { formatNaira } from "@/lib/roomTickets";
import { SIDE_NAME, featuredFor, teamShares, teamSprayMinKobo, teamSprayTiers, type Follow } from "@/lib/gameScreen";
import "./game.css";

export interface SprayTeamSheetProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  game: GameView;
  side: Side;
  onSide(side: Side): void;
  follow: Follow;
  nameOf(userId: string): string;
  /** The toggle's Player half: close this and spray the featured player with the normal tray. */
  onPlayer(playerId: string): void;
  /** Throw the team spray. Absent until the server supports it: the tiles then say so and do nothing. */
  onThrow?: (side: Side, tier: SprayTier) => void;
  returnFocusTo?: () => HTMLElement | null;
}

export default function SprayTeamSheet({ open, onOpenChange, game, side, onSide, follow, nameOf, onPlayer, onThrow, returnFocusTo }: SprayTeamSheetProps) {
  const players = game.teams[side];
  const featured = featuredFor(game, side, follow);
  const tiers = teamSprayTiers(players.length);
  const min = teamSprayMinKobo(players.length);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" returnFocusTo={returnFocusTo} className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="game-team-spray">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">Spray {SIDE_NAME[side]}</SheetTitle>
          <SheetDescription>Split equally between the players still in the match. It tips people; it isn't a bet on the result.</SheetDescription>
        </SheetHeader>

        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Who to spray">
          <button type="button" className="gs-view" aria-pressed={false} disabled={!featured} onClick={() => { if (featured) onPlayer(featured); }} data-testid="spray-mode-player">Player</button>
          <button type="button" className="gs-view" aria-pressed data-testid="spray-mode-team">Team</button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Which team">
          {SIDES.map((s) => (
            <button key={s} type="button" className="gs-view" aria-pressed={side === s} disabled={game.teams[s].length === 0} onClick={() => onSide(s)} data-testid={`spray-team-${s}`}>{SIDE_NAME[s]}</button>
          ))}
        </div>

        {players.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">Nobody is on this team yet.</p> : (
          <>
            <p className="mt-4 text-sm text-muted-foreground" data-testid="spray-team-min">
              Team spray starts at {formatNaira(min)} for {players.length} {players.length === 1 ? "player" : "players"} ({formatNaira(min / players.length)} each).
            </p>
            <ul className="mt-3 space-y-2">
              {tiers.map((tier) => {
                const p = sprayPrice(tier);
                const shares = teamShares(game, side, tier, featured);
                const least = Math.min(...Object.values(shares));
                const blocked = !onThrow;
                return (
                  <li key={tier}>
                    <button type="button" aria-disabled={blocked || undefined} aria-describedby={blocked ? "spray-team-why" : undefined}
                      onClick={() => { if (onThrow) onThrow(side, tier); }}
                      className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-border bg-muted/60 px-3 py-2 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-safe:transition-transform motion-safe:active:scale-[0.98]"
                      data-testid={`spray-team-tile-${tier}`}>
                      <TierMark tier={tier} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{p.label} · {p.display}</span>
                        <span className="block text-xs text-muted-foreground">{formatV3c(SPRAY_CATALOGUE[tier].v3c)} · about {formatNaira(least)} to each player</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {tiers.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No spray is big enough for a team this size.</p>}
            {!onThrow && tiers.length > 0 && <p id="spray-team-why" className="mt-3 text-xs text-muted-foreground">Team spray isn't open yet.</p>}
            <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Who gets a share">
              {players.map((u) => <li key={u}>{nameOf(u)}</li>)}
            </ul>
          </>
        )}
      </RoomSheetContent>
    </Sheet>
  );
}
