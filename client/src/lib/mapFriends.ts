// Friends on the map: the strip order, the search filter, and what the person's own marker shows. Pure, so it can be tested.
import { sanitizeAvatarConfig } from "@shared/avatar";

export interface StripFriend {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatar?: unknown;
  latitude: number;
  longitude: number;
  updatedAt: string;
}

export const friendLabel = (f: Pick<StripFriend, "displayName" | "username">) => f.displayName || f.username;

/** The first word of a name for the strip label: trimmed, never empty. */
export const firstName = (label: string): string => label.trim().split(/\s+/)[0] || "?";

function distanceKm(a: [number, number], lat: number, lng: number) {
  const r = Math.PI / 180;
  const dLat = (lat - a[0]) * r, dLng = (lng - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Nearest first when my position is known (equal distances keep their order), otherwise the most recently updated first. */
export function sortFriendsForStrip<T extends StripFriend>(friends: T[], me: [number, number] | null): T[] {
  const list = [...friends];
  if (me) return list.map((f, i) => ({ f, i, d: distanceKm(me, f.latitude, f.longitude) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.f);
  return list.map((f, i) => ({ f, i })).sort((a, b) => Date.parse(b.f.updatedAt) - Date.parse(a.f.updatedAt) || a.i - b.i).map((x) => x.f);
}

/** Case-insensitive match on display name or username; an empty or blank search returns everyone. */
export function filterFriends<T extends StripFriend>(friends: T[], needle: string): T[] {
  const n = needle.trim().toLowerCase();
  if (!n) return friends;
  return friends.filter((f) => friendLabel(f).toLowerCase().includes(n) || f.username.toLowerCase().includes(n));
}

/** What the person's own marker shows: their avatar pin, else their photo, else the plain dot. */
export function meMarkerKind(me: { avatar?: unknown; avatarUrl?: string | null } | undefined): "avatar" | "photo" | "dot" {
  if (!me) return "dot";
  if (sanitizeAvatarConfig(me.avatar)) return "avatar";
  return me.avatarUrl && me.avatarUrl.trim() ? "photo" : "dot";
}
