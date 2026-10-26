import { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { storage, pool, RoomMoneyRecordsError } from "./storage";
import { toPublicUser, toPublicAdminUser } from "./auth";
import { invalidateCache, postsCache, eventsCache, storiesCache } from "./cache";
import { insertAdminUserSchema, adminRoles, type AdminRole } from "@shared/schema";
import { z } from "zod";
import { getSocialPlanAdminStats } from "./services/socialAdminStats";
import { registerAgeReviewAdminRoutes } from "./routes/age-review-admin-routes";
import { ageReviewEnabled } from "./identity/ageReviewFeatures";
import { isSelfReview } from "./identity/ageReviewAdmin";
import { clearNameAndMatch } from "./identity/payoutNameGuard";
import { AgeReviewError } from "./identity/ageReviewService";
import { requireAdmin, requireStaffNotReviewer, requireAdminPending, requireRole, requireSuperAdmin, isMfaEnrolled, mfaRequiredFor } from "./services/adminSecurity";
import { registerSprayClawbackAdminRoutes } from "./rooms/clawbacks";
import { registerRoomsAdminRoutes } from "./rooms/adminRoutes";
import { registerRoomRecapAdminRoute } from "./rooms/recap";
import { registerAdminSocialRoutes } from "./routes/admin-social-routes";
import {
  authRateLimiter,
  checkLoginThrottle,
  recordLoginAttempt,
  clearLoginAttempts,
  logSecurityEvent,
  sensitiveOperationLimiter,
} from "./security";

const pgSession = connectPgSimple(session);

// Extend session type for admin
declare module "express-session" {
  interface SessionData {
    adminId?: string;
    adminRole?: AdminRole;
  }
}

// Auth gate, role checks and MFA enforcement live in services/adminSecurity.ts (they re-read the
// admin row on every request, so deactivation and demotion apply immediately). Re-exported here
// because other modules import them from this file.
export { requireAdmin, requireRole, requireSuperAdmin };

// Helper to log admin activity
async function logActivity(adminId: string, action: string, targetType?: string, targetId?: string, details?: string, ipAddress?: string) {
  try {
    await storage.logAdminActivity({
      adminId,
      action,
      targetType,
      targetId,
      details,
      ipAddress,
    });
  } catch (error) {
    console.error("Failed to log admin activity:", error);
  }
}

export function registerAgeVerificationAdminRoute(app: Express) {
  app.post("/api/admin/users/:id/age-verification", requireRole("super_admin", "admin", "age_reviewer"), async (req: Request, res: Response) => {
    try {
      const reasonCheck = z.string().trim().min(3).max(300).safeParse(req.body?.reason);
      if (!reasonCheck.success) return res.status(400).json({ message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" });
      const { verified, reason } = z.object({ verified: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
      // Marking someone verified with just a reason skips the checklist, the duplicate check and the second approver, so it stays with admin and super_admin.
      if (verified && req.admin!.role === "age_reviewer") return res.status(403).json({ message: "Reviewers verify through the review queue.", code: "NOT_ALLOWED" });
      const { ageVerifier } = await import("./identity/ageVerification");
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (isSelfReview({ id: req.admin!.id, email: req.admin!.email, role: req.admin!.role }, { email: user.email, dateOfBirth: null })) return res.status(403).json({ message: "You cannot change your own age verification.", code: "SELF_REVIEW" });
      if (verified && !user.dateOfBirth) return res.status(409).json({ message: "This user has no date of birth on file. Verification must vouch for a stored birthdate." });
      const prev = await ageVerifier.status(user.id);
      if (!verified) await clearNameAndMatch(user.id); // removing a verification removes the stored legal name and the name match first
      await storage.setAgeVerification(user.id, { verified, method: "admin" });
      const prevText = prev.verified ? `verified (${prev.method ?? "unknown"})` : "not verified";
      const newText = verified ? "verified (admin)" : "not verified";
      await storage.logAdminActivity({
        adminId: req.session.adminId!,
        action: verified ? "user.age_verified" : "user.age_verification_cleared",
        targetType: "user",
        targetId: user.id,
        details: `${verified ? "Marked ID-verified by admin" : "Cleared ID verification"}: ${prevText} -> ${newText}. Reason: ${reason}`,
        reason,
        ipAddress: req.ip,
      }).catch((error) => console.error("Failed to log admin activity:", error));
      res.json(await ageVerifier.status(user.id));
    } catch (error) {
      if (error instanceof AgeReviewError) return res.status(error.status).json({ message: error.message, code: error.code });
      if (error instanceof z.ZodError) return res.status(400).json({ message: "verified (true or false) and a reason (3 to 300 characters) are required" });
      res.status(500).json({ message: "Failed to update age verification" });
    }
  });

  // Clears a verification found suspect later (chargeback, report). Part of age review, so it follows the AGE_REVIEW flag.
  app.post("/api/admin/users/:id/age-verification/revoke", requireRole("super_admin", "admin", "age_reviewer"), async (req: Request, res: Response) => {
    try {
      if (!ageReviewEnabled()) return res.status(404).json({ message: "Not found", code: "AGE_REVIEW_OFF" });
      const reason = z.string().trim().min(3).max(300).safeParse(req.body?.reason);
      if (!reason.success) return res.status(400).json({ message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" });
      const { ageVerifier } = await import("./identity/ageVerification");
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (isSelfReview({ id: req.admin!.id, email: req.admin!.email, role: req.admin!.role }, { email: user.email, dateOfBirth: null })) return res.status(403).json({ message: "You cannot change your own age verification.", code: "SELF_REVIEW" });
      await storage.logAdminActivity({
        adminId: req.session.adminId!, action: "age_review.revoke", targetType: "user", targetId: user.id,
        details: `Cleared ID verification (revoke). Reason: ${reason.data}`, reason: reason.data, ipAddress: req.ip,
      }).catch((error) => console.error("Failed to log admin activity:", error));
      await clearNameAndMatch(user.id); // the stored legal name (and the account's name match) goes first: a failure leaves the verification in place
      await storage.setAgeVerification(user.id, { verified: false });
      res.json(await ageVerifier.status(user.id));
    } catch (error) {
      if (error instanceof AgeReviewError) return res.status(error.status).json({ message: error.message, code: error.code });
      res.status(500).json({ message: "Failed to revoke age verification" });
    }
  });
}

// ============================================
// PAID ROOMS FINANCE (Finance Manager + Super Admin)
// ============================================
// Payouts to room hosts and ticket totals, plus the alerts finance must act on, and four audited levers (hold, release,
// requeue a failed payout, refund a whole room). No buyer identities, no bank details (they are never stored here).
// last_error is already sanitized when written (shared/roomRefunds.ts). CSRF is enforced for every /api mutation in
// server/index.ts; role checks are requireRole like every other admin route; the only inputs are the room id (uuid) and a
// reason (3 to 300 characters, kept in the admin activity log). Never free-text SQL.
const PAYOUT_STUCK_MS = 24 * 3600_000;
const PAYOUT_HOLD_FROM_MS = Date.parse("9999-01-01T00:00:00.000Z"); // shared/roomRefunds PAYOUT_HOLD_SENTINEL (9999-12-31)
const msToIso = (ms: unknown) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

export function registerRoomFinanceAdminRoutes(app: Express) {
  const FINANCE = ["super_admin", "finance_manager"] as const;

  app.get("/api/admin/finance/room-payouts", requireRole(...FINANCE), async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === "string" && ["held", "queued", "paid", "failed"].includes(req.query.status) ? req.query.status : null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const now = Date.now();
      const [rows, total] = await Promise.all([
        pool.query(
          `select p.id, p.room_id, r.title as room_title, p.host_id, u.username as host_username, p.amount_kobo, p.status,
                  p.transfer_ref, p.attempts, p.last_error,
                  round(extract(epoch from p.release_at) * 1000)::float8 as release_ms,
                  round(extract(epoch from p.paid_at) * 1000)::float8 as paid_ms,
                  round(extract(epoch from p.created_at) * 1000)::float8 as created_ms
             from room_payouts p join rooms r on r.id = p.room_id left join users u on u.id = p.host_id
            where ($1::text is null or p.status = $1::text)
            order by (p.status = 'failed') desc, (p.last_error is not null) desc, p.release_at asc
            limit $2 offset $3`,
          [status, limit, offset],
        ),
        pool.query(`select count(*)::int as n from room_payouts where ($1::text is null or status = $1::text)`, [status]),
      ]);
      res.json({
        payouts: (rows.rows as any[]).map((p) => {
          const releaseMs = p.release_ms === null ? null : Number(p.release_ms);
          const stuck = p.status === "queued" && releaseMs !== null && now - releaseMs > PAYOUT_STUCK_MS;
          const onHold = p.status === "held" && releaseMs !== null && releaseMs >= PAYOUT_HOLD_FROM_MS;
          return {
            id: p.id, roomId: p.room_id, roomTitle: p.room_title, hostId: p.host_id, hostUsername: p.host_username ?? null,
            amountKobo: Number(p.amount_kobo), status: p.status, transferRef: p.transfer_ref, attempts: Number(p.attempts),
            lastError: p.last_error, releaseAt: onHold ? null : msToIso(p.release_ms), paidAt: msToIso(p.paid_ms), createdAt: msToIso(p.created_ms),
            onHold,
            alert: p.status === "failed" || stuck || p.last_error === "NO_PAYOUT_ACCOUNT" || p.last_error === "TRANSFER_NEEDS_OTP"
              || (typeof p.last_error === "string" && p.last_error.startsWith("PAYOUT_BANK_UNRESOLVED")),
          };
        }),
        total: total.rows[0]?.n ?? 0,
      });
    } catch (error) {
      console.error("[ADMIN] room payouts failed:", (error as Error)?.message);
      res.status(500).json({ message: "Failed to load room payouts" });
    }
  });

  app.get("/api/admin/finance/room-tickets", requireRole(...FINANCE), async (_req: Request, res: Response) => {
    try {
      // Refused charges (lane S2 rows, refund_reason auto_*) are not tickets: excluded from the ticket buckets and from
      // refundsAwaitingProvider, reported on their own as refusedCharges (count + gross, and how many are still owed).
      const [tickets, owed, payouts, issues, refused] = await Promise.all([
        pool.query(
          `select status, count(*)::int as n,
                  coalesce(sum(amount_kobo), 0)::bigint as gross, coalesce(sum(vat_kobo), 0)::bigint as vat,
                  coalesce(sum(fee_kobo), 0)::bigint as fee, coalesce(sum(reserve_kobo), 0)::bigint as reserve,
                  coalesce(sum(platform_kobo), 0)::bigint as platform, coalesce(sum(host_kobo), 0)::bigint as host
             from room_tickets where coalesce(left(refund_reason, 5), '') <> 'auto_' group by status`,
        ),
        pool.query(
          `select count(*)::int as n, coalesce(sum(amount_kobo), 0)::bigint as amount from room_tickets
            where status = 'refunded' and refunded_at is null and coalesce(left(refund_reason, 5), '') <> 'auto_'`,
        ),
        pool.query(`select status, count(*)::int as n, coalesce(sum(amount_kobo), 0)::bigint as amount from room_payouts group by status`),
        // Alerts: refund failures for a room ticket row OR for a room charge that never got a row (lane S2's no_row path:
        // ticket_id NULL, the charge reference vib3rt_*), refunds owed > 24 h, payout failures. Never the refund_pending markers.
        pool.query(
          `select i.id, i.reason, i.ticket_id, i.provider_payment_id, i.error_message,
                  round(extract(epoch from i.created_at) * 1000)::float8 as created_ms
             from payment_issues i
            where i.resolved_at is null
              and ((i.reason in ('refund_failed', 'refund_overdue')
                    and (exists (select 1 from room_tickets t where t.id::text = i.ticket_id)
                         or (i.ticket_id is null and i.provider_payment_id ~ '^vib3rt_[0-9a-f]{24}_[0-9a-f]{32}$')))
                or (i.reason = 'payout_failed' and i.provider_payment_id like 'room-payout-%')
                -- Spraying (phase 5): spray refunds that need a person, chargebacks to answer, dispute outcomes to check.
                or (i.reason in ('refund_failed', 'refund_overdue', 'dispute', 'dispute_resolved')
                    and i.provider_payment_id ~ '^vib3rs_[0-9a-f]{24}_[0-9a-f]{32}$'))
            order by i.created_at desc limit 100`,
        ),
        pool.query(
          `select count(*)::int as n, coalesce(sum(amount_kobo), 0)::bigint as gross,
                  (count(*) filter (where refunded_at is null))::int as owed
             from room_tickets where coalesce(left(refund_reason, 5), '') = 'auto_'`,
        ),
      ]);
      const num = (v: unknown) => Number(v ?? 0);
      res.json({
        tickets: (tickets.rows as any[]).map((r) => ({
          status: r.status, count: r.n, grossKobo: num(r.gross), vatKobo: num(r.vat), feeKobo: num(r.fee),
          reserveKobo: num(r.reserve), platformKobo: num(r.platform), hostKobo: num(r.host),
        })),
        refundsAwaitingProvider: { count: owed.rows[0]?.n ?? 0, amountKobo: num(owed.rows[0]?.amount) },
        refusedCharges: { count: refused.rows[0]?.n ?? 0, grossKobo: num(refused.rows[0]?.gross), awaitingProvider: refused.rows[0]?.owed ?? 0 },
        payouts: (payouts.rows as any[]).map((r) => ({ status: r.status, count: r.n, amountKobo: num(r.amount) })),
        alerts: (issues.rows as any[]).map((i) => ({
          id: i.id, kind: i.reason, ticketId: i.ticket_id, reference: i.provider_payment_id, error: i.error_message, since: msToIso(i.created_ms),
        })),
      });
    } catch (error) {
      console.error("[ADMIN] room tickets totals failed:", (error as Error)?.message);
      res.status(500).json({ message: "Failed to load room ticket totals" });
    }
  });

  // ---------------------------------------------------------------- levers (audited)
  const leverBody = z.object({ reason: z.string().trim().min(3).max(300) });
  type Lever = "hold" | "release" | "requeue" | "refund_all";
  type LeverOutcome = { ok: true; [k: string]: unknown } | { ok: false; status: number; code: string; message: string };
  const lever = (name: Lever, path: string, run: (roomId: string, reason: string) => Promise<LeverOutcome>) =>
    app.post(path, requireRole(...FINANCE), async (req: Request, res: Response) => {
      const parsed = leverBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ message: "A reason (3 to 300 characters) is required", code: "REASON_REQUIRED" });
      const roomId = String(req.params.roomId ?? "");
      try {
        const r = await run(roomId, parsed.data.reason);
        if (r.ok === false) return res.status(r.status).json({ message: r.message, code: r.code });
        const { ok: _ok, ...result } = r;
        await storage.logAdminActivity({
          adminId: req.session.adminId!,
          action: `room_payout.${name}`,
          targetType: "room",
          targetId: roomId,
          details: JSON.stringify(result).slice(0, 1000),
          reason: parsed.data.reason,
          ipAddress: req.ip,
        }).catch((error) => console.error(`[ADMIN] ALERT room payout lever ${name} on ${roomId} succeeded but the audit row failed:`, error));
        res.json(result);
      } catch (error) {
        console.error(`[ADMIN] room payout lever ${name} failed:`, (error as Error)?.message);
        res.status(500).json({ message: "That did not work. Check the payout before trying again." });
      }
    });

  // Hold: the payout is never sent until released (release_at pushed to 9999-12-31, reason in last_error).
  lever("hold", "/api/admin/room-payouts/:roomId/hold", async (roomId, reason) => {
    const { adminHoldPayout } = await import("./rooms/settlement");
    return adminHoldPayout(roomId, reason) as Promise<LeverOutcome>;
  });
  // Release a hold: release_at = ended_at + 48 h again (due at once if that has passed).
  lever("release", "/api/admin/room-payouts/:roomId/release", async (roomId) => {
    const { adminReleasePayout } = await import("./rooms/settlement");
    return adminReleasePayout(roomId) as Promise<LeverOutcome>;
  });
  // Requeue a failed payout (attempts 0) after Paystack is asked about its reference (never sent twice).
  lever("requeue", "/api/admin/room-payouts/:roomId/requeue", async (roomId) => {
    const { adminRequeuePayout } = await import("./rooms/settlement");
    return adminRequeuePayout(roomId) as Promise<LeverOutcome>;
  });
  // Refund every paid ticket (host_cancelled) and remove the payout if it is still held.
  lever("refund_all", "/api/admin/rooms/:roomId/refund-all", async (roomId) => {
    const { adminRefundRoom } = await import("./rooms/settlement");
    return adminRefundRoom(roomId) as Promise<LeverOutcome>;
  });
}

export function setupAdminRoutes(app: Express) {
  // Create admin session store with separate table
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adminSessionStore = new pgSession({
    pool: adminPool as any,
    tableName: "admin_session",
    createTableIfMissing: true,
  });

  // Admin session middleware - separate from user sessions with strict security
  const adminSession = session({
    store: adminSessionStore,
    secret: process.env.SESSION_SECRET || "admin-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    name: "admin.sid",
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours for admin sessions
      sameSite: "strict", // Strict for admin sessions
    },
  });

  // Apply admin session to all /api/admin routes
  app.use("/api/admin", adminSession);

  // ============================================
  // FIRST-TIME ADMIN SETUP
  // ============================================

  // Check if initial setup is needed (no admins exist)
  app.get("/api/admin/setup/status", async (req: Request, res: Response) => {
    try {
      const admins = await storage.getAllAdminUsers();
      res.json({ 
        setupRequired: admins.length === 0,
        message: admins.length === 0 
          ? "No admin accounts exist. Initial setup is available." 
          : "Admin accounts already exist. Setup is disabled."
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to check setup status" });
    }
  });

  // First-time Super Admin setup - only works when no admins exist
  const setupSchema = z.object({
    setupKey: z.string().min(1, "Setup key is required"),
    username: z.string().min(3, "Username must be at least 3 characters"),
    email: z.string().email("Valid email required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    displayName: z.string().min(1, "Display name required"),
  });

  app.post("/api/admin/setup", authRateLimiter, async (req: Request, res: Response) => {
    try {
      // Check if any admins already exist
      const existingAdmins = await storage.getAllAdminUsers();
      if (existingAdmins.length > 0) {
        return res.status(403).json({ 
          message: "Setup is disabled. Admin accounts already exist." 
        });
      }

      // Validate input
      const validation = setupSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: validation.error.errors[0].message 
        });
      }

      const { setupKey, username, email, password, displayName } = validation.data;

      // Verify setup key matches environment variable
      const expectedKey = process.env.ADMIN_SETUP_KEY;
      if (!expectedKey) {
        return res.status(500).json({ 
          message: "ADMIN_SETUP_KEY environment variable not configured. Please set it in your secrets." 
        });
      }

      const suppliedBuf = Buffer.from(setupKey);
      const expectedBuf = Buffer.from(expectedKey);
      const keyValid = suppliedBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(suppliedBuf, expectedBuf);
      if (!keyValid) {
        return res.status(401).json({ message: "Invalid setup key" });
      }

      // Check for existing username or email
      const existingByUsername = await storage.getAdminUserByUsername(username);
      if (existingByUsername) {
        return res.status(400).json({ message: "Username already taken" });
      }

      const existingByEmail = await storage.getAdminUserByEmail(email);
      if (existingByEmail) {
        return res.status(400).json({ message: "Email already registered" });
      }

      // Hash password and create the Super Admin
      const passwordHash = await bcrypt.hash(password, 12);
      
      // Use try-catch to handle race conditions - if another admin was created
      // between our initial check and now, the unique constraint will fail
      let newAdmin;
      try {
        newAdmin = await storage.createAdminUser({
          username,
          email,
          passwordHash,
          displayName,
          role: "super_admin",
        });
      } catch (createError: any) {
        // Re-check if another admin was created (race condition)
        const finalCheck = await storage.getAllAdminUsers();
        if (finalCheck.length > 0) {
          return res.status(403).json({ 
            message: "Setup is disabled. Another admin account was just created." 
          });
        }
        throw createError;
      }

      // Final verification - ensure this is truly the first admin
      const allAdmins = await storage.getAllAdminUsers();
      if (allAdmins.length > 1) {
        // Race condition occurred - more than one admin exists
        // This shouldn't happen with proper DB constraints, but extra safety
        return res.status(403).json({ 
          message: "Setup conflict detected. Please contact support." 
        });
      }

      // Log the initial setup
      await logActivity(newAdmin.id, "initial_setup", "admin", newAdmin.id, "Initial Super Admin account created", req.ip);

      const adminWithoutPassword = toPublicAdminUser(newAdmin);
      res.status(201).json({
        message: "Super Admin account created successfully! You can now log in.",
        admin: adminWithoutPassword 
      });
    } catch (error) {
      console.error("Admin setup error:", error);
      res.status(500).json({ message: "Setup failed" });
    }
  });

  // ============================================
  // ADMIN AUTHENTICATION
  // ============================================

  // Admin login
  app.post("/api/admin/login", authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const ip = req.ip || req.headers["x-forwarded-for"] as string || "unknown";
      
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      // Check login throttling
      const throttleCheck = await checkLoginThrottle(`admin:${username}`, ip);
      if (!throttleCheck.allowed) {
        logSecurityEvent("lockout", { identifier: `admin:${username}`, ip, lockedUntil: throttleCheck.lockedUntil });
        return res.status(429).json({
          message: `Account temporarily locked. Try again after ${throttleCheck.lockedUntil?.toLocaleTimeString()}`,
          lockedUntil: throttleCheck.lockedUntil
        });
      }

      const admin = await storage.getAdminUserByUsername(username);
      if (!admin) {
        await recordLoginAttempt(`admin:${username}`, ip, false);
        logSecurityEvent("login_failed", { identifier: `admin:${username}`, ip, type: "admin" });
        return res.status(401).json({ message: "Invalid credentials" });
      }

      if (!admin.isActive) {
        await recordLoginAttempt(`admin:${username}`, ip, false);
        return res.status(401).json({ message: "Account is deactivated" });
      }

      const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
      if (!isValidPassword) {
        await recordLoginAttempt(`admin:${username}`, ip, false);
        logSecurityEvent("login_failed", { identifier: `admin:${username}`, ip, type: "admin" });
        return res.status(401).json({ message: "Invalid credentials" });
      }

      // Clear login attempts on successful login
      await clearLoginAttempts(`admin:${username}`, ip);
      logSecurityEvent("login_success", { adminId: admin.id, ip, type: "admin" });

      // Set session
      req.session.adminId = admin.id;
      req.session.adminRole = admin.role as AdminRole;
      // Roles that need MFA (see mfaRequiredFor) must pass it, or enrol, before any admin route works; enforced in the gate.
      // mfaPassed is never set here: only the TOTP/recovery verify and enrolment confirm endpoints prove a second factor.
      const needsMfa = mfaRequiredFor(admin.role);
      req.session.mfaVerified = !needsMfa;
      req.session.mfaPassed = false;
      const mfaState = needsMfa ? ((await isMfaEnrolled(admin.id)) ? "verify" : "enroll") : null;

      // Update last login
      await storage.updateAdminLastLogin(admin.id);

      // Log activity
      await logActivity(admin.id, "login", "admin", admin.id, "Admin logged in", req.ip);

      const adminWithoutPassword = toPublicAdminUser(admin);
      req.session.save((err) => {
        if (err) {
          console.error('[ADMIN] Session save failed on login:', err);
          return res.status(500).json({ message: "Login failed" });
        }
        res.json({ admin: adminWithoutPassword, mfa: mfaState });
      });
    } catch (error) {
      console.error("Admin login error:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Admin logout
  app.post("/api/admin/logout", requireAdminPending, async (req: Request, res: Response) => {
    const adminId = req.session.adminId!;
    await logActivity(adminId, "logout", "admin", adminId, "Admin logged out", req.ip);
    
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("admin.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  // Get current admin
  app.get("/api/admin/me", requireAdminPending, async (req: Request, res: Response) => {
    try {
      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }
      const adminWithoutPassword = toPublicAdminUser(admin);
      const required = mfaRequiredFor(admin.role);
      res.json({ ...adminWithoutPassword, mfa: { required, enrolled: required ? await isMfaEnrolled(admin.id) : false, verified: required ? req.session.mfaPassed === true : !!req.session.mfaVerified } });
    } catch (error) {
      res.status(500).json({ message: "Failed to get admin" });
    }
  });

  // Change own password — any logged-in admin, any role
  app.patch("/api/admin/me/password", requireAdmin, sensitiveOperationLimiter, async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        currentPassword: z.string().min(1, "Current password is required"),
        newPassword: z.string().min(8, "New password must be at least 8 characters"),
      });
      const { currentPassword, newPassword } = schema.parse(req.body);

      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "Admin not found" });
      }

      const isValid = await bcrypt.compare(currentPassword, admin.passwordHash);
      if (!isValid) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await storage.updateAdminUser(admin.id, { passwordHash });
      await logActivity(admin.id, "update", "admin", admin.id, "Changed own password", req.ip);

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Admin change-password error:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  });

  // ============================================
  // ADMIN USER MANAGEMENT (Super Admin Only)
  // ============================================

  // Get all admin users
  app.get("/api/admin/users/admins", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const admins = await storage.getAllAdminUsers();
      const adminsWithoutPasswords = admins.map(toPublicAdminUser);
      res.json(adminsWithoutPasswords);
    } catch (error) {
      res.status(500).json({ message: "Failed to get admins" });
    }
  });

  // Create new admin user
  app.post("/api/admin/users/admins", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const createSchema = z.object({
        email: z.string().email(),
        username: z.string().min(3),
        password: z.string().min(8),
        displayName: z.string().min(1),
        role: z.enum(adminRoles),
      });

      const data = createSchema.parse(req.body);

      // Check if username or email already exists
      const existingByUsername = await storage.getAdminUserByUsername(data.username);
      if (existingByUsername) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const existingByEmail = await storage.getAdminUserByEmail(data.email);
      if (existingByEmail) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const passwordHash = await bcrypt.hash(data.password, 12);

      const admin = await storage.createAdminUser({
        email: data.email,
        username: data.username,
        passwordHash,
        displayName: data.displayName,
        role: data.role,
        isActive: true,
        createdBy: req.session.adminId,
      });

      await logActivity(
        req.session.adminId!,
        "create_admin",
        "admin",
        admin.id,
        `Created admin user: ${admin.username} with role: ${admin.role}`,
        req.ip
      );

      const adminWithoutPassword = toPublicAdminUser(admin);
      res.status(201).json(adminWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      console.error("Create admin error:", error);
      res.status(500).json({ message: "Failed to create admin" });
    }
  });

  // Update admin user
  app.patch("/api/admin/users/admins/:id", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updateSchema = z.object({
        displayName: z.string().min(1).optional(),
        role: z.enum(adminRoles).optional(),
        isActive: z.boolean().optional(),
      });

      const data = updateSchema.parse(req.body);

      const admin = await storage.updateAdminUser(id, data);

      await logActivity(
        req.session.adminId!,
        "update_admin",
        "admin",
        id,
        `Updated admin user: ${JSON.stringify(data)}`,
        req.ip
      );

      const adminWithoutPassword = toPublicAdminUser(admin);
      res.json(adminWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to update admin" });
    }
  });

  // Deactivate admin user
  app.post("/api/admin/users/admins/:id/deactivate", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Can't deactivate yourself
      if (id === req.session.adminId) {
        return res.status(400).json({ message: "Cannot deactivate your own account" });
      }

      const admin = await storage.deactivateAdminUser(id);

      await logActivity(
        req.session.adminId!,
        "deactivate_admin",
        "admin",
        id,
        `Deactivated admin user: ${admin.username}`,
        req.ip
      );

      const adminWithoutPassword = toPublicAdminUser(admin);
      res.json(adminWithoutPassword);
    } catch (error) {
      res.status(500).json({ message: "Failed to deactivate admin" });
    }
  });

  // ============================================
  // PLATFORM DASHBOARD
  // ============================================

  // Get platform stats
  app.get("/api/admin/stats", requireStaffNotReviewer, async (req: Request, res: Response) => {
    try {
      const stats = await storage.getPlatformStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Failed to get stats" });
    }
  });

  // Time-series dashboard analytics — date-ranged, optionally filtered by
  // currency/country, with period-over-period totals so the UI can show
  // growth %. Defaults to the last 30 days.
  app.get("/api/admin/analytics/overview", requireStaffNotReviewer, async (req: Request, res: Response) => {
    try {
      const to = req.query.to ? new Date(req.query.to as string) : new Date();
      const from = req.query.from ? new Date(req.query.from as string) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return res.status(400).json({ message: "Invalid from/to date" });
      }
      const currency = (req.query.currency as string) || undefined;
      const country = (req.query.country as string) || undefined;
      const overview = await storage.getAdminAnalyticsOverview({ from, to, currency, country });
      res.json(overview);
    } catch (error) {
      console.error('[ADMIN] analytics overview failed:', error);
      res.status(500).json({ message: "Failed to get analytics" });
    }
  });

  // Dropdown options for the currency/country filters across the admin panel.
  app.get("/api/admin/meta/filters", requireStaffNotReviewer, async (req: Request, res: Response) => {
    try {
      const options = await storage.getAdminFilterOptions();
      res.json(options);
    } catch (error) {
      res.status(500).json({ message: "Failed to get filter options" });
    }
  });

  // Real health check — DB connectivity + payment provider configuration.
  // Replaces a previously-hardcoded "all systems operational" card.
  app.get("/api/admin/health", requireStaffNotReviewer, async (req: Request, res: Response) => {
    const health: Record<string, { status: "ok" | "down"; detail?: string }> = {};
    try {
      await pool.query("SELECT 1");
      health.database = { status: "ok" };
    } catch (error) {
      health.database = { status: "down", detail: error instanceof Error ? error.message : "query failed" };
    }
    health.stripe = { status: process.env.STRIPE_SECRET_KEY ? "ok" : "down", detail: process.env.STRIPE_SECRET_KEY ? undefined : "not configured" };
    health.paystack = { status: process.env.PAYSTACK_SECRET_KEY ? "ok" : "down", detail: process.env.PAYSTACK_SECRET_KEY ? undefined : "not configured" };
    health.email = { status: process.env.RESEND_API_KEY ? "ok" : "down", detail: process.env.RESEND_API_KEY ? undefined : "not configured" };
    res.json(health);
  });

  // Get activity logs
  app.get("/api/admin/activity-logs", requireRole("super_admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const from = req.query.from ? new Date(req.query.from as string) : undefined;
      const to = req.query.to ? new Date(req.query.to as string) : undefined;
      const adminId = (req.query.adminId as string) || undefined;
      const action = (req.query.action as string) || undefined;
      if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
        return res.status(400).json({ message: "Invalid from/to date" });
      }
      const { items, total } = await storage.getAdminActivityLogs({ limit, offset, from, to, adminId, action });
      res.json({ logs: items, total });
    } catch (error) {
      res.status(500).json({ message: "Failed to get activity logs" });
    }
  });

  // ============================================
  // USER MANAGEMENT
  // ============================================

  // Get all platform users
  app.get("/api/admin/users", requireRole("super_admin", "admin", "user_support", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const search = (req.query.search as string) || undefined;
      const users = await storage.getAllUsers(limit, offset, search);
      const totalCount = await storage.getUserCount(search);

      const usersWithoutPasswords = users.map(toPublicUser);

      const userIds = usersWithoutPasswords.map(u => u.id);
      const activeSuspensions = await storage.getBulkActiveSuspensions(userIds);
      const suspensionMap = new Map(activeSuspensions.map(s => [s.userId, { id: s.id, reason: s.reason, isPermanent: s.isPermanent }]));

      const usersWithSuspensions = usersWithoutPasswords.map(u => ({
        ...u,
        activeSuspension: suspensionMap.get(u.id) || null,
      }));

      res.json({ users: usersWithSuspensions, total: totalCount });
    } catch (error) {
      res.status(500).json({ message: "Failed to get users" });
    }
  });

  // Grant/adjust a user's free promotion credits (each credit waives payment
  // on one event or venue promotion — see /api/payments/*/promote/intent)
  app.patch("/api/admin/users/:id/promotion-credits", requireRole("super_admin"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { credits } = z.object({
        credits: z.number().int().min(0).max(1000),
      }).parse(req.body);

      const user = await storage.setUserPromotionCredits(id, credits);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      await logActivity(
        req.session.adminId!,
        "set_promotion_credits",
        "user",
        id,
        `Set free promotion credits to ${credits}`,
        req.ip
      );

      res.json({ id: user.id, freePromotionCredits: user.freePromotionCredits });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "credits must be an integer between 0 and 1000" });
      }
      res.status(500).json({ message: "Failed to update promotion credits" });
    }
  });

  // Correct a user's (otherwise locked) birthdate. Audited; reason required.
  app.put("/api/admin/users/:id/date-of-birth", requireRole("super_admin", "admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const body = z.object({ dateOfBirth: z.string(), reason: z.string() }).parse(req.body);
      const { correctDateOfBirth } = await import("./services/dobCorrection");
      const r = await correctDateOfBirth({ adminId: req.session.adminId!, userId: req.params.id, ...body, ip: req.ip });
      if (!r.ok) return res.status(r.status).json({ message: r.message });
      if (r.roomsFailed) {
        return res.status(500).json({ message: "The date of birth was saved, but applying it to this person's rooms failed. Check their rooms now.", saved: true, code: "ROOMS_NOT_UPDATED", failedRoomIds: r.failedRoomIds ?? [], user: r.user });
      }
      res.json(r.user);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "dateOfBirth and reason are required" });
      res.status(500).json({ message: "Failed to correct date of birth" });
    }
  });

  // Mark (or unmark) a user as ID-verified. Admin roles only; a user can never call this, even on themself.
  registerAgeVerificationAdminRoute(app);
  registerAgeReviewAdminRoutes(app);

  // ---- Rooms (alpha): reported rooms, end any room, change a room's age limit. All audited, reason required.
  app.get("/api/admin/rooms/reported", requireRole("super_admin", "content_moderator"), async (_req: Request, res: Response) => {
    try {
      const { listReportedRooms } = await import("./rooms/roomAdmin");
      res.json({ rooms: await listReportedRooms() });
    } catch (error) {
      res.status(500).json({ message: "Failed to load reported rooms" });
    }
  });

  // Room recap, read-only, the host's view (owner decision, fix round). Admin session + moderator roles; audited.
  registerRoomRecapAdminRoute(app);

  app.post("/api/admin/rooms/:id/end", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { adminEndRoom } = await import("./rooms/roomAdmin");
      const r = await adminEndRoom({ adminId: req.session.adminId!, roomId: req.params.id, reason: String(req.body?.reason ?? ""), ip: req.ip });
      if (!r.ok) return res.status(r.status).json({ message: r.message });
      res.json({ room: r.room });
    } catch (error) {
      res.status(500).json({ message: "Failed to end room" });
    }
  });

  app.patch("/api/admin/rooms/:id/age-limit", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { adminSetRoomAgeLimit } = await import("./rooms/roomAdmin");
      const r = await adminSetRoomAgeLimit({ adminId: req.session.adminId!, roomId: req.params.id, ageLimit: req.body?.ageLimit, reason: String(req.body?.reason ?? ""), ip: req.ip });
      if (!r.ok) return res.status(r.status).json({ message: r.message });
      res.json({ room: r.room });
    } catch (error) {
      res.status(500).json({ message: "Failed to change age limit" });
    }
  });

  // Suspend user
  app.post("/api/admin/users/:id/suspend", requireRole("super_admin", "admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const suspendSchema = z.object({
        reason: z.string().min(1),
        suspendedUntil: z.string().datetime().optional(),
        isPermanent: z.boolean().optional(),
      });

      const data = suspendSchema.parse(req.body);

      const suspension = await storage.suspendUser({
        userId: id,
        adminId: req.session.adminId!,
        reason: data.reason,
        suspendedUntil: data.suspendedUntil ? new Date(data.suspendedUntil) : null,
        isPermanent: data.isPermanent || false,
      });

      await logActivity(
        req.session.adminId!,
        "suspend_user",
        "user",
        id,
        `Suspended user: ${data.reason}`,
        req.ip
      );

      res.json(suspension);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to suspend user" });
    }
  });

  // Lift user suspension
  app.post("/api/admin/users/:userId/suspensions/:suspensionId/lift", requireRole("super_admin", "admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const { suspensionId } = req.params;

      const suspension = await storage.liftSuspension(suspensionId);

      await logActivity(
        req.session.adminId!,
        "lift_suspension",
        "suspension",
        suspensionId,
        `Lifted suspension for user`,
        req.ip
      );

      res.json(suspension);
    } catch (error) {
      res.status(500).json({ message: "Failed to lift suspension" });
    }
  });

  // Get all suspensions
  app.get("/api/admin/suspensions", requireRole("super_admin", "admin", "user_support"), async (req: Request, res: Response) => {
    try {
      const suspensions = await storage.getAllSuspensions();
      res.json(suspensions);
    } catch (error) {
      res.status(500).json({ message: "Failed to get suspensions" });
    }
  });

  // Delete user (Super Admin only)
  app.delete("/api/admin/users/:id", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      await storage.deleteUser(id);

      await logActivity(
        req.session.adminId!,
        "delete_user",
        "user",
        id,
        `Deleted user`,
        req.ip
      );

      res.json({ message: "User deleted" });
    } catch (error) {
      // Paid rooms: money records (room tickets, payouts) are never deleted; the admin is told why in plain words.
      if (error instanceof RoomMoneyRecordsError) return res.status(409).json({ message: error.message, code: error.code });
      res.status(500).json({ message: "Failed to delete user" });
    }
  });

  // ============================================
  // EVENT MANAGEMENT
  // ============================================

  // Get all events
  app.get("/api/admin/events", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const currency = (req.query.currency as string) || undefined;
      const country = (req.query.country as string) || undefined;
      const search = (req.query.search as string) || undefined;
      const { items, total } = await storage.getAllEventsAdmin({ limit, offset, currency, country, search });
      res.json({ events: items, total });
    } catch (error) {
      res.status(500).json({ message: "Failed to get events" });
    }
  });

  // Moderate event
  app.post("/api/admin/events/:id/moderate", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if ((await storage.getEventGate(id))?.kind === "social") {
        return res.status(400).json({ message: "Social events are moderated from the moderation queue (a reason is required).", code: "USE_MODERATION_QUEUE" });
      }
      const moderateSchema = z.object({
        action: z.enum(["approved", "rejected", "flagged"]),
        reason: z.string().optional(),
      });

      const data = moderateSchema.parse(req.body);

      const moderation = await storage.moderateEvent({
        eventId: id,
        adminId: req.session.adminId!,
        action: data.action,
        reason: data.reason,
      });

      await logActivity(
        req.session.adminId!,
        `${data.action}_event`,
        "event",
        id,
        `${data.action} event: ${data.reason || "No reason provided"}`,
        req.ip
      );

      res.json(moderation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      console.error('[ADMIN] Failed to moderate event:', error);
      const msg = error instanceof Error ? error.message : "Failed to moderate event";
      res.status(500).json({ message: msg });
    }
  });

  // Moderate venue entry night
  app.post("/api/admin/venue-events/:id/moderate", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { action, reason } = z.object({
        action: z.enum(["approved", "rejected", "flagged"]),
        reason: z.string().optional(),
      }).parse(req.body);

      await storage.moderateVenueEvent(id, action);

      await logActivity(
        req.session.adminId!,
        `${action}_venue_event`,
        "venue_event",
        id,
        `${action} venue event: ${reason || "No reason provided"}`,
        req.ip
      );

      res.json({ message: `Venue event ${action}` });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      console.error('[ADMIN] Failed to moderate venue event:', error);
      const msg = error instanceof Error ? error.message : "Failed to moderate venue event";
      res.status(500).json({ message: msg });
    }
  });

  // Delete event — sourceType distinguishes a real event from a venue entry
  // night (both appear merged in the admin events list; they're different
  // tables). Previously this always called deleteEvent() even for venue_entry
  // rows, so deleting one either no-opped or hit the wrong row.
  app.delete("/api/admin/events/:id", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const sourceType = req.query.sourceType === "venue_entry" ? "venue_entry" : "event";
      if (sourceType === "event" && (await storage.getEventGate(id))?.kind === "social") {
        return res.status(400).json({ message: "Remove social events from the moderation queue (a reason is required).", code: "USE_MODERATION_QUEUE" });
      }

      if (sourceType === "venue_entry") {
        await storage.deleteVenueEntryNight(id);
      } else {
        await storage.deleteEvent(id);
      }

      await logActivity(
        req.session.adminId!,
        sourceType === "venue_entry" ? "delete_venue_event" : "delete_event",
        sourceType === "venue_entry" ? "venue_event" : "event",
        id,
        sourceType === "venue_entry" ? "Deleted venue event" : "Deleted event",
        req.ip
      );

      res.json({ message: sourceType === "venue_entry" ? "Venue event deleted" : "Event deleted" });
    } catch (error) {
      console.error('[ADMIN] Failed to delete event:', error);
      const msg = error instanceof Error ? error.message : "Failed to delete event";
      res.status(500).json({ message: msg });
    }
  });

  // Get event moderation history
  app.get("/api/admin/events/:id/moderations", requireRole("super_admin", "event_reviewer", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const moderations = await storage.getEventModerations(id);
      res.json(moderations);
    } catch (error) {
      res.status(500).json({ message: "Failed to get moderations" });
    }
  });

  // ============================================
  // CONTENT MODERATION
  // ============================================

  // Get all stories (for moderation)
  app.get("/api/admin/stories", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const { items, total } = await storage.getAllStoriesAdmin(limit, offset);
      res.json({ stories: items, total });
    } catch (error) {
      res.status(500).json({ message: "Failed to get stories" });
    }
  });

  // Delete story
  app.delete("/api/admin/stories/:id", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      await storage.deleteStoryAdmin(id);

      await logActivity(
        req.session.adminId!,
        "delete_story",
        "story",
        id,
        `Deleted story`,
        req.ip
      );

      res.json({ message: "Story deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete story" });
    }
  });

  // Get content reports
  app.get("/api/admin/reports", requireRole("super_admin", "content_moderator", "user_support"), async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const { items, total } = await storage.getContentReports(status, limit, offset);
      res.json({ reports: items, total });
    } catch (error) {
      res.status(500).json({ message: "Failed to get reports" });
    }
  });

  // Review content report
  app.post("/api/admin/reports/:id/review", requireRole("super_admin", "content_moderator", "user_support"), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const reviewSchema = z.object({
        status: z.enum(["reviewed", "dismissed", "actioned"]),
        resolution: z.string().optional(),
      });

      const data = reviewSchema.parse(req.body);

      const report = await storage.updateContentReport(id, {
        status: data.status,
        reviewedBy: req.session.adminId!,
        resolution: data.resolution,
      });

      await logActivity(
        req.session.adminId!,
        "review_report",
        "report",
        id,
        `Reviewed report: ${data.status}`,
        req.ip
      );

      res.json(report);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to review report" });
    }
  });

  // ============================================
  // FINANCE (Finance Manager + Super Admin)
  // ============================================

  // Get payment/ticket overview
  app.get("/api/admin/finance/overview", requireRole("super_admin", "finance_manager"), async (req: Request, res: Response) => {
    try {
      const from = req.query.from ? new Date(req.query.from as string) : undefined;
      const to = req.query.to ? new Date(req.query.to as string) : undefined;
      const currency = (req.query.currency as string) || undefined;
      if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
        return res.status(400).json({ message: "Invalid from/to date" });
      }

      const [stats, commissionBps, ledger] = await Promise.all([
        storage.getPlatformStats(),
        storage.getPlatformCommissionBps(),
        storage.getFinanceLedgerSummary({ from, to, currency }),
      ]);
      res.json({
        revenueByCurrency: stats.revenueByCurrency,
        totalTicketsSold: stats.totalTicketsSold,
        totalVenueTicketsSold: stats.totalVenueTicketsSold,
        commissionBps,
        // Full ledger breakdown by transaction type (ticket_sale, venue_ticket_sale,
        // event_promotion, venue_promotion, social_promotion, refund) and currency —
        // the revenueByCurrency fields above only ever cover ticket sales.
        ledger,
      });
    } catch (error) {
      console.error('[ADMIN] finance overview failed:', error);
      res.status(500).json({ message: "Failed to get finance overview" });
    }
  });

  // Update the platform commission rate — takes effect on the next checkout,
  // no deploy required. bps: 1000 = 10%. Bounded to a sane range to prevent a
  // fat-fingered rate (e.g. 100000 = 1000%) from being accepted.
  app.patch("/api/admin/finance/commission-rate", requireRole("super_admin", "finance_manager"), async (req: Request, res: Response) => {
    try {
      const { commissionBps } = z.object({
        commissionBps: z.number().int().min(0).max(5000), // 0%–50%
      }).parse(req.body);

      const updated = await storage.setPlatformCommissionBps(commissionBps, req.session.adminId!);
      await logActivity(
        req.session.adminId!,
        "update_commission_rate",
        "platform_settings",
        "default",
        `Commission rate set to ${commissionBps} bps (${(commissionBps / 100).toFixed(2)}%)`,
        req.ip
      );
      res.json({ commissionBps: updated.commissionBps });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message ?? "Invalid commission rate" });
      }
      res.status(500).json({ message: "Failed to update commission rate" });
    }
  });

  registerRoomFinanceAdminRoutes(app); // paid rooms: payouts + ticket totals, read-only
  registerSprayClawbackAdminRoutes(app); // spraying: chargeback clawbacks list + audited write-off (finance roles)
  registerRoomsAdminRoutes(app); // rooms admin: live rooms, usage overview, spray breakdown, freeze controls

  // ============================================
  // UTILITIES (Super Admin only)
  // ============================================

  // Fix ACL on all post images (repair existing posts that have broken image visibility)
  app.post("/api/admin/utilities/fix-post-acl", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      console.log(`[Admin Utility] Starting ACL fix for all posts by admin ${req.session.adminId}`);
      const { ObjectStorageService } = await import("./objectStorage");
      const objectStorageService = new ObjectStorageService();
      const allPosts = await storage.getAllPosts();
      
      let fixed = 0;
      let skipped = 0;
      const errors: { postId: string; imageUrl: string; error: string }[] = [];
      
      for (const post of allPosts) {
        const imageUrls = [...(post.imageUrls || [])];
        if (post.imageUrl && post.imageUrl.startsWith('/objects/')) {
          imageUrls.push(post.imageUrl);
        }
        
        for (const imageUrl of imageUrls) {
          if (imageUrl && imageUrl.startsWith('/objects/')) {
            try {
              await objectStorageService.trySetObjectEntityAclPolicy(imageUrl, {
                owner: post.userId,
                visibility: "public",
              });
              fixed++;
              console.log(`[Admin Utility] Fixed ACL for: ${imageUrl}`);
            } catch (err: any) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              if (errorMessage.includes('ObjectNotFound') || errorMessage.includes('not found')) {
                skipped++;
              } else {
                console.error(`[Admin Utility] Error for ${imageUrl}:`, errorMessage);
                errors.push({ postId: post.id, imageUrl, error: errorMessage });
              }
            }
          }
        }
      }
      
      await logActivity(
        req.session.adminId!,
        "fix_post_acl",
        "utility",
        "all_posts",
        `Fixed ACL for ${fixed} post images, skipped ${skipped}, errors: ${errors.length}`,
        req.ip
      );
      
      console.log(`[Admin Utility] Complete. Fixed: ${fixed}, Skipped: ${skipped}, Errors: ${errors.length}`);
      res.json({
        message: `Fixed ACL for ${fixed} post images`,
        fixed,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error("[Admin Utility] Error:", error);
      res.status(500).json({ message: "Failed to fix post ACLs" });
    }
  });

  // Cache stats — any admin, read-only
  app.get("/api/admin/cache-stats", requireStaffNotReviewer, async (req: Request, res: Response) => {
    try {
      res.json({
        posts:     postsCache.stats(),
        events:    eventsCache.stats(),
        stories:   storiesCache.stats(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to get cache stats" });
    }
  });

  // Cache clear — super admin only; causes DB load spike, treat as infrastructure op
  app.post("/api/admin/cache-clear", requireSuperAdmin, async (req: Request, res: Response) => {
    try {
      invalidateCache.all();

      await logActivity(
        req.session.adminId!,
        "cache_clear",
        "cache",
        "all",
        "Cleared all caches (posts, events, stories)",
        req.ip
      );

      res.json({
        message:   "All caches cleared",
        cleared:   ["posts", "events", "stories"],
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to clear caches" });
    }
  });

  // ============================================
  // VENUE VERIFICATION
  // ============================================

  app.patch("/api/admin/venues/:id/verify", requireRole("super_admin", "content_moderator"), async (req: Request, res: Response) => {
    try {
      const { isVerified } = z.object({ isVerified: z.boolean() }).parse(req.body);
      const venue = await storage.getVenue(req.params.id);
      if (!venue) return res.status(404).json({ message: "Venue not found" });

      const updated = await storage.verifyVenue(req.params.id, isVerified);

      await logActivity(
        req.session.adminId!,
        isVerified ? "verify_venue" : "unverify_venue",
        "venue",
        req.params.id,
        `${isVerified ? "Verified" : "Unverified"} venue: ${venue.name}`,
        req.ip
      );

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "isVerified (boolean) is required" });
      }
      console.error("[Admin] Verify venue error:", error);
      res.status(500).json({ message: "Failed to update venue verification" });
    }
  });

  // ── SOS Alerts (monitoring only) ────────────────────────────────────────
  app.get("/api/admin/safety-alerts", requireAdmin, requireRole("super_admin", "user_support"), async (req, res) => {
    try {
      const alerts = await storage.getAllSafetyAlerts(100);
      res.json({ alerts });
    } catch (error) {
      console.error("[Admin] Safety alerts error:", error);
      res.status(500).json({ message: "Failed to fetch safety alerts" });
    }
  });

  // ── Zernio Social Media Analytics (aggregate only, no PII) ───────────────

  // Shared helper: compute a 30-day window from today
  function thirtyDaysAgo(): Date {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // GET /api/admin/social/dashboard
  // Overview stats + daily posts/cost series + platform breakdown for last 30 days.
  app.get("/api/admin/social/dashboard", requireStaffNotReviewer, async (req, res) => {
    try {
      const dateFrom = thirtyDaysAgo();
      const [stats, daily, byPlatform] = await Promise.all([
        storage.getSocialDashboardStats(dateFrom),
        storage.getSocialDailyBreakdown(dateFrom),
        storage.getSocialPlatformBreakdown(dateFrom),
      ]);

      res.json({
        stats: {
          total_posts:    stats.totalPosts,
          total_cost_usd: stats.totalCostUsd,
          platforms_used: stats.platformsUsed,
          posts_failed:   stats.failedPosts,
        },
        daily_posts: daily.map((d) => ({
          date:  d.date,
          count: d.count,
          cost:  d.costUsd,
        })),
        by_platform: byPlatform.map((p) => ({
          platform: p.platform,
          posts:    p.posts,
          cost:     p.costUsd,
        })),
      });
    } catch (error) {
      console.error("[Admin] Social dashboard error:", error);
      res.status(500).json({ message: "Failed to fetch social dashboard" });
    }
  });

  // GET /api/admin/social/organizers?limit=50&offset=0
  // Organizer list with aggregate post + cost stats. No individual email or PII.
  app.get("/api/admin/social/organizers", requireStaffNotReviewer, async (req, res) => {
    try {
      const limit  = Math.min(parseInt((req.query.limit  as string) || "50", 10), 200);
      const offset = Math.max(parseInt((req.query.offset as string) || "0",  10), 0);

      const organizers = await storage.getSocialOrganizerStats(limit, offset);
      res.json(organizers.map((o) => ({
        user_id:            o.userId,
        org_name:           o.orgName ?? "—",
        connected_accounts: o.connectedAccounts,
        posts_this_month:   o.postsThisMonth,
        cost_this_month:    o.costThisMonth,
      })));
    } catch (error) {
      console.error("[Admin] Social organizers error:", error);
      res.status(500).json({ message: "Failed to fetch organizer stats" });
    }
  });

  // GET /api/admin/social/costs
  // Daily cost series, platform split, month-to-date total, and linear projection.
  app.get("/api/admin/social/costs", requireStaffNotReviewer, async (req, res) => {
    try {
      const dateFrom    = thirtyDaysAgo();
      const [stats, daily, byPlatform] = await Promise.all([
        storage.getSocialDashboardStats(dateFrom),
        storage.getSocialDailyBreakdown(dateFrom),
        storage.getSocialPlatformBreakdown(dateFrom),
      ]);

      // Month-to-date cost (from the 1st of current month)
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const [monthStats] = await Promise.all([
        storage.getSocialDashboardStats(monthStart),
      ]);
      const monthActual = parseFloat(monthStats.totalCostUsd) || 0;

      // Linear projection: average daily cost × days in month
      const daysElapsed  = Math.max(new Date().getDate(), 1);
      const daysInMonth  = new Date(
        new Date().getFullYear(),
        new Date().getMonth() + 1,
        0,
      ).getDate();
      const monthlyProjection = parseFloat(
        ((monthActual / daysElapsed) * daysInMonth).toFixed(2),
      );

      // Trend: compare average daily cost of last 7 days vs preceding 7 days
      const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
      const last7  = sorted.slice(-7).reduce((s, d) => s + parseFloat(d.costUsd), 0);
      const prev7  = sorted.slice(-14, -7).reduce((s, d) => s + parseFloat(d.costUsd), 0);
      const trendDirection =
        last7 > prev7 * 1.1 ? "up" : last7 < prev7 * 0.9 ? "down" : "stable";

      // Build platform breakdown object { instagram: "12.50", twitter: "8.20" }
      const platformMap: Record<string, string> = {};
      byPlatform.forEach((p) => { platformMap[p.platform] = p.costUsd; });

      res.json({
        this_month_actual:  monthActual.toFixed(2),
        monthly_projection: monthlyProjection.toFixed(2),
        by_platform:        platformMap,
        daily:              daily.map((d) => ({ date: d.date, cost: d.costUsd })),
        trend_direction:    trendDirection,
      });
    } catch (error) {
      console.error("[Admin] Social costs error:", error);
      res.status(500).json({ message: "Failed to fetch cost data" });
    }
  });

  // GET /api/admin/social/platforms
  // Per-platform connection counts and post/cost stats for the last 30 days.
  app.get("/api/admin/social/platforms", requireStaffNotReviewer, async (req, res) => {
    try {
      const dateFrom   = thirtyDaysAgo();
      const breakdown  = await storage.getSocialPlatformBreakdown(dateFrom);

      res.json(breakdown.map((p) => ({
        platform:        p.platform,
        posts_this_month: p.posts,
        cost_this_month:  p.costUsd,
      })));
    } catch (error) {
      console.error("[Admin] Social platforms error:", error);
      res.status(500).json({ message: "Failed to fetch platform stats" });
    }
  });

  // GET /api/admin/social/stale-connections
  // Connected accounts with no successful blast in 60 days — these cost
  // Zernio's per-connected-account fee with no offsetting revenue and will be
  // auto-disconnected by the nightly cleanup job (server/socialCleanupScheduler.ts).
  app.get("/api/admin/social/stale-connections", requireStaffNotReviewer, async (req, res) => {
    try {
      const stale = await storage.getStaleConnectedSocials(60);
      res.json(stale.map((c) => ({
        userId:      c.userId,
        platform:    c.platform,
        connectedAt: c.connectedAt,
      })));
    } catch (error) {
      console.error("[Admin] Stale social connections error:", error);
      res.status(500).json({ message: "Failed to fetch stale connections" });
    }
  });

  // GET /api/admin/social/plans
  // Plan revenue, estimated Zernio/X/card costs, margin, and the should-be-zero health lists.
  app.get("/api/admin/social/plans", requireRole("super_admin", "finance_manager"), async (_req, res) => {
    try {
      res.json(await getSocialPlanAdminStats());
    } catch (error) {
      console.error("[Admin] Social plans stats error:", error);
      res.status(500).json({ message: "Failed to fetch social plan stats" });
    }
  });

  // Social-event moderation, host controls, config, MFA, reveal grants, metrics.
  registerAdminSocialRoutes(app);

}
