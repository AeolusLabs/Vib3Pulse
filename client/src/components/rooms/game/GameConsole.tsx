// Host console for a game room (a tab in the Controls sheet): who is asking to play, the teams, the featured feed per team, the
// score, the format, how long a dropped player keeps their place, and your own view. Every button only asks; the server decides
// and a refusal comes back as a notice the sheet already says out loud.
import { useState, type ReactNode } from "react";
import { MAX_SCORE, SIDES, type DropTimeoutMs, type GameAction, type GameView, type Side } from "@shared/gameScreen";
import { DROP_TIMEOUTS_MS, DEFAULT_DROP_TIMEOUT_MS } from "@shared/gameScreen";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import { DROP_TIMEOUT_LABEL, GAME_COPY, GAME_FORMATS, GAME_LAYOUTS, GAME_LAYOUT_LABEL, LANE_LABEL, SIDE_NAME, otherLane, statusText, type AgeLane, type GameLayout } from "@/lib/gameScreen";
import OpenLane from "./OpenLane";
import "./game.css";

export interface GameConsoleProps {
  game: GameView;
  nameOf(userId: string): string;
  /** Sends room:game. false when the socket isn't open. */
  onAction(action: GameAction, extra?: { targetId?: string; side?: Side; value?: number }): boolean;
  /** Saves a room setting (PATCH). Null when saved, else the server's message. */
  onSaveRoom(patch: { gameDropTimeoutMs: DropTimeoutMs }): Promise<string | null>;
  dropTimeoutMs: number;
  layout: GameLayout;
  onLayout(l: GameLayout): void;
  /** state.serverOffsetMs, for the reconnect countdowns in the roster. */
  serverOffsetMs: number;
  /** Only the host changes room settings; a co-host sees the console without the drop-timeout choice. */
  canSaveRoom: boolean;
  /** Say one plain line (the sheet's notice). */
  say(message: string): void;
  /** Age lanes (config.game.lanes on, and this room is a lane): the card and the open-the-other-lane action. */
  lanes?: { ageLane: AgeLane; parentId: string; onOpened(): void };
}

const Section = ({ title, children, id }: { title: string; children: ReactNode; id: string }) => (
  <section aria-labelledby={id} className="space-y-2 rounded-2xl border p-3">
    <h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {children}
  </section>
);

const Pill = ({ pressed, onClick, children, label, testId }: { pressed: boolean; onClick(): void; children: ReactNode; label?: string; testId?: string }) => (
  <button type="button" className="gs-view" aria-pressed={pressed} aria-label={label} onClick={onClick} data-testid={testId}>{children}</button>
);

