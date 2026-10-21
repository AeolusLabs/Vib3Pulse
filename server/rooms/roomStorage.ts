// Durable room data. Live presence is NOT here (see RoomHub). All visibility rules for listings live in listRooms.
import { and, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db, pool } from "../storage";
import { follows, roomMembers, roomReminders, rooms, users, type Room, type RoomMember } from "@shared/schema";
import type { RoomInput } from "@shared/rooms";
import type { Screen } from "@shared/screen";
import type { NowPlaying } from "@shared/playback";
import { ageFromDob } from "@shared/age";
import { blockedWith } from "../utils/blocks";
import { ackedRoomIdsFor } from "./minorsRoom";
import { NEVER_JOINED } from "./roomLock";

export type RoomStatus = "scheduled" | "live" | "ended";
export type MemberRole = "host" | "cohost" | "guest";

/**
 * minorsRoom is decided by the route from the host's age, never taken from client input. Gaming (ROOMS_GAMING): gameFormat
 * and gameDropTimeoutMs come from the validated request; ageLane and parentRoomId only from gameLanes.ts.
 */
export type CreateRoomInput = RoomInput & {
  screen?: Screen | null; inviteTokenHash?: string; minorsRoom?: boolean;
  gameFormat?: number | null; gameDropTimeoutMs?: number; ageLane?: "teen" | "adult" | null; parentRoomId?: string | null;
};

/** `exec` lets gameLanes.ts create a game room and its lane in one transaction. */
export async function createRoom(hostId: string, input: CreateRoomInput, exec: Pick<typeof db, "insert"> = db): Promise<Room> {
  const [row] = await exec.insert(rooms).values({
    hostId,
    title: input.title,
    description: input.description ?? null,
    kind: input.kind,
    visibility: input.visibility,
    ageLimit: input.ageLimit,
    eventId: input.eventId ?? null,
    venueId: input.venueId ?? null,
    scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
    noDirectInteractions: input.noDirectInteractions ?? false,
    capacity: input.capacity ?? 50,
    screen: input.screen ?? null,
    inviteTokenHash: input.inviteTokenHash ?? null,
    minorsRoom: input.minorsRoom === true,
    pinnedMessage: input.pinnedMessage ?? null, // the route passes it through pinnedPlainText first
    slowModeSec: input.slowModeSec ?? 0,
    // Paid rooms: the route has already checked the host may sell (canSellTickets). Both null = a free room.
    ticketPriceKobo: input.ticketPriceKobo ?? null,
    ticketCapacity: input.ticketCapacity ?? null,
    refundBeforeStart: input.refundBeforeStart ?? true,
    // Gaming: the column defaults when not a game room (null, 120000, null, null).
    gameFormat: input.gameFormat ?? null,
    gameDropTimeoutMs: input.gameDropTimeoutMs ?? 120_000,
    ageLane: input.ageLane ?? null,
    parentRoomId: input.parentRoomId ?? null,
  }).returning();
  return row;
}

export async function getRoom(id: string): Promise<Room | null> {
  const [row] = await db.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  return row ?? null;
}

/** pinnedMessage must already be plain text cut to 200 (pinnedPlainText); slowModeSec one of SLOW_MODES. minorsRoom is never patchable. */
export type RoomPatch = Partial<Pick<Room, "title" | "description" | "ageLimit" | "screen" | "noDirectInteractions" | "capacity" | "moderationStatus" | "scheduledFor" | "inviteTokenHash" | "pinnedMessage" | "slowModeSec" | "locked" | "ticketPriceKobo" | "ticketCapacity" | "refundBeforeStart" | "gameFormat" | "gameDropTimeoutMs">>;

/** The SET clause for a room patch (shared with the ticket-guarded write in ticketStorage.ts). */
export function roomPatchSet(patch: RoomPatch): Record<string, unknown> {
  // A different screen is a different thing to play: bump the version (a late playback message for the old one is then
  // ignored) and forget the old playback state.
  let set: Record<string, unknown> = patch.screen !== undefined ? { ...patch, screenVersion: sql`${rooms.screenVersion} + 1`, nowPlaying: null } : { ...patch };
  // A new start time is a new reminder: the room is claimable again and everyone who asked is told again with the new time.
  if (patch.scheduledFor !== undefined) set = { ...set, reminderNotifiedAt: null };
  return set;
}

