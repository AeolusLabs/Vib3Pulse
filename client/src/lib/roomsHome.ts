// Pure helpers for the Rooms home: cover colour from a room id, filter application, card labels, fixture data. No network here.
import type { RoomKind } from "@shared/rooms";
import type { PeekMember, RoomScope, RoomView } from "@/lib/roomsApi";

/** Room as the list returns it. `priceMinor` only exists once paid rooms ship; today it is always absent. */
export type HomeRoom = RoomView & { priceMinor?: number | null };

/** FNV-1a, 32 bit. Stable across sessions and devices, which is the whole point of a cover colour. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Violet-family only (single accent rule): hue stays in the violet to indigo to plum band, lightness and saturation vary.
const COVER_PALETTE: readonly { hue: number; sat: number }[] = [
  { hue: 262, sat: 58 }, { hue: 270, sat: 50 }, { hue: 278, sat: 62 }, { hue: 286, sat: 46 },
  { hue: 254, sat: 54 }, { hue: 294, sat: 42 }, { hue: 266, sat: 66 }, { hue: 248, sat: 48 },
];

export interface CoverColour { from: string; to: string }

export function coverColour(id: string): CoverColour {
  const h = hashId(id);
  const p = COVER_PALETTE[h % COVER_PALETTE.length];
  const light = 30 + ((h >>> 8) % 12); // 30 to 41
  const shift = 14 + ((h >>> 16) % 14); // second stop hue offset, 14 to 27
  return { from: `hsl(${p.hue} ${p.sat}% ${light}%)`, to: `hsl(${p.hue + shift} ${p.sat}% ${Math.max(light - 14, 12)}%)` };
}

export type PriceFilter = "any" | "free" | "paid";
export interface HomeFilters { kinds: RoomKind[]; friendsInside: boolean; price: PriceFilter }
export const NO_FILTERS: HomeFilters = { kinds: [], friendsInside: false, price: "any" };

export function activeFilterCount(f: HomeFilters, paidRoomsOn: boolean): number {
  return (f.kinds.length ? 1 : 0) + (f.friendsInside ? 1 : 0) + (paidRoomsOn && f.price !== "any" ? 1 : 0);
}

/**
 * People in the room's peek list whom the viewer follows (one-way follows, not the mutual "Friends" tab).
 * The peek is only the first few people the server sends (5 at most), so someone later in a big room is not seen here.
 * Both the "People you follow inside" filter and the card line share this limit; widening it needs a server change.
 * The viewer themself never counts.
 */
export function friendsInside(peek: readonly PeekMember[] | undefined, friendIds: ReadonlySet<string>, selfId?: string | null): PeekMember[] {
  return (peek ?? []).filter((p) => p.userId !== selfId && friendIds.has(p.userId));
}

export function applyFilters(rooms: readonly HomeRoom[], f: HomeFilters, opts: { friendIds: ReadonlySet<string>; selfId?: string | null; paidRoomsOn: boolean }): HomeRoom[] {
  return rooms.filter((r) => {
    if (f.kinds.length && !f.kinds.includes(r.kind)) return false;
    if (f.friendsInside && friendsInside(r.peek, opts.friendIds, opts.selfId).length === 0) return false;
    if (opts.paidRoomsOn && f.price !== "any") {
      const paid = typeof r.priceMinor === "number" && r.priceMinor > 0;
      if (f.price === "paid" && !paid) return false;
      if (f.price === "free" && paid) return false;
    }
    return true;
  });
}

/** Age tag on a card: "All ages", "13+", "18+" and so on. */
export function ageTagLabel(limit: string): string {
  return limit === "all" ? "All ages" : limit;
}

/** The price chip placeholder shows only with the flag on AND an 18+/21+ room (money never sits on a room open to teens). */
export function showPriceChip(room: Pick<HomeRoom, "ageLimit" | "minorsRoom">, paidRoomsOn: boolean): boolean {
  return paidRoomsOn && !room.minorsRoom && (room.ageLimit === "18+" || room.ageLimit === "21+");
}

