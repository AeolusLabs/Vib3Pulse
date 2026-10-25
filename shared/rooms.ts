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

// Paid rooms (phase 4): a ticket costs ticketMinKobo to ticketMaxKobo (integer kobo: 1,000 to 100,000 naira) and a ticketed
// room holds ticketCapacityMin to ticketCapacityMax ticket holders (its `capacity` column is not used for them).
export const ROOM_LIMITS = {
  capacityDefault: 50, capacityMax: 50, capacityMaxPaid: 150, liveVideoMax: 50, title: 80, description: 500, chat: 300, replyText: 120, pinned: 200,
  ticketMinKobo: 100000, ticketMaxKobo: 10000000, ticketCapacityMin: 20, ticketCapacityMax: 150,
} as const;
const MAX_SCHEDULE_DAYS = 90;
const MAX_URL = 2048;

// ---------------------------------------------------------------- host settings
/** Slow mode choices, in seconds between two chat lines from the same person (0 = off). Host and co-hosts are exempt. */
export const SLOW_MODES = [0, 5, 15, 30] as const;
export type SlowMode = (typeof SLOW_MODES)[number];
/** What a pinned message may be sent as, before it is made plain text and cut to ROOM_LIMITS.pinned (longer is refused). */
export const PINNED_INPUT_MAX = 2000;

/**
 * The user-perceived characters of `text` (grapheme clusters: a flag, a skin-toned emoji or a family emoji is ONE).
 * Falls back to code points where Intl.Segmenter is missing (older browsers): never splits a surrogate pair either way.
 */
let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null = null;
function graphemeSegmenter(): typeof segmenter {
  const Seg = typeof Intl !== "undefined" ? (Intl as any).Segmenter : undefined;
  if (typeof Seg !== "function") return null; // looked up each time, so a missing Segmenter is never cached as present
  if (!segmenter) {
    try { segmenter = new Seg(undefined, { granularity: "grapheme" }); } catch { return null; }
  }
  return segmenter;
}
export function graphemes(text: string): string[] {
  const seg = graphemeSegmenter();
  if (seg) {
    try { return Array.from(seg.segment(text), (s) => s.segment); } catch { /* fall back below */ }
  }
  return Array.from(text);
}

/**
 * Cuts text to ROOM_LIMITS.pinned user-perceived characters (grapheme clusters, so no emoji, flag or accented letter is
 * ever split) and trims it. Empty gives null (no pinned message). The server runs this AFTER stripping HTML and invisible
 * characters; the client can use it for previews and counters.
 */
export function cutPinned(text: string): string | null {
  const t = graphemes(text.trim()).slice(0, ROOM_LIMITS.pinned).join("").trim();
  return t ? t : null;
}

// Invisible characters that can reorder or hide text (bidi overrides and isolates, zero-width marks, BOM) and control
// characters (C0 except tab and newline, DEL, C1). Built with RegExp so the TS target never parses the pattern.
const INVISIBLE = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]", "g");
// The zero-width joiner (U+200D) is also invisible, but it is what glues emoji sequences together (a family, a profession,
// a rainbow flag): it is kept only between two pictographs and removed everywhere else. Null where the engine lacks
// Unicode property escapes: ZWJ is then left in place (it cannot reorder text, only join).
const ZWJ: RegExp | null = (() => {
  try { return new RegExp("(\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]*)?\\u200D(?=(\\p{Extended_Pictographic})?)", "gu"); } catch { return null; }
})();

/**
 * Removes bidi controls (U+202A-202E, U+2066-2069), zero-width characters (U+200B-200F, U+2060, U+FEFF; a ZWJ inside an
 * emoji sequence stays) and control characters (C0 except tab and newline, DEL, C1). Used on every room text a person
 * types: title, description, pinned message and chat (the server's plainText runs it).
 */
export function stripInvisible(text: string): string {
  const out = text.replace(INVISIBLE, "");
  return ZWJ ? out.replace(ZWJ, (m: string, before?: string, after?: string) => (before && after ? m : before ?? "")) : out;
}

/** The three host settings as the room shows them (WS `room:settings` and inside `room:state.room`). */
export interface RoomSettings {
  pinnedMessage: string | null; slowModeSec: number; locked: boolean;
  /** Only while ROOMS_SPRAY is on: whether spraying is on right now, and whether an admin is the reason it is off. */
  sprayOn?: boolean; sprayBlockedByAdmin?: boolean;
}

// ---------------------------------------------------------------- minors' rooms
/**
 * A room whose host was under 18 when it was created. Adults (18 and over) need a personal invite from the host and must
 * acknowledge this warning before they can enter. Single source of the wording: every denial path shows exactly this.
 */