export default function GameConsole({ game, nameOf, onAction, onSaveRoom, dropTimeoutMs, layout, onLayout, serverOffsetMs, canSaveRoom, say, lanes }: GameConsoleProps) {
  const now = useNow(Object.keys(game.away).length > 0) + serverOffsetMs;
  const [busy, setBusy] = useState(false);
  const send = (action: GameAction, extra?: { targetId?: string; side?: Side; value?: number }) => { if (!onAction(action, extra)) say("Couldn't reach the room. Try again."); };
  const saveDrop = async (ms: DropTimeoutMs) => {
    if (busy || ms === dropTimeoutMs) return;
    setBusy(true);
    const err = await onSaveRoom({ gameDropTimeoutMs: ms });
    setBusy(false);
    if (err !== null) say(err || "Couldn't save that. Try again.");
  };

  return (
    <div className="gs space-y-3" data-testid="game-console">
      <Section title={`Requests (${game.asks.length})`} id="gc-requests">
        {game.asks.length === 0 ? <p className="text-sm text-muted-foreground">Nobody is asking to play.</p> : (
          <ul className="space-y-1">
            {game.asks.map((a) => {
              const full = game.teams[a.side].length >= game.format;
              return (
                <li key={a.userId} className="flex flex-wrap items-center gap-2" data-testid={`game-ask-${a.userId}`}>
                  <span className="gs-side" data-side={a.side} aria-hidden>{a.side}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{nameOf(a.userId)} <span className="text-muted-foreground">wants {SIDE_NAME[a.side]}</span></span>
                  <Button size="sm" className="min-h-[44px] rounded-full" disabled={full} aria-label={full ? `${SIDE_NAME[a.side]} is full` : `Accept ${nameOf(a.userId)} into ${SIDE_NAME[a.side]}`} onClick={() => send("accept", { targetId: a.userId, side: a.side })} data-testid={`game-accept-${a.userId}`}>{full ? "Team full" : "Accept"}</Button>
                  <Button size="sm" variant="outline" className="min-h-[44px] rounded-full" aria-label={`Decline ${nameOf(a.userId)}`} onClick={() => send("decline", { targetId: a.userId })} data-testid={`game-decline-${a.userId}`}>Decline</Button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {SIDES.map((side) => (
        <Section key={side} title={`${SIDE_NAME[side]} (${game.teams[side].length}/${game.format})`} id={`gc-team-${side}`}>
          {game.teams[side].length === 0 ? <p className="text-sm text-muted-foreground">No players yet.</p> : (
            <ul className="space-y-1">
              {game.teams[side].map((u) => {
                const st = statusText(game, u, now);
                const featured = game.featured[side] === u;
                return (
                  <li key={u} className="flex flex-wrap items-center gap-2" data-testid={`game-player-${u}`}>
                    <span className="min-w-0 flex-1 truncate text-sm">{nameOf(u)}{st && <span className="ml-2 text-xs text-muted-foreground">{st}</span>}</span>
                    <Button size="sm" variant={featured ? "default" : "outline"} className="min-h-[44px] rounded-full" aria-pressed={featured} aria-label={featured ? `${nameOf(u)} is featured` : `Feature ${nameOf(u)}`} disabled={featured} onClick={() => send("feature", { targetId: u })} data-testid={`game-feature-${u}`}>{featured ? "Featured" : "Feature"}</Button>
                    <Button size="sm" variant="ghost" className="min-h-[44px] rounded-full" aria-label={`Remove ${nameOf(u)} from the match`} onClick={() => send("remove", { targetId: u })} data-testid={`game-remove-${u}`}>Remove</Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ))}

      <Section title="Score" id="gc-score">
        <div className="grid grid-cols-2 gap-3">
          {SIDES.map((side, i) => {
            const v = game.score[i];
            return (
              <div key={side} className="flex items-center justify-between gap-2" role="group" aria-label={`${SIDE_NAME[side]} score`}>
                <span className="text-sm font-medium">{SIDE_NAME[side]}</span>
                <span className="flex items-center gap-2">
                  <button type="button" className="gs-view" style={{ minWidth: 44, padding: 0 }} aria-label={`Lower ${SIDE_NAME[side]} score`} disabled={v <= 0} onClick={() => send("score", { side, value: v - 1 })} data-testid={`game-score-dec-${side}`}>−</button>
                  <output className="min-w-[2ch] text-center font-serif text-2xl font-bold tabular-nums" aria-live="polite" data-testid={`game-score-${side}`}>{v}</output>
                  <button type="button" className="gs-view" style={{ minWidth: 44, padding: 0 }} aria-label={`Raise ${SIDE_NAME[side]} score`} disabled={v >= MAX_SCORE} onClick={() => send("score", { side, value: v + 1 })} data-testid={`game-score-inc-${side}`}>+</button>
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={GAME_COPY.formatLegend} id="gc-format">
        <div className="gs-views" role="group" aria-label={GAME_COPY.formatLegend}>
          {GAME_FORMATS.map((n) => <Pill key={n} pressed={game.format === n} onClick={() => send("format", { value: n })} testId={`game-format-${n}`}>{n}v{n}</Pill>)}
        </div>
        <p className="text-xs text-muted-foreground">A smaller format needs the extra players removed first.</p>
      </Section>

      {canSaveRoom && <Section title={GAME_COPY.dropLegend} id="gc-drop">
        <div className="gs-views" role="group" aria-label={GAME_COPY.dropLegend}>
          {DROP_TIMEOUTS_MS.map((ms) => <Pill key={ms} pressed={(dropTimeoutMs ?? DEFAULT_DROP_TIMEOUT_MS) === ms} onClick={() => void saveDrop(ms)} testId={`game-drop-${ms}`}>{DROP_TIMEOUT_LABEL[ms]}</Pill>)}
        </div>
        <p className="text-xs text-muted-foreground">{GAME_COPY.dropHelp}</p>
      </Section>}

      {lanes && (
        <Section title="Age lanes" id="gc-lanes">
          <p className="text-sm text-muted-foreground" data-testid="game-lanes-card">This room has separate lanes. You are in the {LANE_LABEL[lanes.ageLane]} lane. Each lane has its own matches, chat and spray, and the lanes never see each other.</p>
          <OpenLane parentId={lanes.parentId} lane={otherLane(lanes.ageLane)} onOpened={lanes.onOpened} say={say} />
          <p className="text-xs text-muted-foreground">Only the host, or someone the host follows back, can open it.</p>
        </Section>
      )}

      <Section title="Your view" id="gc-view">
        <div className="gs-views" role="group" aria-label="Your view">
          {GAME_LAYOUTS.map((l) => <Pill key={l} pressed={layout === l} onClick={() => onLayout(l)} testId={`game-console-view-${l}`}>{GAME_LAYOUT_LABEL[l]}</Pill>)}
        </div>
        <p className="text-xs text-muted-foreground">This changes what you see. Everyone else picks their own.</p>
      </Section>
    </div>
  );
}
