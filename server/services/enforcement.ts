import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { and, eq, gt, inArray, isNull, or, sql, count } from "drizzle-orm";
import { db } from "../storage";
import { invalidateCache } from "../cache";
import { bans, events, userDevices, userStrikes, users, type Ban, type UserStrike } from "@shared/schema";
import { getConfig } from "./moderationConfig";

// Strikes, bans (phone / device / user) and device linking for social-event hosts.
// Admin routes in Phase 4 call addStrike / banUser / liftBan; this phase uses isBanned
// to gate hosting and phone verification. Everything keyed on a phone number or device
// is stored HASHED, so the ban list is not a directory of phone numbers.

// Server-side pepper. Rotating it silently un-bans every phone number, so set PHONE_HASH_KEY
// explicitly in production rather than relying on the SESSION_SECRET fallback.
const hmacKey = () => process.env.PHONE_HASH_KEY || process.env.SESSION_SECRET || "dev-only-insecure-key";
const hmac = (v: string) => crypto.createHmac("sha256", hmacKey()).update(v).digest("hex");

export const hashPhone = (e164: string) => hmac(`phone:${e164}`);
export const hashDevice = (rawDeviceId: string) => hmac(`device:${rawDeviceId}`);

// ------------------------------------------------------------------ device cookie
// Signed httpOnly cookie identifying a browser. Best-effort only: clearing cookies or
// switching browsers evades it, which is why bans also cover the verified phone number.
const DEVICE_COOKIE = "vp_dev";
const TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000;
const sign = (id: string) => crypto.createHmac("sha256", hmacKey()).update(`cookie:${id}`).digest("base64url").slice(0, 22);

declare global {
  namespace Express {
    interface Request {
      deviceHash?: string;
    }
  }
}

const recentUpserts = new Map<string, number>(); // `${userId}:${deviceHash}` → last write (ms), throttles DB writes
const UPSERT_EVERY_MS = 30 * 60 * 1000;

export function deviceMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    let id: string | null = null;
    const raw = req.cookies?.[DEVICE_COOKIE];
    if (typeof raw === "string") {
      const [candidate, sig] = raw.split(".");
      if (candidate && sig && sig.length === 22 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(candidate)))) id = candidate;
    }
    if (!id) {
      id = crypto.randomBytes(16).toString("base64url");
      res.cookie(DEVICE_COOKIE, `${id}.${sign(id)}`, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: TWO_YEARS_MS,
        path: "/",
      });
    }
    req.deviceHash = hashDevice(id);

    const uid = req.isAuthenticated?.() ? req.user?.id : undefined;
    if (uid) {
      const key = `${uid}:${req.deviceHash}`;
      const last = recentUpserts.get(key) ?? 0;
      if (Date.now() - last > UPSERT_EVERY_MS) {
        recentUpserts.set(key, Date.now());
        if (recentUpserts.size > 5000) recentUpserts.clear();
        recordDevice(uid, req.deviceHash, req.ip ?? null).catch((e) => console.error("[Devices] record failed:", e.message));
      }
    }
  } catch (e) {
    console.error("[Devices] middleware error (continuing):", (e as Error).message);
  }
  next();
}

export async function recordDevice(userId: string, deviceHash: string, ip: string | null): Promise<void> {
  await db
    .insert(userDevices)
    .values({ userId, deviceHash, lastIp: ip })
    .onConflictDoUpdate({ target: [userDevices.userId, userDevices.deviceHash], set: { lastSeenAt: new Date(), lastIp: ip } });
}

// Other accounts that have used any of this user's devices (admin "linked accounts" view).
export async function getLinkedAccounts(userId: string): Promise<Array<{ userId: string; username: string; sharedDevices: number }>> {
  const mine = await db.select({ h: userDevices.deviceHash }).from(userDevices).where(eq(userDevices.userId, userId));
  if (mine.length === 0) return [];
  const rows = await db
    .select({ userId: userDevices.userId, username: users.username, shared: count() })
    .from(userDevices)
    .innerJoin(users, eq(userDevices.userId, users.id))
    .where(and(inArray(userDevices.deviceHash, mine.map((m) => m.h)), sql`${userDevices.userId} <> ${userId}`))
    .groupBy(userDevices.userId, users.username);
  return rows.map((r) => ({ userId: r.userId, username: r.username, sharedDevices: Number(r.shared) }));
}

