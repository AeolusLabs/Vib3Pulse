import crypto from "crypto";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "../storage";
import { phoneVerifications, users } from "@shared/schema";
import { sendSmsWithFallback } from "../buddyService";
import { isPhoneBanned } from "./enforcement";

// SMS one-time-code phone verification. The code is never stored (only an HMAC bound to the
// row), is single-use, expires in 10 minutes and locks after 5 wrong tries. Sends are limited
// per user, per phone number (so nobody can use us to spam a victim's phone from many
// accounts) and per resend cooldown.

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 3600 * 1000;

// Test seam: the real sender hits Twilio/Termii. Tests swap it for a recorder.
type Sender = (e164: string, body: string) => Promise<void>;
let sender: Sender = (e164, body) => sendSmsWithFallback(e164, body, "phone_otp");
export function setSmsSenderForTests(fn: Sender | null) {
  sender = fn ?? ((e164, body) => sendSmsWithFallback(e164, body, "phone_otp"));
}

const key = () => process.env.PHONE_HASH_KEY || process.env.SESSION_SECRET || "dev-only-insecure-key";
const codeHash = (rowId: string, code: string) => crypto.createHmac("sha256", key()).update(`otp:${rowId}:${code}`).digest("hex");

// Strict E.164: "+" then 8-15 digits, no leading zero in the country code.
export function normalizeE164(input: string): string | null {
  const cleaned = input.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

export type PhoneResult<T = object> = ({ ok: true } & T) | { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } => ({ ok: false, status, code, message });

export async function requestPhoneCode(userId: string, rawPhone: string, ip: string | null): Promise<PhoneResult<{ phoneLast4: string; expiresInSeconds: number }>> {
  const phone = normalizeE164(rawPhone);
  if (!phone) return fail(400, "INVALID_PHONE", "Enter your number with the country code, like +447700900123.");
  if (await isPhoneBanned(phone)) return fail(403, "PHONE_UNAVAILABLE", "This phone number can't be used.");

  const [owner] = await db.select({ id: users.id }).from(users).where(and(eq(users.verifiedPhone, phone), ne(users.id, userId)));
  if (owner) return fail(409, "PHONE_IN_USE", "That number is already verified on another account.");

  // All time comparisons happen in SQL: a raw max(created_at) comes back as a zone-less string and JS
  // would parse it in the server's local zone.
  const since = new Date(Date.now() - HOUR_MS);
  const [mine] = await db
    .select({
      n: count(),
      recent: sql<number>`count(*) filter (where ${phoneVerifications.createdAt} > now() - interval '60 seconds')::int`,
    })
    .from(phoneVerifications)
    .where(and(eq(phoneVerifications.userId, userId), gt(phoneVerifications.createdAt, since)));
  if (Number(mine.recent) > 0) return fail(429, "COOLDOWN", "Please wait a minute before asking for another code.");
  if (Number(mine.n) >= MAX_SENDS_PER_HOUR) return fail(429, "TOO_MANY_CODES", "Too many codes requested. Try again in an hour.");
  const [theirs] = await db.select({ n: count() }).from(phoneVerifications).where(and(eq(phoneVerifications.phone, phone), gt(phoneVerifications.createdAt, since)));
  if (Number(theirs.n) >= MAX_SENDS_PER_HOUR) return fail(429, "TOO_MANY_CODES", "Too many codes have been sent to that number. Try again later.");

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const id = crypto.randomUUID();
  await db.insert(phoneVerifications).values({ id, userId, phone, codeHash: codeHash(id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), ipAddress: ip });
  try {
    await sender(phone, `Your Vib3Pulse verification code is ${code}. It expires in 10 minutes. Never share it.`);
  } catch (e) {
    await db.delete(phoneVerifications).where(eq(phoneVerifications.id, id));
    console.error("[Phone] SMS send failed:", (e as Error).message);
    return fail(502, "SMS_FAILED", "We couldn't send the text message. Check the number and try again.");
  }
  return { ok: true, phoneLast4: phone.slice(-4), expiresInSeconds: CODE_TTL_MS / 1000 };
}

export async function confirmPhoneCode(userId: string, rawCode: string): Promise<PhoneResult<{ phoneLast4: string }>> {
  const code = rawCode.trim();
  if (!/^\d{6}$/.test(code)) return fail(400, "INVALID_CODE", "Enter the 6-digit code.");

  const [row] = await db
    .select()
    .from(phoneVerifications)
    .where(and(eq(phoneVerifications.userId, userId), isNull(phoneVerifications.consumedAt), gt(phoneVerifications.expiresAt, new Date())))
    .orderBy(desc(phoneVerifications.createdAt))
    .limit(1);
  if (!row) return fail(400, "CODE_EXPIRED", "That code has expired. Ask for a new one.");
  if (row.attempts >= MAX_ATTEMPTS) return fail(429, "TOO_MANY_ATTEMPTS", "Too many wrong tries. Ask for a new code.");

  // Count the attempt first, atomically, so parallel guesses can't beat the limit.
  const [bumped] = await db
    .update(phoneVerifications)
    .set({ attempts: sql`${phoneVerifications.attempts} + 1` })
    .where(and(eq(phoneVerifications.id, row.id), sql`${phoneVerifications.attempts} < ${MAX_ATTEMPTS}`))
    .returning({ attempts: phoneVerifications.attempts });
  if (!bumped) return fail(429, "TOO_MANY_ATTEMPTS", "Too many wrong tries. Ask for a new code.");

  const expected = Buffer.from(row.codeHash);
  const actual = Buffer.from(codeHash(row.id, code));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return fail(400, "WRONG_CODE", `That code isn't right. ${MAX_ATTEMPTS - bumped.attempts} ${MAX_ATTEMPTS - bumped.attempts === 1 ? "try" : "tries"} left.`);
  }

  if (await isPhoneBanned(row.phone)) return fail(403, "PHONE_UNAVAILABLE", "This phone number can't be used.");
  try {
    await db.transaction(async (tx) => {
      const used = await tx.update(phoneVerifications).set({ consumedAt: new Date() }).where(and(eq(phoneVerifications.id, row.id), isNull(phoneVerifications.consumedAt))).returning({ id: phoneVerifications.id });
      if (used.length === 0) throw new Error("ALREADY_USED");
      await tx.update(users).set({ verifiedPhone: row.phone, phoneVerifiedAt: new Date() }).where(eq(users.id, userId));
      // Burn every other pending code for this user so none can be replayed later.
      await tx.update(phoneVerifications).set({ consumedAt: new Date() }).where(and(eq(phoneVerifications.userId, userId), isNull(phoneVerifications.consumedAt)));
    });
  } catch (e: any) {
    if (e?.code === "23505") return fail(409, "PHONE_IN_USE", "That number is already verified on another account.");
    if (e?.message === "ALREADY_USED") return fail(400, "CODE_EXPIRED", "That code has already been used.");
    throw e;
  }
  return { ok: true, phoneLast4: row.phone.slice(-4) };
}

