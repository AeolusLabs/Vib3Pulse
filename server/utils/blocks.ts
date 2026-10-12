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
