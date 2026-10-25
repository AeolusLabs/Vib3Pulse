// Request paths whose response bodies must never reach the request log (the selfie code, request details, evidence metadata).
export const NO_BODY_LOG_PREFIXES: readonly string[] = ["/api/age-review", "/api/admin/age-reviews"];

export function logsBody(path: string): boolean {
  return !NO_BODY_LOG_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}
