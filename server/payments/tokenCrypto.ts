// Encryption at rest for saved-card authorization codes (spray, phase 5, rule B8). Node crypto only, no database.
//
// Format: "v1:" + base64url(iv[12] | tag[16] | ciphertext). AES-256-GCM with a fixed, domain-separating AAD, key from
// PAYMENT_TOKEN_KEY (exactly 32 bytes, base64). The "v1:" prefix is the key id, so a later key can be added as "v2:".
//
// The key is needed ONLY when the spray flag is on or a card is being stored. With the flag off nothing here runs at
// boot, and encryptToken / decryptToken simply throw if they were ever called. Production boot with the flag ON and no
// valid key is refused by assertPaymentTokenKeyForBoot (called when server/payments/splitProvider.ts loads).
//
// Errors never contain the plaintext, the ciphertext or the key.
import crypto from "crypto";

const KEY_ID = "v1";
const PREFIX = `${KEY_ID}:`;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("vib3pulse:payment-token:v1", "utf8");

export const TOKEN_KEY_MISSING = "PAYMENT_TOKEN_KEY is not set or is not 32 bytes of base64";
export const TOKEN_DECRYPT_FAILED = "PAYMENT_TOKEN_DECRYPT_FAILED";

/** The 32-byte key, or null when PAYMENT_TOKEN_KEY is unset or malformed. Never throws, never logs. */
export function parsePaymentTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.PAYMENT_TOKEN_KEY ?? "").trim();
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? key : null;
}

function keyOrThrow(): Buffer {
  const key = parsePaymentTokenKey(process.env);
  if (!key) throw new Error(TOKEN_KEY_MISSING);
  return key;
}

/** Encrypts a provider authorization code. A fresh random IV each call, so the same code never gives the same output. */
export function encryptToken(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0 || plain.length > 512) throw new Error("encryptToken: bad input");
  const key = keyOrThrow();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

/**
 * Decrypts a value made by encryptToken. Any problem (wrong key id, bad encoding, short input, tampered bytes, wrong key,
 * empty string from a deleted card) throws TOKEN_DECRYPT_FAILED: it never returns a partial or guessed value.
 */
export function decryptToken(enc: string): string {
  const key = keyOrThrow();
  if (typeof enc !== "string" || !enc.startsWith(PREFIX)) throw new Error(TOKEN_DECRYPT_FAILED);
  const body = enc.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error(TOKEN_DECRYPT_FAILED);
  const buf = Buffer.from(body, "base64url");
  if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new Error(TOKEN_DECRYPT_FAILED);
  try {
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    if (!out) throw new Error("empty");
    return out;
  } catch {
    throw new Error(TOKEN_DECRYPT_FAILED);
  }
}

/**
 * Boot rule (B8): in production, with the spray flag ON, a missing or malformed PAYMENT_TOKEN_KEY refuses to start.
 * With the flag OFF (today) this never throws, so production keeps booting without the key.
 */
export function assertPaymentTokenKeyForBoot(sprayEnabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!sprayEnabled) return;
  if (env.NODE_ENV !== "production") return;
  if (!parsePaymentTokenKey(env)) throw new Error(`Refusing to start: spray is on and ${TOKEN_KEY_MISSING}`);
}
