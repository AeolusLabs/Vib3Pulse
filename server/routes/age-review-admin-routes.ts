// Reviewer API for manual age review. Flag off => every route here is a plain 404. No evidence bytes in any JSON.
// (Evidence reveal, health, pause and emergency purge belong to the guardrails task and register under the same prefix.)
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireRole } from "../services/adminSecurity";
import { ageReviewEnabled } from "../identity/ageReviewFeatures";
import { AgeReviewError } from "../identity/ageReviewService";
import { decide, getDetail, isUuid, listQueue, secondApprove, type AdminRef } from "../identity/ageReviewAdmin";
import { inviteLiveCheck, reviewerLiveJoin } from "../identity/ageReviewLive";
import { CHECKLIST_KEYS, DECISION_OUTCOMES, DECLINE_REASONS } from "../../shared/ageReview";

const REVIEWERS = ["super_admin", "admin", "age_reviewer"] as const;

function flagGate(_req: Request, res: Response, next: NextFunction) {
  if (!ageReviewEnabled()) return res.status(404).json({ message: "Not found" });
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
  note: z.string().max(500).optional(),
  overrideDuplicate: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
});

export function registerAgeReviewAdminRoutes(app: Express): void {
  const base = "/api/admin/age-reviews";
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
    const body = z.object({ approve: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    res.json({ request: await secondApprove(me(req), String(req.params.id), body, req.ip) });
  }));

  app.post(`${base}/:id/invite-live`, requireRole(...REVIEWERS), withId(async (req, res) => { res.json(await inviteLiveCheck(me(req), String(req.params.id))); }));
  app.post(`${base}/:id/live-join`, requireRole(...REVIEWERS), withId(async (req, res) => { res.json(await reviewerLiveJoin(me(req), String(req.params.id))); }));
}
