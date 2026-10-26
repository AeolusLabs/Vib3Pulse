// Reviewer API for manual age review. Flag off => every route here is a plain 404. No evidence bytes in any JSON.
// (Evidence reveal, health, pause and emergency purge belong to the guardrails task and register under the same prefix.)
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireRole } from "../services/adminSecurity";
import { ageReviewEnabled } from "../identity/ageReviewFeatures";
import { noStore } from "./age-review-routes";
import { AgeReviewError } from "../identity/ageReviewService";
import { decide, getDetail, isSelfReview, isUuid, listQueue, secondApprove, type AdminRef } from "../identity/ageReviewAdmin";
import { inviteLiveCheck, reviewerLiveJoin } from "../identity/ageReviewLive";
import { emergencyPurge, getHealth, setPause } from "../identity/ageReviewControls";
import { claimReveal, consumeRevealToken, issueRevealToken, sendEvidence } from "../identity/ageReviewReveal";
import { CHECKLIST_KEYS, DECISION_OUTCOMES, DECLINE_REASONS } from "../../shared/ageReview";

const REVIEWERS = ["super_admin", "admin", "age_reviewer"] as const;

function flagGate(_req: Request, res: Response, next: NextFunction) {
  if (!ageReviewEnabled()) return res.status(404).json({ message: "Not found", code: "AGE_REVIEW_OFF" });
  next();
}

function fail(res: Response, e: unknown) {
  if (e instanceof AgeReviewError) return res.status(e.status).json({ message: e.message, code: e.code, ...e.extra });
  if (e instanceof z.ZodError) return res.status(400).json({ message: "Invalid request", code: "BAD_REQUEST" });
  // Class name only: bodies and messages on these paths can carry birthdates and document numbers.
  console.error("[AGE-REVIEW] admin request failed:", (e as Error)?.name ?? "error");
  return res.status(500).json({ message: "Something went wrong", code: "SERVER_ERROR" });
}

const me = (req: Request): AdminRef => ({ id: req.admin!.id, email: req.admin!.email, role: req.admin!.role });

export const decideSchema = z.object({
  outcome: z.enum(DECISION_OUTCOMES),
  checklist: z.object(Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof CHECKLIST_KEYS)[number], z.ZodBoolean>).partial().optional(),
  idBirthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentNumber: z.string().trim().min(3).max(40).optional(),
  documentType: z.enum(["passport", "drivers_licence", "national_id", "nin_slip"]).optional(),
  declineReason: z.enum(DECLINE_REASONS).optional(),
  note: z.string().max(300).optional(),
  legalName: z.string().max(200).optional(),
  overrideDuplicate: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
});

