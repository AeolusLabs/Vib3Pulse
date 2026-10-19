// Paystack implementation of SplitPaymentProvider (spray, phase 5, task 5.3, decision D6). Built and unit tested against
// the docs only: it has NEVER been called with real keys. Flag `spray` stays OFF until the owner's G3 checklist passes.
//
// Mechanics (docs-v2.paystack.com, read 2026-10-19: Transaction API, Split API, Multi-split payments, Refunds, Webhooks):
//  - one recipient (spray to the host): `subaccount` + `transaction_charge` (flat, kobo) = everything that stays with us
//    (price - host share), `bearer: "account"` so Paystack's own fee comes out of OUR part, never the host's.
//  - two recipients (spray to a stage guest: guest share + host cut): a flat split (type "flat", currency NGN, shares in
//    kobo, bearer_type "account") created once per (subaccounts, shares) and reused by name; then `split_code`. The
//    remainder of a flat split stays with the main account (docs imply it; on the G3 checklist).
//  - first payment: POST /transaction/initialize with channels ["card"] (a card is the only thing that can be saved and the
//    only channel whose authorization can be reused), the server-made reference and callback.
//  - saved card: POST /transaction/charge_authorization. At or above 10,000 naira (or force3ds) we never charge silently:
//    a card-only checkout is started instead and the answer is action_required (rule B9).
//  - verify: GET /transaction/verify/:reference. paid on status success for the same reference; the currency and amount
//    are passed through for the caller to compare exactly (a mismatch is refunded in full, never treated as unpaid).
//  - a saved-card charge that needs a bank step (OTP, PIN, open_url, paused) answers action_required with the bank's https
//    link so the payer can approve it; without a link it is NOT_REUSABLE once verify shows nothing final.
//  - refund: full refund with our deterministic merchant note, after a lookup (phase 4 helpers in paystack.ts).
//
// Never logged, never in an error message: request bodies, the authorization code, the card signature, the email.
// Errors from Paystack are scrubbed (scrubProviderMessage) before they go anywhere.
import crypto from "crypto";
import { MIN_CHARGE_KOBO } from "@shared/money";
import { THREE_DS_AT_KOBO } from "@shared/spray";
import {
  PAYSTACK_UNAVAILABLE, getPaystackRefundState, refundPaystackPayment, paystackMetadataObject, type ProviderRefundState,
} from "./paystack.js";
import { looksLikeSprayReference, sprayRefundNote } from "./sprayReference.js";
import type { ChargeFailure, ChargeResult, ProviderAuthorization, SplitPaymentProvider, SplitSpec, SplitVerifyResult } from "./splitProvider.js";

/** Rule B9: at or above this a saved card is never charged silently. The one constant: THREE_DS_AT_KOBO (shared/spray.ts). */
export const THREE_DS_FLOOR_KOBO = THREE_DS_AT_KOBO;
const SUBACCOUNT_RE = /^ACCT_[A-Za-z0-9]{4,64}$/;
const SPLIT_CODE_RE = /^SPL_[A-Za-z0-9]{4,64}$/;
const METADATA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN_METADATA_KEYS = new Set(["authorization_code", "authorizationCode", "authEnc", "auth_enc", "signature", "email", "card", "pan", "cvv"]);

// ------------------------------------------------------------------------------------------------ pure helpers (tested)

/** Removes anything that might be a secret or personal data from a provider message, and shortens it. */
export function scrubProviderMessage(msg: unknown): string {
  const s = typeof msg === "string" ? msg : "";
  return s
    .replace(/AUTH_[A-Za-z0-9]+/g, "AUTH_[redacted]")
    .replace(/SIG_[A-Za-z0-9]+/g, "SIG_[redacted]")
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\d{6,}/g, "[number]")
    .slice(0, 120);
}

