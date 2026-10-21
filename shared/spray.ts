// Spraying (phase 5): the pure rules shared by the server (the gate) and the client (what to offer).
// The server calls sprayEligibility with data it loaded from the database and the room hub, never from the request, and
// answers EVERY failing code with the same generic 403 (no oracle). The client mirrors it only to hide controls.
// No wallet, no balance: one spray is one real charge, priced from SPRAY_CATALOGUE (shared/money.ts).
import { moneyEligibleRoom, type Check } from "./roomRules";
import { SPRAY_CATALOGUE, sprayBreakdown, isSprayTier, type Breakdown, type Rates, type SprayTier } from "./money";

export type SprayCode =
  | "FEATURE_OFF"
  | "ROOM_NOT_ELIGIBLE"
  | "ROOM_NOT_LIVE"
  | "PAYER_NOT_VERIFIED"
  | "PAYER_NOT_IN_ROOM"
  | "SELF"
  | "RECIPIENT_NOT_ALLOWED"
  | "RECIPIENT_NOT_PAYABLE"
  | "HOST_NOT_PAYABLE";

export interface SprayEligibilityInput {
  room: { ageLimit: string; status: string; minorsRoom: boolean | null | undefined };
  payer: {
    userId: string;
    idVerifiedAdult: boolean;
    /** Currently a member of the room in the hub (a socket in the room). */
    inRoom: boolean;
    /** Optional extra: banned or kicked from this room, or account banned/deleted. true refuses (PAYER_NOT_IN_ROOM). */
    banned?: boolean;
  };
  recipient: {
    userId: string;
    idVerifiedAdult: boolean;
    /** A verified payout account / Paystack subaccount. */
    hasSubaccount: boolean;
    role: "host" | "cohost" | "guest";
    onStage: boolean;
    /** Optional extra: false when the recipient is not in the room right now. false refuses (RECIPIENT_NOT_ALLOWED). */
    present?: boolean;
  };
  host: { idVerifiedAdult: boolean; hasPayoutAccount: boolean };
  flags: { spray: boolean };
  /** Optional extra: either of the pair blocked the other. true refuses (RECIPIENT_NOT_ALLOWED). */
  blocked?: boolean;
}

const OK = { ok: true } as const;
const no = (code: SprayCode): Check<SprayCode> => ({ ok: false, code });

/**
 * The one spray rule. First failing rule wins, in this order: the spray switch, everything about the payer, the room, self,
 * the recipient, the host. Anything not literally `true` counts as false (fail closed).
 */
export function sprayEligibility(i: SprayEligibilityInput): Check<SprayCode> {
  if (!i || !i.flags || i.flags.spray !== true) return no("FEATURE_OFF");
  if (!i.payer || i.payer.idVerifiedAdult !== true) return no("PAYER_NOT_VERIFIED");
  if (!i.room || !moneyEligibleRoom({ ageLimit: i.room.ageLimit, minorsRoom: i.room.minorsRoom })) return no("ROOM_NOT_ELIGIBLE");
  if (i.room.status !== "live") return no("ROOM_NOT_LIVE");
  if (i.payer.inRoom !== true || i.payer.banned === true) return no("PAYER_NOT_IN_ROOM");
  if (typeof i.payer.userId !== "string" || !i.payer.userId) return no("PAYER_NOT_IN_ROOM");
  const r = i.recipient;
  if (!r || typeof r.userId !== "string" || !r.userId) return no("RECIPIENT_NOT_ALLOWED");
  if (i.payer.userId === r.userId) return no("SELF");
  if (i.blocked === true || r.present === false) return no("RECIPIENT_NOT_ALLOWED");
  const isHost = r.role === "host";
  const onStage = (r.role === "cohost" || r.role === "guest") && r.onStage === true;
  if (!isHost && !onStage) return no("RECIPIENT_NOT_ALLOWED");
  if (r.idVerifiedAdult !== true) return no("RECIPIENT_NOT_ALLOWED");
  if (r.hasSubaccount !== true) return no("RECIPIENT_NOT_PAYABLE");
  if (!i.host || i.host.idVerifiedAdult !== true || i.host.hasPayoutAccount !== true) return no("HOST_NOT_PAYABLE");
  return OK;
}

