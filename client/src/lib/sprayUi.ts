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

/** A saved card as shown: the last four digits when the server knows them (null when it does not), and the brand. */
export interface SprayCard { last4: string | null; brand: string }
export interface SprayMe { method: SprayCard | null; dailyLimitKobo: number; dailySpentKobo: number; verified: boolean }

export function parseSprayMe(raw: unknown): SprayMe | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!koboOk(b.dailyLimitKobo) || !koboOk(b.dailySpentKobo) || typeof b.verified !== "boolean") return null;
  let method: SprayMe["method"] = null;
  if (b.method && typeof b.method === "object") {
    const m = b.method as Record<string, unknown>;
    // Only the last four digits and the brand are ever shown. Anything else on the object is ignored, never rendered.
    // A saved card whose last four the server does not have (empty or missing) is still a saved card: the server charges
    // it in one tap, so the UI must never call it "no card" (review M4). Only a malformed last4 drops it.
    const brand = typeof m.brand === "string" ? m.brand.slice(0, 24) : "";
    if (typeof m.last4 === "string" && /^\d{4}$/.test(m.last4)) method = { last4: m.last4, brand };
    else if (m.last4 === null || m.last4 === undefined || m.last4 === "") method = { last4: null, brand };
  }
  return { method, dailyLimitKobo: b.dailyLimitKobo, dailySpentKobo: b.dailySpentKobo, verified: b.verified };
}

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", verve: "Verve", amex: "Amex", "american express": "Amex" };
/** "Visa ending 4242", or "Your saved Visa" when the last four are unknown. An unknown brand is just "card". */
export function cardLabel(method: SprayCard | null): string | null {
  if (!method) return null;
  const brand = BRANDS[method.brand.trim().toLowerCase()];
  if (!method.last4) return brand ? `Your saved ${brand}` : "Your saved card";
  return `${brand ?? "Card"} ending ${method.last4}`;
}

/** The card label inside a sentence: "Charged to your saved Visa", "Charged to Visa ending 4242". */
export const cardInSentence = (label: string) => (label.startsWith("Your ") ? `y${label.slice(1)}` : label);

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

/**
 * One spray the payer chose. `key` is the idempotency key, made once for this intent and sent on every attempt of it.
 * `bankUrl` is the approval link once the server gave one (kept so the payer can reopen it while we keep checking).
 */
export interface SprayIntent { tier: SprayTier; targetId: string; key: string; saveCard: boolean; bankUrl?: string }

export type SprayFailReason =
  | SprayReason
  | "REVERSED" | "FAILED" | "UNAVAILABLE" | "ROOM_LIMIT" | "DAILY_LIMIT" | "RATE_LIMITED" | "SIGNED_OUT"
  /** Offline when Pay was tapped: nothing was sent. */
  | "NOT_SENT"
  /** The server could not start the payment (our side, 402 NETWORK or a failed row with NETWORK): not charged. */
  | "NOT_STARTED"
  /** A bank approval that was never paid and ran out of time (failed + TIMEOUT): NOT charged, never "refunded". */
  | "EXPIRED"
  /** GET /spray/:id answered 404: not this payer's spray, or no such spray. */
  | "NOT_FOUND"
  | "BAD_REQUEST" | "MISMATCH" | "BAD_LINK"
  /** The wait deadline passed while paying (the outcome is still unknown): "still checking", never a failure. */
  | "STILL_CHECKING"
  /** The wait deadline passed while the bank approval was open. */
  | "STILL_WAITING";

export type SprayFlow =
  | { kind: "idle" }
  | { kind: "confirming"; intent: SprayIntent }
  /**
   * The request is out or the server is delivering. `since` is when Pay was tapped (the wait deadline counts from it).
   * `unknown`: the last attempt got no answer (network, timeout, 5xx). We say "checking, don't pay again" and replay the
   * SAME key until the server answers or the deadline passes. Never shown as a failure.
   */
  | { kind: "paying"; intent: SprayIntent; sprayId: string | null; since: number; unknown?: boolean }
  | { kind: "action_required"; intent: SprayIntent; sprayId: string; url: string; since: number }
  | { kind: "delivered"; intent: SprayIntent; sprayId: string }
  | { kind: "failed"; intent: SprayIntent; reason: SprayFailReason; sameKey: boolean; sprayId: string | null; retryAfterSec?: number };

