// Room types, per-user room privacy and input validation. Pure; shared by server, WebSocket handlers and client.
import { AGE_LIMITS, type AgeLimit } from "./age";

export const ROOM_KINDS = ["party", "listening", "talk", "event"] as const;
export const ROOM_VISIBILITY = ["public", "friends", "invite"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export type RoomVisibility = (typeof ROOM_VISIBILITY)[number];

export const ROOM_REACTIONS: readonly string[] = ["❤️", "🔥", "👏", "😂", "🎉", "🙌", "😍", "🎶"];

// Free rooms hold at most 50 people. Paid rooms (part 5) will hold 100 to 150: capacityMaxPaid is recorded here, unused until then.
/** How long a room stays open after its host leaves or drops, before it ends on its own (the server uses this; the client words it). */
export const HOST_LEAVE_GRACE_MS = 120_000;

export const ROOM_LIMITS = { capacityDefault: 50, capacityMax: 50, capacityMaxPaid: 150, liveVideoMax: 50, title: 80, description: 500, chat: 300, replyText: 120 } as const;
const MAX_SCHEDULE_DAYS = 90;
const MAX_URL = 2048;

// ---------------------------------------------------------------- minors' rooms
/**
 * A room whose host was under 18 when it was created. Adults (18 and over) need a personal invite from the host and must
 * acknowledge this warning before they can enter. Single source of the wording: every denial path shows exactly this.
 */
export const MINORS_ROOM_WARNING =
  "This room is for under 18s. Adults can only come in if the host has invited them. Any inappropriate behaviour or indecent act will lead to your account being suspended, an investigation being opened, and possible legal action.";
/** MINORS_ROOM: an adult with no personal invite. MINORS_ROOM_ACK: invited, but the warning is not yet acknowledged. */
export const MINORS_ROOM_CODES = ["MINORS_ROOM", "MINORS_ROOM_ACK"] as const;
export type MinorsRoomCode = (typeof MINORS_ROOM_CODES)[number];

// ---------------------------------------------------------------- privacy
export const INTERACTION_MODES = ["everyone", "mutuals", "none"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export interface RoomPrivacy {
  v: 1;
  interactions: InteractionMode;
  appearInLists: boolean;
  allowInvites: boolean;
  /**
   * Direct messages between an adult and an under-18 (either way). OFF by default for everyone: with it off, nobody in the
   * other age group can start a conversation with you, and you can't start one with them. Both people must turn it on.
   */
  allowCrossAgeDm: boolean;
}

export const DEFAULT_ROOM_PRIVACY: RoomPrivacy = { v: 1, interactions: "mutuals", appearInLists: true, allowInvites: true, allowCrossAgeDm: false };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Reads a stored/legacy value tolerantly: each bad or missing field falls back to its default. */
export function resolveRoomPrivacy(stored: unknown): RoomPrivacy {
  if (!isObj(stored)) return { ...DEFAULT_ROOM_PRIVACY };
  const d = DEFAULT_ROOM_PRIVACY;
  return {
    v: 1,
    interactions: (INTERACTION_MODES as readonly unknown[]).includes(stored.interactions) ? (stored.interactions as InteractionMode) : d.interactions,
    appearInLists: typeof stored.appearInLists === "boolean" ? stored.appearInLists : d.appearInLists,
    allowInvites: typeof stored.allowInvites === "boolean" ? stored.allowInvites : d.allowInvites,
    allowCrossAgeDm: typeof stored.allowCrossAgeDm === "boolean" ? stored.allowCrossAgeDm : d.allowCrossAgeDm,
  };
}

export type Validated<T> = { ok: true; value: T } | { ok: false; field: string };

/** Strict: for writes. Unknown keys and wrong types are rejected, naming the field. */
export function validateRoomPrivacy(input: unknown): Validated<RoomPrivacy> {
  if (!isObj(input)) return { ok: false, field: "body" };
  for (const k of Object.keys(input)) if (!["v", "interactions", "appearInLists", "allowInvites", "allowCrossAgeDm"].includes(k)) return { ok: false, field: k };
  if (input.v !== undefined && input.v !== 1) return { ok: false, field: "v" };
  if (!(INTERACTION_MODES as readonly unknown[]).includes(input.interactions)) return { ok: false, field: "interactions" };
  if (typeof input.appearInLists !== "boolean") return { ok: false, field: "appearInLists" };
  if (typeof input.allowInvites !== "boolean") return { ok: false, field: "allowInvites" };
  if (input.allowCrossAgeDm !== undefined && typeof input.allowCrossAgeDm !== "boolean") return { ok: false, field: "allowCrossAgeDm" };
  return { ok: true, value: { v: 1, interactions: input.interactions as InteractionMode, appearInLists: input.appearInLists, allowInvites: input.allowInvites, allowCrossAgeDm: input.allowCrossAgeDm === true } };
}

// ---------------------------------------------------------------- room input
export interface RoomInput {
  title: string;
  description?: string;
  kind: RoomKind;
  visibility: RoomVisibility;
  ageLimit: AgeLimit;
  eventId?: string;
  venueId?: string;
  scheduledFor?: string;
  noDirectInteractions?: boolean;
  screenUrl?: string;
  capacity?: number;
}

const optId = (v: unknown) => v === undefined || v === null || v === "" ? undefined : typeof v === "string" && v.length <= 64 ? v : null;

export function validateRoomInput(input: unknown, now = new Date()): Validated<RoomInput & { capacity: number; noDirectInteractions: boolean }> {
  if (!isObj(input)) return { ok: false, field: "body" };
  const fail = (field: string) => ({ ok: false as const, field });

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 1 || title.length > ROOM_LIMITS.title) return fail("title");

  let description: string | undefined;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string" || input.description.length > ROOM_LIMITS.description) return fail("description");
    description = input.description.trim() || undefined;
  }

  if (!(ROOM_KINDS as readonly unknown[]).includes(input.kind)) return fail("kind");
  if (!(ROOM_VISIBILITY as readonly unknown[]).includes(input.visibility)) return fail("visibility");
  const ageLimit = input.ageLimit === undefined ? "all" : input.ageLimit;
  if (!(AGE_LIMITS as readonly unknown[]).includes(ageLimit)) return fail("ageLimit");

  const capacity = input.capacity === undefined || input.capacity === null ? ROOM_LIMITS.capacityDefault : input.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 2 || capacity > ROOM_LIMITS.capacityMax) return fail("capacity");

  const eventId = optId(input.eventId), venueId = optId(input.venueId);
  if (eventId === null) return fail("eventId");
  if (venueId === null) return fail("venueId");
  if (eventId && venueId) return fail("venueId");

  if (input.noDirectInteractions !== undefined && typeof input.noDirectInteractions !== "boolean") return fail("noDirectInteractions");

  let screenUrl: string | undefined;
  if (input.screenUrl !== undefined && input.screenUrl !== null && input.screenUrl !== "") {
    if (typeof input.screenUrl !== "string" || input.screenUrl.length > MAX_URL) return fail("screenUrl");
    screenUrl = input.screenUrl;
  }

  let scheduledFor: string | undefined;
  if (input.scheduledFor !== undefined && input.scheduledFor !== null && input.scheduledFor !== "") {
    const t = typeof input.scheduledFor === "string" ? Date.parse(input.scheduledFor) : NaN;
    if (Number.isNaN(t) || t < now.getTime() || t > now.getTime() + MAX_SCHEDULE_DAYS * 86400000) return fail("scheduledFor");
    scheduledFor = new Date(t).toISOString();
  }

  return {
    ok: true,
    value: {
      title, description, kind: input.kind as RoomKind, visibility: input.visibility as RoomVisibility, ageLimit: ageLimit as AgeLimit,
      eventId, venueId, scheduledFor, noDirectInteractions: input.noDirectInteractions === true, screenUrl, capacity,
    },
  };
}

