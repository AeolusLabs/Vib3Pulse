// Payment references for sprays, bound to (roomId, payerId, tier, recipientId) by an HMAC. Pure (node crypto only).
// Copy of server/rooms/ticketReference.ts with its own prefix and a domain-separated MAC input ("room-spray:v1:"), so a
// ticket reference can never pass as a spray reference or the other way round, even under the same secret.
//
// Why: the reference travels through the payer's browser and Paystack and comes back on verify and the webhook. Binding it
// to the room, payer, tier and recipient means it can only ever complete the spray it was made for, and a transaction
// someone set up themselves (with our public key and metadata of their choosing) can never become a spray (rule B4).
import crypto from "crypto";

const PREFIX = "vib3rs";
const NONCE_HEX = 24; // 12 random bytes
const MAC_HEX = 32;   // 128 bits of HMAC-SHA256
const SHAPE = new RegExp(`^${PREFIX}_([0-9a-f]{${NONCE_HEX}})_([0-9a-f]{${MAC_HEX}})$`);

/** The secret for the MAC. ROOM_SPRAY_REF_SECRET if set, else SESSION_SECRET. Throws when neither is set (fail closed). */
export function sprayReferenceSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.ROOM_SPRAY_REF_SECRET || env.SESSION_SECRET;
  if (!s) throw new Error("ROOM_SPRAY_REF_SECRET or SESSION_SECRET must be set to take sprays");
  return s;
}

function mac(secret: string, roomId: string, payerId: string, tier: string, recipientId: string, nonce: string): string {
  return crypto.createHmac("sha256", secret)
    .update(`room-spray:v1:${JSON.stringify([roomId, payerId, tier, recipientId, nonce])}`)
    .digest("hex").slice(0, MAC_HEX);
}

/** A fresh reference for this spray. Lowercase hex and underscores only. */
export function makeSprayReference(
  roomId: string, payerId: string, tier: string, recipientId: string, secret: string,
  nonce: string = crypto.randomBytes(NONCE_HEX / 2).toString("hex"),
): string {
  if (!secret) throw new Error("spray reference secret missing");
  for (const v of [roomId, payerId, tier, recipientId]) if (typeof v !== "string" || !v) throw new Error("bad spray reference input");
  if (!/^[0-9a-f]+$/.test(nonce) || nonce.length !== NONCE_HEX) throw new Error("bad nonce");
  return `${PREFIX}_${nonce}_${mac(secret, roomId, payerId, tier, recipientId, nonce)}`;
}

/** Shape only (no secret needed): rejects junk early, and tells the webhook a charge is a spray charge (rule B12). */
export function looksLikeSprayReference(reference: unknown): reference is string {
  return typeof reference === "string" && SHAPE.test(reference);
}

/** True only when this exact reference was made by makeSprayReference for these four values. Constant-time compare. */
export function sprayReferenceBelongsTo(
  reference: unknown, roomId: string, payerId: string, tier: string, recipientId: string, secret: string,
): boolean {
  if (typeof reference !== "string" || !secret) return false;
  const m = SHAPE.exec(reference);
  if (!m) return false;
  const expected = Buffer.from(mac(secret, roomId, payerId, tier, recipientId, m[1]), "utf8");
  const given = Buffer.from(m[2], "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** First characters only, for logs (rule B4: "log reference prefix only"). */
export function sprayReferenceForLog(reference: unknown): string {
  return typeof reference === "string" ? `${reference.slice(0, 12)}...` : "(none)";
}

/**
 * Our deterministic refund note for a spray. Paystack's refund API has no idempotency key, so the note is written on the
 * refund and looked up before any retry (same scheme as ticketRefundReference in phase 4).
 */
export function sprayRefundNote(reference: string): string {
  return `spray-refund-${reference}`;
}
