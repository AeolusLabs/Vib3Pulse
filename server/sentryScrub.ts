// Nothing a request carried (bodies with photos or birthdates, cookies, auth headers) may leave the server inside a Sentry event.
export function scrubSentryEvent<T extends { request?: { data?: unknown; cookies?: unknown; headers?: Record<string, unknown>; query_string?: unknown } | undefined; user?: unknown }>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    const h = event.request.headers;
    if (h) for (const k of Object.keys(h)) if (/^(authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|proxy-authorization)$/i.test(k)) delete h[k];
  }
  return event;
}