/** Throws (RangeError) unless the split is 1 or 2 distinct subaccounts with positive integer shares summing to at most the price. */
export function assertValidSplit(split: SplitSpec, amountKobo: number): void {
  if (!split || !Array.isArray(split.shares)) throw new RangeError("split: shares missing");
  const shares = split.shares;
  if (shares.length < 1 || shares.length > 2) throw new RangeError("split: one or two recipients only");
  const seen = new Set<string>();
  let sum = 0;
  for (const s of shares) {
    if (!s || typeof s.subaccountCode !== "string" || !SUBACCOUNT_RE.test(s.subaccountCode)) throw new RangeError("split: bad subaccount code");
    if (seen.has(s.subaccountCode)) throw new RangeError("split: duplicate subaccount");
    seen.add(s.subaccountCode);
    if (!Number.isSafeInteger(s.amountKobo) || s.amountKobo <= 0) throw new RangeError("split: every share must be a positive integer of kobo");
    sum += s.amountKobo;
  }
  if (sum > amountKobo) throw new RangeError("split: shares exceed the price");
}

/** String metadata only, safe keys, no secret-looking keys; the fixed key type: "spray" always wins. */
export function sprayMetadata(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!METADATA_KEY_RE.test(k) || FORBIDDEN_METADATA_KEYS.has(k)) throw new RangeError("metadata: key not allowed");
    if (typeof v !== "string" || v.length > 200) throw new RangeError("metadata: values must be short strings");
    out[k] = v;
  }
  out.type = "spray";
  return out;
}

export interface ChargeBodyInput {
  kind: "initialize" | "charge_authorization";
  reference: string;
  email: string;
  amountKobo: number;
  currency: string;
  split: SplitSpec;
  /** Required (and only allowed) when the split has two recipients. */
  splitCode?: string;
  metadata: Record<string, string>;
  /** initialize only. */
  callbackUrl?: string;
  /** charge_authorization only. */
  authorizationCode?: string;
}

/**
 * The exact JSON body for /transaction/initialize or /transaction/charge_authorization. Pure. Throws RangeError on any
 * bad input, so nothing malformed ever reaches Paystack: NGN only, integer kobo at or above MIN_CHARGE_KOBO, a spray
 * reference, one or two valid shares summing to at most the price.
 */
export function buildChargeBody(p: ChargeBodyInput): Record<string, unknown> {
  if (p.currency !== "NGN") throw new RangeError("currency: NGN only");
  if (!Number.isSafeInteger(p.amountKobo) || p.amountKobo < MIN_CHARGE_KOBO) throw new RangeError("amount: integer kobo at or above the minimum charge");
  if (!looksLikeSprayReference(p.reference)) throw new RangeError("reference: not a spray reference");
  if (typeof p.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(p.email) || p.email.length > 254) throw new RangeError("email: invalid");
  assertValidSplit(p.split, p.amountKobo);

  const body: Record<string, unknown> = {
    email: p.email,
    amount: p.amountKobo,
    currency: "NGN",
    reference: p.reference,
    metadata: sprayMetadata(p.metadata),
  };

  if (p.split.shares.length === 1) {
    if (p.splitCode !== undefined) throw new RangeError("splitCode: only for two recipients");
    const only = p.split.shares[0];
    body.subaccount = only.subaccountCode;
    const charge = p.amountKobo - only.amountKobo; // what stays with us
    // Never 0: Paystack may read 0 as "not set" and fall back to the subaccount's default percentage charge.
    if (!Number.isSafeInteger(charge) || charge <= 0) throw new RangeError("transaction_charge: must be a positive integer of kobo");
    body.transaction_charge = charge;
    body.bearer = "account";
  } else {
    if (typeof p.splitCode !== "string" || !SPLIT_CODE_RE.test(p.splitCode)) throw new RangeError("splitCode: required for two recipients");
    body.split_code = p.splitCode;
  }

  if (p.kind === "initialize") {
    if (p.authorizationCode !== undefined) throw new RangeError("authorizationCode: not for initialize");
    if (typeof p.callbackUrl !== "string" || !callbackUrlAllowed(p.callbackUrl)) throw new RangeError("callbackUrl: required (https)");
    body.callback_url = p.callbackUrl;
    body.channels = ["card"];
  } else if (p.kind === "charge_authorization") {
    if (p.callbackUrl !== undefined) throw new RangeError("callbackUrl: not for charge_authorization");
    if (typeof p.authorizationCode !== "string" || !/^AUTH_[A-Za-z0-9]{4,64}$/.test(p.authorizationCode)) throw new RangeError("authorizationCode: invalid");
    body.authorization_code = p.authorizationCode;
  } else {
    throw new RangeError("kind: unknown");
  }
  return body;
}