export function registerAgeReviewAdminRoutes(app: Express): void {
  const base = "/api/admin/age-reviews";
  app.use(base, noStore);
  app.use(base, flagGate);
  // Routes that are not a request id (health, pause, purge) fall through to their own handlers.
  const withId = (h: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    if (!isUuid(String(req.params.id))) return next("route");
    try { await h(req, res); } catch (e) { fail(res, e); }
  };

  app.get(base, requireRole(...REVIEWERS), async (req, res) => {
    try {
      const limit = Number(req.query.limit);
      res.json(await listQueue({
        status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
        cursor: typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }));
    } catch (e) { fail(res, e); }
  });

  app.get(`${base}/:id`, requireRole(...REVIEWERS), withId(async (req, res) => { res.json(await getDetail(me(req), String(req.params.id))); }));

  app.post(`${base}/:id/decide`, requireRole(...REVIEWERS), withId(async (req, res) => {
    const body = decideSchema.parse(req.body);
    res.json({ request: await decide(me(req), String(req.params.id), body, req.ip) });
  }));

  app.post(`${base}/:id/second-approve`, requireRole("super_admin"), withId(async (req, res) => {
    const body = z.object({ approve: z.boolean(), reason: z.string().trim().min(3).max(300), overrideDuplicate: z.object({ reason: z.string().trim().min(3).max(300) }).optional() }).parse(req.body);
    res.json({ request: await secondApprove(me(req), String(req.params.id), body, req.ip) });
  }));

  app.post(`${base}/:id/invite-live`, requireRole(...REVIEWERS), withId(async (req, res) => { res.json(await inviteLiveCheck(me(req), String(req.params.id))); }));
  app.post(`${base}/:id/live-join`, requireRole(...REVIEWERS), withId(async (req, res) => { res.json(await reviewerLiveJoin(me(req), String(req.params.id))); }));

  // ---- guardrail controls. Not request ids, so withId is not used; the :id routes pass these through (next("route")).
  app.get(`${base}/health`, requireRole("super_admin", "admin"), async (_req, res) => {
    try { res.json(await getHealth()); } catch (e) { fail(res, e); }
  });
  app.post(`${base}/pause`, requireRole("super_admin", "admin"), async (req, res) => {
    try {
      const b = z.object({ on: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
      res.json(await setPause(me(req), b, req.ip));
    } catch (e) { fail(res, e); }
  });
  app.post(`${base}/emergency-purge`, requireRole("super_admin"), async (req, res) => {
    try {
      const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
      res.json(await emergencyPurge(me(req), b.reason, req.ip));
    } catch (e) { fail(res, e); }
  });

  // ---- evidence: a POST issues a one-time 60 second token, the GET needs it. A plain GET never returns an image.
  const evidenceIds = (req: Request) => ({ requestId: String(req.params.id), evidenceId: String(req.params.evidenceId) });
  const auditReveal = async (req: Request, action: string, requestId: string, details: string) => {
    const { storage } = await import("../storage");
    await storage.logAdminActivity({ adminId: req.admin!.id, action, targetType: "age_review_request", targetId: requestId, details, reason: details, ipAddress: req.ip });
  };

  app.post(`${base}/:id/evidence/:evidenceId/reveal`, requireRole(...REVIEWERS), withId(async (req, res) => {
    const { requestId, evidenceId } = evidenceIds(req);
    if (!isUuid(evidenceId)) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
    const { pool } = await import("../storage");
    const row = (await pool.query(
      `select e.kind, r.status, u.email as user_email from age_review_evidence e join age_review_requests r on r.id = e.request_id join users u on u.id = r.user_id where e.id = $1 and e.request_id = $2`,
      [evidenceId, requestId])).rows[0] as { kind: string; status: string; user_email: string | null } | undefined;
    if (!row) throw new AgeReviewError(404, "WRONG_STATE", "That photo is no longer available.");
    // Only a request that is actually with the reviewers: not a draft, not one waiting for the user's next photo.
    if (!["submitted", "in_review", "pending_second_approval"].includes(row.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request is not open for review.");
    if (isSelfReview(me(req), { email: row.user_email, dateOfBirth: null })) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
    // Count and record in one transaction under a per-reviewer lock: parallel requests cannot all pass the check. No audit row, no token.
    if (!(await claimReveal(pool, { adminId: req.admin!.id, requestId, kind: row.kind, ip: req.ip }))) {
      console.error(`[AGE-REVIEW] ALERT reveal limit reached by reviewer ${req.admin!.id}`);
      await auditReveal(req, "age_review.reveal_limit", requestId, `request=${requestId}`).catch(() => console.error("[AGE-REVIEW] ALERT the reveal limit audit row could not be written"));
      throw new AgeReviewError(429, "REVEAL_LIMIT", "You have opened too many photos this hour.");
    }
    res.json({ token: issueRevealToken({ adminId: req.admin!.id, requestId, evidenceId }), expiresInSec: 60 });
  }));

  app.get(`${base}/:id/evidence/:evidenceId`, requireRole(...REVIEWERS), withId(async (req, res) => {
    const { requestId, evidenceId } = evidenceIds(req);
    if (!isUuid(evidenceId)) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
    await consumeRevealToken(req.query.token, { adminId: req.admin!.id, requestId, evidenceId });
    const { pool } = await import("../storage");
    const row = (await pool.query(`select id, request_id, kind, mime, bytes_enc from age_review_evidence where id = $1 and request_id = $2`, [evidenceId, requestId])).rows[0];
    if (!row) throw new AgeReviewError(404, "WRONG_STATE", "That photo is no longer available.");
    sendEvidence(res, row);
  }));
}
