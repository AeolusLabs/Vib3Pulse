/** Where a person's full profile lives. Prefers the username route; both segments are encoded so an odd name can't change the path. */
export function profilePath(m: { username?: string | null; userId: string }): string {
  const name = m.username?.trim();
  return name ? `/profile/${encodeURIComponent(name)}` : `/user/${encodeURIComponent(m.userId)}`;
}