/**
 * The payer's way back from the bank page. https only; plain http is accepted ONLY outside production and only for a
 * local address (the dev server and the test server), never for a public host.
 */
export function callbackUrlAllowed(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof url !== "string" || url.length > 2048 || /\s/.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol !== "http:" || env.NODE_ENV === "production") return false;
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

/** A copy safe to log or show in a test failure: no authorization code, no email. */
export function redactChargeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if ("authorization_code" in out) out.authorization_code = "[redacted]";
  if ("email" in out) out.email = "[redacted]";
  return out;
}

/** Deterministic, so every process finds and reuses the same split instead of creating a new one per spray. */
export function splitNameFor(shares: SplitSpec["shares"]): string {
  const key = [...shares].sort((a, b) => a.subaccountCode.localeCompare(b.subaccountCode)).map((s) => `${s.subaccountCode}:${s.amountKobo}`).join("|");
  // A name, not a secret (an existing split is re-checked by splitMatches before use anyway).
  return `vib3-spray-${crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)}`;
}

export function buildSplitBody(shares: SplitSpec["shares"]): Record<string, unknown> {
  if (shares.length !== 2) throw new RangeError("a split code is only for two recipients");
  assertValidSplit({ shares }, Number.MAX_SAFE_INTEGER);
  return {
    name: splitNameFor(shares),
    type: "flat",
    currency: "NGN",
    subaccounts: shares.map((s) => ({ subaccount: s.subaccountCode, share: s.amountKobo })),
    bearer_type: "account",
  };
}

type PaystackSplitRow = {
  split_code?: string; name?: string; type?: string; currency?: string; active?: boolean; bearer_type?: string;
  subaccounts?: Array<{ subaccount?: string | { subaccount_code?: string }; share?: number | string }>;
};

/** True only when this existing Paystack split is exactly the one we want (flat, NGN, active, same codes and shares). */
export function splitMatches(row: PaystackSplitRow, shares: SplitSpec["shares"]): boolean {
  if (!row || typeof row.split_code !== "string" || !SPLIT_CODE_RE.test(row.split_code)) return false;
  if (row.type !== "flat" || (row.currency ?? "").toUpperCase() !== "NGN" || row.active === false) return false;
  if (row.bearer_type !== undefined && row.bearer_type !== "account") return false;
  const subs = Array.isArray(row.subaccounts) ? row.subaccounts : [];
  if (subs.length !== shares.length) return false;
  const got = new Map<string, number>();
  for (const s of subs) {
    const code = typeof s.subaccount === "string" ? s.subaccount : s.subaccount?.subaccount_code;
    if (typeof code !== "string") return false;
    got.set(code, Number(s.share));
  }
  return shares.every((s) => got.get(s.subaccountCode) === s.amountKobo);
}

/** What a failed charge means for the payer. Only clear decline words count; the rest is DECLINED (no money moved). */
export function classifyDecline(gatewayResponse: unknown): Exclude<ChargeFailure, "NETWORK"> {
  const g = typeof gatewayResponse === "string" ? gatewayResponse.toLowerCase() : "";
  if (g.includes("insufficient")) return "INSUFFICIENT_FUNDS";
  if (/not reusable|reusable|invalid authori[sz]ation|authori[sz]ation (code )?(is )?(invalid|expired)|token/.test(g)) return "NOT_REUSABLE";
  return "DECLINED";
}

/** Statuses where the bank wants the payer to do something (an OTP, a PIN, a bank page) before the charge can finish. */
const INTERACTIVE_CHARGE_STATUSES = new Set(["send_otp", "send_pin", "send_phone", "send_birthday", "send_address", "open_url", "paused"]);

export type ChargeData = { status?: unknown; reference?: unknown; gateway_response?: unknown; url?: unknown; authorization_url?: unknown; paused?: unknown };

/** The bank page Paystack named for a charge step (authorization_url, else url), only when it is https. */
function bankStepLink(data: ChargeData): string | null {
  for (const v of [data.authorization_url, data.url]) {
    if (typeof v === "string" && v.length <= 2048 && /^https:\/\/[^\s]+$/.test(v)) return v;
  }
  return null;
}

