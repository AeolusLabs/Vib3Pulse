import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { adminActivityLogs, adminMfa, type AdminRole, type AdminUser } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    mfaVerified?: boolean;
  }
}
declare global {
  namespace Express {
    interface Request {
      admin?: AdminUser;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Audit. admin_activity_logs is append-only (DB trigger). New admin actions write the entry
// BEFORE acting, so nothing can ever happen unlogged; if the action then fails a second
// "<action>_failed" entry records that. Audit failures are never swallowed here.
// ---------------------------------------------------------------------------------------------
export type AuditEntry = {
  adminId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  reason?: string | null;
  details?: Record<string, unknown> | string | null;
  ip?: string | null;
};

export async function audit(e: AuditEntry): Promise<void> {
  await db.insert(adminActivityLogs).values({
    adminId: e.adminId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    reason: e.reason ?? null,
    details: e.details == null ? null : typeof e.details === "string" ? e.details : JSON.stringify(e.details),
    ipAddress: e.ip ?? null,
  });
}

export async function withAudit<T>(e: AuditEntry, fn: () => Promise<T>): Promise<T> {
  await audit(e);
  try {
    return await fn();
  } catch (err) {
    await audit({ ...e, action: `${e.action}_failed`, details: { error: (err as Error).message?.slice(0, 300) } }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Auth gate. Every admin request re-reads the admin row, so deactivation and role changes take
// effect immediately (the old gate trusted a role cached in the session for up to 8 hours).
// Super-admins additionally need a session that has passed MFA, enforced here in code.
// ---------------------------------------------------------------------------------------------
// Two-factor authentication for super-admins is BUILT but switched OFF. Super-admins sign in with
// username + password only until ADMIN_MFA_REQUIRED=true is set. Read on every call (not at import),
// so flipping the variable and restarting is the whole change. While off, nothing below treats a
// super-admin differently from any other admin, and the MFA endpoints refuse to start enrolment.
export const mfaRequired = (): boolean => process.env.ADMIN_MFA_REQUIRED === "true";

export type GateOpts = { roles?: readonly AdminRole[]; allowPendingMfa?: boolean };

export function adminGate(opts: GateOpts = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.session?.adminId;
      if (!id) return res.status(401).json({ message: "Admin authentication required" });
      const admin = await storage.getAdminUser(id);
      if (!admin || !admin.isActive) {
        req.session.destroy(() => {});
        return res.status(401).json({ message: "Admin authentication required" });
      }
      req.session.adminRole = admin.role as AdminRole;
      if (mfaRequired() && admin.role === "super_admin" && !opts.allowPendingMfa && !req.session.mfaVerified) {
        const enrolled = await isMfaEnrolled(admin.id);
        return res.status(403).json({ message: "Two-factor authentication required", code: "MFA_REQUIRED", mfa: enrolled ? "verify" : "enroll" });
      }
      if (opts.roles && !opts.roles.includes(admin.role as AdminRole)) {
        return res.status(403).json({ message: "Insufficient permissions" });
      }
      req.admin = admin;
      next();
    } catch (error) {
      console.error("[ADMIN] auth gate failed:", (error as Error).message);
      res.status(500).json({ message: "Authentication check failed" });
    }
  };
}

export const requireAdmin = adminGate();
export const requireAdminPending = adminGate({ allowPendingMfa: true }); // /me, /logout and the MFA endpoints themselves
export const requireRole = (...roles: AdminRole[]) => adminGate({ roles });
export const requireSuperAdmin = adminGate({ roles: ["super_admin"] });

export const MODERATOR_ROLES: AdminRole[] = ["content_moderator", "event_reviewer"];
export const MODERATION_ROLES: AdminRole[] = ["super_admin", ...MODERATOR_ROLES];
export const HOST_ADMIN_ROLES: AdminRole[] = ["super_admin", "admin"];

// ---------------------------------------------------------------------------------------------
// TOTP MFA
// ---------------------------------------------------------------------------------------------
authenticator.options = { window: 1 }; // accept the previous/next 30s code for clock drift

let warnedKey = false;
function encKey(): Buffer {
  const raw = process.env.MFA_ENC_KEY;
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (b.length !== 32) throw new Error("MFA_ENC_KEY must be 32 bytes (64 hex characters or base64)");
    return b;
  }
  if (!warnedKey) {
    warnedKey = true;
    console.warn("[ADMIN] MFA_ENC_KEY is not set; deriving the TOTP encryption key from SESSION_SECRET. Set MFA_ENC_KEY in production.");
  }
  return Buffer.from(crypto.hkdfSync("sha256", process.env.SESSION_SECRET || "dev-only-insecure-key", "vib3pulse-mfa", "totp-secret-encryption", 32));
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

function decrypt(blob: string): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const STEP_MS = 30_000;

export async function isMfaEnrolled(adminId: string): Promise<boolean> {
  const [row] = await db.select({ enabledAt: adminMfa.enabledAt }).from(adminMfa).where(eq(adminMfa.adminId, adminId));
  return !!row?.enabledAt;
}

export async function beginMfaSetup(adminId: string, label: string): Promise<{ ok: true; secret: string; otpauthUrl: string; qrDataUrl: string } | { ok: false; reason: "already_enrolled" }> {
  if (await isMfaEnrolled(adminId)) return { ok: false, reason: "already_enrolled" };
  const secret = authenticator.generateSecret();
  await db
    .insert(adminMfa)
    .values({ adminId, secretEnc: encrypt(secret) })
    .onConflictDoUpdate({ target: adminMfa.adminId, set: { secretEnc: encrypt(secret), lastUsedStep: null, recoveryCodeHashes: [] }, setWhere: isNull(adminMfa.enabledAt) });
  const otpauthUrl = authenticator.keyuri(label, "Vib3Pulse Admin", secret);
  return { ok: true, secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
}

// Accepts a code only if it is valid AND newer than the last one used (replay protection).
async function consumeTotp(adminId: string, secret: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return false;
  const step = Math.floor(Date.now() / STEP_MS) + delta;
  const [row] = await db
    .update(adminMfa)
    .set({ lastUsedStep: step })
    .where(and(eq(adminMfa.adminId, adminId), sql`(${adminMfa.lastUsedStep} is null or ${adminMfa.lastUsedStep} < ${step})`))
    .returning({ adminId: adminMfa.adminId });
  return !!row;
}

export async function confirmMfaSetup(adminId: string, code: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: "no_pending" | "bad_code" }> {
  const [row] = await db.select().from(adminMfa).where(and(eq(adminMfa.adminId, adminId), isNull(adminMfa.enabledAt)));
  if (!row) return { ok: false, reason: "no_pending" };
  if (!(await consumeTotp(adminId, decrypt(row.secretEnc), code))) return { ok: false, reason: "bad_code" };
  const recoveryCodes = Array.from({ length: 8 }, () => `${crypto.randomBytes(5).toString("hex")}-${crypto.randomBytes(5).toString("hex")}`);
  await db.update(adminMfa).set({ enabledAt: new Date(), recoveryCodeHashes: recoveryCodes.map(sha) }).where(eq(adminMfa.adminId, adminId));
  return { ok: true, recoveryCodes };
}

export async function verifyMfaLogin(adminId: string, input: { code?: string; recoveryCode?: string }): Promise<{ ok: boolean; usedRecovery?: boolean }> {
  const [row] = await db.select().from(adminMfa).where(and(eq(adminMfa.adminId, adminId)));
  if (!row?.enabledAt) return { ok: false };
  if (input.recoveryCode) {
    const h = sha(input.recoveryCode.trim().toLowerCase());
    const used = await db
      .update(adminMfa)
      .set({ recoveryCodeHashes: sql`array_remove(${adminMfa.recoveryCodeHashes}, ${h})` })
      .where(and(eq(adminMfa.adminId, adminId), sql`${h} = any(${adminMfa.recoveryCodeHashes})`))
      .returning({ adminId: adminMfa.adminId });
    return { ok: used.length > 0, usedRecovery: true };
  }
  return { ok: input.code ? await consumeTotp(adminId, decrypt(row.secretEnc), input.code) : false };
}

export async function resetMfa(adminId: string): Promise<void> {
  await db.delete(adminMfa).where(eq(adminMfa.adminId, adminId));
}