export async function updateRoom(id: string, patch: RoomPatch): Promise<Room> {
  const rescheduled = patch.scheduledFor !== undefined;
  const [row] = await db.update(rooms).set(roomPatchSet(patch) as Partial<Room>).where(eq(rooms.id, id)).returning();
  if (rescheduled && row) await db.update(roomReminders).set({ notifiedAt: null }).where(eq(roomReminders.roomId, id));
  return row;
}

/** Live video rides on voice: switching voice off switches live video off in the same write, so the two cannot disagree. */
export async function setVoiceEnabled(roomId: string, enabled: boolean): Promise<Room> {
  const [row] = await db.update(rooms).set(enabled ? { voiceEnabled: true } : { voiceEnabled: false, liveVideo: false }).where(eq(rooms.id, roomId)).returning();
  return row;
}

export async function setLiveVideo(roomId: string, enabled: boolean): Promise<Room> {
  const [row] = await db.update(rooms).set({ liveVideo: enabled }).where(eq(rooms.id, roomId)).returning();
  return row;
}

/**
 * Switches live video on only while voice is on, checked in the write itself: a voice-off that commits first (even after the
 * caller read voice as on) makes this a no-op. Returns null when voice is off.
 */
export async function enableLiveVideo(roomId: string): Promise<Room | null> {
  const [row] = await db.update(rooms).set({ liveVideo: true }).where(and(eq(rooms.id, roomId), eq(rooms.voiceEnabled, true))).returning();
  return row ?? null;
}

export async function setNowPlaying(roomId: string, np: NowPlaying | null): Promise<Room> {
  const [row] = await db.update(rooms).set({ nowPlaying: np }).where(eq(rooms.id, roomId)).returning();
  return row;
}

/** Returns the new version; also forgets the playback state. */
export async function bumpScreenVersion(roomId: string): Promise<number> {
  const [row] = await db.update(rooms).set({ screenVersion: sql`${rooms.screenVersion} + 1`, nowPlaying: null }).where(eq(rooms.id, roomId)).returning({ v: rooms.screenVersion });
  return row.v;
}

export async function setStatus(id: string, status: RoomStatus, now = new Date()): Promise<Room> {
  const set: Partial<Room> = { status };
  if (status === "live") set.startedAt = now;
  if (status === "ended") set.endedAt = now;
  const [row] = await db.update(rooms).set(set).where(eq(rooms.id, id)).returning();
  return row;
}

/**
 * Scheduled -> live, checked in the write itself. Returns null when the room is not scheduled any more (already live, or
 * ended by a safety rule in between), so an ended room can never be brought back to life.
 */
export async function startScheduledRoom(id: string, now = new Date()): Promise<Room | null> {
  const [row] = await db.update(rooms).set({ status: "live", startedAt: now }).where(and(eq(rooms.id, id), eq(rooms.status, "scheduled"))).returning();
  return row ?? null;
}

/** Cancels a scheduled room, checked in the write. Returns null when it is not scheduled any more (it went live, or ended). */
export async function cancelScheduledRoom(id: string, now = new Date()): Promise<Room | null> {
  const [row] = await db.update(rooms).set({ status: "ended", endedAt: now }).where(and(eq(rooms.id, id), eq(rooms.status, "scheduled"))).returning();
  return row ?? null;
}

export interface ListRoomsOpts {
  scope: "live" | "upcoming" | "friends";
  viewerId: string;
  eventId?: string;
  venueId?: string;
  limit?: number;
}