export type SprayOutcome =
  | { kind: "delivered"; sprayId: string }
  | { kind: "pending"; sprayId: string }
  | { kind: "action_required"; sprayId: string; url: string }
  | { kind: "failed"; reason: SprayFailReason; sprayId: string | null; retryAfterSec?: number }
  /** No answer we can trust (network, timeout, 5xx, a garbled 200): the payment may or may not have happened. */
  | { kind: "unknown" }
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
  /** After a reload: keep tracking a spray this tab started (sessionStorage), from idle only. */
  | { type: "resume"; intent: SprayIntent; sprayId: string; since: number }
  | { type: "close" };

export const IDLE: SprayFlow = { kind: "idle" };

/**
 * Unknown outcomes keep the key (the request may have reached the server: a replay returns the first result and never
 * charges again). Everything else was a definitive answer, so trying again is a new intent.
 */
export const SAME_KEY_REASONS: ReadonlySet<SprayFailReason> = new Set<SprayFailReason>(["NOT_SENT", "RATE_LIMITED", "STILL_CHECKING", "STILL_WAITING"]);

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
    case "resume":
      if (s.kind !== "idle" || !isSprayTier(e.intent.tier) || !idempotencyKeyShape(e.intent.key) || !sprayIdOk(e.sprayId) || !Number.isFinite(e.since)) return s;
      return { kind: "paying", intent: { tier: e.intent.tier, targetId: e.intent.targetId, key: e.intent.key, saveCard: false }, sprayId: e.sprayId, since: e.since };
    case "outcome": {
      if (s.kind !== "paying" && s.kind !== "action_required") return s;
      const o = e.outcome;
      if (o.kind === "wait") return s;
      // No answer: keep the same key and keep checking. Never a failure, never a new charge.
      if (o.kind === "unknown") return s.kind === "paying" && !s.unknown ? { ...s, unknown: true } : s;
      const id = "sprayId" in o ? o.sprayId : null;
      // An answer about a different spray (a late reply crossing a new intent) changes nothing.
      if (s.sprayId && id && id !== s.sprayId) return s;
      switch (o.kind) {
        case "delivered": return { kind: "delivered", intent: s.intent, sprayId: o.sprayId };
        case "pending": return s.kind === "paying" ? { ...s, sprayId: o.sprayId, unknown: false } : { kind: "paying", intent: s.intent, sprayId: o.sprayId, since: s.since };
        case "action_required":
          // The deadline keeps counting from the Pay tap (rule: a wait deadline from the moment Pay is tapped).
          return s.kind === "action_required" ? s : { kind: "action_required", intent: { ...s.intent, bankUrl: o.url }, sprayId: o.sprayId, url: o.url, since: s.since };
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
      return idempotencyKeyShape(e.key) ? { kind: "confirming", intent: { tier: s.intent.tier, targetId: s.intent.targetId, key: e.key, saveCard: s.intent.saveCard } } : s;
    case "close":
      // While the request is out or the bank page is open the flow is never dropped: the sheet is hidden, and the hook
      // keeps watching (closing the bank sheet must not stop tracking, review M8).
      return inFlight(s) ? s : IDLE;
  }
  return s;
}

/** The flow is waiting on the server or the bank. */
export const inFlight = (s: SprayFlow) => s.kind === "paying" || s.kind === "action_required";

/**
 * The flow has money in motion or an outcome the payer has not read: the room keeps the last good spray block while this
 * is true, so a reload that comes back without a block never unmounts the flow (review I7, ruling 2).
 */
export const holdsSprayBlock = (s: SprayFlow) => s.kind === "paying" || s.kind === "action_required" || s.kind === "failed";

// ---------------------------------------------------------------- answers from the server

