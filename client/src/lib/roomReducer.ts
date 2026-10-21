// Pure state machine for the room page. No React, no sockets: server messages and a few local events in, state out.
// Terminal phases (ended, denied) ignore everything except an explicit reset/connecting, so a late message
// after "the host ended the room" can never resurrect the room.
import { validateChatReply, type ChatReply } from "@shared/rooms";
import type { Screen } from "@shared/screen";
import type { NowPlaying } from "@shared/playback";
import { isSprayTier, type SprayTier } from "@shared/money";
import type { GameView } from "@shared/gameScreen";

export type RoomPhase = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "denied";
export type MemberRole = "host" | "cohost" | "guest";

export interface RoomMemberView {
  userId: string;
  role: MemberRole;
  muted: boolean;
  joinedAt: number;
  username?: string;
  displayName?: string | null;
  organizationName?: string | null;
  avatarUrl?: string | null;
  avatar?: unknown;
}

/**
 * `system`: set ONLY from the server's own `room:chat` field (a spray receipt "spray", the payer-only refund line
 * "spray_reversed"). A system line is never rendered as something a person typed, and offers no reply, heart or wave.
 * Typed chat never carries it (the server builds every typed line itself).
 */
export interface ChatItem { id: string; userId: string; text: string; at: number; replyTo?: ChatReply; system?: string }
export interface ReactionItem { id: string; userId: string; emoji: string; at: number }
export interface InteractionItem { id: string; fromId: string; targetId: string; kind: "wave" | "reaction"; emoji?: string; at: number }
/**
 * Phase 5: a delivered spray, exactly as the server broadcast it (`room:spray`). It is animation fuel only: the receipt chat
 * line is a normal server chat line (room:chat), so nothing here ever makes a chat line. `id` is the server's spray id.
 * No amount beyond what the tier implies, no card, no reference.
 */
export interface SprayEvent { id: string; tier: SprayTier; v3c: number; fromId: string; toId: string; at: number }

export interface RoomState {
  selfId: string | null;
  phase: RoomPhase;
  room: { id: string; [k: string]: unknown } | null;
  members: RoomMemberView[];
  memberCount: number;
  screen: Screen | null;
  you: { role: MemberRole; muted: boolean } | null;
  chat: ChatItem[];
  reactions: ReactionItem[];
  interactions: InteractionItem[];
  /** Phase 5: the last SPRAY_CAP delivered sprays, newest last (ring). */
  sprays: SprayEvent[];
  /** Terminal failure code (AGE_LIMIT, BANNED, KICKED, ROOM_FULL ...). */
  error: string | null;
  /** Last non-terminal rejection (RATE_LIMITED, MUTED, PRIVACY, SLOW_MODE ...); `n` changes on every notice so the UI can react to repeats. `retryMs` comes with SLOW_MODE. */
  notice: { code: string; n: number; retryMs?: number } | null;
  seq: number;
  /** Part 3a: live voice. `stage` = guests given the mic, `hands` = guests asking for it. */
  voiceEnabled: boolean;
  stage: string[];
  hands: string[];
  /** The host invited you to speak and you have not answered yet. */
  invitedYou: boolean;
  /** Live screen: whether the room has live video, who holds the screen, and who asked to. */
  liveVideo: boolean;
  holder: string | null;
  asks: string[];
  /** When the holder's held spot is given up (server epoch ms), null while they are present. */
  holderAwayUntil: number | null;
  /** Synced playback: what is playing, and server clock minus client clock when it last arrived. */
  nowPlaying: NowPlaying | null;
  serverOffsetMs: number;
  /** Gamers live: the match (teams, featured feeds, score, who is away). null unless the server's flag is on and this is a game room. */
  game: GameView | null;
}

export const CHAT_CAP = 200;
const REACTION_CAP = 30;
const INTERACTION_CAP = 20;
export const SPRAY_CAP = 20;

export const initialRoomState = (selfId: string | null = null): RoomState => ({
  selfId, phase: "idle", room: null, members: [], memberCount: 0, screen: null, you: null,
  chat: [], reactions: [], interactions: [], sprays: [], error: null, notice: null, seq: 0,
  voiceEnabled: false, stage: [], hands: [], invitedYou: false, liveVideo: false, holder: null, asks: [], holderAwayUntil: null, nowPlaying: null, serverOffsetMs: 0, game: null,
});