/**
 * Who sees what (viewer = V, host = H):
 *  - H === V: always (except the "friends" scope, which is other people's rooms).
 *  - blocked either way: never. invite-only: never listed.
 *  - public: host must be an adult (teen-hosted rooms are never public listings); if H opted out of lists
 *    (appearInLists=false) only followers of H see it.
 *  - friends: only mutual followers.
 *  - scope "friends": the above, restricted to mutual followers' rooms.
 *  - minors' room (host was under 18 at creation): a viewer who is not a teen (adult or unknown age) sees it only with an
 *    active, acknowledged personal invite, whatever else is true (an adult mutual friend of a teen host sees nothing).
 * Sorted live first (newest start), then upcoming (soonest first). The route may re-sort live rooms by member count.
 */
export async function listRooms(opts: ListRoomsOpts): Promise<Room[]> {
  const { scope, viewerId } = opts;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const linked = !!(opts.eventId || opts.venueId);
  const statuses: RoomStatus[] = linked || scope === "friends" ? ["live", "scheduled"] : scope === "live" ? ["live"] : ["scheduled"];

  const [blocked, outgoing, incoming, viewerRow, acked] = await Promise.all([
    blockedWith(viewerId),
    db.select({ id: follows.followingId }).from(follows).where(eq(follows.followerId, viewerId)),
    db.select({ id: follows.followerId }).from(follows).where(eq(follows.followingId, viewerId)),
    db.select({ dob: users.dateOfBirth }).from(users).where(eq(users.id, viewerId)).limit(1),
    ackedRoomIdsFor(viewerId),
  ]);
  const viewerAge = ageFromDob(viewerRow[0]?.dob);
  const viewerIsTeen = viewerAge !== null && viewerAge < 18;
  const following = new Set(outgoing.map((r) => r.id));
  const followers = new Set(incoming.map((r) => r.id));
  const mutual = (id: string) => following.has(id) && followers.has(id);

  const STALE_MS = 24 * 3600_000; // a scheduled room whose time passed a day ago was never started: not an "upcoming" room
  const conds = [
    inArray(rooms.status, statuses),
    or(ne(rooms.visibility, "invite"), eq(rooms.hostId, viewerId)),
    or(ne(rooms.status, "scheduled"), isNull(rooms.scheduledFor), gt(rooms.scheduledFor, new Date(Date.now() - STALE_MS))),
  ];
  if (blocked.size) conds.push(notInArray(rooms.hostId, Array.from(blocked)));
  if (scope === "friends") {
    const ids = Array.from(following).filter((id) => followers.has(id));
    if (!ids.length) return [];
    conds.push(inArray(rooms.hostId, ids));
  }
  if (opts.eventId) conds.push(eq(rooms.eventId, opts.eventId));
  if (opts.venueId) conds.push(eq(rooms.venueId, opts.venueId));

  // Live first, then newest; scheduled rooms have no startedAt, so NULLS LAST keeps them from crowding the cap out.
  const rows = await db.select({ room: rooms, dob: users.dateOfBirth, privacy: users.roomPrivacy })
    .from(rooms).innerJoin(users, eq(users.id, rooms.hostId))
    .where(and(...conds))
    .orderBy(sql`(${rooms.status} = 'live') desc`, sql`${rooms.startedAt} desc nulls last`, sql`${rooms.scheduledFor} asc nulls last`)
    .limit(500);
  if (!rows.length) return [];

  const out = rows.filter(({ room, dob, privacy }) => {
    const host = room.hostId;
    if (host === viewerId) return scope !== "friends";
    if (blocked.has(host)) return false;
    if (room.minorsRoom && !viewerIsTeen && !acked.has(room.id)) return false;
    if (scope === "friends" && !mutual(host)) return false;
    if (room.visibility === "friends") return mutual(host);
    if (room.visibility !== "public") return false;
    const age = ageFromDob(dob);
    if (age === null || age < 18) return false;
    if (privacy && privacy.appearInLists === false && !following.has(host)) return false;
    return true;
  }).map((r) => r.room);

  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "live" ? -1 : 1;
    const ta = (a.status === "live" ? a.startedAt : a.scheduledFor)?.getTime() ?? 0;
    const tb = (b.status === "live" ? b.startedAt : b.scheduledFor)?.getTime() ?? 0;
    return a.status === "live" ? tb - ta : ta - tb;
  });
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- members
export async function getMember(roomId: string, userId: string): Promise<RoomMember | null> {
  const [row] = await db.select().from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId))).limit(1);
  return row ?? null;
}