const SERVER_REASONS: readonly string[] = SPRAY_REASONS;
const isServerReason = (x: unknown): x is SprayReason => typeof x === "string" && SERVER_REASONS.includes(x);
const sprayIdOk = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);

/** This build is a dev (or test) build. Vite turns `import.meta.env.DEV` into a literal; outside Vite (tsx) it is false. */
export function isDevBuild(): boolean {
  try { return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true; } catch { return false; }
}

/** The mock split provider's checkout host (server/payments/mockSplitProvider.ts). Opened in dev and test builds only. */
export const MOCK_CHECKOUT_HOST = "checkout.mock.test";

/**
 * The provider's approval page, or null. Production: https Paystack only (`paystack.com` / `paystack.co` and their
 * subdomains), never our own origin and never anything else. Dev and test builds (`dev`, default from the build flag)
 * also allow our own origin (the dev fixture) and the mock provider's https checkout host. No userinfo, ever.
 */
export function safeAuthorizationUrl(url: unknown, origin: string, opts: { dev?: boolean } = {}): string | null {
  if (typeof url !== "string" || !url || url.length > 2048) return null;
  const dev = opts.dev ?? isDevBuild();
  try {
    const u = new URL(url, origin);
    if (u.username || u.password) return null;
    const h = u.hostname;
    if (u.protocol === "https:" && (h === "paystack.com" || h.endsWith(".paystack.com") || h === "paystack.co" || h.endsWith(".paystack.co"))) return u.toString();
    if (dev && u.origin === origin) return u.toString();
    if (dev && u.protocol === "https:" && h === MOCK_CHECKOUT_HOST) return u.toString();
    return null;
  } catch {
    return null;
  }
}

type Answer =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; code?: string; reason?: string; sprayId?: string; retryAfterSec?: number };

/** No answer we can act on: the request may or may not have reached the server. */
export const unknownStatus = (status: number) => status === 0 || status === 408 || status >= 500;

/** A failed row's stored reason in plain words. Never a "refunded" reason: a failed spray never took money. */
function failedReason(reason: unknown): SprayFailReason {
  if (reason === "TIMEOUT") return "EXPIRED";
  if (reason === "NETWORK") return "NOT_STARTED";
  if (reason === "DECLINED" || reason === "INSUFFICIENT_FUNDS" || reason === "NOT_REUSABLE") return reason as SprayFailReason;
  return "FAILED";
}

/**
 * A reversed row's reason. Only `status: "reversed"` ever reaches a "returned" line. The recipient leaving, the room ending and
 * a slow delivery no longer reverse anything (a charge that went through is delivered), so they read as the plain reversed line.
 */
function reversedReason(reason: unknown): SprayFailReason {
  if (reason === "DISPUTED") return "DISPUTED";
  return "REVERSED";
}

/** POST /spray's answer as an outcome. */
export function outcomeOfPost(r: Answer, origin: string, opts: { dev?: boolean } = {}): SprayOutcome {
  if (r.ok) {
    const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
    // A 200 we can't read may still mean the payment started: check again with the same key, never "failed".
    if (!sprayIdOk(b.sprayId)) return { kind: "unknown" };
    const sprayId = b.sprayId;
    switch (b.status) {
      case "delivered": return { kind: "delivered", sprayId };
      case "pending": return { kind: "pending", sprayId };
      case "action_required": {
        const url = safeAuthorizationUrl(b.authorizationUrl, origin, opts);
        // A saved-card OTP/3DS answer may come without a link: keep checking (the poll and the room event still work).
        if (b.authorizationUrl === undefined || b.authorizationUrl === null) return { kind: "pending", sprayId };
        return url ? { kind: "action_required", sprayId, url } : { kind: "failed", reason: "BAD_LINK", sprayId };
      }
      case "reversed": return { kind: "failed", reason: reversedReason(b.reason), sprayId };
      case "failed": return { kind: "failed", reason: failedReason(b.reason), sprayId };
      default: return { kind: "unknown" };
    }
  }
  if (unknownStatus(r.status)) return { kind: "unknown" };
  const sprayId = sprayIdOk(r.sprayId) ? r.sprayId : null;
  return { kind: "failed", reason: reasonOfRefusal(r.status, r.code, r.reason), sprayId, ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) };
}

