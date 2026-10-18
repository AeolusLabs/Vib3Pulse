// Minors' rooms: a room whose host was under 18 when it was created. Adults get in only with a personal invite from the
// host (a row here, never a link) that they have acknowledged. The door rule itself is the shared canAdultEnterMinorsRoom.
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../storage";
import { roomAdultInvites, rooms, users, type Room, type User } from "@shared/schema";
import { canAdultEnterMinorsRoom, type Check } from "@shared/roomRules";
import { MINORS_ROOM_WARNING, type MinorsRoomCode } from "@shared/rooms";

export type InviteState = { invited: boolean; acknowledged: boolean };
export const NO_INVITE: InviteState = { invited: false, acknowledged: false };

/** The active (not revoked) invite of this user to this room. */
export async function getInviteState(roomId: string, userId: string): Promise<InviteState> {
  const [row] = await db.select({ ack: roomAdultInvites.acknowledgedAt }).from(roomAdultInvites)
    .where(and(eq(roomAdultInvites.roomId, roomId), eq(roomAdultInvites.userId, userId), isNull(roomAdultInvites.revokedAt))).limit(1);
  return row ? { invited: true, acknowledged: row.ack !== null } : { ...NO_INVITE };
}

/**
 * Creates the invite, or brings back a revoked one. A revoked invite that comes back must be acknowledged again (the old
 * acknowledgement belonged to the old invite); first_acknowledged_at is never touched here. An active invite is left as it is.
 */
export async function upsertInvite(roomId: string, userId: string, invitedBy: string): Promise<InviteState> {
  const [row] = await db.insert(roomAdultInvites).values({ roomId, userId, invitedBy }).onConflictDoUpdate({
    target: [roomAdultInvites.roomId, roomAdultInvites.userId],
    set: {
      invitedBy,
      createdAt: sql`CASE WHEN ${roomAdultInvites.revokedAt} IS NOT NULL THEN now() ELSE ${roomAdultInvites.createdAt} END`,
      acknowledgedAt: sql`CASE WHEN ${roomAdultInvites.revokedAt} IS NOT NULL THEN NULL ELSE ${roomAdultInvites.acknowledgedAt} END`,
      revokedAt: null,
    },
  }).returning({ ack: roomAdultInvites.acknowledgedAt });
  return { invited: true, acknowledged: row.ack !== null };
}

/** Marks the active invite revoked (the row and its acknowledgement time are kept). True if there was one. */
export async function revokeInvite(roomId: string, userId: string): Promise<boolean> {
  const rows = await db.update(roomAdultInvites).set({ revokedAt: new Date() })
    .where(and(eq(roomAdultInvites.roomId, roomId), eq(roomAdultInvites.userId, userId), isNull(roomAdultInvites.revokedAt)))
    .returning({ r: roomAdultInvites.roomId });
  return rows.length > 0;
}

/** Records the acknowledgement on the active invite; the first time is kept. Null when there is no active invite. */
export async function acknowledgeInvite(roomId: string, userId: string): Promise<Date | null> {
  const [row] = await db.update(roomAdultInvites).set({
    acknowledgedAt: sql`COALESCE(${roomAdultInvites.acknowledgedAt}, now())`,
    firstAcknowledgedAt: sql`COALESCE(${roomAdultInvites.firstAcknowledgedAt}, now())`, // evidence: the first time is kept forever
  })
    .where(and(eq(roomAdultInvites.roomId, roomId), eq(roomAdultInvites.userId, userId), isNull(roomAdultInvites.revokedAt)))
    .returning({ at: roomAdultInvites.acknowledgedAt });
  return row?.at ?? null;
}

/** Active invites of a room with the invited user's row (the caller sanitizes it). */
export async function listActiveInvites(roomId: string): Promise<Array<{ user: User; createdAt: Date; acknowledgedAt: Date | null }>> {
  const rows = await db.select({ user: users, createdAt: roomAdultInvites.createdAt, acknowledgedAt: roomAdultInvites.acknowledgedAt })
    .from(roomAdultInvites).innerJoin(users, eq(users.id, roomAdultInvites.userId))
    .where(and(eq(roomAdultInvites.roomId, roomId), isNull(roomAdultInvites.revokedAt)))
    .orderBy(roomAdultInvites.createdAt);
  return rows;
}

/** Rooms this user holds an active, acknowledged invite to (they may see these rooms in lists). */
export async function ackedRoomIdsFor(userId: string): Promise<Set<string>> {
  const rows = await db.select({ id: roomAdultInvites.roomId }).from(roomAdultInvites)
    .where(and(eq(roomAdultInvites.userId, userId), isNull(roomAdultInvites.revokedAt), isNotNull(roomAdultInvites.acknowledgedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Users holding an active, acknowledged invite to this room. */
export async function ackedInviteesOf(roomId: string): Promise<Set<string>> {
  const rows = await db.select({ id: roomAdultInvites.userId }).from(roomAdultInvites)
    .where(and(eq(roomAdultInvites.roomId, roomId), isNull(roomAdultInvites.revokedAt), isNotNull(roomAdultInvites.acknowledgedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Flags every room of this host that has not ended as a minors' room. One way: nothing ever clears the flag. */
export async function markHostRoomsMinors(hostId: string): Promise<Array<{ id: string; status: string }>> {
  return db.update(rooms).set({ minorsRoom: true })
    .where(and(eq(rooms.hostId, hostId), sql`${rooms.status} <> 'ended'`))
    .returning({ id: rooms.id, status: rooms.status });
}

/** The door, server side: the host is never stopped; everyone else goes through the shared rule. */
export function minorsGate(room: Pick<Room, "minorsRoom" | "hostId">, userId: string, age: number | null, invite: InviteState): Check<MinorsRoomCode> {
  if (userId === room.hostId) return { ok: true };
  return canAdultEnterMinorsRoom({ age }, room, invite);
}

/** The body every minors' room denial carries: the code and the one warning text, nothing about the room. */
export const minorsDenialBody = (code: MinorsRoomCode) => ({ code, message: MINORS_ROOM_WARNING, warning: MINORS_ROOM_WARNING, canJoin: { ok: false, code } });
