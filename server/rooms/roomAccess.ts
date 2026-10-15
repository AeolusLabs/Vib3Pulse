// Shared by the REST routes and the WebSocket handlers so both answer "who may see / enter this room" the same way.
import crypto from "crypto";
import { and, inArray } from "drizzle-orm";
import { db } from "../storage";
import { sanitizeTextOnly } from "../security";
import { toPublicUser } from "../auth";
import { isBlockedEitherWay } from "../utils/blocks";
import { follows, type Room, type User } from "@shared/schema";
import * as rs from "./roomStorage";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * User-typed text that React will render as text. sanitizeTextOnly strips tags but leaves entities escaped
 * (`R&B` -> `R&amp;B`), which would show literally, so decode the five it produces.
 */
export function plainText(input: string): string {
  return sanitizeTextOnly(input).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}

export function hostSummary(u: User) {
  const p = toPublicUser(u);
  return {
    id: p.id, username: p.username, displayName: p.displayName, organizationName: p.organizationName,
    avatarUrl: p.avatarUrl, avatar: p.avatar ?? null, isVerified: p.isVerified, isOfficial: p.isOfficial,
  };
}

/** A room row as the API shows it: never the invite hash. */
export function publicRoom(room: Room) {
  const { inviteTokenHash, ...rest } = room;
  return rest;
}

export async function mutualFollow(a: string, b: string): Promise<boolean> {
  const rows = await db.select({ f: follows.followerId, t: follows.followingId }).from(follows)
    .where(and(inArray(follows.followerId, [a, b]), inArray(follows.followingId, [a, b])));
  return rows.some((r) => r.f === a && r.t === b) && rows.some((r) => r.f === b && r.t === a);
}

/** Can this viewer see that the room exists at all? Invisible rooms answer 404 / NOT_FOUND, same as unknown ones. */
export async function canViewRoom(room: Room, viewerId: string, token?: string): Promise<boolean> {
  if (room.hostId === viewerId) return true;
  if (await isBlockedEitherWay(viewerId, room.hostId)) return false;
  if (room.visibility === "public") return true;
  if (room.visibility === "friends") return mutualFollow(viewerId, room.hostId);
  const member = await rs.getMember(room.id, viewerId);
  if (member && !member.banned) return true;
  return !!token && !!room.inviteTokenHash && sha256(token) === room.inviteTokenHash;
}
