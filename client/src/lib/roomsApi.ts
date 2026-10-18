// Types and small helpers shared by the rooms pages. Rules (age, interactions, screen parsing) come from @shared.
import type { AgeLimit } from "@shared/age";
import type { Screen } from "@shared/screen";
import { MINORS_ROOM_WARNING, type RoomKind, type RoomVisibility, type ROOM_LIMITS } from "@shared/rooms";
import { useQuery } from "@tanstack/react-query";

export interface RoomHostSummary {
  id: string;
  username: string;
  displayName: string | null;
  organizationName: string | null;
  avatarUrl: string | null;
  avatar: unknown;
  isVerified: boolean | null;
  isOfficial: boolean | null;
}

/** Who is in a live room, as the list and lobby see it: public profile bits and a role, never an age. */
export interface PeekMember {
  userId: string;
  role: "host" | "cohost" | "guest";
  username: string | null;
  displayName: string | null;
  organizationName?: string | null;
  avatarUrl: string | null;
  avatar: unknown;
}

/** Link screens (YouTube, Vimeo, music links) are switched off for now; live streaming replaces them. Mirrors server/rooms/features.ts. */
export const LINK_SCREENS = false;

export interface RoomView {
  id: string;
  hostId: string;
  title: string;
  description: string | null;
  kind: RoomKind;
  visibility: RoomVisibility;
  ageLimit: AgeLimit;
  capacity: number;
  status: "scheduled" | "live" | "ended";
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  screen: Screen | null;
  eventId: string | null;
  venueId: string | null;
  noDirectInteractions: boolean;
  /** Hosted by someone under 18 when it was made. Adults without access never receive a room object, so they never see this. */
  minorsRoom?: boolean;
  liveVideo?: boolean;
  /** Only when the server already says so for this viewer; never assumed. */
  reminder?: boolean;
  peakCount?: number | null;
  memberCount?: number;
  peek?: PeekMember[];
  host: RoomHostSummary | null;
}

export type RoomScope = "live" | "upcoming" | "friends";

export const KIND_LABEL: Record<RoomKind, string> = { party: "Party", listening: "Listening", talk: "Talk", event: "Event" };
export const VISIBILITY_LABEL: Record<RoomVisibility, string> = { public: "Public", friends: "Friends", invite: "Invite only" };

export const ageLimitLabel = (l: AgeLimit) => (l === "all" ? "All ages" : l);

export const hostName = (h: Pick<RoomHostSummary, "displayName" | "organizationName" | "username"> | null) => h?.displayName || h?.organizationName || h?.username || "Host";

export const PROVIDER_LABEL: Record<string, string> = {
  youtube: "YouTube", vimeo: "Vimeo", spotify: "Spotify", apple_music: "Apple Music", soundcloud: "SoundCloud", image: "Image", link: "Link",
};

export async function fetchRooms(scope: RoomScope, extra: { eventId?: string; venueId?: string } = {}): Promise<RoomView[]> {
  const q = new URLSearchParams({ scope });
  if (extra.eventId) q.set("eventId", extra.eventId);
  if (extra.venueId) q.set("venueId", extra.venueId);
  const res = await fetch(`/api/rooms?${q}`, { credentials: "include" });
  if (!res.ok) throw new Error("Couldn't load rooms");
  return (await res.json()).rooms as RoomView[];
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Shown to guests when a live room closes because its host's account is being reviewed (neutral, no accusation). */
export const HOST_REVIEW_COPY = "This room has closed because the host's account is being reviewed.";
/** Someone already inside no longer meets the room's age limit (their birthdate was corrected). */
export const AGE_LIMIT_EVICTED_COPY = "You no longer meet this room's age limit.";

/** Message for a join/read refusal code from the server. Never mentions anyone's age. */
export const DENIED_MESSAGE: Record<string, string> = {
  AGE_LIMIT: "This room has an age limit.",
  AGE_UNKNOWN: "Add your date of birth in your profile to join rooms.",
  BANNED: "You can't join this room.",
  BLOCKED: "You can't join this room.",
  KICKED: "The host removed you from this room. You can try again in 10 minutes.",
  NOT_FOUND: "This room isn't available.",
  ROOM_FULL: "This room is full right now. Try again in a moment.",
  ROOM_ENDED: "This room has ended.",
  ROOM_LOCKED: "The host has locked this room. Ask them to let you in.",
  ROOM_NOT_LIVE: "This room hasn't started yet.",
  // Minors' rooms: even a path that falls back to this table shows the one warning, never a room name or a host.
  MINORS_ROOM: MINORS_ROOM_WARNING,
  MINORS_ROOM_ACK: MINORS_ROOM_WARNING,
};

export const NOTICE_MESSAGE: Record<string, string> = {
  RATE_LIMITED: "Slow down a little.",
  MUTED: "The host has muted you.",
  PRIVACY: "That person isn't taking this kind of interaction.",
  AGE_BAND: "That isn't available between these accounts.",
  ROOM_NO_DIRECT: "This room has direct interactions turned off.",
  TARGET_GONE: "They've left the room.",
  FORBIDDEN: "You can't do that.",
  INVALID_SCREEN: "That link can't be shown on the screen.",
  NOT_IN_ROOM: "You're not in the room.",
  VOICE_OFF: "Voice isn't on in this room.",
  STAGE_FULL: "The stage is full.",
  NOT_ELIGIBLE: "You can't speak in this room right now.",
  BAD_STATE: "That isn't possible right now.",
  BAD_REQUEST: "That didn't work.",
  HOST_REVIEW: HOST_REVIEW_COPY,
};

/** Public switches and limits from GET /api/rooms/config. */
export interface RoomsConfig {
  features: { paidRooms: boolean; spray: boolean };
  limits: typeof ROOM_LIMITS;
  currency: "NGN";
  region: "NG";
}

export async function fetchRoomsConfig(): Promise<RoomsConfig> {
  const res = await fetch("/api/rooms/config", { credentials: "include" });
  if (!res.ok) throw new Error("Couldn't load rooms settings");
  return (await res.json()) as RoomsConfig;
}

export function useRoomsConfig() {
  return useQuery({ queryKey: ["/api/rooms/config"], queryFn: fetchRoomsConfig, staleTime: 5 * 60 * 1000 });
}
