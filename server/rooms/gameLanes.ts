// Gamers live (ROOMS_GAMING): age lanes. A game room with lanes is a PARENT row (never joinable, it only routes) with one
// child "lane" room per age group: "teen" (13-17, a minors' room hosted by a teen) and "adult" (18+). The lane comes only from
// the date of birth the server holds, never from the client. Each lane is an ordinary room with its own members, chat, spray,
// stage, game and counts, so every existing door rule (age limit, minors' room invite + warning, bans, locks) applies to it
// unchanged. Owner decision 2026-10-22: the teen lane's host is a teen; an adult reaches the teen lane only through the
// minors' room personal invite + acknowledged warning; nobody is routed into the other lane automatically.
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, storage } from "../storage";
import { rooms, type Room, type User } from "@shared/schema";
import { ageFromDob, minAgeForLimit, MIN_PLATFORM_AGE, type AgeLimit } from "@shared/age";
import type { SlowMode } from "@shared/rooms";
import * as rs from "./roomStorage";
import { getInviteState } from "./minorsRoom";
import type { CreateRoomInput } from "./roomStorage";

export type Lane = "teen" | "adult";

/** 13-17 teen, 18 and over adult; unknown or under the platform age: no lane (refused). */
export function laneForAge(age: number | null): Lane | null {
  if (age === null || age < MIN_PLATFORM_AGE) return null;
  return age < 18 ? "teen" : "adult";
}

/**
 * The age limit of a lane under a game room with this limit. An adult lane is 18+ (21+ when the room is). A teen lane keeps
 * the room's own limit; a room limited to 18+ or 21+ cannot have a teen lane (null).
 */
export function laneAgeLimit(parentLimit: AgeLimit, lane: Lane): AgeLimit | null {
  if (lane === "adult") return parentLimit === "21+" ? "21+" : "18+";
  return minAgeForLimit(parentLimit) >= 18 ? null : parentLimit;
}

/** The lanes of a game room (any status). Empty for a room that is not a lane parent. */
export async function laneChildren(parentId: string): Promise<Room[]> {
  return db.select().from(rooms).where(eq(rooms.parentRoomId, parentId));
}

/** Lanes of several game rooms at once (for the rooms list), keyed by parent id. Ended lanes are left out. */
export async function openLanesOf(parentIds: string[]): Promise<Map<string, Room[]>> {
  const out = new Map<string, Room[]>();
  if (!parentIds.length) return out;
  const rows = await db.select().from(rooms).where(and(inArray(rooms.parentRoomId, parentIds), ne(rooms.status, "ended")));
  for (const r of rows) { const k = r.parentRoomId!; out.set(k, [...(out.get(k) ?? []), r]); }
  return out;
}

/** A lane parent always has at least one lane: they are created together, in one transaction. */
export async function isLaneParent(roomId: string): Promise<boolean> {
  const [row] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.parentRoomId, roomId)).limit(1);
  return !!row;
}

export type LaneRefusal = "NO_AGE" | "TOO_YOUNG" | "NO_LANE";

/** Which lane of this game room the user goes to, from the date of birth on file. The other lane is never offered. */
export async function resolveLaneRoom(parentId: string, userId: string): Promise<{ roomId: string } | { refused: LaneRefusal }> {
  const user = await storage.getUser(userId);
  const age = ageFromDob(user?.dateOfBirth);
  if (age === null) return { refused: "NO_AGE" };
  const lane = laneForAge(age);
  if (!lane) return { refused: "TOO_YOUNG" };
  const child = (await laneChildren(parentId)).find((c) => c.ageLane === lane && c.status !== "ended");
  return child ? { roomId: child.id } : { refused: "NO_LANE" };
}

/** The lane this host runs under a game room (not ended), or null. */
export async function ownLane(parentId: string, hostId: string): Promise<Room | null> {
  return (await laneChildren(parentId)).find((c) => c.hostId === hostId && c.status !== "ended") ?? null;
}

/** The settings a lane copies from its game room (a stored row, or the create input). */
type LaneSource = {
  title: string; description?: string | null; kind: string; visibility: string; ageLimit: string; capacity?: number;
  noDirectInteractions?: boolean; pinnedMessage?: string | null; slowModeSec?: number; gameFormat?: number | null; gameDropTimeoutMs?: number;
};

/** The lane row for a game room: the same room settings, its own age limit and lane, never a ticket, never its own reminder. */
function laneInput(p: LaneSource, lane: Lane, extra: Partial<CreateRoomInput> = {}): CreateRoomInput {
  return {
    title: p.title, description: p.description ?? undefined, kind: p.kind as CreateRoomInput["kind"], visibility: p.visibility as CreateRoomInput["visibility"],
    ageLimit: laneAgeLimit(p.ageLimit as AgeLimit, lane)!, capacity: p.capacity, noDirectInteractions: p.noDirectInteractions ?? false,
    pinnedMessage: p.pinnedMessage ?? null, ...(p.slowModeSec !== undefined ? { slowModeSec: p.slowModeSec as SlowMode } : {}),
    gameFormat: p.gameFormat ?? null, gameDropTimeoutMs: p.gameDropTimeoutMs ?? 120_000,
    ageLane: lane, minorsRoom: lane === "teen",
    // scheduledFor is left out on purpose: the reminder is the game room's (one per person, linking to the game room).
    ...extra,
  };
}

export class LaneError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.reason ?? body.code)); }
}