// ---------------------------------------------------------------- limits (all kobo)
export const ROOM_LIMIT_OPTIONS_KOBO: readonly number[] = Object.freeze([50000, 100000, 200000, 500000, 1000000, 10000000]);
export const ROOM_LIMIT_DEFAULT_KOBO = 200000;
export const DAILY_DEFAULT_KOBO = 2000000;
export const DAILY_VERIFIED_MAX_KOBO = 10000000;
/** Raising a room or daily limit above this needs an ID-verified adult. */
export const ID_REQUIRED_ABOVE_KOBO = 2000000;
/** At or above this price a saved card is never charged silently (3D Secure / checkout). */
export const THREE_DS_AT_KOBO = 1000000;
/** A paid spray not delivered this long after payment was detected is reversed in full. */
export const DELIVERY_DEADLINE_MS = 60000;
export const NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT = 5000000;
export const NEW_HOST_WINDOW_DAYS = 14;
export const VELOCITY: Readonly<{ perMinute: number; perHour: number; perRecipientPerMinute: number }> =
  Object.freeze({ perMinute: 10, perHour: 60, perRecipientPerMinute: 3 });

const LIMIT_CONSTANTS = Object.freeze({
  ROOM_LIMIT_OPTIONS_KOBO, ROOM_LIMIT_DEFAULT_KOBO, DAILY_DEFAULT_KOBO, DAILY_VERIFIED_MAX_KOBO, ID_REQUIRED_ABOVE_KOBO,
  THREE_DS_AT_KOBO, DELIVERY_DEADLINE_MS, NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT, NEW_HOST_WINDOW_DAYS, VELOCITY,
});
export type SprayLimits = typeof LIMIT_CONSTANTS & { NEW_HOST_RECEIVE_CAP_KOBO: number };

/**
 * The limit constants. Usable both as an object (`sprayLimits.DAILY_DEFAULT_KOBO`) and as a function taking config
 * (`sprayLimits({ newHostReceiveCapKobo })`) that returns the constants plus the effective NEW_HOST_RECEIVE_CAP_KOBO.
 * A config cap that is not a positive safe integer falls back to the default.
 */
export const sprayLimits: typeof LIMIT_CONSTANTS & ((config?: { newHostReceiveCapKobo?: number | null }) => SprayLimits) =
  Object.assign((config?: { newHostReceiveCapKobo?: number | null }): SprayLimits => {
    const c = config?.newHostReceiveCapKobo;
    const cap = typeof c === "number" && Number.isSafeInteger(c) && c > 0 ? c : NEW_HOST_RECEIVE_CAP_KOBO_DEFAULT;
    return { ...LIMIT_CONSTANTS, NEW_HOST_RECEIVE_CAP_KOBO: cap };
  }, LIMIT_CONSTANTS);

/** True when spending `priceKobo` on top of `spentKobo` would go over `limitKobo` (equal to the limit is allowed). */
export function exceedsRoomLimit(spentKobo: number, limitKobo: number, priceKobo: number): boolean {
  if (![spentKobo, limitKobo, priceKobo].every((n) => Number.isSafeInteger(n) && n >= 0)) return true; // fail closed
  return spentKobo + priceKobo > limitKobo;
}

/** Is this one of the room limit options? */
export function isRoomLimitOption(kobo: unknown): kobo is number {
  return typeof kobo === "number" && ROOM_LIMIT_OPTIONS_KOBO.includes(kobo);
}

// ---------------------------------------------------------------- price and split
/**
 * What the PAYER sees as the price. `display` (like "₦1,000") is payer price text only, never in spray artwork or the
 * room event. Throws RangeError for an unknown tier.
 */
