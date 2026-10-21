// Gamers live, client side: pure helpers over the server's GameView (no React, no sockets). The server decides who plays,
// who is featured and who is away; this only reads that and works out what a viewer sees. Spec: docs/superpowers/specs/2026-10-21-rooms-gaming-design.md.
import { SIDES, sideOf, splitShares, type GameView, type Side } from "@shared/gameScreen";
import { MIN_CHARGE_KOBO, SPRAY_CATALOGUE, SPRAY_TIERS, type SprayTier } from "@shared/money";

/** What a viewer's own follow picks look like: per team, a player the viewer chose to watch (changes only their own device). */
export type Follow = Partial<Record<Side, string>>;
export type GameStatus = "live" | "reconnecting" | "out";
export type GameLayout = "versus" | "team" | "grid" | "spot";
export const GAME_LAYOUTS: readonly GameLayout[] = ["versus", "team", "grid", "spot"];
export const GAME_LAYOUT_LABEL: Record<GameLayout, string> = { versus: "Versus", team: "Teams", grid: "Four-way", spot: "Spotlight" };

/** Most video feeds a viewer ever receives at once (the four-way grid); every other layout needs fewer. */
export const MAX_VIDEO_SUBS = 4;
/** Most spray notes in the air at once in a game room (the engine otherwise allows 120 over a live video). */
export const GAME_MAX_NOTES = 70;

export const membersOf = (game: GameView, side: Side): string[] => game.teams[side];

/** The viewer's follow beats the host's pick, but only while that player is still on the team; then the host's pick; then the first member. */
export function featuredFor(game: GameView, side: Side, follow: Follow): string | null {
  const members = membersOf(game, side);
  const followed = follow[side];
  if (followed && members.includes(followed)) return followed;
  const host = game.featured[side];
  if (host && members.includes(host)) return host;
  return members[0] ?? null;
}

/** The host's own pick for a team (null when the team is empty), ignoring any follow: used by the "back to host pick" chip. */
export const hostPick = (game: GameView, side: Side): string | null => featuredFor(game, side, {});

/** True while the viewer is watching someone other than the host's pick on this team. */
export const isFollowing = (game: GameView, side: Side, follow: Follow): boolean => featuredFor(game, side, follow) !== hostPick(game, side);

/** Players on the team who are not the featured feed: the thumbnail roster. */
export const thumbsOf = (game: GameView, side: Side, follow: Follow): string[] => {
  const f = featuredFor(game, side, follow);
  return membersOf(game, side).filter((u) => u !== f);
};

/**
 * `out`: not on a team any more (their slot was released, or they were removed). `reconnecting`: on a team and the server marked
 * them away (a key exists only for an away player). Otherwise live.
 */
export function statusOf(game: GameView, userId: string, now: number): GameStatus {
  void now; // away players stay "reconnecting" until the server releases the slot, whatever the local clock says
  if (!sideOf(game, userId)) return "out";
  return Object.prototype.hasOwnProperty.call(game.away, userId) ? "reconnecting" : "live";
}

/** ms until the slot is released; null when present or when the room holds the slot. Never negative. */
export function countdownMs(game: GameView, userId: string, now: number): number | null {
  if (!Object.prototype.hasOwnProperty.call(game.away, userId)) return null;
  const until = game.away[userId];
  return typeof until === "number" ? Math.max(0, until - now) : null;
}

/** 24_000 -> "0:24"; rounds up so the clock never shows 0:00 while a second is left. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The words on a tile's status overlay; null for a live player. Colour is never the only signal. */
export function statusText(game: GameView, userId: string, now: number): string | null {
  const st = statusOf(game, userId, now);
  if (st === "live") return null;
  if (st === "out") return "Dropped out";
  const left = countdownMs(game, userId, now);
  return left === null ? "Reconnecting…" : `Reconnecting… ${formatCountdown(left)}`;
}

/** Everyone who is in the match, team A first. */
export const allPlayers = (game: GameView): string[] => [...game.teams.A, ...game.teams.B];