export const MINORS_ROOM_WARNING =
  "This room is for under 18s. Adults can only come in if the host has invited them. Any inappropriate behaviour or indecent act will lead to your account being suspended, an investigation being opened, and possible legal action.";
/**
 * Gaming (ROOMS_GAMING): the warning for the teen lane of a game room (a minors' room hosted by a teen). Same rule as
 * MINORS_ROOM_WARNING; the wording (owner decision 2026-10-22, to be checked by the lawyer) says the adult is entering a room
 * with a minor or minors and that misconduct is recorded and investigated. Sent as `warning` on every teen-lane refusal.
 */
export const MINORS_LANE_WARNING =
  "You are entering a room with a minor or minors. Adults can only come in if the host has invited them. Any misconduct is recorded and investigated, and inappropriate behaviour or an indecent act will lead to your account being suspended and possible legal action.";
/** The warning for this room: the teen-lane wording for a teen lane, the minors' room wording everywhere else. */
export const minorsWarningFor = (room: { ageLane?: string | null } | null | undefined): string =>
  room?.ageLane === "teen" ? MINORS_LANE_WARNING : MINORS_ROOM_WARNING;
/** MINORS_ROOM: an adult with no personal invite. MINORS_ROOM_ACK: invited, but the warning is not yet acknowledged. */
export const MINORS_ROOM_CODES = ["MINORS_ROOM", "MINORS_ROOM_ACK"] as const;
export type MinorsRoomCode = (typeof MINORS_ROOM_CODES)[number];

/** Why a host cannot turn spray on for a room (canEnableSpray), with the sentence the host sees. */
export const SPRAY_ENABLE_CODES = ["FEATURE_OFF", "HOST_NOT_ADULT", "HOST_NOT_VERIFIED", "NO_PAYOUT_ACCOUNT", "ROOM_NOT_ADULT"] as const;
export type SprayEnableCode = (typeof SPRAY_ENABLE_CODES)[number];
export const SPRAY_ENABLE_MESSAGES: Record<SprayEnableCode, string> = {
  FEATURE_OFF: "Spray isn't available yet.",
  HOST_NOT_ADULT: "You need to be 18 or over to turn on spray.",
  HOST_NOT_VERIFIED: "Verify your ID to turn on spray.",
  NO_PAYOUT_ACCOUNT: "Add a bank account on the Payout account page (/rooms/payouts) to turn on spray.",
  ROOM_NOT_ADULT: "Spray can only be turned on in 18+ or 21+ rooms.",
};

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
  /** Phase 6.6: tell my followers when I go live (the room_live notice). ON by default; off = nobody is told. */
  notifyFriendsLive: boolean;
}

export const DEFAULT_ROOM_PRIVACY: RoomPrivacy = { v: 1, interactions: "mutuals", appearInLists: true, allowInvites: true, allowCrossAgeDm: false, notifyFriendsLive: true };

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
    notifyFriendsLive: typeof stored.notifyFriendsLive === "boolean" ? stored.notifyFriendsLive : d.notifyFriendsLive,
  };
}

export type Validated<T> = { ok: true; value: T } | { ok: false; field: string };

/**
 * Strict: for writes. Unknown keys and wrong types are rejected, naming the field. notifyFriendsLive is optional (older
 * clients do not send it): when absent it keeps `prev`'s value (the stored setting), else the default (true).
 */
export function validateRoomPrivacy(input: unknown, prev?: Pick<RoomPrivacy, "notifyFriendsLive">): Validated<RoomPrivacy> {
  if (!isObj(input)) return { ok: false, field: "body" };
  for (const k of Object.keys(input)) if (!["v", "interactions", "appearInLists", "allowInvites", "allowCrossAgeDm", "notifyFriendsLive"].includes(k)) return { ok: false, field: k };
  if (input.v !== undefined && input.v !== 1) return { ok: false, field: "v" };
  if (!(INTERACTION_MODES as readonly unknown[]).includes(input.interactions)) return { ok: false, field: "interactions" };
  if (typeof input.appearInLists !== "boolean") return { ok: false, field: "appearInLists" };
  if (typeof input.allowInvites !== "boolean") return { ok: false, field: "allowInvites" };
  if (input.allowCrossAgeDm !== undefined && typeof input.allowCrossAgeDm !== "boolean") return { ok: false, field: "allowCrossAgeDm" };
  if (input.notifyFriendsLive !== undefined && typeof input.notifyFriendsLive !== "boolean") return { ok: false, field: "notifyFriendsLive" };
  const notifyFriendsLive = typeof input.notifyFriendsLive === "boolean" ? input.notifyFriendsLive
    : typeof prev?.notifyFriendsLive === "boolean" ? prev.notifyFriendsLive : DEFAULT_ROOM_PRIVACY.notifyFriendsLive;
  return { ok: true, value: { v: 1, interactions: input.interactions as InteractionMode, appearInLists: input.appearInLists, allowInvites: input.allowInvites, allowCrossAgeDm: input.allowCrossAgeDm === true, notifyFriendsLive } };
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
  /**
   * Host setting. undefined = not sent; null = no pinned message. A string here is only trimmed: the server makes it
   * plain text and cuts it to ROOM_LIMITS.pinned (pinnedPlainText), so tags never count towards the length.
   */
  pinnedMessage?: string | null;
  /** Host setting: one of SLOW_MODES. undefined = not sent. */
  slowModeSec?: SlowMode;
  /**
   * Paid rooms. undefined = not sent; null = free. Price in integer kobo (ROOM_LIMITS.ticketMinKobo to ticketMaxKobo),
   * capacity ROOM_LIMITS.ticketCapacityMin to ticketCapacityMax. Both set or both free, and only in 18+ / 21+ rooms.
   * The validator checks shape only: whether this host may sell (flag, ID check, payout account) is the server's call.
   */
  ticketPriceKobo?: number | null;
  ticketCapacity?: number | null;
  /** Buyers may refund themselves before the start (default true). undefined = not sent. */
  refundBeforeStart?: boolean;
  /** Spray opt-in (host switch, default off). undefined = not sent. Shape only: whether this host may turn it on is the server's call. */
  sprayEnabled?: boolean;
}