export function sprayPrice(tier: SprayTier): { kobo: number; v3c: number; label: string; display: string } {
  if (!isSprayTier(tier)) throw new RangeError(`unknown spray tier ${String(tier)}`);
  const t = SPRAY_CATALOGUE[tier];
  const naira = Math.floor(t.kobo / 100);
  const kobo = t.kobo % 100;
  const display = `₦${String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${kobo ? `.${String(kobo).padStart(2, "0")}` : ""}`;
  return { kobo: t.kobo, v3c: t.v3c, label: t.label, display };
}

/** Bank approval (3D Secure) is needed at or above THREE_DS_AT_KOBO: the bag and rain tiers. Unknown tier: true. */
export function requiresThreeDs(tier: SprayTier): boolean {
  if (!isSprayTier(tier)) return true;
  return SPRAY_CATALOGUE[tier].kobo >= THREE_DS_AT_KOBO;
}

export type SprayTargetKind = "host" | "stage";

/**
 * Who the recipient is to the room: the host, a person currently on stage (co-host or guest speaker), or null (not a
 * valid target). `stage` holds user ids exactly as the hub's stage list does.
 */
export function sprayTargetKind(room: { hostId: string; stage: readonly string[] }, recipientId: string): SprayTargetKind | null {
  if (typeof recipientId !== "string" || !recipientId) return null;
  if (recipientId === room.hostId) return "host";
  return Array.isArray(room.stage) && room.stage.includes(recipientId) ? "stage" : null;
}

/**
 * The split for one spray. Host target: the whole host share, no guest. Any other on-stage person:
 * sprayBreakdown(tier, true), `hostKobo` is the host's cut and `guestKobo` the stage person's.
 */
export function spraySplit(tier: SprayTier, kind: SprayTargetKind, rates?: Rates): { hostKobo: number; guestKobo: number | null; breakdown: Breakdown } {
  if (kind !== "host" && kind !== "stage") throw new RangeError(`unknown spray target kind ${String(kind)}`);
  const b = sprayBreakdown(tier, kind === "stage", rates);
  return { hostKobo: b.host, guestKobo: kind === "stage" ? (b.guest as number) : null, breakdown: b };
}

// ---------------------------------------------------------------- idempotency and status
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A lowercase UUID v4 (what crypto.randomUUID() makes). Anything else is refused. */
export function idempotencyKeyShape(x: unknown): x is string {
  return typeof x === "string" && x.length === 36 && UUID_V4.test(x);
}

export const SPRAY_STATUSES = ["created", "pending", "paid", "delivered", "reversing", "reversed", "failed", "disputed"] as const;
export type SprayStatus = typeof SPRAY_STATUSES[number];

export function isSprayStatus(x: unknown): x is SprayStatus {
  return typeof x === "string" && (SPRAY_STATUSES as readonly string[]).includes(x);
}

/**
 * Nothing more for the spray flow or the sweep to do. `delivered` can still become `disputed` through a chargeback
 * webhook, which is not part of the flow.
 */
export function isTerminal(status: SprayStatus): boolean {
  return status === "delivered" || status === "reversed" || status === "failed" || status === "disputed";
}

/** Statuses whose amount counts toward the payer's rolling 24 hour daily limit. */
export const SPRAY_SPEND_STATUSES: readonly SprayStatus[] = Object.freeze(["created", "pending", "paid", "delivered", "reversing", "disputed"] as SprayStatus[]);

/** Reason codes the client shows in plain words. */
export const SPRAY_REASONS = ["DECLINED", "INSUFFICIENT_FUNDS", "NOT_REUSABLE", "NETWORK", "RECIPIENT_LEFT", "ROOM_ENDED", "TIMEOUT", "DISPUTED"] as const;
export type SprayReason = typeof SPRAY_REASONS[number];
