/** Where a person's full profile lives. Prefers the username route; both segments are encoded so an odd name can't change the path. */
export function profilePath(m: { username?: string | null; userId: string }): string {
  const name = m.username?.trim();
  return name ? `/profile/${encodeURIComponent(name)}` : `/user/${encodeURIComponent(m.userId)}`;
}

/** Whether the peek may ask the server about this member. Anonymous members never qualify, whatever the caller says. */
export function shouldFetchProfile(member: { userId: string; anonymous?: boolean } | null | undefined, canViewProfile?: boolean): boolean {
  if (!member || !member.userId) return false;
  if (member.anonymous === true) return false;
  return canViewProfile !== false;
}

/** Room data wins; the fetched profile only fills fields the member lacks (a fetched null never erases a known avatar). */
export function fillMissing<T extends Record<string, any>>(member: T, fetched: Record<string, any> | null | undefined): T {
  const out: Record<string, any> = { ...member };
  for (const [k, v] of Object.entries(fetched ?? {})) {
    if (v == null) continue;
    if (out[k] == null || out[k] === "") out[k] = v;
  }
  return out as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the peek asks GET /api/users/:identifier for: the userId (the endpoint resolves UUIDs), else the username. */
export function peekIdentifier(m: { userId: string; username?: string | null }): string {
  if (UUID.test(m.userId)) return m.userId;
  return m.username?.trim() || m.userId;
}

/**
 * Opens a page in a new tab so the room (socket, voice, a host's live room) keeps running in this one.
 * With "noopener" the browser returns null whether or not the tab opened, so there is nothing to check here.
 */
export function openInNewTab(path: string, open: (url: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): void {
  open(path, "_blank", "noopener,noreferrer");
}