/** The default view: 1v1 sets two feeds side by side; bigger teams get lanes. A viewer's own choice wins. */
export function layoutFor(game: GameView, pref: GameLayout | null): GameLayout {
  if (pref && GAME_LAYOUTS.includes(pref)) return pref;
  return game.format === 1 ? "versus" : "team";
}

/** Columns the tiles use at a container width. The phone/desktop switch is the container's width, never the viewport's. */
export function columnsFor(layout: GameLayout, containerPx: number): 1 | 2 {
  if (layout === "grid") return 2;
  if (layout === "spot") return 1;
  return containerPx >= 560 ? 2 : 1;
}

/** The player the spotlight view is on: the viewer's latest follow, else the host's pick for team A, else team B. */
export function spotlightFor(game: GameView, follow: Follow): string | null {
  const followed = [follow.A, follow.B].find((u): u is string => !!u && allPlayers(game).includes(u));
  return followed ?? featuredFor(game, "A", follow) ?? featuredFor(game, "B", follow);
}

/** Which players' video a viewer should receive. Featured feeds only; thumbnails are never video. Empty in sound-only mode. */
export function videoFeeds(game: GameView, layout: GameLayout, follow: Follow, audioOnly: boolean): string[] {
  if (audioOnly) return [];
  let ids: Array<string | null>;
  if (layout === "spot") ids = [spotlightFor(game, follow)];
  else if (layout === "grid") {
    // Four-way: both featured feeds, then the next players in order, at most four tiles.
    const fa = featuredFor(game, "A", follow), fb = featuredFor(game, "B", follow);
    ids = [fa, fb, ...allPlayers(game).filter((u) => u !== fa && u !== fb)];
  } else ids = SIDES.map((s) => featuredFor(game, s, follow));
  const out: string[] = [];
  for (const id of ids) if (id && !out.includes(id) && statusOf(game, id, 0) === "live") out.push(id);
  return out.slice(0, MAX_VIDEO_SUBS);
}

/** The one player whose game sound plays: the viewer's pick while they are still playing, else team A's featured feed, else B's. Sound-only mode keeps this. */
export function soundFeed(game: GameView, follow: Follow, pick: string | null): string | null {
  if (pick && allPlayers(game).includes(pick) && statusOf(game, pick, 0) === "live") return pick;
  const fa = featuredFor(game, "A", follow);
  if (fa && statusOf(game, fa, 0) === "live") return fa;
  const fb = featuredFor(game, "B", follow);
  return fb && statusOf(game, fb, 0) === "live" ? fb : null;
}

/** Short human line for each refusal code the game handler sends as `room:notice`. No wording about anyone's age. */
export const GAME_NOTICE: Record<string, string> = {
  GAME_OFF: "The match isn't open right now.",
  FEATURE_OFF: "Game rooms aren't available right now.",
  NOT_ALLOWED: "You can't do that in this match.",
  TEEN_RULE: "You can't play in this room.",
  NOT_PRESENT: "That player isn't in the match any more.",
  TEAM_FULL: "That team is full.",
  NO_CHANGE: "Nothing changed.",
  BAD_VALUE: "That value isn't allowed.",
  BAD_REQUEST: "That didn't go through. Try again.",
  NOT_IN_ROOM: "You're not in this room any more.",
  RATE_LIMITED: "Slow down a little, then try again.",
};
export const gameNoticeText = (code: string): string | null => GAME_NOTICE[code] ?? null;

/**
 * Tracks that come in through OBS/RTMP ingest are published by a LiveKit identity `<userId>#obs` (one connection per identity:
 * the player's own browser keeps the bare id). Every place that maps a track to a player goes through this.
 */
export const OBS_SUFFIX = "#obs";
export const playerIdOf = (identity: string): string => (identity.endsWith(OBS_SUFFIX) ? identity.slice(0, -OBS_SUFFIX.length) : identity);

/** Names of the two teams' lanes on screen. */
export const SIDE_NAME: Record<Side, string> = { A: "Team A", B: "Team B" };

