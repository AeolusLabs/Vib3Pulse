// Spraying on the client (tasks 5.7 and 5.9), pure: no React, no network, no clock reads. The server is the authority on
// everything here; these rules only decide what the UI offers and how it words what the server answered. They mirror
// shared/spray.ts and shared/money.ts (imported by name), never replace them.
//
// The pay flow is one state machine (`sprayFlow`): idle -> confirming -> paying -> (action_required) -> delivered | failed.
// The idempotency key is made once per intent (start) and kept on the intent; every retry of the same request reuses it.
// Only a definitive answer from the server (declined, refunded, refused) makes "Try again" a new intent with a new key.
import { SPRAY_TIERS, formatV3c, isSprayTier, type SprayTier } from "@shared/money";
import {
  DAILY_DEFAULT_KOBO, DAILY_VERIFIED_MAX_KOBO, DELIVERY_DEADLINE_MS, ID_REQUIRED_ABOVE_KOBO, ROOM_LIMIT_OPTIONS_KOBO, SPRAY_REASONS,
  exceedsRoomLimit, idempotencyKeyShape, requiresThreeDs, sprayPrice, type SprayReason,
} from "@shared/spray";
import { moneyEligibleRoom } from "@shared/roomRules";
import { formatNaira } from "./roomTickets";

// ---------------------------------------------------------------- the room's spray block (GET /api/rooms/:id)

/** Sent ONLY to a viewer who passes payer eligibility in a live, money-eligible room. Absent means no Spray anywhere. */
export interface SprayBlock { enabled: true; roomLimitKobo: number; roomSpentKobo: number; targets: string[] }

const koboOk = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const MAX_TARGETS = 50;

/**
 * The block, or null. Fails closed: anything malformed, a room that is not live, not 18+/21+, a minors' room, or a viewer
 * who only listens here gives null, whatever the server sent. A teen or an unverified adult never gets a block from the
 * server; this is the second lock on the same door.
 */
export function parseSprayBlock(raw: unknown, room: { ageLimit: string; minorsRoom?: boolean | null; status: string } | null | undefined, opts: { listenOnly?: boolean } = {}): SprayBlock | null {
  if (!room || opts.listenOnly || room.status !== "live" || !moneyEligibleRoom(room)) return null;
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (b.enabled !== true || !koboOk(b.roomLimitKobo) || !koboOk(b.roomSpentKobo) || !Array.isArray(b.targets)) return null;
  const targets = b.targets.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 128).slice(0, MAX_TARGETS);
  return { enabled: true, roomLimitKobo: b.roomLimitKobo, roomSpentKobo: b.roomSpentKobo, targets: Array.from(new Set(targets)) };
}

/**
 * Who can be sprayed right now: the server's list, narrowed to people still here and still the host or on stage (the
 * socket knows sooner than the last GET), never yourself. The server checks again at payment and again at delivery.
 */
export function sprayTargets(block: SprayBlock | null, room: { hostId: string; stage: readonly string[]; memberIds: readonly string[]; selfId: string | null }): string[] {
  if (!block) return [];
  return block.targets.filter((id) => id !== room.selfId && room.memberIds.includes(id) && (id === room.hostId || room.stage.includes(id)));
}

/** The host first, then the stage in its order: the target picked when Spray is opened from the dock. */
export function defaultTarget(targets: readonly string[], hostId: string): string | null {
  return targets.includes(hostId) ? hostId : targets[0] ?? null;
}

// ---------------------------------------------------------------- the payer's own settings (GET /api/users/me/spray)

export interface SprayMe { method: { last4: string; brand: string } | null; dailyLimitKobo: number; dailySpentKobo: number; verified: boolean }

