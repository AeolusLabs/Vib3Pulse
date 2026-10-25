// Live room presence, in memory. Durable state (rooms, bans, mutes) is in Postgres; clients rebuild presence by
// re-sending room:join after a reconnect or restart. Keep this interface small so a Redis-backed hub can replace it.
import { CHAT_QUOTE_WINDOW, type ChatReply } from "@shared/rooms";
import { ageBand, type AgeBand } from "@shared/age";
import type { StageState } from "@shared/stage";
import type { LiveState } from "@shared/liveScreen";
import { emptyGame, type GameState } from "@shared/gameScreen";
import type { MemberRole } from "./roomStorage";

export interface HubMember {
  userId: string;
  role: MemberRole;
  muted: boolean;
  joinedAt: number;
  send: (msg: object) => void;
  /** Public profile bits shown in the scene (never email/dob). */
  info?: Record<string, unknown>;
  /** Whole years, null if unknown. Server-side only: never put this in a payload. Drives the "teens speak only among teens" rule. */
  age?: number | null;
  /** What LiveKit was last told about their publish permission (unset until they asked for a token). */
  publish?: boolean;
  /** Settles when the room has finished reconciling this joiner (stage right restored, teen rule applied). A voice token waits for it. */
  ready?: Promise<void>;
  /**
   * The screen holder's connection dropped: their spot is held until `until` (epoch ms). Only ever set on the current holder,
   * or (ROOMS_GAMING) on a game player, where `until` 0 means the slot is held until the host acts (timeout "hold").
   */
  away?: { until: number };
}

const emptyStage = (): StageState => ({ stage: [], hands: [], invited: [] });

/** Gaming: what the room row says about its game, kept while the room is live (set on the first join, like voice). */
export interface GameRoomInfo { dropMs: number; ageLane: "teen" | "adult" | null }

export interface ChatLine { userId: string; text: string; at: number; replyTo?: ChatReply; quotable?: false }

const CHAT_RING = CHAT_QUOTE_WINDOW;

export class RoomHub {
  private rooms = new Map<string, Map<string, HubMember>>(); // Map keeps insertion (join) order
  private byUser = new Map<string, string>();
  private chat = new Map<string, ChatLine[]>();
  private stages = new Map<string, StageState>();
  private voice = new Map<string, boolean>();
  private lives = new Map<string, LiveState>();
  private liveVideo = new Map<string, boolean>();
  private games = new Map<string, GameState>();      // ROOMS_GAMING: teams, asks, featured, score (memory only, like the stage)
  private gameRooms = new Map<string, GameRoomInfo>(); // ROOMS_GAMING: live game rooms with someone in them
  private minors = new Set<string>(); // live rooms that are minors' rooms (mirrors rooms.minors_room, which never clears)
  /** Phase 6 recap: the most people in each live room at once (this process). Kept while the room lives; gone on end. */
  private peaks = new Map<string, number>();

  /**
   * Call right after a join: returns the new peak when this join raised it (the caller persists it, conditionally), else
   * null. Counts everyone in the hub for the room, host included.
   */
  recordPeak(roomId: string): number | null {
    const n = this.count(roomId);
    if (n <= (this.peaks.get(roomId) ?? 0)) return null;
    if (this.peaks.size > 5000 && !this.peaks.has(roomId)) {
      // Safety valve only: forget rooms nobody is in (their peak is already in the database).
      Array.from(this.peaks.keys()).forEach((id) => { if (this.count(id) === 0) this.peaks.delete(id); });
    }
    this.peaks.set(roomId, n);
    return n;
  }

  /** The peak this process saw for the room (0 when it saw nobody). */
  peakOf(roomId: string): number { return this.peaks.get(roomId) ?? 0; }

  /** One room per user: joining another leaves the first. Returns the room that was left, if any. */
  join(roomId: string, m: HubMember): string | null {
    const prev = this.byUser.get(m.userId);
    let left: string | null = null;
    if (prev && prev !== roomId) { this.leave(prev, m.userId); left = prev; }
    let room = this.rooms.get(roomId);
    if (!room) { room = new Map(); this.rooms.set(roomId, room); }
    if (!room.has(m.userId)) room.set(m.userId, m); // one entry per user, however many sockets they have
    this.byUser.set(m.userId, roomId);
    return left;
  }