/**
 * A definitive refusal in plain words. 402 PAYMENT_DECLINED carries the server's reason: the card's own answer
 * (DECLINED, INSUFFICIENT_FUNDS, NOT_REUSABLE), NETWORK (our side could not start it: never "your bank said no"), or
 * TIMEOUT (a replayed key whose bank approval expired unpaid).
 */
export function reasonOfRefusal(status: number, code?: string, reason?: unknown): SprayFailReason {
  if (status === 401) return "SIGNED_OUT";
  if (status === 402) return isServerReason(reason) ? failedReason(reason) : "DECLINED";
  if (status === 400) return "BAD_REQUEST";
  if (status === 409) return code === "ROOM_LIMIT" ? "ROOM_LIMIT" : code === "DAILY_LIMIT" ? "DAILY_LIMIT" : code === "IDEMPOTENCY_MISMATCH" ? "MISMATCH" : "UNAVAILABLE";
  if (status === 429) return "RATE_LIMITED";
  return "UNAVAILABLE"; // 403 SPRAY_UNAVAILABLE, 404, anything else: the one plain line
}

/**
 * GET /spray/:id's answer. A network blip or a 5xx changes nothing (the deadline ends the wait); signed out and 404
 * (not your spray, or none) are final.
 */
export function outcomeOfStatus(r: Answer, sprayId: string): SprayOutcome {
  if (!r.ok) {
    if (r.status === 401) return { kind: "failed", reason: "SIGNED_OUT", sprayId };
    if (r.status === 404) return { kind: "failed", reason: "NOT_FOUND", sprayId };
    return { kind: "wait" };
  }
  const b = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
  switch (b.status) {
    case "delivered": return { kind: "delivered", sprayId };
    case "reversed": return { kind: "failed", reason: reversedReason(b.reason), sprayId };
    // A failed row is final whatever its reason (the server never marks an unknown charge failed).
    case "failed": return { kind: "failed", reason: failedReason(b.reason), sprayId };
    default: return { kind: "wait" }; // pending, action_required: keep waiting
  }
}

/** Ask the server again after this long (quick at first, slower after 30 seconds). */
export const pollDelayMs = (elapsedMs: number) => (elapsedMs < 30_000 ? 2_000 : 4_000);

/** Each request gives up after this long (it then counts as no answer, and the same key is tried again). */
export const SPRAY_REQUEST_TIMEOUT_MS = 15_000;

/**
 * When the client stops waiting and says so (never a spinner forever), counted from the Pay tap. Paid sprays are
 * delivered or reversed by the server within DELIVERY_DEADLINE_MS plus one sweep; a bank approval may take the payer a
 * few minutes, the server re-checks after 10.
 */
export function waitDeadlineMs(kind: "paying" | "action_required"): number {
  return kind === "paying" ? DELIVERY_DEADLINE_MS + 45_000 : 11 * 60_000;
}

/** Retry-After as seconds: delta-seconds or an HTTP date, capped at an hour. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) { const n = Number(v); return n > 0 ? Math.min(3600, n) : null; }
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  const sec = Math.ceil((at - nowMs) / 1000);
  return sec > 0 ? Math.min(3600, sec) : null;
}

// ---------------------------------------------------------------- tracking across a reload (sessionStorage)

/** Per tab: only what is needed to keep asking the server about one spray. No card data, no amount, no reference. */
export const SPRAY_TRACK_KEY = "vib3.rooms.sprayTrack";
export interface SprayTrack { v: 1; roomId: string; key: string; sprayId: string; tier: SprayTier; targetId: string; since: number }

export function encodeSprayTrack(roomId: string, s: SprayFlow): string | null {
  if ((s.kind !== "paying" && s.kind !== "action_required") || !s.sprayId) return null;
  const t: SprayTrack = { v: 1, roomId, key: s.intent.key, sprayId: s.sprayId, tier: s.intent.tier, targetId: s.intent.targetId, since: s.since };
  return JSON.stringify(t);
}