/** A ticket field as sent: undefined (not sent), null (free) or an integer within [min, max]; false when invalid. */
function ticketNumber(v: unknown, min: number, max: number): number | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : false;
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

  // Only the exact numbers in SLOW_MODES (the string "5" or 7 are refused). Absent means "not sent".
  let slowModeSec: SlowMode | undefined;
  if (input.slowModeSec !== undefined) {
    if (typeof input.slowModeSec !== "number" || !(SLOW_MODES as readonly number[]).includes(input.slowModeSec)) return fail("slowModeSec");
    slowModeSec = input.slowModeSec as SlowMode;
  }

  // null or "" clears it. Anything else must be a string; it is made plain text and cut to 200 by the server.
  let pinnedMessage: string | null | undefined;
  if (input.pinnedMessage !== undefined) {
    if (input.pinnedMessage === null || input.pinnedMessage === "") pinnedMessage = null;
    else if (typeof input.pinnedMessage !== "string" || input.pinnedMessage.length > PINNED_INPUT_MAX) return fail("pinnedMessage");
    else pinnedMessage = input.pinnedMessage.trim() || null;
  }

  // Paid rooms: exact integers in range (the string "100000", 1.5 or a negative are refused), price and capacity together
  // or not at all, and never in a room open to under 18s.
  const ticketPriceKobo = ticketNumber(input.ticketPriceKobo, ROOM_LIMITS.ticketMinKobo, ROOM_LIMITS.ticketMaxKobo);
  if (ticketPriceKobo === false) return fail("ticketPriceKobo");
  const ticketCapacity = ticketNumber(input.ticketCapacity, ROOM_LIMITS.ticketCapacityMin, ROOM_LIMITS.ticketCapacityMax);
  if (ticketCapacity === false) return fail("ticketCapacity");
  const priced = typeof ticketPriceKobo === "number", sized = typeof ticketCapacity === "number";
  if (priced !== sized) return fail(priced ? "ticketCapacity" : "ticketPriceKobo");
  if (priced && ageLimit !== "18+" && ageLimit !== "21+") return fail("ageLimit");
  if (input.refundBeforeStart !== undefined && typeof input.refundBeforeStart !== "boolean") return fail("refundBeforeStart");
  const refundBeforeStart = input.refundBeforeStart as boolean | undefined;
  if (input.sprayEnabled !== undefined && typeof input.sprayEnabled !== "boolean") return fail("sprayEnabled");
  const sprayEnabled = input.sprayEnabled as boolean | undefined;

  return {
    ok: true,
    value: {
      title, description, kind: input.kind as RoomKind, visibility: input.visibility as RoomVisibility, ageLimit: ageLimit as AgeLimit,
      eventId, venueId, scheduledFor, noDirectInteractions: input.noDirectInteractions === true, screenUrl, capacity,
      ...(slowModeSec !== undefined ? { slowModeSec } : {}),
      ...(pinnedMessage !== undefined ? { pinnedMessage } : {}),
      ...(ticketPriceKobo !== undefined ? { ticketPriceKobo } : {}),
      ...(ticketCapacity !== undefined ? { ticketCapacity } : {}),
      ...(refundBeforeStart !== undefined ? { refundBeforeStart } : {}),
      ...(sprayEnabled !== undefined ? { sprayEnabled } : {}),
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