export function parseSprayMe(raw: unknown): SprayMe | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!koboOk(b.dailyLimitKobo) || !koboOk(b.dailySpentKobo) || typeof b.verified !== "boolean") return null;
  let method: SprayMe["method"] = null;
  if (b.method && typeof b.method === "object") {
    const m = b.method as Record<string, unknown>;
    // Only the last four digits and the brand are ever shown. Anything else on the object is ignored, never rendered.
    if (typeof m.last4 === "string" && /^\d{4}$/.test(m.last4)) method = { last4: m.last4, brand: typeof m.brand === "string" ? m.brand.slice(0, 24) : "" };
  }
  return { method, dailyLimitKobo: b.dailyLimitKobo, dailySpentKobo: b.dailySpentKobo, verified: b.verified };
}

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", verve: "Verve", amex: "Amex", "american express": "Amex" };
/** "Visa ending 4242". An unknown brand is just "Card". */
export function cardLabel(method: { last4: string; brand: string } | null): string | null {
  if (!method) return null;
  return `${BRANDS[method.brand.trim().toLowerCase()] ?? "Card"} ending ${method.last4}`;
}

/** PUT .../spray/limit answers `{ limitKobo, spentKobo }`. */
export function parseLimitBody(raw: unknown): { limitKobo: number; spentKobo: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  return koboOk(b.limitKobo) && koboOk(b.spentKobo) ? { limitKobo: b.limitKobo, spentKobo: b.spentKobo } : null;
}

// ---------------------------------------------------------------- the tray

/** Plain words for what each tier does. Prices come from sprayPrice (payer text only); no naira sign is ever in artwork. */
export const TIER_LINE: Record<SprayTier, string> = {
  note: "one note",
  bundle: "100 notes",
  bag: "a duffle unzips",
  rain: "the whole room sees it",
};

export function confirmTitle(tier: SprayTier, name: string): string {
  switch (tier) {
    case "note": return `Throw a note at ${name}`;
    case "bundle": return `Throw a bundle at ${name}`;
    case "bag": return `Unzip a money bag over ${name}`;
    case "rain": return `Make it Rain on ${name}`;
  }
}

/** "₦10,000 · 1,000,000 V3C". */
export function priceLine(tier: SprayTier): string {
  const p = sprayPrice(tier);
  return `${p.display} · ${formatV3c(p.v3c)}`;
}

/** The note pays with a tap; bundle, bag and rain need a deliberate slide. */
export const needsSlide = (tier: SprayTier) => tier !== "note";

export type TileAction = { kind: "pay" } | { kind: "limit" } | { kind: "blocked"; reason: string };

/**
 * What tapping a tier does. Over the room limit asks to raise it first (board 7, Room limit); over the daily limit, offline,
 * or while the payer's settings are still loading, the tile is disabled with the reason in words.
 */
export function tileAction(tier: SprayTier, block: SprayBlock, me: SprayMe | null, online: boolean): TileAction {
  if (!online) return { kind: "blocked", reason: "You're offline." };
  if (!me) return { kind: "blocked", reason: "Checking your card." };
  const price = sprayPrice(tier).kobo;
  if (me.dailySpentKobo + price > me.dailyLimitKobo) return { kind: "blocked", reason: `Over your daily limit of ${formatNaira(me.dailyLimitKobo)}.` };
  if (exceedsRoomLimit(block.roomSpentKobo, block.roomLimitKobo, price)) {
    // No room limit option is high enough: there is nothing to raise it to.
    return limitChoices(block, price, me.verified).some((c) => c.ok) ? { kind: "limit" } : { kind: "blocked", reason: "Above the highest room limit." };
  }
  return { kind: "pay" };
}

export interface LimitChoice { kobo: number; ok: boolean; why?: string }

/** Room limit options for this spray: one below what you have spent plus this price cannot be picked; above ₦20,000 needs ID. */
export function limitChoices(block: SprayBlock, priceKobo: number, verified: boolean): LimitChoice[] {
  return ROOM_LIMIT_OPTIONS_KOBO.map((kobo) => {
    if (kobo < block.roomSpentKobo + priceKobo) return { kobo, ok: false, why: "Too low for this spray" };
    if (kobo > ID_REQUIRED_ABOVE_KOBO && !verified) return { kobo, ok: false, why: "Needs a verified account" };
    return { kobo, ok: true };
  });
}

