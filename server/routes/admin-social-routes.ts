import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, storage } from "../storage";
import { hostTrustTiers, moderationAppeals, type AdminRole } from "@shared/schema";
import { checkLoginThrottle, recordLoginAttempt, clearLoginAttempts, logSecurityEvent } from "../security";
import {
  audit, beginMfaSetup, confirmMfaSetup, resetMfa, verifyMfaLogin, isMfaEnrolled, mfaRequired,
  requireAdminPending, requireRole, requireSuperAdmin, HOST_ADMIN_ROLES, MODERATION_ROLES, MODERATOR_ROLES, withAudit,
} from "../services/adminSecurity";
import { applyBulk, applyModerationAction, dismissReport, getModerationQueue, getSocialMetrics, listEventReports, listOpenAppeals, markAbusiveReporter, resolveAppeal } from "../services/moderationQueue";
import { banHost, getHostProfile, issueStrike, liftBanById, revokeStrike, searchHosts, setAbusiveReporter, setFeaturedOverride, setTierOverride } from "../services/adminHosts";
import { listConfigWithValues, setConfigValue } from "../services/adminConfig";
import { createGrant, getRevealActivity, listGrantsForSuperAdmin, listMyActiveGrants, revealEventData, revokeGrant } from "../services/revealGrants";

// Admin side of social events: moderation queue, host controls, config, MFA, reveal grants, metrics.
//   moderators (content_moderator, event_reviewer): the queue and event actions
//   admin:                                          hosts (strikes, bans, trust) and configuration
//   super_admin:                                    roles/MFA resets, reveal authority, plus everything above
// Every mutation requires a reason and is audited BEFORE it runs.

const reason = z.string().trim().min(5, "A reason of at least 5 characters is required").max(500);
const actionEnum = z.enum(["approve", "reject", "hide", "restore", "request_edit", "remove"]);
const caseRef = z.object({ caseType: z.enum(["report", "moderation_item"]), caseId: z.string().min(1).max(64) });

const METRIC_ROLES: AdminRole[] = [...MODERATION_ROLES, "admin", "analytics_viewer"];

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: error.errors[0]?.message ?? "Invalid input", errors: error.errors });
    console.error(`[ADMIN] ${req.method} ${req.path} failed:`, (error as Error).message);
    res.status(500).json({ message: "Something went wrong" });
  }
};

