// Fetch helpers for the reviewer API. Plain functions, no query cache: nothing returned here from the evidence routes is kept.
import { ensureCsrfToken } from "@/lib/queryClient";
import { adminErrorMessage, secondApproveBody, urlUnlessCancelled, type Checklist } from "@/lib/adminAgeReviewUi";

export class ReviewApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly retryAfter?: string | null) {
    super(adminErrorMessage(code, { retryAfter }));
  }
}

async function parseError(res: Response): Promise<ReviewApiError> {
  let j: { code?: string; retryAfter?: string } = {};
  try { j = await res.json(); } catch { /* not JSON */ }
  return new ReviewApiError(res.status, j.code, j.retryAfter);
}

export async function reviewCall<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-csrf-token"] = await ensureCsrfToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const errText = (e: unknown): string => (e instanceof ReviewApiError ? e.message : adminErrorMessage(undefined));

export interface QueueItem {
  id: string; createdAt: string; submittedAt: string | null; method: "upload" | "live"; status: string; userId: string;
  displayName: string; documentType: string | null; registeredAge: number | null; needsMore: boolean; awaitingSecondApproval: boolean;
}
export interface Detail {
  request: QueueItem & { registeredDob: string; proposedDob?: string | null; code: string | null; codeExpiresAt: string | null; moreRequests: number; consentRecorded: boolean; liveInviteExpiresAt: string | null };
  evidence: { id: string; kind: "document" | "selfie"; mime: string; bytes: number }[];
  checklist: string[];
  canDecide: boolean;
  canSecondApprove: boolean;
}
export interface Health {
  paused: boolean; pendingEvidence: number; staleEvidence: number; oldestEvidenceAgeHours: number | null; lastSweepAt: string | null;
  revealsToday: { reviewer: string; count: number }[];
}

export const listQueue = (status: string, cursor?: string) => {
  const p = new URLSearchParams({ limit: "25" });
  if (status) p.set("status", status);
  if (cursor) p.set("cursor", cursor);
  return reviewCall<{ items: QueueItem[]; nextCursor: string | null }>("GET", `/api/admin/age-reviews?${p}`);
};
export const getDetail = (id: string) => reviewCall<Detail>("GET", `/api/admin/age-reviews/${id}`);
export const decide = (id: string, body: Record<string, unknown> & { checklist: Checklist }) => reviewCall<{ request: QueueItem }>("POST", `/api/admin/age-reviews/${id}/decide`, body);
export const secondApprove = (id: string, approve: boolean, reason: string, overrideReason = "") =>
  reviewCall<{ request: QueueItem }>("POST", `/api/admin/age-reviews/${id}/second-approve`, secondApproveBody(approve, reason, { allowed: overrideReason.trim().length > 0, reason: overrideReason }));
export const inviteLive = (id: string) => reviewCall<{ expiresAt: string }>("POST", `/api/admin/age-reviews/${id}/invite-live`);
export const liveJoin = (id: string) => reviewCall<{ url: string; token: string; roomName: string }>("POST", `/api/admin/age-reviews/${id}/live-join`);
export const getHealth = () => reviewCall<Health>("GET", "/api/admin/age-reviews/health");
export const setPause = (on: boolean, reason: string) => reviewCall<{ paused: boolean; changed: boolean }>("POST", "/api/admin/age-reviews/pause", { on, reason });
export const emergencyPurge = (reason: string) => reviewCall<{ deleted: number }>("POST", "/api/admin/age-reviews/emergency-purge", { reason });
export const markVerified = (userId: string, verified: boolean, reason: string) => reviewCall<unknown>("POST", `/api/admin/users/${userId}/age-verification`, { verified, reason });
export const revokeVerification = (userId: string, reason: string) => reviewCall<unknown>("POST", `/api/admin/users/${userId}/age-verification/revoke`, { reason });

/** Reveal, then fetch the bytes with the one time token. Returns a blob URL the caller must revoke. The URL with the token is never put in the DOM. */
export async function revealEvidence(requestId: string, evidenceId: string, cancelled: () => boolean = () => false): Promise<string | null> {
  const base = `/api/admin/age-reviews/${requestId}/evidence/${evidenceId}`;
  const { token } = await reviewCall<{ token: string; expiresInSec: number }>("POST", `${base}/reveal`);
  const res = await fetch(`${base}?token=${encodeURIComponent(token)}`, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw await parseError(res);
  return urlUnlessCancelled(await res.blob(), cancelled, (b) => URL.createObjectURL(b));
}
