// Live room presence, in memory. Durable state (rooms, bans, mutes) is in Postgres; clients rebuild presence by
// re-sending room:join after a reconnect or restart. Keep this interface small so a Redis-backed hub can replace it.
import { ageBand, type AgeBand } from "@shared/age";
import type { StageState } from "@shared/stage";
import type { LiveState } from "@shared/liveScreen";
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
}

const emptyStage = (): StageState => ({ stage: [], hands: [], invited: [] });

export interface ChatLine { userId: string; text: string; at: number }

const CHAT_RING = 50;

export class RoomHub {
  private rooms = new Map<string, Map<string, HubMember>>(); // Map keeps insertion (join) order
  private byUser = new Map<string, string>();
  private chat = new Map<string, ChatLine[]>();
  private stages = new Map<string, StageState>();
  private voice = new Map<string, boolean>();
  private lives = new Map<string, LiveState>();
  private liveVideo = new Map<string, boolean>();

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
    if (room.size === 0) { this.rooms.delete(roomId); this.chat.delete(roomId); this.stages.delete(roomId); this.voice.delete(roomId); this.lives.delete(roomId); this.liveVideo.delete(roomId); }
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

  count(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
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

  /** Whether live video is on for the room (mirrors rooms.live_video). */
  liveVideoOn(roomId: string): boolean { return this.liveVideo.get(roomId) === true; }
  setLiveVideoOn(roomId: string, on: boolean): void { if (on) this.liveVideo.set(roomId, true); else this.liveVideo.delete(roomId); }

  /** Rooms with voice on that have someone in them (for the periodic sweep against LiveKit). */
  voiceRooms(): string[] {
    return Array.from(this.voice.keys()).filter((id) => this.count(id) > 0);
  }

  /** Whether voice is on for the room (mirrors rooms.voice_enabled so hot paths need no query). */
  voiceOn(roomId: string): boolean { return this.voice.get(roomId) === true; }
  setVoiceOn(roomId: string, on: boolean): void { if (on) this.voice.set(roomId, true); else this.voice.delete(roomId); }

  recordChat(roomId: string, line: ChatLine): void {
    const ring = this.chat.get(roomId) ?? [];
    ring.push(line);
    if (ring.length > CHAT_RING) ring.shift();
    this.chat.set(roomId, ring);
  }

  /** The last 50 lines, kept only so a report can attach them. Never persisted otherwise. */
  recentChat(roomId: string): ChatLine[] {
    return [...(this.chat.get(roomId) ?? [])];
  }
}

export const roomHub = new RoomHub();
