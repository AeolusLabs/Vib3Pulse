// User API for manual age review. Flag off => every route is a plain 404. Bodies (base64 photos, the selfie code) are never logged.
import type { Express, NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../middleware";
import { ageReviewEnabled } from "../identity/ageReviewFeatures";
import { AgeReviewError, cancelRequest, createRequest, getMe, liveJoin, newCode, putEvidence, submitRequest } from "../identity/ageReviewService";

const keyGenerator = (req: Request) => (req.user as any)?.id ?? ipKeyGenerator(req.ip ?? "");
const limited = (windowMs: number, max: number) => rateLimit({
  windowMs, max, keyGenerator, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ message: "You're doing that too fast. Please try again later.", code: "RATE_LIMITED", retryAfter: new Date(Date.now() + windowMs).toISOString() }); },
});
export const evidenceLimiter = limited(60 * 60 * 1000, 20);
export const createLimiter = limited(24 * 60 * 60 * 1000, 10);

function flagGate(_req: Request, res: Response, next: NextFunction) {
  if (!ageReviewEnabled()) return res.status(404).json({ message: "Not found" });
  next();
}

function fail(res: Response, e: unknown) {
  if (e instanceof AgeReviewError) return res.status(e.status).json({ message: e.message, code: e.code, ...e.extra });
  if (e instanceof z.ZodError) return res.status(400).json({ message: "Invalid request", code: "BAD_REQUEST" });
  // Only the error class is logged: messages and bodies on these paths may carry personal data.
  console.error("[AGE-REVIEW] request failed:", (e as Error)?.name ?? "error");
  return res.status(500).json({ message: "Something went wrong", code: "SERVER_ERROR" });
}

const uid = (req: Request) => (req.user as { id: string }).id;
const idParam = (req: Request) => String(req.params.id);

export function registerAgeReviewRoutes(app: Express): void {
  const base = "/api/age-review";
  app.use(base, flagGate);

  app.get(`${base}/me`, requireAuth, async (req, res) => {
    try { res.json(await getMe(uid(req))); } catch (e) { fail(res, e); }
  });

  app.post(`${base}/requests`, requireAuth, createLimiter, async (req, res) => {
    try {
      const b = z.object({ method: z.enum(["upload", "live"]), documentType: z.string().max(40).nullish(), consentVersion: z.string().max(40) }).parse(req.body);
      res.status(201).json({ request: await createRequest(uid(req), b) });
    } catch (e) { fail(res, e); }
  });

  app.post(`${base}/requests/:id/evidence`, requireAuth, evidenceLimiter, async (req, res) => {
    try {
      const b = z.object({ kind: z.string().max(20), mime: z.string().max(40), data: z.string().max(5 * 1024 * 1024) }).parse(req.body);
      res.json(await putEvidence(uid(req), idParam(req), b));
    } catch (e) { fail(res, e); }
  });

  app.post(`${base}/requests/:id/submit`, requireAuth, async (req, res) => {
    try { res.json({ request: await submitRequest(uid(req), idParam(req)) }); } catch (e) { fail(res, e); }
  });
  app.post(`${base}/requests/:id/cancel`, requireAuth, async (req, res) => {
    try { res.json({ request: await cancelRequest(uid(req), idParam(req)) }); } catch (e) { fail(res, e); }
  });
  app.post(`${base}/requests/:id/new-code`, requireAuth, async (req, res) => {
    try { res.json({ request: await newCode(uid(req), idParam(req)) }); } catch (e) { fail(res, e); }
  });
  app.post(`${base}/requests/:id/live-join`, requireAuth, async (req, res) => {
    try { res.json(await liveJoin(uid(req), idParam(req))); } catch (e) { fail(res, e); }
  });
}
