import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ensureCsrfToken } from "@/lib/queryClient";
import { createBody, errorMessage, shouldPoll, type AgeReviewMe, type AgeReviewMethod, type AgeReviewRequest } from "@/lib/ageReview";

export const AGE_REVIEW_KEY = ["/api/age-review/me"] as const;
const POLL_MS = 20_000;

export class AgeReviewError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly retryAfter?: string | null) {
    super(errorMessage(code, { retryAfter }));
  }
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-csrf-token"] = await ensureCsrfToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
  if (!res.ok) {
    let j: { code?: string; retryAfter?: string } = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    throw new AgeReviewError(res.status, j.code, j.retryAfter);
  }
  return (await res.json()) as T;
}

/** `me` is null when the feature is off (the server answers 404): callers render nothing. */
export function useAgeReview() {
  const qc = useQueryClient();
  const me = useQuery<AgeReviewMe | null>({
    queryKey: AGE_REVIEW_KEY,
    queryFn: async () => {
      try { return await call<AgeReviewMe>("GET", "/api/age-review/me"); }
      catch (e) { if (e instanceof AgeReviewError && (e.status === 404 || e.status === 401)) return null; throw e; }
    },
    retry: false,
    staleTime: 15_000,
    refetchInterval: (q) => (shouldPoll(q.state.data) ? POLL_MS : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: AGE_REVIEW_KEY });
  const withRefresh = { onSettled: refresh };
  const req = (id: string, action: string) => call<{ request: AgeReviewRequest }>("POST", `/api/age-review/requests/${id}/${action}`);

  return {
    me: me.data ?? null,
    enabled: !!me.data,
    isLoading: me.isLoading,
    refresh,
    create: useMutation({
      mutationFn: (v: { method: AgeReviewMethod; documentType?: string; consentVersion: string; wantsPayouts?: boolean; legalName?: string }) => call<{ request: AgeReviewRequest }>("POST", "/api/age-review/requests", createBody(v)),
      ...withRefresh,
    }),
    // A plain function, not a mutation: TanStack would keep the base64 image in its mutation cache.
    uploadEvidence: (v: { id: string; kind: "document" | "selfie"; mime: string; data: string }) =>
      call<{ kind: string; received: true }>("POST", `/api/age-review/requests/${v.id}/evidence`, { kind: v.kind, mime: v.mime, data: v.data }),
    submit: useMutation({ mutationFn: (id: string) => req(id, "submit"), ...withRefresh }),
    cancel: useMutation({ mutationFn: (id: string) => req(id, "cancel"), ...withRefresh }),
    newCode: useMutation({ mutationFn: (id: string) => req(id, "new-code"), ...withRefresh }),
    liveJoin: useMutation({
      mutationFn: (id: string) => call<{ url: string; token: string; roomName: string }>("POST", `/api/age-review/requests/${id}/live-join`),
      onSettled: refresh,
    }),
  };
}