/** The tracked spray for this room, or null (another room, too old, or anything malformed). */
export function decodeSprayTrack(raw: string | null | undefined, roomId: string, now: number): SprayTrack | null {
  if (!raw || raw.length > 1024) return null;
  let t: unknown;
  try { t = JSON.parse(raw); } catch { return null; }
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (o.v !== 1 || o.roomId !== roomId || typeof o.key !== "string" || !idempotencyKeyShape(o.key) || !sprayIdOk(o.sprayId)) return null;
  if (!isSprayTier(o.tier) || typeof o.targetId !== "string" || !o.targetId || o.targetId.length > 128) return null;
  if (typeof o.since !== "number" || !Number.isFinite(o.since) || o.since > now || now - o.since > waitDeadlineMs("action_required")) return null;
  return { v: 1, roomId, key: o.key, sprayId: o.sprayId, tier: o.tier, targetId: o.targetId, since: o.since };
}

/** The bank always confirms bag and rain (3D Secure), even with a saved card. */
export const bankWillAsk = (tier: SprayTier, hasCard: boolean) => requiresThreeDs(tier) || !hasCard;

// ---------------------------------------------------------------- copy

/**
 * `tone`: "fail" is a definitive failure (an alert), "refund" is money that came back (only ever for status "reversed"),
 * "wait" is an outcome we don't know yet (a calm status line, never an alert), "info" is a plain refusal.
 */
export interface FailCopy {
  title: string; body: string; primary: "retry" | "check" | "limit" | "limits" | "signin" | null; anotherCard: boolean; refunded: boolean;
  tone: "fail" | "refund" | "wait" | "info";
}