  leave(roomId: string, userId: string): HubMember | undefined {
    const room = this.rooms.get(roomId);
    const m = room?.get(userId);
    if (!room || !m) return undefined;
    room.delete(userId);
    if (this.byUser.get(userId) === roomId) this.byUser.delete(userId);
    if (room.size === 0) { this.rooms.delete(roomId); this.chat.delete(roomId); this.stages.delete(roomId); this.voice.delete(roomId); this.lives.delete(roomId); this.liveVideo.delete(roomId); this.games.delete(roomId); this.gameRooms.delete(roomId); }
    return m;
  }

  get(roomId: string, userId: string): HubMember | undefined {
    return this.rooms.get(roomId)?.get(userId);
  }

  broadcast(roomId: string, msg: object, exceptUserId?: string): void {
    for (const m of this.members(roomId)) if (m.userId !== exceptUserId) m.send(msg);
  }

  sendTo(userId: string, msg: object): void {
    const roomId = this.byUser.get(userId);
    if (roomId) this.get(roomId, userId)?.send(msg);
  }

  members(roomId: string, limit?: number): HubMember[] {
    const all = Array.from(this.rooms.get(roomId)?.values() ?? []);
    return limit === undefined ? all : all.slice(0, limit);
  }

  /** Rooms with someone in them (this process). */
  roomIds(): string[] {
    return Array.from(this.rooms.keys()).filter((id) => this.count(id) > 0);
  }