// ------------------------------------------------------------------ bans
export async function isBanned(who: { userId?: string | null; verifiedPhone?: string | null; deviceHash?: string | null }): Promise<boolean> {
  const conds = [];
  if (who.userId) conds.push(and(eq(bans.kind, "user"), eq(bans.valueHash, who.userId)));
  if (who.verifiedPhone) conds.push(and(eq(bans.kind, "phone"), eq(bans.valueHash, hashPhone(who.verifiedPhone))));
  if (who.deviceHash) conds.push(and(eq(bans.kind, "device"), eq(bans.valueHash, who.deviceHash)));
  if (conds.length === 0) return false;
  const [row] = await db.select({ id: bans.id }).from(bans).where(and(isNull(bans.liftedAt), or(...conds))).limit(1);
  return !!row;
}

export async function isPhoneBanned(e164: string): Promise<boolean> {
  return isBanned({ verifiedPhone: e164 });
}

async function insertBanIfMissing(kind: "user" | "phone" | "device", valueHash: string, userId: string, reason: string, adminId: string): Promise<boolean> {
  const [existing] = await db.select({ id: bans.id }).from(bans).where(and(eq(bans.kind, kind), eq(bans.valueHash, valueHash), isNull(bans.liftedAt))).limit(1);
  if (existing) return false;
  await db.insert(bans).values({ kind, valueHash, userId, reason, adminId });
  return true;
}

// Ban the account, its verified phone number and every device it has used; take its public
// social events out of discovery. Idempotent.
export async function banUser(p: { userId: string; reason: string; adminId: string }): Promise<{ created: number }> {
  const [u] = await db.select({ verifiedPhone: users.verifiedPhone }).from(users).where(eq(users.id, p.userId));
  const devices = await db.select({ h: userDevices.deviceHash }).from(userDevices).where(eq(userDevices.userId, p.userId));
  let created = 0;
  if (await insertBanIfMissing("user", p.userId, p.userId, p.reason, p.adminId)) created++;
  if (u?.verifiedPhone && (await insertBanIfMissing("phone", hashPhone(u.verifiedPhone), p.userId, p.reason, p.adminId))) created++;
  for (const d of devices) if (await insertBanIfMissing("device", d.h, p.userId, p.reason, p.adminId)) created++;

  await db
    .update(events)
    .set({ moderationStatus: "hidden", queueReason: "host_banned", queuedAt: new Date() })
    .where(and(eq(events.organizerId, p.userId), eq(events.kind, "social"), eq(events.visibility, "public"), inArray(events.moderationStatus, ["approved", "pending"])));
  invalidateCache.events();
  return { created };
}

export async function liftBan(banId: string, adminId: string): Promise<Ban | undefined> {
  const [row] = await db.update(bans).set({ liftedAt: new Date(), liftedBy: adminId }).where(and(eq(bans.id, banId), isNull(bans.liftedAt))).returning();
  return row;
}

// ------------------------------------------------------------------ strikes
export async function countActiveStrikes(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(userStrikes)
    .where(and(eq(userStrikes.userId, userId), eq(userStrikes.type, "strike"), isNull(userStrikes.revokedAt), or(isNull(userStrikes.expiresAt), gt(userStrikes.expiresAt, new Date()))));
  return Number(r.n);
}

// Records a warn/strike. When active strikes reach strikes_for_auto_ban the host is banned
// (phone + device included) attributed to the admin who issued the final strike.
export async function addStrike(p: {
  userId: string;
  eventId?: string | null;
  type: "warn" | "strike";
  reason: string;
  adminId: string;
  expiresAt?: Date | null;
}): Promise<{ strike: UserStrike; autoBanned: boolean }> {
  const [strike] = await db
    .insert(userStrikes)
    .values({ userId: p.userId, eventId: p.eventId ?? null, type: p.type, reason: p.reason, adminId: p.adminId, expiresAt: p.expiresAt ?? null })
    .returning();
  let autoBanned = false;
  if (p.type === "strike") {
    const limit = await getConfig("strikes_for_auto_ban");
    if (limit > 0 && (await countActiveStrikes(p.userId)) >= limit) {
      await banUser({ userId: p.userId, reason: `Automatic: ${limit} active strikes (latest: ${p.reason})`, adminId: p.adminId });
      autoBanned = true;
    }
  }
  return { strike, autoBanned };
}