/** The daily limit choices (Spending limits). Above the default needs a verified account; never above the verified maximum. */
export const DAILY_LIMIT_OPTIONS_KOBO: readonly number[] = [500_000, 2_000_000, 5_000_000, 10_000_000].filter((k) => k <= DAILY_VERIFIED_MAX_KOBO);
export function dailyChoices(verified: boolean): LimitChoice[] {
  return DAILY_LIMIT_OPTIONS_KOBO.map((kobo) => (kobo > DAILY_DEFAULT_KOBO && !verified ? { kobo, ok: false, why: "Needs a verified account" } : { kobo, ok: true }));
}

// ---------------------------------------------------------------- the pay flow (state machine)

export interface SprayIntent { tier: SprayTier; targetId: string; key: string; saveCard: boolean }

export type SprayFailReason =
  | SprayReason
  | "REVERSED" | "FAILED" | "UNAVAILABLE" | "ROOM_LIMIT" | "DAILY_LIMIT" | "RATE_LIMITED" | "SIGNED_OUT"
  | "OFFLINE" | "SERVER" | "BAD_REQUEST" | "MISMATCH" | "STILL_WAITING" | "BAD_LINK";

export type SprayFlow =
  | { kind: "idle" }
  | { kind: "confirming"; intent: SprayIntent }
  | { kind: "paying"; intent: SprayIntent; sprayId: string | null; since: number }
  | { kind: "action_required"; intent: SprayIntent; sprayId: string; url: string; since: number }
  | { kind: "delivered"; intent: SprayIntent; sprayId: string }
  | { kind: "failed"; intent: SprayIntent; reason: SprayFailReason; sameKey: boolean; sprayId: string | null; retryAfterSec?: number };

export type SprayOutcome =
  | { kind: "delivered"; sprayId: string }
  | { kind: "pending"; sprayId: string }
  | { kind: "action_required"; sprayId: string; url: string }
  | { kind: "failed"; reason: SprayFailReason; sprayId: string | null; retryAfterSec?: number }
  /** A poll that changes nothing (still waiting, or a passing network blip while polling). */
  | { kind: "wait" };

export type SprayFlowEvent =
  | { type: "start"; tier: SprayTier; targetId: string; key: string }
  | { type: "saveCard"; on: boolean }
  | { type: "pay"; now: number }
  | { type: "outcome"; outcome: SprayOutcome; now: number }
  /** A room:spray event with this id reached the room: it was delivered. */
  | { type: "seen"; sprayId: string }
  /** `key` is a fresh key, used only when the failure was definitive. */
  | { type: "retry"; key: string }
  | { type: "close" };

export const IDLE: SprayFlow = { kind: "idle" };

/**
 * Unknown outcomes keep the key (the request may have reached the server: a replay returns the first result and never
 * charges again). Everything else was a definitive answer, so trying again is a new intent.
 */
export const SAME_KEY_REASONS: ReadonlySet<SprayFailReason> = new Set<SprayFailReason>(["OFFLINE", "SERVER", "RATE_LIMITED", "STILL_WAITING", "NETWORK"]);