export function peopleLabel(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** One sentence naming the card for a screen reader. `when` is the start time text for a room that has not started. */
export function cardLabel(room: Pick<HomeRoom, "title" | "kind" | "status" | "ageLimit" | "memberCount">, hostLabel: string, kindLabel: string, friendNames: readonly string[], when?: string): string {
  const parts = [room.title, `hosted by ${hostLabel}`, kindLabel, ageTagLabel(room.ageLimit)];
  parts.push(room.status === "live" ? `live, ${peopleLabel(room.memberCount ?? 0)} inside` : (when ? `not started yet, starts ${when}` : "not started yet"));
  if (friendNames.length) parts.push(`${friendNames.slice(0, 2).join(" and ")} inside`);
  return parts.join(", ");
}

export const TAB_COPY: Record<RoomScope, { label: string; empty: string; emptyFiltered: string }> = {
  live: { label: "Live", empty: "Quiet right now", emptyFiltered: "No live rooms match these filters." },
  upcoming: { label: "Upcoming", empty: "Nothing is scheduled yet", emptyFiltered: "No upcoming rooms match these filters." },
  // The server's `friends` scope is MUTUAL followers: people you follow who follow you back.
  friends: { label: "Friends", empty: "None of your friends are in a room", emptyFiltered: "No rooms from your friends match these filters." },
};

export const TAB_ORDER: readonly RoomScope[] = ["live", "upcoming", "friends"];

/** The tab an arrow, Home or End key moves to; null for any other key. Wraps at the ends. */
export function nextTab(current: RoomScope, key: string): RoomScope | null {
  const i = TAB_ORDER.indexOf(current);
  if (key === "ArrowRight") return TAB_ORDER[(i + 1) % TAB_ORDER.length];
  if (key === "ArrowLeft") return TAB_ORDER[(i - 1 + TAB_ORDER.length) % TAB_ORDER.length];
  if (key === "Home") return TAB_ORDER[0];
  if (key === "End") return TAB_ORDER[TAB_ORDER.length - 1];
  return null;
}

// ---- DEV fixture (?home=live|empty), no network. Fake people only.
const fixPerson = (n: number): PeekMember => ({ userId: `fx-u${n}`, role: n === 1 ? "host" : "guest", username: `fixture${n}`, displayName: ["Ada", "Tolu", "Mira", "Kemi", "Jo"][n - 1] ?? `Guest ${n}`, avatarUrl: null, avatar: null });
const fixRoom = (i: number, over: Partial<HomeRoom>): HomeRoom => ({
  id: `fixture-home-${i}`, hostId: `fx-u${i}`, title: "Fixture room", description: null, kind: "party", visibility: "public", ageLimit: "all", capacity: 50,
  status: "live", scheduledFor: null, startedAt: null, endedAt: null, screen: null, eventId: null, venueId: null, noDirectInteractions: false,
  memberCount: 3, peek: [1, 2, 3].map(fixPerson),
  host: { id: `fx-u${i}`, username: `fixture${i}`, displayName: fixPerson(i).displayName, organizationName: null, avatarUrl: null, avatar: null, isVerified: false, isOfficial: false },
  ...over,
});
export function fixtureHome(name: string | null): Record<RoomScope, HomeRoom[]> | null {
  if (name === "empty") return { live: [], upcoming: [], friends: [] };
  if (name !== "live") return null;
  return {
    live: [
      fixRoom(1, { title: "Sunday sunset session", kind: "listening", memberCount: 24, ageLimit: "18+" }),
      fixRoom(2, { title: "Open mic warm up", kind: "talk", memberCount: 7 }),
      fixRoom(3, { title: "A very long room title that has to be cut off cleanly at 320 pixels wide", kind: "party", memberCount: 1, peek: [fixPerson(3)] }),
    ],
    upcoming: [fixRoom(4, { title: "Friday listening party", kind: "listening", status: "scheduled", scheduledFor: "2026-10-23T19:00:00.000Z", memberCount: 0, peek: [] })],
    friends: [fixRoom(5, { title: "Late night talk", kind: "talk", memberCount: 4 })],
  };
}
export const FIXTURE_FRIEND_IDS: ReadonlySet<string> = new Set(["fx-u2"]);