/** Joining (or re-joining) never touches muted/banned. joinedAt restarts only after a leave. */
export async function upsertMember(roomId: string, userId: string, role: MemberRole): Promise<RoomMember> {
  const [row] = await db.insert(roomMembers).values({ roomId, userId, role }).onConflictDoUpdate({
    target: [roomMembers.roomId, roomMembers.userId],
    set: {
      role,
      joinedAt: sql`CASE WHEN ${roomMembers.leftAt} IS NOT NULL THEN now() ELSE ${roomMembers.joinedAt} END`,
      leftAt: null,
    },
  }).returning();
  return row;
}

/**
 * Phase 6 recap: the visit that is ending, added to seconds_in in the same write that sets left_at. Database clock on both
 * ends (joined_at is written by now()), clamped to 0..24 h per visit so a clock oddity can never add a silly number.
 */
const addVisitSeconds = () =>
  sql`${roomMembers.secondsIn} + least(86400, greatest(0, floor(extract(epoch from (now()::timestamp - ${roomMembers.joinedAt})))))::int`;

export async function markLeft(roomId: string, userId: string): Promise<void> {
  await flushChatCounts([chatKey(roomId, userId)]).catch(() => {});
  await db.update(roomMembers).set({ leftAt: new Date(), secondsIn: addVisitSeconds() })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId), isNull(roomMembers.leftAt)));
}

// ---------------------------------------------------------------- recap chat counts (review r2 I1)
// A chat line never touches the database: the count is kept in memory per (room, sender) and written in ONE batched UPDATE
// every CHAT_FLUSH_MS, when the sender leaves, and when the room ends. A crash loses at most one interval of counts (the
// recap only ever under-counts). The map is bounded: past MAX_PENDING_CHAT keys, new senders are not counted until the
// next flush (memory never grows without limit). Per-process, so several instances each write their own share.
export const CHAT_FLUSH_MS = 60_000;
const MAX_PENDING_CHAT = 50_000;
const FLUSH_BATCH = 2_000;
type PendingChat = { roomId: string; userId: string; n: number };
const pendingChat = new Map<string, PendingChat>();
const chatKey = (roomId: string, userId: string) => `${roomId}|${userId}`;
let chatTimer: ReturnType<typeof setInterval> | null = null;

/** Phase 6 recap: one chat line sent. Synchronous, in memory only; written later by flushChatCounts. */
export function countChatLine(roomId: string, userId: string): void {
  const k = chatKey(roomId, userId);
  const e = pendingChat.get(k);
  if (e) { e.n++; return; }
  if (pendingChat.size >= MAX_PENDING_CHAT) return;
  pendingChat.set(k, { roomId, userId, n: 1 });
  if (!chatTimer) {
    chatTimer = setInterval(() => { void flushChatCounts().catch((err) => console.error("[rooms] chat count flush failed:", err?.message ?? err)); }, CHAT_FLUSH_MS);
    chatTimer.unref();
  }
}

/**
 * Writes the pending counts (all of them, or only these keys) in batched UPDATEs, and forgets them first (a failed write
 * only under-counts; it is never retried into a double count).
 */
export async function flushChatCounts(keys?: string[]): Promise<void> {
  const batch: PendingChat[] = [];
  for (const k of keys ?? Array.from(pendingChat.keys())) {
    const e = pendingChat.get(k);
    if (!e) continue;
    pendingChat.delete(k);
    batch.push(e);
  }
  for (let i = 0; i < batch.length; i += FLUSH_BATCH) {
    const part = batch.slice(i, i + FLUSH_BATCH);
    await pool.query(
      `update room_members m set messages_sent = m.messages_sent + v.n
         from unnest($1::varchar[], $2::varchar[], $3::int[]) as v(room_id, user_id, n)
        where m.room_id = v.room_id and m.user_id = v.user_id`,
      [part.map((e) => e.roomId), part.map((e) => e.userId), part.map((e) => e.n)],
    );
  }
}