/** What the server's config says gamers-live can do. Missing pieces are all false: a flag-off server sends neither key. */
export interface GameCaps { on: boolean; ingest: boolean; teamSpray: boolean; lanes: boolean }
export const NO_GAME_CAPS: GameCaps = { on: false, ingest: false, teamSpray: false, lanes: false };
export function gameCaps(cfg: { features?: { gaming?: boolean }; game?: { ingest?: boolean; teamSpray?: boolean; lanes?: boolean } } | null | undefined): GameCaps {
  if (cfg?.features?.gaming !== true) return NO_GAME_CAPS;
  return { on: true, ingest: cfg.game?.ingest === true, teamSpray: cfg.game?.teamSpray === true, lanes: cfg.game?.lanes === true };
}

/** The formats a host can pick: players per side. */
export const GAME_FORMATS: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
export const DROP_TIMEOUT_LABEL: Record<number, string> = { 30_000: "30 seconds", 120_000: "2 minutes", 0: "Hold the slot" };

/** Words for the create step, the host console and the go-live sheet. */
export const GAME_COPY = {
  formatLegend: "Game format",
  formatOff: "Not a game",
  formatHelp: "Players put their own screen in the room. Viewers see up to four feeds at a time and can spray players.",
  dropLegend: "If a player drops",
  dropHelp: "Their place stays with a countdown. When it runs out, the room says they dropped out.",
  lanesLabel: "Separate age groups",
  lanesHelp: "13-17 and 18+ each get their own lane with their own matches, chat and spray. Adults and teens never see each other.",
} as const;

// ---------------------------------------------------------------- team spray (owner ruling 2026-10-22)

/** A team spray must give every player at least the 500 NGN minimum: 500 x the players on the team, in kobo. 0 for an empty team. */
export const teamSprayMinKobo = (players: number): number => MIN_CHARGE_KOBO * Math.max(0, players);

/** Only tiers at or above the team minimum are offered (a team of 3 needs 1,500: the 1,000 tier is not there). */
export const teamSprayTiers = (players: number): SprayTier[] =>
  players <= 0 ? [] : SPRAY_TIERS.filter((t) => SPRAY_CATALOGUE[t].kobo >= teamSprayMinKobo(players));

/** What each player would get from this tier: an equal split, the few kobo left over to the featured player. */
export function teamShares(game: GameView, side: Side, tier: SprayTier, featured: string | null): Record<string, number> {
  return splitShares(SPRAY_CATALOGUE[tier].kobo, game.teams[side], featured);
}

// ---------------------------------------------------------------- refusals on create / edit / lanes (no wording about anyone's age)

const REFUSAL_REASON: Record<string, string> = {
  needs_live_video: "Game rooms need live video. Keep the room small enough for video, then try again.",
  needs_game: "Pick a game format first, then turn on separate lanes.",
  lanes: "Separate lanes can't be used with paid tickets.",
  teen_host_required: "You can't open that lane.",
  minors_parent: "That lane can't be opened in this room.",
};
const REFUSAL_CODE: Record<string, string> = {
  LANE_EXISTS: "That lane is already open.",
  TEAM_FULL: "A team has more players than that format allows. Remove players first.",
  GAME_IN_PROGRESS: "Players are in the match. Remove them before turning the game off.",
  LANE_ROOM: "This room's game can't be turned off while it has age groups.",
};
/** Plain words for a refused game field (`reason`) or code, or null when it isn't a game refusal. `invalid` counts only on a game field. */
export function gameRefusalText(f: { code?: string; reason?: string; field?: string }): string | null {
  if (f.code && REFUSAL_CODE[f.code]) return REFUSAL_CODE[f.code];
  if (f.reason && REFUSAL_REASON[f.reason]) return REFUSAL_REASON[f.reason];
  if (f.reason === "invalid" && (f.field === "gameFormat" || f.field === "gameDropTimeoutMs" || f.field === "lanes")) return "That game setting isn't allowed. Pick one from the list.";
  return null;
}
