import { and, eq, or } from "drizzle-orm";
import { db } from "../storage";
import { userBlocks } from "@shared/schema";

// Ids of everyone the user has blocked OR who has blocked the user. Blocks are symmetric in effect.
export async function blockedWith(userId: string): Promise<Set<string>> {
  const rows = await db.select().from(userBlocks)
    .where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const [row] = await db.select({ blockerId: userBlocks.blockerId }).from(userBlocks)
    .where(or(
      and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
      and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
    )).limit(1);
  return !!row;
}

/**
 * The one profile-visibility rule. A signed-in viewer may not read a profile when either side has blocked the other, and the
 * routes then answer exactly as for a user who does not exist (same 404 and body) for those viewers. This is not a full
 * invisibility guarantee: signed-out visitors can still read public profiles, and the follow route answers a blocked pair
 * with 403 rather than 404. Signed-out viewers and the user themself are never blocked here. The blocker who wants to undo it does not need the profile:
 * unblocking goes by id through GET /api/blocks (the Account settings list) and DELETE /api/blocks/:userId.
 */
export async function profileBlocked(viewerId: string | undefined | null, targetId: string): Promise<boolean> {
  if (!viewerId || viewerId === targetId) return false;
  return isBlockedEitherWay(viewerId, targetId);
}
