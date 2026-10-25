// Shared by the REST routes and the WebSocket handlers so both answer "who may see / enter this room" the same way.
import crypto from "crypto";
import { and, inArray } from "drizzle-orm";
import { db, storage } from "../storage";
import { sanitizeTextOnly } from "../security";
import { toPublicUser } from "../auth";
import { isBlockedEitherWay } from "../utils/blocks";
import { follows, type Room, type User } from "@shared/schema";
import { ageFromDob } from "@shared/age";
import { cutPinned, stripInvisible, type MinorsRoomCode } from "@shared/rooms";
import * as rs from "./roomStorage";
import { roomFeatures } from "./features";
import { getInviteState, minorsGate, NO_INVITE } from "./minorsRoom";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * User-typed text that React will render as text. sanitizeTextOnly strips tags but leaves entities escaped
 * (`R&B` -> `R&amp;B`), which would show literally, so decode the five it produces. Then bidi overrides, zero-width
 * characters and control characters are removed (stripInvisible), so a title, description, pinned message or chat line
 * can never reorder or hide text.
 */
export function plainText(input: string): string {
  return stripInvisible(sanitizeTextOnly(input).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")).trim();
}

export function hostSummary(u: User) {
  const p = toPublicUser(u);
  return {
    id: p.id, username: p.username, displayName: p.displayName, organizationName: p.organizationName,
    avatarUrl: p.avatarUrl, avatar: p.avatar ?? null, isVerified: p.isVerified, isOfficial: p.isOfficial,
  };
}

/** A pinned message as stored: plain text (tags stripped, never HTML), cut to ROOM_LIMITS.pinned; null when empty. */
export function pinnedPlainText(raw: string | null | undefined): string | null {
  return typeof raw === "string" ? cutPinned(plainText(raw)) : null;
}

/**
 * A room row as lists and cards show it: never the invite hash, and never the pinned message (that is for people who may
 * view the room: use viewerRoom there).
 */
export function publicRoom(room: Room) {
  // Paid rooms: the price, ticket capacity and refund setting never ride on a room object. The price reaches only eligible
  // viewers (GET /api/rooms/:id `ticket`, list `priceMinor`); the host gets all three through hostRoom.
  // peakMembers is a host-only recap number (phase 6): it reaches the host only through GET /api/rooms/:id/recap.
  // Gaming columns never ride on a room object either (so a flag-off payload is exactly what it was before they existed): the
  // host gets gameFormat / gameDropTimeoutMs (and sprayEnabled, anyone else learns spray from the `spray` block) through hostRoom, a lane's own members get their lane through viewerRoom.
  const { inviteTokenHash, pinnedMessage, reminderNotifiedAt, ticketPriceKobo, ticketCapacity, refundBeforeStart, peakMembers, sprayEnabled, sprayAdminBlocked, sprayBlockReason, sprayBlockedBy, sprayBlockedAt, gameFormat, gameDropTimeoutMs, ageLane, parentRoomId, ...rest } = room;
  return rest;
}

/** For someone who may view the room (GET /api/rooms/:id after viewRoom, room:state, the host's own writes): adds the pinned message. */
export function viewerRoom(room: Room) {
  return {
    ...publicRoom(room), pinnedMessage: room.pinnedMessage ?? null,
    // Gaming: someone who may view a lane room learns which lane it is and its game room (their own lane only).
    ...(roomFeatures.gaming && room.ageLane ? { ageLane: room.ageLane, parentRoomId: room.parentRoomId } : {}),
  };
}

/** The host's own view of their room (create, PATCH and GET by the host): the viewer room plus the ticket settings. */
export function hostRoom(room: Room) {
  return {
    ...viewerRoom(room), ticketPriceKobo: room.ticketPriceKobo ?? null, ticketCapacity: room.ticketCapacity ?? null, refundBeforeStart: room.refundBeforeStart !== false,
    sprayEnabled: room.sprayEnabled === true,
    // Only the host learns an admin switched spraying off for the room (never the admin id or time).
    // The admin's internal reason never leaves the server. With ROOMS_SPRAY off the key is absent (the payload is what it always was).
    ...(roomFeatures.spray ? { sprayAdminBlocked: room.sprayAdminBlocked === true } : {}),
    ...(roomFeatures.gaming ? { gameFormat: room.gameFormat ?? null, gameDropTimeoutMs: room.gameDropTimeoutMs } : {}),
  };
}

export async function mutualFollow(a: string, b: string): Promise<boolean> {
  const rows = await db.select({ f: follows.followerId, t: follows.followingId }).from(follows)
    .where(and(inArray(follows.followerId, [a, b]), inArray(follows.followingId, [a, b])));
  return rows.some((r) => r.f === a && r.t === b) && rows.some((r) => r.f === b && r.t === a);
}

/** Visibility by the room's own setting, before the minors' room door. A personal adult invite counts like membership. */
async function visibleBySetting(room: Room, viewerId: string, token: string | undefined, personallyInvited: boolean): Promise<boolean> {
  if (personallyInvited) return true;
  if (room.visibility === "public") return true;
  if (room.visibility === "friends") return mutualFollow(viewerId, room.hostId);
  const member = await rs.getMember(room.id, viewerId);
  if (member && !member.banned) return true;
  return !!token && !!room.inviteTokenHash && sha256(token) === room.inviteTokenHash;
}

export type RoomView = { ok: true } | { ok: false; code: "NOT_FOUND" | "AGE_UNKNOWN" | MinorsRoomCode };

/**
 * Who may see this room, and if not, what they are told. NOT_FOUND for unknown, invisible or blocked (indistinguishable).
 * In a minors' room, someone who could otherwise see it but is not let in gets AGE_UNKNOWN (no birthdate) or a minors' room
 * code (adult without an acknowledged personal invite): never the title, host or members.
 */
export async function viewRoom(room: Room, viewerId: string, token?: string): Promise<RoomView> {
  if (room.hostId === viewerId) return { ok: true };
  if (await isBlockedEitherWay(viewerId, room.hostId)) return { ok: false, code: "NOT_FOUND" };
  if (!room.minorsRoom) return (await visibleBySetting(room, viewerId, token, false)) ? { ok: true } : { ok: false, code: "NOT_FOUND" };
  const [viewer, stored, member] = await Promise.all([storage.getUser(viewerId), getInviteState(room.id, viewerId), rs.getMember(room.id, viewerId)]);
  const invite = member?.banned ? NO_INVITE : stored; // a ban outranks an old invite: it no longer shows or opens anything
  if (!(await visibleBySetting(room, viewerId, token, invite.invited))) return { ok: false, code: "NOT_FOUND" };
  const age = ageFromDob(viewer?.dateOfBirth);
  if (age === null) return { ok: false, code: "AGE_UNKNOWN" };
  const g = minorsGate(room, viewerId, age, invite);
  return g.ok ? { ok: true } : g;
}

/**
 * Can this viewer see the room (its title, host, members)? Invisible rooms answer 404 / NOT_FOUND, same as unknown ones.
 * An adult without an acknowledged invite to a minors' room gets false here, so every endpoint built on this treats the
 * room as not found; only GET /api/rooms/:id and room:join use viewRoom to show the warning instead.
 */
export async function canViewRoom(room: Room, viewerId: string, token?: string): Promise<boolean> {
  return (await viewRoom(room, viewerId, token)).ok;
}