const isInteractive = (data: ChargeData) =>
  data.paused === true || (typeof data.status === "string" && INTERACTIVE_CHARGE_STATUSES.has(data.status));

/**
 * A charge_authorization answer as a ChargeResult. Pure. Only "success" is success, only "failed" is a decline.
 * A bank step (send_otp, open_url, paused, ...) WITH an https link is action_required carrying that link, so the payer can
 * approve it (the link is the bank's page, not a secret). Any other status (pending, a bank step without a link, a
 * reference that is not ours) is NETWORK = outcome unknown, verify later (chargeSaved then uses interactiveWithoutLink).
 */
export function mapChargeData(reference: string, data: ChargeData | null | undefined): ChargeResult {
  if (!data || data.reference !== reference) return { status: "failed", reference, failure: "NETWORK" };
  if (data.status === "success") return { status: "success", reference };
  if (data.status === "failed") return { status: "failed", reference, failure: classifyDecline(data.gateway_response) };
  const link = bankStepLink(data);
  if (link && isInteractive(data)) return { status: "action_required", reference, authorizationUrl: link };
  return { status: "failed", reference, failure: "NETWORK" };
}

/** A bank step the payer cannot be shown (no https link): the saved card cannot be used silently for this charge. */
export function interactiveWithoutLink(reference: string, data: ChargeData | null | undefined): boolean {
  if (!data || data.reference !== reference || bankStepLink(data)) return false;
  return isInteractive(data);
}

type PaystackAuthorization = {
  authorization_code?: unknown; last4?: unknown; brand?: unknown; card_type?: unknown; bank?: unknown;
  reusable?: unknown; signature?: unknown; channel?: unknown;
};
export type PaystackVerifyRaw = {
  status?: unknown; reference?: unknown; amount?: unknown; currency?: unknown; metadata?: unknown; authorization?: PaystackAuthorization | null;
};

/**
 * A verify answer as a SplitVerifyResult. Pure. paid = Paystack says success on OUR reference: money was taken. The
 * currency and the amount are reported as Paystack gave them (a non-integer or missing amount is reported as 0), and the
 * CALLER compares them with the stored row (verifiedMatches in spray.ts): a wrong currency or amount is then a full refund,
 * never "unpaid" (owner ruling 4: reporting it unpaid let the sweep mark it failed and keep the money).
 * A reusable authorization is reported only for a card with all of code, last4 and signature.
 */
export function mapVerifyData(reference: string, data: PaystackVerifyRaw): SplitVerifyResult {
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const currency = typeof data.currency === "string" ? data.currency.toUpperCase() : "";
  const amountKobo = typeof data.amount === "number" && Number.isSafeInteger(data.amount) && data.amount >= 0 ? data.amount : -1;
  const sameRef = data.reference === reference;
  const paid = sameRef && status === "success";
  // "failed" only for Paystack's final no-money words on OUR reference ("reversed" = already refunded in full). Anything
  // else that is not paid is "pending" (abandoned, ongoing, queued).
  const state: SplitVerifyResult["state"] = paid ? "paid"
    : sameRef && (status === "failed" || status === "reversed") ? "failed"
    : "pending";
  const raw = paystackMetadataObject(data.metadata);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") metadata[k] = v;

  let authorization: ProviderAuthorization | undefined;
  const a = data.authorization;
  if (paid && a && typeof a === "object" && typeof a.authorization_code === "string" && typeof a.signature === "string"
      && typeof a.last4 === "string" && /^\d{4}$/.test(a.last4)) {
    const brandRaw = typeof a.brand === "string" && a.brand.trim() ? a.brand : typeof a.card_type === "string" ? a.card_type : "card";
    authorization = {
      authorizationCode: a.authorization_code,
      last4: a.last4,
      brand: brandRaw.trim().toLowerCase().slice(0, 20),
      ...(typeof a.bank === "string" && a.bank.trim() ? { bank: a.bank.trim().slice(0, 60) } : {}),
      reusable: a.reusable === true && a.channel === "card",
      signature: a.signature,
    };
  }
  return { paid, state, amountKobo: Math.max(0, amountKobo), currency, metadata, ...(authorization ? { authorization } : {}) };
}