/** The keys of one room's pending counts (room end). */
const chatKeysOfRoom = (roomId: string) => Array.from(pendingChat.values()).filter((e) => e.roomId === roomId).map((e) => chatKey(e.roomId, e.userId));

/** Tests only: how many lines are waiting to be written for this sender. */
export const pendingChatCount = (roomId: string, userId: string): number => pendingChat.get(chatKey(roomId, userId))?.n ?? 0;

/** Phase 6 recap: raise rooms.peak_members to n, never lower it (conditional, so any order of calls is safe). */
export async function raisePeak(roomId: string, n: number): Promise<void> {
  if (!Number.isSafeInteger(n) || n < 1) return;
  await db.update(rooms).set({ peakMembers: n })
    .where(and(eq(rooms.id, roomId), or(isNull(rooms.peakMembers), lt(rooms.peakMembers, n))));
}

/**
 * Creates the row if the user never joined, so a host can ban someone before they arrive. Such a row carries NEVER_JOINED
 * as joined_at and left_at: it never counts as a member of the live session (no pass through a locked room), and a real
 * join later (upsertMember) starts joined_at afresh because left_at is set.
 */
export async function setMemberFlag(roomId: string, userId: string, flags: { muted?: boolean; banned?: boolean }): Promise<RoomMember> {
  const set: Partial<RoomMember> = {};
  if (flags.muted !== undefined) set.muted = flags.muted;
  if (flags.banned !== undefined) set.banned = flags.banned;
  const [row] = await db.insert(roomMembers).values({ roomId, userId, joinedAt: NEVER_JOINED, leftAt: NEVER_JOINED, ...set })
    .onConflictDoUpdate({ target: [roomMembers.roomId, roomMembers.userId], set: Object.keys(set).length ? set : { role: sql`${roomMembers.role}` } })
    .returning();
  return row;
}

export async function isBanned(roomId: string, userId: string): Promise<boolean> {
  return (await getMember(roomId, userId))?.banned === true;
}

const countBy = async (hostId: string, status: RoomStatus) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(rooms).where(and(eq(rooms.hostId, hostId), eq(rooms.status, status))))[0].n);
export const countLiveRoomsByHost = (hostId: string) => countBy(hostId, "live");
export const countScheduledByHost = (hostId: string) => countBy(hostId, "scheduled");

export async function markAllLeft(roomId: string): Promise<void> {
  await flushChatCounts(chatKeysOfRoom(roomId)).catch(() => {});
  await db.update(roomMembers).set({ leftAt: new Date(), secondsIn: addVisitSeconds() }).where(and(eq(roomMembers.roomId, roomId), isNull(roomMembers.leftAt)));
}

/** A host's rooms that have not ended (live and scheduled). */
export async function listOpenRoomsByHost(hostId: string): Promise<Room[]> {
  return db.select().from(rooms).where(and(eq(rooms.hostId, hostId), ne(rooms.status, "ended")));
}

export async function listLiveRooms(): Promise<Room[]> {
  return db.select().from(rooms).where(eq(rooms.status, "live"));
}

export async function setMemberRole(roomId: string, userId: string, role: MemberRole): Promise<RoomMember | null> {
  const [row] = await db.update(roomMembers).set({ role }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId))).returning();
  return row ?? null;
}

// ---------------------------------------------------------------- stage (guests given the mic)
export async function setOnStage(roomId: string, userId: string, onStage: boolean): Promise<void> {
  await db.update(roomMembers).set({ onStage }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}

export async function listOnStage(roomId: string): Promise<string[]> {
  const rows = await db.select({ id: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.onStage, true), eq(roomMembers.banned, false)));
  return rows.map((r) => r.id);
}

export async function clearStage(roomId: string): Promise<void> {
  await db.update(roomMembers).set({ onStage: false }).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.onStage, true)));
}