// ---------------------------------------------------------------- chat replies
/** How many recent chat lines the server keeps per room (for reports and reply quotes). Older lines can't be quoted. */
export const CHAT_QUOTE_WINDOW = 50;

/** The quoted part of a reply. Always addressed by `userId`, never by a name. */
export interface ChatReply { userId: string; text: string }

/**
 * Shape check for a client-sent reply quote: exactly `{ userId, text }`, userId a string of 1 to 64 chars, text a string.
 * Text is trimmed and cut to ROOM_LIMITS.replyText; an empty result, a wrong type or any extra key gives null.
 * The server still checks the quote against its own record of the chat before forwarding it.
 */
export function validateChatReply(x: unknown): ChatReply | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const keys = Object.keys(x);
  if (keys.length !== 2 || !keys.includes("userId") || !keys.includes("text")) return null;
  const { userId, text } = x as Record<string, unknown>;
  if (typeof userId !== "string" || userId.length < 1 || userId.length > 64 || typeof text !== "string") return null;
  const t = Array.from(text.trim()).slice(0, ROOM_LIMITS.replyText).join("").trim();
  if (!t) return null;
  return { userId, text: t };
}

/**
 * Server-side gate for a reply quote. The client only says which line it means; the quoted text is taken from the
 * server's own record (newest matching line by that author), so nobody can put words in another member's mouth.
 * Lines flagged `quotable: false` (author kicked or banned) are skipped.
 * Returns null when no such line is in `recent` (never said, too old, or deleted), and the message then goes out without a quote.
 */
export function resolveChatReply(recent: ReadonlyArray<{ userId: string; text: string; quotable?: false }>, reply: ChatReply | null): ChatReply | null {
  if (!reply) return null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = recent[i];
    if (line.userId !== reply.userId || line.quotable === false) continue;
    const stored = validateChatReply({ userId: line.userId, text: line.text });
    if (stored && stored.text === reply.text) return stored;
  }
  return null;
}