export function sprayFlow(s: SprayFlow, e: SprayFlowEvent): SprayFlow {
  switch (e.type) {
    case "start":
      // A payment in flight is never replaced by a new one (double tap, a second tray, a tap on another tier).
      if (s.kind === "paying" || s.kind === "action_required") return s;
      if (!isSprayTier(e.tier) || !e.targetId || !idempotencyKeyShape(e.key)) return s;
      return { kind: "confirming", intent: { tier: e.tier, targetId: e.targetId, key: e.key, saveCard: false } };
    case "saveCard":
      return s.kind === "confirming" ? { ...s, intent: { ...s.intent, saveCard: e.on === true } } : s;
    case "pay":
      return s.kind === "confirming" ? { kind: "paying", intent: s.intent, sprayId: null, since: e.now } : s;
    case "outcome": {
      if (s.kind !== "paying" && s.kind !== "action_required") return s;
      const o = e.outcome;
      if (o.kind === "wait") return s;
      const id = "sprayId" in o ? o.sprayId : null;
      // An answer about a different spray (a late reply crossing a new intent) changes nothing.
      if (s.sprayId && id && id !== s.sprayId) return s;
      switch (o.kind) {
        case "delivered": return { kind: "delivered", intent: s.intent, sprayId: o.sprayId };
        case "pending": return s.kind === "paying" ? { ...s, sprayId: o.sprayId } : { kind: "paying", intent: s.intent, sprayId: o.sprayId, since: s.since };
        case "action_required": return s.kind === "action_required" ? s : { kind: "action_required", intent: s.intent, sprayId: o.sprayId, url: o.url, since: e.now };
        case "failed": return {
          kind: "failed", intent: s.intent, reason: o.reason, sameKey: SAME_KEY_REASONS.has(o.reason), sprayId: o.sprayId ?? s.sprayId,
          ...(o.retryAfterSec ? { retryAfterSec: o.retryAfterSec } : {}),
        };
      }
      return s;
    }
    case "seen":
      return (s.kind === "paying" || s.kind === "action_required") && s.sprayId === e.sprayId ? { kind: "delivered", intent: s.intent, sprayId: e.sprayId } : s;
    case "retry":
      if (s.kind !== "failed") return s;
      if (s.sameKey) return { kind: "confirming", intent: s.intent };
      return idempotencyKeyShape(e.key) ? { kind: "confirming", intent: { ...s.intent, key: e.key } } : s;
    case "close":
      // While the request is out the flow cannot be dropped (the sheet can be hidden; the hook keeps watching).
      return s.kind === "paying" ? s : IDLE;
  }
  return s;
}

/** The flow is waiting on the server or the bank. */
export const inFlight = (s: SprayFlow) => s.kind === "paying" || s.kind === "action_required";

// ---------------------------------------------------------------- answers from the server

const SERVER_REASONS: readonly string[] = SPRAY_REASONS;
const reasonOf = (x: unknown, fallback: SprayFailReason): SprayFailReason => (typeof x === "string" && SERVER_REASONS.includes(x) ? (x as SprayReason) : fallback);
const sprayIdOk = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);

/**
 * The provider's approval page, or null. Our own origin (the mock provider and the dev fixture) or https Paystack only;
 * anything else is never opened.
 */
export function safeAuthorizationUrl(url: unknown, origin: string): string | null {
  if (typeof url !== "string" || !url || url.length > 2048) return null;
  try {
    const u = new URL(url, origin);
    if (u.username || u.password) return null;
    if (u.origin === origin) return u.toString();
    const h = u.hostname;
    if (u.protocol === "https:" && (h === "paystack.com" || h.endsWith(".paystack.com") || h === "paystack.co" || h.endsWith(".paystack.co"))) return u.toString();
    return null;
  } catch {
    return null;
  }
}

type Answer = { ok: true; status: number; body: unknown } | { ok: false; status: number; code?: string; retryAfterSec?: number };

/** POST /spray's answer as an outcome. */
export function outcomeOfPost(r: Answer, origin: string): SprayOutcome {
  if (r.ok) {
    const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
    if (!sprayIdOk(b.sprayId)) return { kind: "failed", reason: "SERVER", sprayId: null };
    const sprayId = b.sprayId;
    switch (b.status) {
      case "delivered": return { kind: "delivered", sprayId };
      case "pending": return { kind: "pending", sprayId };
      case "action_required": {
        const url = safeAuthorizationUrl(b.authorizationUrl, origin);
        return url ? { kind: "action_required", sprayId, url } : { kind: "failed", reason: "BAD_LINK", sprayId };
      }
      case "reversed": return { kind: "failed", reason: reasonOf(b.reason, "REVERSED"), sprayId };
      // NETWORK is an unknown outcome (lane B1): keep checking with the server, never call it failed.
      case "failed": return b.reason === "NETWORK" ? { kind: "pending", sprayId } : { kind: "failed", reason: reasonOf(b.reason, "FAILED"), sprayId };
      default: return { kind: "failed", reason: "SERVER", sprayId };
    }
  }
  return { kind: "failed", reason: reasonOfRefusal(r.status, r.code), sprayId: null, ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) };
}