/** Paystack's words for "no transaction with this reference" (a 400/404 with a not-found message). */
export function isTransactionNotFound(a: { httpStatus: number; message?: string }): boolean {
  if (a.httpStatus !== 400 && a.httpStatus !== 404) return false;
  return /not found|no transaction|reference not found|transaction reference not found/i.test(a.message ?? "");
}

// ------------------------------------------------------------------------------------------------ HTTP (never logs)

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return key;
}

type Answer<T> = { httpStatus: number; ok: true; data: T } | { httpStatus: number; ok: false; message: string };

/** Same outage rules as paystackAnswer in paystack.ts: network, 5xx or an unreadable body throws "Paystack unavailable". */
async function answer<T>(path: string, init: RequestInit = {}): Promise<Answer<T>> {
  const secret = getSecretKey();
  let res: Response;
  try {
    res = await fetch(`https://api.paystack.co${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new Error(`${PAYSTACK_UNAVAILABLE}: network error`);
  }
  if (res.status >= 500) throw new Error(`${PAYSTACK_UNAVAILABLE}: HTTP ${res.status}`);
  const body = await res.json().catch(() => null) as { status?: boolean; data?: T; message?: string } | null;
  if (!body || typeof body !== "object") throw new Error(`${PAYSTACK_UNAVAILABLE}: HTTP ${res.status} without a JSON body`);
  if (body.status === true && res.status < 400) return { httpStatus: res.status, ok: true, data: body.data as T };
  return { httpStatus: res.status, ok: false, message: scrubProviderMessage(String(body.message ?? `HTTP ${res.status}`)) };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const a = await answer<T>(path, init);
  if (!a.ok) throw new Error(`Paystack error: ${a.message}`);
  return a.data;
}

// ------------------------------------------------------------------------------------------------ the provider

export function createPaystackSplitProvider(): SplitPaymentProvider {
  // Split codes are fixed per (subaccounts, shares), and shares are fixed per tier, so there are few of them.
  const splitCache = new Map<string, string>();

  async function ensureSplitCode(shares: SplitSpec["shares"]): Promise<string> {
    const body = buildSplitBody(shares);
    const name = body.name as string;
    const hit = splitCache.get(name);
    if (hit) return hit;
    const list = await call<PaystackSplitRow[]>(`/split?name=${encodeURIComponent(name)}&active=true&perPage=50`);
    const found = (Array.isArray(list) ? list : []).find((r) => splitMatches(r, shares));
    let code = found?.split_code;
    if (!code) {
      const created = await call<PaystackSplitRow>("/split", { method: "POST", body: JSON.stringify(body) });
      if (!splitMatches(created, shares)) throw new Error("Paystack error: the created split does not match what was asked");
      code = created.split_code as string;
    }
    splitCache.set(name, code);
    return code;
  }

  async function initialize(p: { reference: string; email: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string>; callbackUrl: string }): Promise<{ url: string }> {
    // Validate before any network call (also before a split is created).
    buildChargeBody({ kind: "initialize", ...p, currency: "NGN", splitCode: p.split.shares.length === 2 ? "SPL_placeholder0" : undefined });
    const splitCode = p.split.shares.length === 2 ? await ensureSplitCode(p.split.shares) : undefined;
    const body = buildChargeBody({ kind: "initialize", ...p, currency: "NGN", splitCode });
    const data = await call<{ authorization_url?: string; reference?: string }>("/transaction/initialize", { method: "POST", body: JSON.stringify(body) });
    if (!data || typeof data.authorization_url !== "string" || !/^https:\/\//.test(data.authorization_url)) throw new Error("Paystack error: no checkout link");
    if (data.reference !== undefined && data.reference !== p.reference) throw new Error("Paystack error: reference mismatch");
    return { url: data.authorization_url };
  }

  async function verify(reference: string): Promise<SplitVerifyResult | null> {
    if (!looksLikeSprayReference(reference)) return null;
    const a = await answer<PaystackVerifyRaw>(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!a.ok) {
      if (isTransactionNotFound(a)) return null;
      throw new Error(`Paystack error: verify refused (${a.message})`); // unknown: the caller retries, never "unpaid"
    }
    return mapVerifyData(reference, a.data ?? {});
  }

  /** After an unclear charge answer: the provider's own record decides. refused = Paystack rejected our request outright. */
  async function settleUnclear(reference: string, refused: boolean): Promise<ChargeResult> {
    try {
      const v = await verify(reference);
      if (v?.state === "paid") return { status: "success", reference };
      if (v?.state === "failed") return { status: "failed", reference, failure: "DECLINED" };
      if (v === null && refused) return { status: "failed", reference, failure: "DECLINED" }; // rejected and nothing created
    } catch { /* unknown */ }
    return { status: "failed", reference, failure: "NETWORK" };
  }

  return {
    startFirstPayment: initialize,

    async chargeSaved(p) {
      if (p.force3ds || p.amountKobo >= THREE_DS_FLOOR_KOBO) {
        // Rule B9: never a silent charge at this size. A card checkout, the bank's own checks, then the webhook/verify.
        if (typeof p.callbackUrl !== "string") throw new RangeError("callbackUrl: required when 3D Secure applies");
        const { url } = await initialize({ reference: p.reference, email: p.email, amountKobo: p.amountKobo, split: p.split, metadata: p.metadata, callbackUrl: p.callbackUrl });
        return { status: "action_required", reference: p.reference, authorizationUrl: url };
      }
      buildChargeBody({ kind: "charge_authorization", reference: p.reference, email: p.email, amountKobo: p.amountKobo, currency: "NGN", split: p.split, metadata: p.metadata, authorizationCode: p.authorizationCode, splitCode: p.split.shares.length === 2 ? "SPL_placeholder0" : undefined });
      const splitCode = p.split.shares.length === 2 ? await ensureSplitCode(p.split.shares) : undefined;
      const body = buildChargeBody({ kind: "charge_authorization", reference: p.reference, email: p.email, amountKobo: p.amountKobo, currency: "NGN", split: p.split, metadata: p.metadata, authorizationCode: p.authorizationCode, splitCode });
      let a: Answer<ChargeData>;
      try {
        a = await answer<ChargeData>("/transaction/charge_authorization", { method: "POST", body: JSON.stringify(body) });
      } catch {
        return settleUnclear(p.reference, false); // outage: maybe charged, maybe not
      }
      if (!a.ok) {
        // Clear card words answer at once; anything else (for example "duplicate reference") is looked up first.
        const kind = classifyDecline(a.message);
        if (kind !== "DECLINED" || /declin|do not honou?r|not permitted|restricted|stolen|lost card|expired card/i.test(a.message)) {
          return { status: "failed", reference: p.reference, failure: kind };
        }
        return settleUnclear(p.reference, true);
      }
      const mapped = mapChargeData(p.reference, a.data);
      if (interactiveWithoutLink(p.reference, a.data)) {
        // The bank wants a step we cannot show the payer. Unless verify says paid or failed, this card cannot be charged
        // silently: NOT_REUSABLE (no money moved now; a payment that lands later is caught by the sweep's 24 hour re-check
        // of failed sprays and refunded as LATE_PAYMENT).
        const settled = await settleUnclear(p.reference, false);
        return settled.failure === "NETWORK" ? { status: "failed", reference: p.reference, failure: "NOT_REUSABLE" } : settled;
      }
      return mapped.failure === "NETWORK" ? settleUnclear(p.reference, false) : mapped;
    },

    verify,

    async refund(reference: string): Promise<void> {
      if (!looksLikeSprayReference(reference)) throw new Error("BAD_REFERENCE");
      const note = sprayRefundNote(reference);
      const state: ProviderRefundState = await getPaystackRefundState(reference, note); // throws: do not refund
      if (state !== "none" && state !== "failed") return; // already refunded or in progress: never a second refund
      await refundPaystackPayment(reference, { merchantNote: note });
    },

    async refundState(reference: string, fullKobo?: number): Promise<ProviderRefundState> {
      if (!looksLikeSprayReference(reference)) throw new Error("BAD_REFERENCE");
      // With the full amount, "done" needs processed refunds adding up to all of it (a partial refund made by hand in the
      // dashboard is needs_attention, never "reversed").
      return getPaystackRefundState(reference, sprayRefundNote(reference), fullKobo !== undefined ? { fullKobo } : {});
    },
  };
}
