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