export function reasonOfRefusal(status: number, code?: string): SprayFailReason {
  if (status === 0) return "OFFLINE";
  if (status === 401) return "SIGNED_OUT";
  if (status === 402) return "DECLINED";
  if (status === 400) return "BAD_REQUEST";
  if (status === 409) return code === "ROOM_LIMIT" ? "ROOM_LIMIT" : code === "DAILY_LIMIT" ? "DAILY_LIMIT" : code === "IDEMPOTENCY_MISMATCH" ? "MISMATCH" : "UNAVAILABLE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER";
  return "UNAVAILABLE"; // 403 SPRAY_UNAVAILABLE, 404, anything else: the one plain line
}

/** GET /spray/:id's answer. A refused or failed poll changes nothing (the deadline ends the wait), except being signed out. */
export function outcomeOfStatus(r: Answer, sprayId: string): SprayOutcome {
  if (!r.ok) return r.status === 401 ? { kind: "failed", reason: "SIGNED_OUT", sprayId } : { kind: "wait" };
  const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
  switch (b.status) {
    case "delivered": return { kind: "delivered", sprayId };
    case "reversed": return { kind: "failed", reason: reasonOf(b.reason, "REVERSED"), sprayId };
    case "failed": return b.reason === "NETWORK" ? { kind: "wait" } : { kind: "failed", reason: reasonOf(b.reason, "FAILED"), sprayId };
    default: return { kind: "wait" }; // pending, action_required: keep waiting
  }
}

/** Ask the server again after this long (quick at first, slower after 30 seconds). */
export const pollDelayMs = (elapsedMs: number) => (elapsedMs < 30_000 ? 2_000 : 4_000);

/**
 * When the client stops waiting and says so (never a spinner forever). Paid sprays are delivered or reversed by the server
 * within DELIVERY_DEADLINE_MS plus one sweep; a bank approval may take the payer a few minutes, the server re-checks after 10.
 */
export function waitDeadlineMs(kind: "paying" | "action_required"): number {
  return kind === "paying" ? DELIVERY_DEADLINE_MS + 45_000 : 11 * 60_000;
}

/** The bank always confirms bag and rain (3D Secure), even with a saved card. */
export const bankWillAsk = (tier: SprayTier, hasCard: boolean) => requiresThreeDs(tier) || !hasCard;

// ---------------------------------------------------------------- copy

export interface FailCopy { title: string; body: string; primary: "retry" | "check" | "limit" | "limits" | "signin" | null; anotherCard: boolean; refunded: boolean }