/**
 * POST /api/rooms with gameFormat and `lanes: true`: the game room and the creator's own lane, in ONE transaction. The lane
 * is the creator's age group (a teen creates the teen lane, an adult the adult lane); the other lane is opened by a host of
 * that age (openLane). `input` is the validated create input (the route already ran the host checks).
 */
export async function createGameRoomWithLane(host: User, input: CreateRoomInput): Promise<{ parent: Room; lane: Room }> {
  const lane = laneForAge(ageFromDob(host.dateOfBirth));
  if (!lane) throw new LaneError(403, { message: "Add your date of birth in your profile to host rooms.", code: "AGE_UNKNOWN" });
  if (typeof input.ticketPriceKobo === "number") throw new LaneError(400, { message: "A game room with age lanes can't sell tickets.", field: "ticketPriceKobo", reason: "lanes" });
  if (!laneAgeLimit(input.ageLimit, lane)) throw new LaneError(400, { message: "Under 18s can't have a lane in an 18+ room.", field: "ageLimit", reason: "age_limit" });
  return db.transaction(async (tx) => {
    const parent = await rs.createRoom(host.id, input, tx);
    // The same invite link works for the creator's lane (an invite-only game room routes its link holders to their lane).
    // Spray is per lane and the lane is what runs the game; the create route already vetted this creator for spray.
    const child = await rs.createRoom(host.id, laneInput(input, lane, { parentRoomId: parent.id, inviteTokenHash: input.inviteTokenHash, screen: input.screen ?? null, sprayEnabled: input.sprayEnabled === true && lane === "adult" }), tx);
    return { parent, lane: child };
  });
}

/**
 * Opens the other lane of a game room. The host of a lane is of that lane's age (a teen for the teen lane: reason
 * "teen_host_required" otherwise), and is the game room's host or one of their mutual follows. An adult lane is never opened
 * under a minors' game room. A teen lane is never public (friends or invite, the teen host's choice).
 */
export async function openLane(parent: Room, requester: User, lane: Lane, visibility: "public" | "friends" | "invite", mutual: boolean, inviteTokenHash?: string): Promise<Room> {
  const band = laneForAge(ageFromDob(requester.dateOfBirth));
  if (band !== lane) throw new LaneError(403, { message: lane === "teen" ? "The teen lane is hosted by someone under 18." : "The adult lane is hosted by someone 18 or over.", code: "NOT_ALLOWED", reason: lane === "teen" ? "teen_host_required" : "adult_host_required" });
  if (parent.hostId !== requester.id && !mutual) throw new LaneError(403, { message: "Only the host or their friends can open a lane.", code: "NOT_ALLOWED" });
  if (parent.status === "ended") throw new LaneError(409, { message: "This room has ended.", code: "ROOM_ENDED" });
  if (lane === "adult" && parent.minorsRoom) throw new LaneError(403, { message: "This game room is for under 18s.", code: "NOT_ALLOWED", reason: "minors_parent" });
  const ageLimit = laneAgeLimit(parent.ageLimit as AgeLimit, lane);
  if (!ageLimit) throw new LaneError(409, { message: "Under 18s can't have a lane in an 18+ room.", code: "BAD_STATE", reason: "age_limit" });
  if ((await laneChildren(parent.id)).some((c) => c.ageLane === lane && c.status !== "ended")) throw new LaneError(409, { message: "That lane is already open.", code: "LANE_EXISTS" });
  return rs.createRoom(requester.id, laneInput(parent, lane, { parentRoomId: parent.id, visibility, inviteTokenHash }));
}

/**
 * A lane ended: when no lane of its game room is live any more, the game room ends too and lanes that never started are
 * cancelled (a game room with nothing live must not keep showing as live). Never throws.
 */
export async function afterLaneEnded(parentId: string): Promise<void> {
  try {
    const lanes = await laneChildren(parentId);
    if (lanes.some((c) => c.status === "live")) return;
    for (const c of lanes) if (c.status === "scheduled") await rs.cancelScheduledRoom(c.id);
    const parent = await rs.getRoom(parentId);
    if (parent && parent.status !== "ended") await rs.setStatus(parentId, "ended");
  } catch (e) {
    console.error("[rooms:lanes] ending the game room after its last lane failed:", parentId, e instanceof Error ? e.message : e);
  }
}

/** A lane went live: its game room is live too (once). Returns the game room row. */
export async function startParentOf(lane: Room): Promise<Room | null> {
  if (!lane.parentRoomId) return null;
  return (await rs.startScheduledRoom(lane.parentRoomId)) ?? (await rs.getRoom(lane.parentRoomId));
}

/**
 * May this person see anything about this lane by its own id (room page, member actions)? Their own age group's lane, or the
 * teen lane for an adult holding an active, acknowledged personal invite to it (the minors' room path). Any other room: true.
 * A direct lane id must never show someone the other lane's people or counts.
 */
export async function mayUseLane(room: Pick<Room, "id" | "parentRoomId" | "ageLane" | "hostId">, userId: string): Promise<boolean> {
  if (!room.parentRoomId || !room.ageLane || room.hostId === userId) return true;
  const lane = laneForAge(ageFromDob((await storage.getUser(userId))?.dateOfBirth));
  if (lane === room.ageLane) return true;
  if (room.ageLane === "teen" && lane === "adult") return (await getInviteState(room.id, userId)).invited;
  return false;
}
