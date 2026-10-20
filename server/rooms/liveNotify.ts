// "<host> is live": the go-live notice to the host's FOLLOWERS (owner decision, fix round: every follower, not capped).
//
// Who is told (unchanged rules, only the cap and the batching changed):
//  - nobody when the host turned "Tell my followers" off (roomPrivacy.notifyFriendsLive, default ON), or for an invite-only
//    room (invites are told by the invite routes, never the public);
//  - never a deleted account, never anyone blocked either way with the host;
//  - only people who could join the room by age (canJoinRoom with their own birthdate);
//  - a minors' room: only teens, and adults who already hold an acknowledged personal invite;
//  - a friends-only room: only followers the host follows back (mutual).
//
// How: walks the followers in pages of LIVE_NOTIFY_CHUNK (keyset on the user id, so a host with 100,000 followers is many
// small statements, never one giant transaction), writes each page's notices in ONE multi-row INSERT (autocommit, skipping
// anyone already told about this room), then pings the bell and the phone with a small concurrency. Runs in the
// background: the /start answer never waits for it, and a failure is logged, never thrown.
import { pool } from "../storage";
import { wsManager } from "../websocket";
import { sendPushNotification } from "../pushService";
import type { Room, User } from "@shared/schema";
import { ageFromDob } from "@shared/age";
import { resolveRoomPrivacy } from "@shared/rooms";
import { canJoinRoom } from "@shared/roomRules";
import { blockedWith } from "../utils/blocks";
import * as mr from "./minorsRoom";

export const LIVE_NOTIFY_CHUNK = 500;
const PUSH_CONCURRENCY = 5;
const isTeen = (age: number | null) => age !== null && age < 18;

export interface LiveAudienceRules {
  minorsRoom: boolean;
  visibility: string;
  blocked: Set<string>;
  acked: Set<string> | null;
  mutual: Set<string> | null;
}

/** Pure: may this follower be told? (exported for the unit tests) */
export function mayTellFollower(f: { id: string; dob: string | null }, room: Pick<Room, "ageLimit" | "minorsRoom" | "visibility">, r: LiveAudienceRules, now: Date = new Date()): boolean {
  if (r.blocked.has(f.id)) return false;
  const age = ageFromDob(f.dob, now);
  if (!canJoinRoom({ age }, room as any).ok) return false;
  if (room.minorsRoom && !(isTeen(age) || (r.acked?.has(f.id) ?? false))) return false;
  if (room.visibility === "friends" && !(r.mutual?.has(f.id) ?? false)) return false;
  return true;
}

async function pushAll(ids: string[], title: string, body: string, url: string, tag: string): Promise<void> {
  for (let i = 0; i < ids.length; i += PUSH_CONCURRENCY) {
    await Promise.allSettled(ids.slice(i, i + PUSH_CONCURRENCY).map((id) => sendPushNotification(id, { title, body, url, tag })));
  }
}

/** Tells every eligible follower; returns how many were newly notified. Throws on a database error (callers catch). */
export async function notifyFollowersLive(room: Room, host: User): Promise<number> {
  if (room.visibility === "invite") return 0;
  if (!resolveRoomPrivacy(host.roomPrivacy).notifyFriendsLive) return 0;
  const [blocked, acked, mutual] = await Promise.all([
    blockedWith(host.id),
    room.minorsRoom ? mr.ackedInviteesOf(room.id) : Promise.resolve(null),
    room.visibility === "friends"
      ? pool.query(`select following_id as id from follows where follower_id = $1`, [host.id]).then((r) => new Set((r.rows as { id: string }[]).map((x) => x.id)))
      : Promise.resolve(null),
  ]);
  const rules: LiveAudienceRules = { minorsRoom: room.minorsRoom, visibility: room.visibility, blocked, acked, mutual };
  const name = host.displayName || host.organizationName || host.username;
  const title = `${name} is live`;
  const link = `/rooms/${room.id}`;
  const now = new Date();
  let after = "";
  let told = 0;
  for (;;) {
    const page = (await pool.query(
      `select u.id, u.date_of_birth::text as dob
         from follows f join users u on u.id = f.follower_id
        where f.following_id = $1 and u.deleted_at is null and u.id <> $1 and u.id > $2
        order by u.id limit $3`,
      [host.id, after, LIVE_NOTIFY_CHUNK],
    )).rows as { id: string; dob: string | null }[];
    if (!page.length) break;
    after = page[page.length - 1].id;
    const ids = page.filter((f) => mayTellFollower(f, room, rules, now)).map((f) => f.id);
    if (ids.length) {
      // Explicit casts: each parameter is used both as an insert value and in a comparison, and untyped Postgres would
      // deduce text in one place and varchar in the other ("inconsistent types deduced"), failing every run.
      // Dedupe only against an earlier GO-LIVE notice: the invite routes also write type 'room_live' rows for this room
      // ("<name> invited you", "<name> invited you to a room"), and an invited follower must still be told it is live.
      const inserted = (await pool.query(
        `insert into notifications (user_id, type, title, message, link, related_user_id, related_entity_id, is_read)
         select v.id, 'room_live', $2::text, $3::text, $4::text, $5::varchar, $6::varchar, false from unnest($1::varchar[]) as v(id)
          where not exists (select 1 from notifications n where n.user_id = v.id and n.type = 'room_live' and n.related_entity_id = $6::varchar
                              and n.title like '%is live')
         returning user_id`,
        [ids, title, room.title, link, host.id, room.id],
      )).rows as { user_id: string }[];
      const newly = inserted.map((r) => r.user_id);
      told += newly.length;
      for (const id of newly) { try { wsManager.sendToUser(id, { type: "notification", data: { type: "room_live" } }); } catch { /* best effort */ } }
      await pushAll(newly, title, room.title, link, "room_live");
    }
    if (page.length < LIVE_NOTIFY_CHUNK) break;
  }
  return told;
}

/** In this process: the run per room, until it settles (tests wait on it; production never needs to). */
const runs = new Map<string, Promise<number>>();

/** Starts the notice in the background. Never throws, never rejects. */
export function startLiveNotice(room: Room, host: User): void {
  const p = notifyFollowersLive(room, host).catch((e) => { console.error("[rooms] live notice failed:", room.id, e?.message ?? e); return 0; });
  runs.set(room.id, p);
  void p.finally(() => { if (runs.get(room.id) === p) runs.delete(room.id); });
}

/** Resolves once this room's background notice (if any) has finished, with how many were told (0 when none ran). */
export async function liveNoticeSettled(roomId: string): Promise<number> {
  return (await runs.get(roomId)) ?? 0;
}