export function registerAdminSocialRoutes(app: Express) {
  // ------------------------------------------------------------------ MFA
  app.get("/api/admin/mfa/status", requireAdminPending, h(async (req, res) => {
    const required = mfaRequired() && req.admin!.role === "super_admin";
    res.json({ required, enrolled: required ? await isMfaEnrolled(req.admin!.id) : false, verified: !!req.session.mfaVerified });
  }));

  app.post("/api/admin/mfa/setup", requireAdminPending, h(async (req, res) => {
    if (!mfaRequired()) return res.status(400).json({ message: "Two-factor authentication is switched off.", code: "MFA_DISABLED" });
    if (req.admin!.role !== "super_admin") return res.status(400).json({ message: "Two-factor authentication is only required for super-admin accounts" });
    // Only a not-yet-verified session may (re)start enrolment. Once enrolled, setup is closed.
    const r = await beginMfaSetup(req.admin!.id, req.admin!.email);
    if (!r.ok) return res.status(409).json({ message: "Two-factor authentication is already set up", code: "ALREADY_ENROLLED" });
    res.json({ secret: r.secret, otpauthUrl: r.otpauthUrl, qrDataUrl: r.qrDataUrl });
  }));

  app.post("/api/admin/mfa/confirm", requireAdminPending, h(async (req, res) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
    const ip = req.ip || "unknown";
    const key = `admin-mfa:${req.admin!.id}`;
    const gate = await checkLoginThrottle(key, ip);
    if (!gate.allowed) return res.status(429).json({ message: "Too many attempts. Try again later." });
    const r = await confirmMfaSetup(req.admin!.id, code);
    if (!r.ok) {
      await recordLoginAttempt(key, ip, false);
      return res.status(400).json({ message: r.reason === "no_pending" ? "Start setup first" : "That code isn't right. Check your authenticator app's clock and try again.", code: r.reason });
    }
    await clearLoginAttempts(key, ip);
    await audit({ adminId: req.admin!.id, action: "mfa_enrolled", targetType: "admin", targetId: req.admin!.id, reason: "Two-factor authentication enabled", ip });
    req.session.mfaVerified = true;
    req.session.save(() => res.json({ enrolled: true, recoveryCodes: r.recoveryCodes }));
  }));

  app.post("/api/admin/mfa/verify", requireAdminPending, h(async (req, res) => {
    const body = z.object({ code: z.string().optional(), recoveryCode: z.string().optional() }).parse(req.body);
    if (!body.code && !body.recoveryCode) return res.status(400).json({ message: "Enter a code" });
    const ip = req.ip || "unknown";
    const key = `admin-mfa:${req.admin!.id}`;
    const gate = await checkLoginThrottle(key, ip);
    if (!gate.allowed) return res.status(429).json({ message: "Too many attempts. Try again later." });
    const r = await verifyMfaLogin(req.admin!.id, body);
    if (!r.ok) {
      await recordLoginAttempt(key, ip, false);
      logSecurityEvent("login_failed", { identifier: key, ip, type: "admin_mfa" });
      return res.status(401).json({ message: "That code isn't right", code: "BAD_MFA_CODE" });
    }
    await clearLoginAttempts(key, ip);
    if (r.usedRecovery) await audit({ adminId: req.admin!.id, action: "mfa_recovery_code_used", targetType: "admin", targetId: req.admin!.id, reason: "Signed in with a recovery code", ip });
    req.session.mfaVerified = true;
    req.session.save(() => res.json({ verified: true }));
  }));

  // One super-admin resets another's lost authenticator. Never your own: that would defeat the point.
  app.post("/api/admin/users/admins/:id/reset-mfa", requireSuperAdmin, h(async (req, res) => {
    const { reason: why } = z.object({ reason }).parse(req.body);
    if (req.params.id === req.admin!.id) return res.status(400).json({ message: "Ask another super-admin to reset your two-factor authentication" });
    const target = await storage.getAdminUser(req.params.id);
    if (!target) return res.status(404).json({ message: "Admin not found" });
    await withAudit({ adminId: req.admin!.id, action: "mfa_reset", targetType: "admin", targetId: target.id, reason: why, ip: req.ip }, () => resetMfa(target.id));
    res.json({ message: "Two-factor authentication reset. They'll set it up again at next sign-in." });
  }));

  // ------------------------------------------------------------------ moderation queue
  app.get("/api/admin/moderation/queue", requireRole(...MODERATION_ROLES), h(async (req, res) => {
    const q = z.object({
      flag: z.string().max(40).optional(),
      minReports: z.coerce.number().int().min(0).max(1000).optional(),
      tier: z.enum(hostTrustTiers).optional(),
      minAgeHours: z.coerce.number().min(0).max(100000).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      sort: z.enum(["event_date", "queued_oldest", "reports"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getModerationQueue(q));
  }));

  app.get("/api/admin/moderation/events/:id/reports", requireRole(...MODERATION_ROLES), h(async (req, res) => {
    res.json({ reports: await listEventReports(req.params.id) });
  }));

  const actionResponse = (res: Response, r: Awaited<ReturnType<typeof applyModerationAction>>) => {
    if (r.ok) return res.json({ status: r.status });
    return res.status(r.code === "not_found" ? 404 : 409).json({ message: r.message, code: r.code });
  };

  app.post("/api/admin/moderation/events/:id/action", requireRole(...MODERATION_ROLES), h(async (req, res) => {
    const b = z.object({ action: actionEnum, reason }).parse(req.body);
    actionResponse(res, await applyModerationAction({ eventId: req.params.id, adminId: req.admin!.id, action: b.action, reason: b.reason, ip: req.ip }));
  }));

  app.post("/api/admin/moderation/bulk", requireRole(...MODERATION_ROLES), h(async (req, res) => {
    const b = z.object({ eventIds: z.array(z.string().min(1)).min(1).max(100), action: actionEnum, reason }).parse(req.body);
    const results = await applyBulk({ eventIds: b.eventIds, adminId: req.admin!.id, action: b.action, reason: b.reason, ip: req.ip });
    res.json({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  }));

  // ------------------------------------------------------------------ appeals
  app.get("/api/admin/moderation/appeals", requireRole(...MODERATION_ROLES, "admin"), h(async (req, res) => {
    const all = await listOpenAppeals();
    // Moderators decide event appeals; strike / ban / suspension appeals belong to admins.
    const isModeratorOnly = (MODERATOR_ROLES as string[]).includes(req.admin!.role);
    res.json({ appeals: isModeratorOnly ? all.filter((a) => a.subjectType === "event") : all });
  }));

  app.post("/api/admin/moderation/appeals/:id/resolve", requireRole(...MODERATION_ROLES, "admin"), h(async (req, res) => {
    const b = z.object({ decision: z.enum(["uphold", "deny"]), reason }).parse(req.body);
    const [a] = await db.select().from(moderationAppeals).where(eq(moderationAppeals.id, req.params.id));
    if (!a) return res.status(404).json({ message: "Appeal not found" });
    const role = req.admin!.role as AdminRole;
    const allowed = a.subjectType === "event" ? ([...MODERATION_ROLES, "admin"] as AdminRole[]).includes(role) : HOST_ADMIN_ROLES.includes(role);
    if (!allowed) return res.status(403).json({ message: "Insufficient permissions for this kind of appeal" });
    const r = await resolveAppeal({ appealId: req.params.id, adminId: req.admin!.id, decision: b.decision, reason: b.reason, ip: req.ip });
    if (!r.ok) return res.status(r.code === "not_found" ? 404 : 409).json({ message: r.message, code: r.code });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ report management
  app.post("/api/admin/moderation/reports/:id/dismiss", requireRole(...MODERATION_ROLES, "admin"), h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const ok = await dismissReport({ reportId: req.params.id, adminId: req.admin!.id, reason: b.reason, ip: req.ip });
    if (!ok) return res.status(404).json({ message: "Report not found" });
    res.json({ ok: true });
  }));

  app.post("/api/admin/moderation/reports/:id/mark-abusive", requireRole(...MODERATION_ROLES, "admin"), h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const r = await markAbusiveReporter({ reportId: req.params.id, adminId: req.admin!.id, reason: b.reason, ip: req.ip });
    if (!r) return res.status(404).json({ message: "Report not found" });
    res.json({ ok: true, reporterId: r.reporterId });
  }));

  // ------------------------------------------------------------------ metrics
  app.get("/api/admin/social/metrics", requireRole(...METRIC_ROLES), h(async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    res.json(await getSocialMetrics(days));
  }));

  // ------------------------------------------------------------------ hosts (admin, super_admin)
  app.get("/api/admin/hosts", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const { search } = z.object({ search: z.string().trim().min(2).max(80) }).parse(req.query);
    res.json({ hosts: await searchHosts(search) });
  }));

  app.get("/api/admin/hosts/:userId", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const p = await getHostProfile(req.params.userId);
    if (!p) return res.status(404).json({ message: "User not found" });
    res.json(p);
  }));

  app.post("/api/admin/hosts/:userId/strikes", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ type: z.enum(["warn", "strike"]), reason, eventId: z.string().max(64).optional(), expiresInDays: z.number().int().min(1).max(3650).optional() }).parse(req.body);
    const r = await issueStrike({ adminId: req.admin!.id, userId: req.params.userId, ...b, ip: req.ip });
    if (!r) return res.status(404).json({ message: "User not found" });
    res.status(201).json({ strikeId: r.strike.id, autoBanned: r.autoBanned });
  }));

  app.post("/api/admin/strikes/:id/revoke", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const r = await revokeStrike({ adminId: req.admin!.id, strikeId: req.params.id, reason: b.reason, ip: req.ip });
    if (!r) return res.status(404).json({ message: "Strike not found or already revoked" });
    res.json({ ok: true });
  }));

  app.post("/api/admin/hosts/:userId/ban", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const r = await banHost({ adminId: req.admin!.id, userId: req.params.userId, reason: b.reason, ip: req.ip });
    if (!r) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true, bansCreated: r.created });
  }));

  app.post("/api/admin/bans/:id/lift", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const r = await liftBanById({ adminId: req.admin!.id, banId: req.params.id, reason: b.reason, ip: req.ip });
    if (!r) return res.status(404).json({ message: "Ban not found or already lifted" });
    res.json({ ok: true });
  }));

  app.put("/api/admin/hosts/:userId/trust-tier", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ tier: z.enum(hostTrustTiers).nullable(), reason }).parse(req.body);
    if (!(await setTierOverride({ adminId: req.admin!.id, userId: req.params.userId, tier: b.tier, reason: b.reason, ip: req.ip }))) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true });
  }));

  app.put("/api/admin/hosts/:userId/featured", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ eligible: z.boolean().nullable(), reason }).parse(req.body);
    if (!(await setFeaturedOverride({ adminId: req.admin!.id, userId: req.params.userId, eligible: b.eligible, reason: b.reason, ip: req.ip }))) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true });
  }));

  app.put("/api/admin/hosts/:userId/abusive-reporter", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ abusive: z.boolean(), reason }).parse(req.body);
    await setAbusiveReporter({ adminId: req.admin!.id, userId: req.params.userId, abusive: b.abusive, reason: b.reason, ip: req.ip });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ configuration
  app.get("/api/admin/moderation/config", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    res.json({ settings: await listConfigWithValues(req.admin!.role as never) });
  }));

  app.put("/api/admin/moderation/config/:key", requireRole(...HOST_ADMIN_ROLES), h(async (req, res) => {
    const b = z.object({ value: z.unknown(), reason }).parse(req.body);
    const r = await setConfigValue({ adminId: req.admin!.id, role: req.admin!.role as never, key: req.params.key, value: b.value, reason: b.reason, ip: req.ip });
    if (!r.ok) return res.status(r.status).json({ message: r.message, code: r.code });
    res.json({ ok: true, before: r.before, after: r.after });
  }));

  // ------------------------------------------------------------------ reveal authority
  app.post("/api/admin/events/:id/reveal", requireRole("super_admin", ...MODERATOR_ROLES), h(async (req, res) => {
    const b = z.object({ scope: z.enum(["address", "guests"]), grantId: z.string().max(64).optional(), case: caseRef.optional(), reason: z.string().max(500).optional() }).parse(req.body);
    const r = await revealEventData({ admin: req.admin!, eventId: req.params.id, scope: b.scope, grantId: b.grantId, case: b.case, reason: b.reason, ip: req.ip });
    if (!r.ok) return res.status(r.status).json({ message: r.message, code: r.code });
    res.setHeader("Cache-Control", "no-store");
    res.json(r.data);
  }));

  app.get("/api/admin/moderators", requireSuperAdmin, h(async (_req, res) => {
    const all = await storage.getAllAdminUsers();
    res.json({ moderators: all.filter((a) => a.isActive && (MODERATOR_ROLES as string[]).includes(a.role)).map((a) => ({ id: a.id, name: a.displayName, username: a.username, role: a.role })) });
  }));

  app.get("/api/admin/reveal-grants", requireSuperAdmin, h(async (_req, res) => {
    res.json({ grants: await listGrantsForSuperAdmin() });
  }));

  app.get("/api/admin/reveal-grants/mine", requireRole(...MODERATOR_ROLES), h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ grants: await listMyActiveGrants(req.admin!.id) });
  }));

  app.post("/api/admin/reveal-grants", requireSuperAdmin, h(async (req, res) => {
    const b = z.object({ granteeId: z.string().min(1).max(64), eventId: z.string().min(1).max(64), case: caseRef, reason: z.string().trim().min(10, "A reason of at least 10 characters is required").max(500), hours: z.number().int().min(1).max(720).optional() }).parse(req.body);
    const r = await createGrant({ grantor: req.admin!, granteeId: b.granteeId, eventId: b.eventId, case: b.case, reason: b.reason, hours: b.hours, ip: req.ip });
    if (!r.ok) return res.status(r.status).json({ message: r.message, code: r.code });
    const { id, eventId, granteeId, expiresAt } = r.grant;
    res.status(201).json({ id, eventId, granteeId, expiresAt });
  }));

  app.post("/api/admin/reveal-grants/:id/revoke", requireSuperAdmin, h(async (req, res) => {
    const b = z.object({ reason }).parse(req.body);
    const r = await revokeGrant({ admin: req.admin!, grantId: req.params.id, reason: b.reason, ip: req.ip });
    if (!r.ok) return res.status(r.status).json({ message: r.message, code: r.code });
    res.json({ ok: true });
  }));

  app.get("/api/admin/reveal-activity", requireSuperAdmin, h(async (_req, res) => {
    res.json({ activity: await getRevealActivity() });
  }));
}