export type RoomServerMessage =
  | { type: "room:state"; room: { id: string }; members: RoomMemberView[]; memberCount: number; screen: Screen | null; you: { role: MemberRole; muted: boolean }; voiceEnabled?: boolean; stage?: string[]; hands?: string[]; holder?: string | null; asks?: string[]; away?: number | null; nowPlaying?: NowPlaying | null; serverNowMs?: number; game?: GameView }
  | { type: "room:joined"; member: RoomMemberView }
  | { type: "room:left"; userId: string }
  | { type: "room:chat"; userId: string; text: string; at: number; replyTo?: ChatReply; system?: string }
  | { type: "room:react"; userId: string; emoji: string; at?: number }
  | { type: "room:interact"; fromId: string; targetId: string; kind: "wave" | "reaction"; emoji?: string }
  | { type: "room:spray"; id: string; tier: SprayTier; v3c: number; fromId: string; toId: string; at: number }
  | { type: "room:screen"; screen: Screen | null; screenVersion?: number }
  | { type: "room:stage"; stage: string[]; hands: string[]; invitedYou?: boolean }
  | { type: "room:voice"; enabled: boolean }
  | { type: "room:live"; holder: string | null; asks: string[]; away?: number | null }
  | { type: "room:livevideo"; enabled: boolean }
  | { type: "room:game"; game: GameView }
  | { type: "room:settings"; pinnedMessage: string | null; slowModeSec: number; locked: boolean }
  | { type: "room:playback"; nowPlaying: NowPlaying | null; serverNowMs: number }
  | { type: "room:mod"; action: "mute" | "unmute" | "kick" | "ban" | "role"; targetId: string; role?: MemberRole }
  | { type: "room:ended" }
  | { type: "room:error"; code: string }
  | { type: "room:notice"; code: string; retryMs?: number };

export type RoomClientEvent =
  | { type: "client:connecting" }
  | { type: "client:reconnecting" }
  | { type: "client:reset" }
  | { type: "client:self"; userId: string | null }
  | { type: "client:expire"; before: number }
  | { type: "client:dismissInvite" };

export type RoomEvent = RoomServerMessage | RoomClientEvent;

/** A game view from the wire, checked before it is kept: a malformed one is dropped, never rendered. */
export function validGameView(g: unknown): g is GameView {
  const v = g as Partial<GameView> | null;
  if (!v || typeof v !== "object") return false;
  const team = (t: unknown) => Array.isArray(t) && t.every((x) => typeof x === "string");
  return typeof v.format === "number" && !!v.teams && team(v.teams.A) && team(v.teams.B)
    && !!v.featured && Array.isArray(v.asks) && Array.isArray(v.score) && !!v.away && typeof v.away === "object";
}

const TERMINAL: RoomPhase[] = ["ended", "denied"];
const cap = <T,>(list: T[], n: number) => (list.length > n ? list.slice(list.length - n) : list);
const patchMember = (members: RoomMemberView[], userId: string, patch: Partial<RoomMemberView>) =>
  members.map((m) => (m.userId === userId ? { ...m, ...patch } : m));