export const SPRAY_FAIL_COPY: Record<SprayFailReason, FailCopy> = {
  DECLINED: { title: "Payment declined", body: "Your bank said no. You were not charged and nothing was sent. Try again, or use another card.", primary: "retry", anotherCard: true, refunded: false },
  INSUFFICIENT_FUNDS: { title: "Not enough on this card", body: "Your bank said there isn't enough on this card. You were not charged and nothing was sent.", primary: "retry", anotherCard: true, refunded: false },
  NOT_REUSABLE: { title: "Your bank needs to approve this card again", body: "This card can't be charged in one tap any more. Add it again with your bank, or use another card. You were not charged.", primary: null, anotherCard: true, refunded: false },
  // Never shown for a spray the server is still checking (that keeps waiting); only if NETWORK ever arrives some other way.
  NETWORK: { title: "Still checking your payment", body: "We couldn't hear back from the card network yet. If you were charged, your spray arrives or you are refunded in full. You will never be charged twice for this spray.", primary: "check", anotherCard: false, refunded: false },
  RECIPIENT_LEFT: { title: "Refunded in full", body: "They left the stage, so you were refunded in full.", primary: null, anotherCard: false, refunded: true },
  ROOM_ENDED: { title: "Refunded in full", body: "The room ended before your spray arrived, so you were refunded in full.", primary: null, anotherCard: false, refunded: true },
  TIMEOUT: { title: "Refunded in full", body: "Your spray couldn't be delivered in time, so you were refunded in full.", primary: "retry", anotherCard: false, refunded: true },
  DISPUTED: { title: "This payment was disputed", body: "Your bank reversed this payment. Nothing more happens to it here.", primary: null, anotherCard: false, refunded: false },
  REVERSED: { title: "Refunded in full", body: "Your spray couldn't be delivered, so you were refunded in full.", primary: null, anotherCard: false, refunded: true },
  FAILED: { title: "The payment didn't go through", body: "Nothing was sent. If your bank shows a charge, it is returned in full.", primary: "retry", anotherCard: false, refunded: false },
  UNAVAILABLE: { title: "Spraying isn't available", body: "Spraying is not available here.", primary: null, anotherCard: false, refunded: false },
  ROOM_LIMIT: { title: "Over your room limit", body: "This spray is above your limit for this room. Raise it to continue.", primary: "limit", anotherCard: false, refunded: false },
  DAILY_LIMIT: { title: "Over your daily limit", body: "This spray would go over your daily limit. You can change it in Spending limits.", primary: "limits", anotherCard: false, refunded: false },
  RATE_LIMITED: { title: "Slow down a little", body: "You've sprayed a lot in a short time. Wait a moment, then try again.", primary: "retry", anotherCard: false, refunded: false },
  SIGNED_OUT: { title: "Sign in to spray", body: "You were signed out. Sign in again, then come back to the room.", primary: "signin", anotherCard: false, refunded: false },
  OFFLINE: { title: "You're offline", body: "We couldn't confirm the payment because the connection dropped. If anything was taken it is refunded in full automatically. Try again when you're back online: you will never be charged twice for this spray.", primary: "retry", anotherCard: false, refunded: false },
  SERVER: { title: "Something went wrong", body: "We couldn't confirm the payment. Trying again is safe: you will never be charged twice for this spray.", primary: "retry", anotherCard: false, refunded: false },
  BAD_REQUEST: { title: "That didn't work", body: "Nothing was sent. Close this and try again.", primary: null, anotherCard: false, refunded: false },
  MISMATCH: { title: "That didn't work", body: "Nothing was sent. Close this and try again.", primary: "retry", anotherCard: false, refunded: false },
  STILL_WAITING: { title: "Still waiting for your bank", body: "We haven't heard back yet. If the payment went through, your spray arrives or you are refunded in full. You will never be charged twice for this spray.", primary: "check", anotherCard: false, refunded: false },
  BAD_LINK: { title: "Couldn't open your bank", body: "Something was wrong with the approval link, so we didn't open it. You were not charged.", primary: "retry", anotherCard: false, refunded: false },
};

export const SPRAY_COPY = {
  trayIntro: "You pay when you throw. Nothing is stored.",
  addCardTitle: "Add a card",
  addCardBody: "Your bank asks you to approve once. Cards are handled by Paystack: we never see your card number.",
  saveCard: "Save this card so the next note or bundle is one tap",
  addCardGo: "Continue",
  notNow: "Not now",
  bankTitle: "Approve with your bank",
  bankOpen: "Open my bank",
  bankWaiting: "Waiting for your bank. Come back here when you have approved it.",
  bankDismiss: "Close",
  bankDismissNote: "If you already approved it, your spray still goes through.",
  paying: "Paying",
  sending: "Checking your payment and sending your spray",
  sent: "Sprayed",
  limitTitle: "Room limit",
  limitNote: `Limits above ${formatNaira(ID_REQUIRED_ABOVE_KOBO)} need a verified account.`,
  limitsTitle: "Spending limits",
  dailyLabel: "Most I can spend in a day",
  dailyNote: `Verified adults can go up to ${formatNaira(DAILY_VERIFIED_MAX_KOBO)} a day.`,
  removeCard: "Remove saved card",
  removedCard: "Card removed. Your next spray goes through your bank.",
  quietLabel: "Quiet effects",
  quietHint: "Show a short line instead of the animation",
  anotherCard: "Use another card",
  tryAgain: "Try again",
  checkAgain: "Check again",
  changeLimit: "Change room limit",
  openLimits: "Spending limits",
  signIn: "Sign in",
  cancel: "Cancel",
  done: "Done",
  returnTitle: "Back from your bank",
  returnChecking: "Checking your payment.",
  returnClose: "Close this window",
  returnBack: "Back to the room",
} as const;