  count(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /** Rooms the hub knows this person hosts (the host is present in them). Used to fail closed when the database cannot be read. */
  roomsHostedBy(userId: string): string[] {
    const out: string[] = [];
    this.rooms.forEach((members, roomId) => { if (members.get(userId)?.role === "host") out.push(roomId); });
    return out;
  }

  roomOf(userId: string): string | null {
    return this.byUser.get(userId) ?? null;
  }

  /** Tells everyone the room is over and forgets it. Returns who was in it. */
  end(roomId: string): HubMember[] {
    const gone = this.members(roomId);
    for (const m of gone) m.send({ type: "room:ended", roomId });
    for (const m of gone) if (this.byUser.get(m.userId) === roomId) this.byUser.delete(m.userId);
    this.rooms.delete(roomId);
    this.chat.delete(roomId);
    this.stages.delete(roomId);
    this.voice.delete(roomId);
    this.lives.delete(roomId);
    this.liveVideo.delete(roomId);
    this.games.delete(roomId);
    this.gameRooms.delete(roomId);
    this.minors.delete(roomId);
    this.peaks.delete(roomId);
    return gone;
  }

  /** The age band of everyone in the room (null = unknown). */
  bandsIn(roomId: string): Array<AgeBand | null> {
    return this.members(roomId).map((m) => ageBand(m.age ?? null));
  }

  stageOf(roomId: string): StageState {
    const s = this.stages.get(roomId);
    return s ? { stage: [...s.stage], hands: [...s.hands], invited: [...s.invited] } : emptyStage();
  }

  setStage(roomId: string, s: StageState): void {
    if (s.stage.length || s.hands.length || s.invited.length) this.stages.set(roomId, { stage: [...s.stage], hands: [...s.hands], invited: [...s.invited] });
    else this.stages.delete(roomId);
  }

  /** Who holds the room's live screen and who has asked to (memory only, like the stage). */
  liveOf(roomId: string): LiveState {
    const s = this.lives.get(roomId);
    return s ? { holder: s.holder, asks: [...s.asks] } : { holder: null, asks: [] };
  }

  setLive(roomId: string, s: LiveState): void {
    if (s.holder || s.asks.length) this.lives.set(roomId, { holder: s.holder, asks: [...s.asks] });
    else this.lives.delete(roomId);
  }

  /** Gaming: the room's game (an empty one when there is none). Always a copy. */
  gameOf(roomId: string): GameState {
    const s = this.games.get(roomId) ?? emptyGame;
    return { format: s.format, teams: { A: [...s.teams.A], B: [...s.teams.B] }, featured: { ...s.featured }, asks: s.asks.map((a) => ({ ...a })), score: [s.score[0], s.score[1]] };
  }
  setGame(roomId: string, s: GameState): void {
    if (!this.gameRooms.has(roomId)) { this.games.delete(roomId); return; } // only a live game room keeps a game
    this.games.set(roomId, { format: s.format, teams: { A: [...s.teams.A], B: [...s.teams.B] }, featured: { ...s.featured }, asks: s.asks.map((a) => ({ ...a })), score: [s.score[0], s.score[1]] });
  }
  /** Gaming: the room is a game room (rooms.game_format set). Like voice, only kept while someone is in the room. */
  gameOn(roomId: string): boolean { return this.gameRooms.has(roomId); }
  setGameOn(roomId: string, on: boolean, info: GameRoomInfo = { dropMs: 120_000, ageLane: null }): void {
    if (on && this.count(roomId) > 0) this.gameRooms.set(roomId, { ...info });
    else { this.gameRooms.delete(roomId); this.games.delete(roomId); }
  }
  gameInfo(roomId: string): GameRoomInfo | null { const g = this.gameRooms.get(roomId); return g ? { ...g } : null; }

  /** Minors' room flag for the stage rule (hot path, no query). Set from the room row on every join; one way, like the column. */
  isMinorsRoom(roomId: string): boolean { return this.minors.has(roomId); }
  /**
   * Marked even while the room is empty, and NOT cleared when it empties (only when the room ends), like the column it
   * mirrors: a join whose row read predates the flag is still caught right before its hub insert, even if other people came
   * and went in between.
   */
  markMinorsRoom(roomId: string): void { this.minors.add(roomId); }

  /**
   * The one place a live member's age changes after they joined (an admin birthdate correction). The stage rule reads
   * HubMember.age, so the caller must reconcile the room's voice right after. Returns true if the age changed.
   */
  refreshAge(roomId: string, userId: string, age: number | null): boolean {
    const m = this.get(roomId, userId);
    if (!m || m.age === age) return false;
    m.age = age;
    return true;
  }

  /** Whether live video is on for the room (mirrors rooms.live_video). Like voice, only kept while someone is in the room. */
  liveVideoOn(roomId: string): boolean { return this.liveVideo.get(roomId) === true; }
  setLiveVideoOn(roomId: string, on: boolean): void { if (on && this.count(roomId) > 0) this.liveVideo.set(roomId, true); else this.liveVideo.delete(roomId); }

  /** Rooms with voice on that have someone in them (for the periodic sweep against LiveKit). */
  voiceRooms(): string[] {
    return Array.from(this.voice.keys()).filter((id) => this.count(id) > 0);
  }

  /**
   * Whether voice is on for the room (mirrors rooms.voice_enabled so hot paths need no query). Only kept while someone is in
   * the room: nothing would ever clear an entry for an empty room, and its first joiner reads the flag from the database anyway.
   */
  voiceOn(roomId: string): boolean { return this.voice.get(roomId) === true; }
  setVoiceOn(roomId: string, on: boolean): void { if (on && this.count(roomId) > 0) this.voice.set(roomId, true); else this.voice.delete(roomId); }

  recordChat(roomId: string, line: ChatLine): void {
    const ring = this.chat.get(roomId) ?? [];
    ring.push(line);
    if (ring.length > CHAT_RING) ring.shift();
    this.chat.set(roomId, ring);
  }

  /**
   * Kick or ban: their existing lines stay in the ring (reports attach them as evidence) but can no longer be quoted,
   * so nobody can keep re-broadcasting their words. Lines they send after returning are quotable again; unban does not
   * restore the old ones.
   */
  markUnquotable(roomId: string, userId: string): void {
    for (const l of this.chat.get(roomId) ?? []) if (l.userId === userId) l.quotable = false;
  }

  /** The last 50 lines, kept only so a report can attach them. Never persisted otherwise. */
  recentChat(roomId: string): ChatLine[] {
    return [...(this.chat.get(roomId) ?? [])];
  }
}

export const roomHub = new RoomHub();