export const SPRAY_FAIL_COPY: Record<SprayFailReason, FailCopy> = {
  DECLINED: { title: "Payment declined", body: "Your bank said no. You were not charged and nothing was sent. Try again, or use another card.", primary: "retry", anotherCard: true, refunded: false, tone: "fail" },
  INSUFFICIENT_FUNDS: { title: "Not enough on this card", body: "Your bank said there isn't enough on this card. You were not charged and nothing was sent.", primary: "retry", anotherCard: true, refunded: false, tone: "fail" },
  NOT_REUSABLE: { title: "Your bank needs to approve this card again", body: "This card can't be charged in one tap any more. Add it again with your bank, or use another card. You were not charged.", primary: null, anotherCard: true, refunded: false, tone: "fail" },
  // Never reached from a server answer (a failed NETWORK row is NOT_STARTED); kept as the plain line for the reason itself.
  NETWORK: { title: "The payment didn't start", body: "Something went wrong on our side, so you were not charged and nothing was sent. Try again in a moment.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
  NOT_STARTED: { title: "The payment didn't start", body: "Something went wrong on our side, so you were not charged and nothing was sent. Try again in a moment.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
  // The three below are only ever shown for status "reversed": money was taken and has been sent back.
  // Delivery problems no longer reverse a spray: a charge that went through is delivered. These three keys stay only so an old
  // row still reads honestly; they say the same as REVERSED and claim nothing about the room or the player.
  RECIPIENT_LEFT: { title: "Payment returned", body: "This payment didn't pass our checks, so it was returned to you in full.", primary: null, anotherCard: false, refunded: true, tone: "refund" },
  ROOM_ENDED: { title: "Payment returned", body: "This payment didn't pass our checks, so it was returned to you in full.", primary: null, anotherCard: false, refunded: true, tone: "refund" },
  TIMEOUT: { title: "Payment returned", body: "This payment didn't pass our checks, so it was returned to you in full.", primary: null, anotherCard: false, refunded: true, tone: "refund" },
  REVERSED: { title: "Payment returned", body: "This payment didn't pass our checks, so it was returned to you in full.", primary: null, anotherCard: false, refunded: true, tone: "refund" },
  DISPUTED: { title: "This payment was disputed", body: "Your bank reversed this payment. Nothing more happens to it here.", primary: null, anotherCard: false, refunded: false, tone: "info" },
  EXPIRED: { title: "The approval ran out of time", body: "The payment wasn't finished in time, so you were not charged and nothing was sent.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
  FAILED: { title: "The payment didn't go through", body: "Nothing was sent. If your bank shows a charge, it is returned in full.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
  NOT_FOUND: { title: "We can't find this payment", body: "This payment isn't on your account, or it doesn't exist.", primary: null, anotherCard: false, refunded: false, tone: "info" },
  UNAVAILABLE: { title: "Spraying isn't available", body: "Spraying is not available here.", primary: null, anotherCard: false, refunded: false, tone: "info" },
  ROOM_LIMIT: { title: "Over your room limit", body: "This spray is above your limit for this room. Raise it to continue.", primary: "limit", anotherCard: false, refunded: false, tone: "info" },
  DAILY_LIMIT: { title: "Over your daily limit", body: "This spray would go over your daily limit. You can change it in Spending limits.", primary: "limits", anotherCard: false, refunded: false, tone: "info" },
  RATE_LIMITED: { title: "Slow down a little", body: "You've sprayed a lot in a short time. Wait a moment, then try again.", primary: "retry", anotherCard: false, refunded: false, tone: "info" },
  SIGNED_OUT: { title: "Sign in to spray", body: "You were signed out. Sign in again, then come back to the room.", primary: "signin", anotherCard: false, refunded: false, tone: "info" },
  NOT_SENT: { title: "You're offline", body: "Nothing was sent and you were not charged. Try again when you're back online.", primary: "retry", anotherCard: false, refunded: false, tone: "info" },
  BAD_REQUEST: { title: "That didn't work", body: "Nothing was sent. Close this and try again.", primary: null, anotherCard: false, refunded: false, tone: "fail" },
  MISMATCH: { title: "That didn't work", body: "Nothing was sent. Close this and try again.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
  STILL_CHECKING: { title: "Still checking your payment", body: "We haven't had an answer yet. Don't pay again: if it went through, your spray lands. You are never charged twice for this spray.", primary: "check", anotherCard: false, refunded: false, tone: "wait" },
  STILL_WAITING: { title: "Still waiting for your bank", body: "We haven't heard back yet. If you approved it, your spray lands. You are never charged twice for this spray.", primary: "check", anotherCard: false, refunded: false, tone: "wait" },
  BAD_LINK: { title: "Couldn't open your bank", body: "Something was wrong with the approval link, so we didn't open it. You were not charged.", primary: "retry", anotherCard: false, refunded: false, tone: "fail" },
};

export const SPRAY_COPY = {
  trayIntro: "You pay when you throw. Nothing is stored.",
  nonRefundable: "Spray purchases are non-refundable.",
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
  checking: "We're still checking your payment. Don't pay again: you are never charged twice for this spray.",
  bankAgain: "Open my bank again",
  slideAlt: "Pay with a button instead",
  slideAltBack: "Use the slider",
  confirmAgain: "Tap again to confirm",
  thankYou: "Say thank you",
  privateLine: "Only you can see this",
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
export function chargeLine(tier: SprayTier, method: SprayCard | null): string {
  const label = cardLabel(method);
  const card = label ? cardInSentence(label) : null;
  if (!card) return "Your bank will ask you to add and approve a card.";
  return requiresThreeDs(tier) ? `Charged to ${card}. Your bank will ask you to approve it.` : `Charged to ${card}.`;
}

/**
 * Why a limit change was refused, in words. `ID_REQUIRED` (403) is the payer's own fact: a limit above the ID line needs
 * a verified ID (review M17). `status` undefined means the answer came back but could not be read.
 */
export function limitErrorText(status: number | undefined, code: string | undefined, fallback: string): string {
  if (status === 0) return "You're offline. Try again when you're back online.";
  if (code === "ID_REQUIRED") return `Verify your ID to set a limit above ${formatNaira(ID_REQUIRED_ABOVE_KOBO)}.`;
  return fallback;
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

// ---------------------------------------------------------------- screen effects (notes.html: dim, banner, flash, bump)

/**
 * What the room does around the particles for each tier, from the prototype. Rain owns the room: a dim with a spotlight
 * on the recipient, a banner from the dock with a live V3C counter, then the recipient is offered a thank-you. Never
 * played under Quiet effects or reduced motion (the chip and the server's chat line say it instead).
 */
export const SPRAY_SCREEN_FX: Readonly<Record<SprayTier, Readonly<{ flash: number; dim: boolean; banner: boolean; thank: boolean }>>> = {
  note: { flash: 0, dim: false, banner: false, thank: false },
  bundle: { flash: 0.28, dim: false, banner: false, thank: false },
  bag: { flash: 0.3, dim: false, banner: false, thank: true },
  rain: { flash: 0.4, dim: true, banner: true, thank: true },
};
/** Rain timings (ms from the room:spray event), as in notes.html. */
export const RAIN_FX = { dimOpacity: 0.7, dimOpacityVideo: 0.5, counterMs: 2200, offMs: 5600, thankMs: 5900 } as const;
/** How long the recipient's thank-you offer stays. */
export const THANK_OFFER_MS = 10_000;

/** The banner's counter at `elapsedMs`: an integer from 0 to `total`, ease-out cubic, exactly `total` at the end. */
export function counterAt(total: number, elapsedMs: number, durMs: number = RAIN_FX.counterMs): number {
  if (!Number.isSafeInteger(total) || total <= 0) return 0;
  if (!(durMs > 0) || !(elapsedMs < durMs)) return elapsedMs >= 0 ? total : 0;
  if (!(elapsedMs > 0)) return 0;
  const u = elapsedMs / durMs;
  return Math.min(total, Math.round(total * (1 - Math.pow(1 - u, 3))));
}

/** The rain banner's words: "Ade is making it rain" (or "You are making it rain") over the recipient's name. */
export function rainBannerText(fromName: string, toName: string, fromIsYou: boolean): { sub: string; who: string; label: string } {
  const sub = fromIsYou ? "You are making it rain" : `${fromName} is making it rain`;
  return { sub, who: toName, label: `${sub} on ${toName}` };
}

/** What the recipient sends when they tap "Say thank you": a real chat line from them, never one made for them. */
export const thankYouText = (fromName: string) => `Thank you ${fromName.trim().slice(0, 40) || "for the spray"}!`;

/**
 * A server-made chat line in words (room:chat with `system`). The receipt reads "Ade sprayed Mara a note"; the private
 * refund line is shown as is. These lines are never shown as something a person typed.
 */
export function systemChatText(system: string, text: string, who: string): string {
  return system === "spray" ? `${who} ${text}` : text;
}

/** Every sentence these screens can show, so one test checks the copy rules over all of them. */
export function allSprayCopy(): string[] {
  const out: string[] = [...Object.values(SPRAY_COPY), ...Object.values(TIER_LINE)];
  for (const c of Object.values(SPRAY_FAIL_COPY)) out.push(c.title, c.body);
  for (const t of SPRAY_TIERS) {
    out.push(confirmTitle(t, "Mara"), priceLine(t), chargeLine(t, { last4: "4242", brand: "visa" }), chargeLine(t, { last4: null, brand: "visa" }), chargeLine(t, null), bankAsk(t), sprayChipText(t, "Ade", "Mara"));
  }
  const rb = rainBannerText("Ade", "Mara", false);
  out.push(rb.sub, rb.label, rainBannerText("Ade", "Mara", true).sub, thankYouText("Ade"), confirmAgainText("note"), slidePayLabel("bundle"));
  return out;
}

/** The second tap of the button path: "Tap again to pay ₦1,000". */
export const confirmAgainText = (tier: SprayTier) => `Tap again to pay ${sprayPrice(tier).display}`;
/** The slider's name and the button path's first label. */
export const slidePayLabel = (tier: SprayTier) => `Slide to pay ${sprayPrice(tier).display}`;

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

// The dev fixture scenes (/dev/room-fixture?spray=...) live in sprayFixtures.ts, imported only by the DEV-only fixture page.