/** "Charged to Visa ending 4242. Your bank will ask you to approve it." */
export function chargeLine(tier: SprayTier, method: { last4: string; brand: string } | null): string {
  const card = cardLabel(method);
  if (!card) return "Your bank will ask you to add and approve a card.";
  return requiresThreeDs(tier) ? `Charged to ${card}. Your bank will ask you to approve it.` : `Charged to ${card}.`;
}

/** "Room limit ₦2,000 · spent ₦0". */
export const limitChipText = (b: SprayBlock) => `Room limit ${formatNaira(b.roomLimitKobo)} · spent ${formatNaira(b.roomSpentKobo)}`;

export function limitAsk(tier: SprayTier, b: SprayBlock): string {
  return `This spray is ${sprayPrice(tier).display}, above your limit of ${formatNaira(b.roomLimitKobo)} (${formatNaira(b.roomSpentKobo)} spent). Raise it to continue.`;
}

/** The bank approval line: "Your bank is asking you to approve a payment of ₦10,000 to Vib3Pulse." */
export const bankAsk = (tier: SprayTier) => `Your bank is asking you to approve a payment of ${sprayPrice(tier).display} to Vib3Pulse.`;

/** The short chip shown instead of the animation (Quiet effects, reduced motion). The chat line comes from the server. */
export function sprayChipText(tier: SprayTier, from: string, to: string): string {
  switch (tier) {
    case "note": return `${from} sprayed ${to} a note`;
    case "bundle": return `${from} sprayed ${to} a bundle`;
    case "bag": return `${from} unzipped a money bag over ${to}`;
    case "rain": return `${from} made it rain on ${to}`;
  }
}

/** Every sentence these screens can show, so one test checks the copy rules over all of them. */
export function allSprayCopy(): string[] {
  const out: string[] = [...Object.values(SPRAY_COPY), ...Object.values(TIER_LINE)];
  for (const c of Object.values(SPRAY_FAIL_COPY)) out.push(c.title, c.body);
  for (const t of SPRAY_TIERS) {
    out.push(confirmTitle(t, "Mara"), priceLine(t), chargeLine(t, { last4: "4242", brand: "visa" }), chargeLine(t, null), bankAsk(t), sprayChipText(t, "Ade", "Mara"));
  }
  return out;
}

// ---------------------------------------------------------------- idempotency key, return address, effects

/** A fresh lowercase UUID v4 for one intent. Throws when the browser has no crypto (fail closed: no key, no spray). */
export function newIdempotencyKey(c: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined = (globalThis as { crypto?: Crypto }).crypto): string {
  let k: string | null = null;
  if (c?.randomUUID) k = c.randomUUID().toLowerCase();
  else if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    k = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  if (!k || !idempotencyKeyShape(k)) throw new Error("No secure random source for the spray key");
  return k;
}

/** The way back from the bank: /rooms/:id?spray=<sprayId>. Null when absent or not an id. */
export function sprayReturnId(search: string): string | null {
  const v = new URLSearchParams(search).get("spray");
  return v && sprayIdOk(v) ? v : null;
}

export function searchWithoutSpray(search: string): string {
  const p = new URLSearchParams(search);
  p.delete("spray");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Animate only when the viewer has not asked for Quiet effects and does not prefer reduced motion. */
export const animateSprays = (p: { quiet: boolean; reducedMotion: boolean }) => !p.quiet && !p.reducedMotion;

/** Sprays to play now: new ids only, and only recent ones (a reconnect never replays an old pour). */
export function newSprays<T extends { id: string; at: number }>(list: readonly T[], seen: ReadonlySet<string>, now: number, maxAgeMs = 15_000): T[] {
  return list.filter((s) => !seen.has(s.id) && now - s.at <= maxAgeMs);
}

/** Dev fixture scenes for /dev/room-fixture?spray=... */
export const SPRAY_SCENES = ["tray", "confirm", "bank", "declined", "limit", "quiet"] as const;
export type SprayScene = (typeof SPRAY_SCENES)[number];
export function parseSprayFixture(search: string): SprayScene | null {
  const v = new URLSearchParams(search).get("spray");
  return v && (SPRAY_SCENES as readonly string[]).includes(v) ? (v as SprayScene) : null;
}
