// Encryption at rest for age-review evidence images, plus the document-number fingerprint. Node crypto only, no database.
//
// Format: "v1:" + iv[12] | tag[16] | ciphertext, as a Buffer (stored in bytea). AES-256-GCM with a fixed AAD, key from
// AGE_EVIDENCE_KEY (exactly 32 bytes, base64). The "v1:" prefix is the key id so a later key can be "v2:".
// Errors never contain plaintext, ciphertext, key or document number.
import crypto from "crypto";

const PREFIX = Buffer.from("v1:", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_PREFIX = "vib3pulse:age-evidence:v1:";
// The AAD is "<requestId>:<kind>", so ciphertext copied to another row or kind fails to decrypt.
const aadFor = (aad: string) => Buffer.from(AAD_PREFIX + aad, "utf8");
const FINGERPRINT_INFO = "vib3pulse:age-review:document-fingerprint:v1";

export const EVIDENCE_KEY_MISSING = "AGE_EVIDENCE_KEY is not set or is not 32 bytes of base64";
export const EVIDENCE_DECRYPT_FAILED = "EVIDENCE_DECRYPT_FAILED";

/** The 32-byte key, or null when AGE_EVIDENCE_KEY is unset or malformed. Never throws, never logs. */
export function parseEvidenceKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.AGE_EVIDENCE_KEY ?? "").trim();
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? key : null;
}

export function evidenceKeyOk(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEvidenceKey(env) !== null;
}

function keyOrThrow(): Buffer {
  const key = parseEvidenceKey(process.env);
  if (!key) throw new Error(EVIDENCE_KEY_MISSING);
  return key;
}

export function encryptEvidence(buf: Buffer, aad: string): Buffer {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || typeof aad !== "string" || !aad) throw new Error("encryptEvidence: bad input");
  const key = keyOrThrow();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(aad));
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([PREFIX, iv, cipher.getAuthTag(), ct]);
}

/** Any problem (wrong key id, short input, tampered bytes, wrong key) throws EVIDENCE_DECRYPT_FAILED and returns nothing. */
export function decryptEvidence(enc: Buffer, aad: string): Buffer {
  const key = keyOrThrow();
  if (typeof aad !== "string" || !aad || !Buffer.isBuffer(enc) || enc.length < PREFIX.length + IV_BYTES + TAG_BYTES + 1 || !enc.subarray(0, PREFIX.length).equals(PREFIX)) {
    throw new Error(EVIDENCE_DECRYPT_FAILED);
  }
  try {
    const body = enc.subarray(PREFIX.length);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, body.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(aad));
    decipher.setAuthTag(body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error(EVIDENCE_DECRYPT_FAILED);
  }
}

/** Production + flag on + missing/invalid key refuses to start. Flag off never throws. */
export function assertEvidenceKeyForBoot(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!enabled) return;
  if (env.NODE_ENV !== "production") return;
  if (!evidenceKeyOk(env)) throw new Error(`Refusing to start: age review is on and ${EVIDENCE_KEY_MISSING}`);
}

/** Keyed, one-way fingerprint of a document (type + normalised number). The number itself is never stored. */
export function documentFingerprint(type: string, number: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = parseEvidenceKey(env);
  if (!key) throw new Error(EVIDENCE_KEY_MISSING);
  const derived = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), FINGERPRINT_INFO, 32));
  const normalised = number.trim().toUpperCase().replace(/[\s-]+/g, "");
  return crypto.createHmac("sha256", derived).update(`${type}:${normalised}`).digest("hex");
}