export function roomReducer(state: RoomState, event: RoomEvent, now: () => number = Date.now): RoomState {
  switch (event.type) {
    case "client:reset": return initialRoomState(state.selfId);
    case "client:self": return { ...state, selfId: event.userId };
    case "client:dismissInvite": return { ...state, invitedYou: false };
    case "client:connecting": return { ...initialRoomState(state.selfId), phase: "connecting" };
    case "client:reconnecting": return TERMINAL.includes(state.phase) || state.phase === "idle" ? state : { ...state, phase: "reconnecting" };
    case "client:expire": return { ...state, reactions: state.reactions.filter((r) => r.at >= event.before), interactions: state.interactions.filter((i) => i.at >= event.before) };
  }
  if (TERMINAL.includes(state.phase)) return state;

  switch (event.type) {
    case "room:state": {
      const sameRoom = state.room?.id === event.room.id;
      return {
        ...state, phase: "live", error: null, room: event.room, members: event.members, memberCount: event.memberCount,
        screen: event.screen ?? null, you: event.you,
        voiceEnabled: event.voiceEnabled === true, stage: event.stage ?? [], hands: event.hands ?? [], invitedYou: false, liveVideo: (event.room as { liveVideo?: boolean }).liveVideo === true, holder: event.holder ?? null, asks: event.asks ?? [], holderAwayUntil: event.away ?? null, nowPlaying: event.nowPlaying ?? null,
        game: validGameView(event.game) ? event.game : null,
        // A late joiner has the host's clock from this message, not only from the next heartbeat.
        serverOffsetMs: event.serverNowMs !== undefined ? event.serverNowMs - now() : state.serverOffsetMs,
        chat: sameRoom ? state.chat : [], reactions: sameRoom ? state.reactions : [], interactions: sameRoom ? state.interactions : [], sprays: sameRoom ? state.sprays : [],
      };
    }
    case "room:joined": {
      const known = state.members.some((m) => m.userId === event.member.userId);
      return {
        ...state,
        members: known ? state.members.map((m) => (m.userId === event.member.userId ? event.member : m)) : [...state.members, event.member],
        memberCount: known ? state.memberCount : state.memberCount + 1,
      };
    }
    case "room:left":
      // The list is capped by the server, so the leaver may not be in it; the count still drops.
      return { ...state, members: state.members.filter((m) => m.userId !== event.userId), memberCount: Math.max(0, state.memberCount - 1) };
    case "room:chat": {
      // A system line (server-made) is never a reply to anything; its kind is a short known-shape word, kept as is.
      const system = typeof event.system === "string" && /^[a-z_]{1,32}$/.test(event.system) ? event.system : undefined;
      const replyTo = system ? undefined : validateChatReply(event.replyTo) ?? undefined;
      const item: ChatItem = { id: `c${state.seq}`, userId: event.userId, text: event.text, at: event.at, ...(replyTo ? { replyTo } : {}), ...(system ? { system } : {}) };
      return { ...state, seq: state.seq + 1, chat: cap([...state.chat, item], CHAT_CAP) };
    }
    case "room:react": {
      const item: ReactionItem = { id: `r${state.seq}`, userId: event.userId, emoji: event.emoji, at: event.at ?? now() };
      return { ...state, seq: state.seq + 1, reactions: cap([...state.reactions, item], REACTION_CAP) };
    }
    case "room:interact": {
      const item: InteractionItem = { id: `i${state.seq}`, fromId: event.fromId, targetId: event.targetId, kind: event.kind, emoji: event.emoji, at: now() };
      return { ...state, seq: state.seq + 1, interactions: cap([...state.interactions, item], INTERACTION_CAP) };
    }
    case "room:spray": {
      // Server-made, but still checked: a malformed event is dropped, never animated. The same id twice (a resend after a
      // reconnect) is kept once, so a spray never plays twice.
      const e = event as Partial<SprayEvent>;
      if (typeof e.id !== "string" || !e.id || !isSprayTier(e.tier) || typeof e.fromId !== "string" || !e.fromId || typeof e.toId !== "string" || !e.toId) return state;
      if (typeof e.v3c !== "number" || !Number.isSafeInteger(e.v3c) || e.v3c <= 0) return state;
      if (state.sprays.some((x) => x.id === e.id)) return state;
      const item: SprayEvent = { id: e.id, tier: e.tier, v3c: e.v3c, fromId: e.fromId, toId: e.toId, at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : now() };
      return { ...state, sprays: cap([...state.sprays, item], SPRAY_CAP) };
    }
    case "room:screen":
      return { ...state, screen: event.screen, nowPlaying: null, room: state.room && event.screenVersion !== undefined ? { ...state.room, screenVersion: event.screenVersion } : state.room };
    case "room:stage": {
      const reached = !!state.selfId && event.stage.includes(state.selfId);
      return { ...state, stage: event.stage, hands: event.hands, invitedYou: event.invitedYou === true ? true : state.invitedYou && !reached };
    }
    case "room:voice":
      return event.enabled ? { ...state, voiceEnabled: true } : { ...state, voiceEnabled: false, stage: [], hands: [], invitedYou: false, liveVideo: false, holder: null, asks: [], holderAwayUntil: null };
    case "room:live":
      return { ...state, holder: event.holder, asks: event.asks, holderAwayUntil: event.holder ? event.away ?? null : null };
    case "room:livevideo":
      return event.enabled ? { ...state, liveVideo: true } : { ...state, liveVideo: false, holder: null, asks: [], holderAwayUntil: null };
    case "room:game":
      // Only a room that started with a game (room:state carried one) takes updates: a stale or stray message never makes a game appear.
      return state.game && validGameView(event.game) ? { ...state, game: event.game } : state;
    case "room:playback": {
      const current = (state.room as { screenVersion?: number } | null)?.screenVersion;
      // A message about a screen that has since been replaced (it crossed a screen change on the way) must not resurrect old playback.
      if (event.nowPlaying && current !== undefined && event.nowPlaying.screenVersion !== current) return state;
      return { ...state, nowPlaying: event.nowPlaying, serverOffsetMs: event.serverNowMs - now() };
    }
    case "room:mod": {
      const self = event.targetId === state.selfId;
      if (event.action === "mute" || event.action === "unmute") {
        const muted = event.action === "mute";
        return { ...state, members: patchMember(state.members, event.targetId, { muted }), you: self && state.you ? { ...state.you, muted } : state.you };
      }
      if (event.action === "role" && event.role) {
        return { ...state, members: patchMember(state.members, event.targetId, { role: event.role }), you: self && state.you ? { ...state.you, role: event.role } : state.you };
      }
      if ((event.action === "kick" || event.action === "ban") && self) {
        return { ...state, phase: "denied", error: event.action === "ban" ? "BANNED" : "KICKED" };
      }
      return state; // someone else removed: the server follows up with room:left
    }
    case "room:ended": return { ...state, phase: "ended" };
    case "room:error": return { ...state, phase: "denied", error: event.code };
    case "room:settings": {
      // Host settings live on the room object (room:state carries them there too). Before the first room:state there is no
      // room to put them on: the room:state that follows carries the current values anyway.
      if (!state.room) return state;
      const pinnedMessage = typeof event.pinnedMessage === "string" && event.pinnedMessage ? event.pinnedMessage : null;
      const slowModeSec = typeof event.slowModeSec === "number" && event.slowModeSec > 0 ? event.slowModeSec : 0;
      return { ...state, room: { ...state.room, pinnedMessage, slowModeSec, locked: event.locked === true } };
    }
    case "room:notice": {
      const retryMs = typeof event.retryMs === "number" && event.retryMs > 0 ? event.retryMs : undefined;
      return { ...state, notice: { code: event.code, n: (state.notice?.n ?? 0) + 1, ...(retryMs !== undefined ? { retryMs } : {}) } };
    }
  }
  return state;
}
