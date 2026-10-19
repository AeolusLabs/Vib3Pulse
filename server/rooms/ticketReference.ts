// Payment references for room tickets, bound to (roomId, userId) by an HMAC. Pure (node crypto only, no database).
//
// Why: the reference is the one value that travels through the buyer's browser and Paystack and comes back on the
// verify call and the webhook. Binding it to the room and the buyer means a reference can only ever complete the
// purchase it was made for: another user's reference, or one replayed against a different room, fails the check.
// It also means a transaction someone set up themselves (for example with our public key in Paystack Popup, with
// metadata of their choosing) can never become a ticket, because they cannot make a valid MAC.
import crypto from "crypto";

const PREFIX = "vib3rt";
const NONCE_HEX = 24; // 12 random bytes
const MAC_HEX = 32;   // 128 bits of HMAC-SHA256
const SHAPE = new RegExp(`^${PREFIX}_([0-9a-f]{${NONCE_HEX}})_([0-9a-f]{${MAC_HEX}})$`);

/** The secret for the MAC. ROOM_TICKET_REF_SECRET if set, else SESSION_SECRET. Throws when neither is set (fail closed). */
export function ticketReferenceSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.ROOM_TICKET_REF_SECRET || env.SESSION_SECRET;
  if (!s) throw new Error("ROOM_TICKET_REF_SECRET or SESSION_SECRET must be set to sell room tickets");
  return s;
}

function mac(secret: string, roomId: string, userId: string, nonce: string): string {
  return crypto.createHmac("sha256", secret).update(`room-ticket:v1:${JSON.stringify([roomId, userId, nonce])}`).digest("hex").slice(0, MAC_HEX);
}

/** A fresh reference for this buyer and room. Paystack accepts it as a transaction reference (letters, digits, underscore). */
export function makeTicketReference(roomId: string, userId: string, secret: string, nonce: string = crypto.randomBytes(NONCE_HEX / 2).toString("hex")): string {
  if (!/^[0-9a-f]+$/.test(nonce) || nonce.length !== NONCE_HEX) throw new Error("bad nonce");
  return `${PREFIX}_${nonce}_${mac(secret, roomId, userId, nonce)}`;
}

/** Shape only (no secret needed): used to reject junk early, before any database or provider call. */
export function looksLikeTicketReference(reference: unknown): reference is string {
  return typeof reference === "string" && SHAPE.test(reference);
}

/** True only when this exact reference was made by makeTicketReference for this room and this user. Constant-time compare. */
export function ticketReferenceBelongsTo(reference: unknown, roomId: string, userId: string, secret: string): boolean {
  if (typeof reference !== "string") return false;
  const m = SHAPE.exec(reference);
  if (!m) return false;
  const expected = Buffer.from(mac(secret, roomId, userId, m[1]), "utf8");
  const given = Buffer.from(m[2], "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
