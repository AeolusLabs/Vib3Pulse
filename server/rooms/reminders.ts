// "Starts in N minutes" reminders for scheduled rooms. The job claims a room with one conditional UPDATE, so when two
// server instances run it at the same moment only one gets the row back and only one sends.
//
// Delivery is AT MOST ONCE: the claim is written before anything is sent, so a crash between the claim and the sends loses
// that room's reminders instead of ever sending them twice. A reschedule (rs.updateRoom with scheduledFor) clears the
// claim and every reminder row's notified_at, so the room is reminded again with the new time.
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "../storage";
import { deliverNotification } from "../notifications";
import { roomReminders, rooms, type Room } from "@shared/schema";
import { reminderTitle, reminderWindow } from "@shared/roomReminders";
import * as rs from "./roomStorage";
import { canViewRoom } from "./roomAccess";

export const REMINDER_EVERY_MS = 60_000;

export async function hasReminder(roomId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ u: roomReminders.userId }).from(roomReminders)
    .where(and(eq(roomReminders.roomId, roomId), eq(roomReminders.userId, userId))).limit(1);
  return !!row;
}

/** Idempotent: setting twice keeps the one row. */
export async function setReminder(roomId: string, userId: string): Promise<void> {
  await db.insert(roomReminders).values({ roomId, userId }).onConflictDoNothing();
}

export async function clearReminder(roomId: string, userId: string): Promise<void> {
  await db.delete(roomReminders).where(and(eq(roomReminders.roomId, roomId), eq(roomReminders.userId, userId)));
}

/** Claims the rooms due now (atomically) and notifies each person who may still see the room. Returns how many were sent. */
export async function runReminderPass(now: Date = new Date()): Promise<number> {
  const { from, to } = reminderWindow(now);
  // The claim. A second instance (or a second call) matches nothing because reminder_notified_at is no longer null.
  // Only rooms moderation has left approved are claimed (a room taken down is never announced; if it is approved again
  // while still in the window, the next tick reminds it).
  const claimed = await db.update(rooms).set({ reminderNotifiedAt: now })
    .where(and(
      eq(rooms.status, "scheduled"), eq(rooms.moderationStatus, "approved"), isNull(rooms.reminderNotifiedAt),
      gte(rooms.scheduledFor, from), lte(rooms.scheduledFor, to),
    ))
    .returning();
  let sent = 0;
  for (const room of claimed) {
    try { sent += await notifyRoom(room, now); } catch (e) { console.error("[rooms] reminder failed for", room.id, e); }
  }
  return sent;
}

async function notifyRoom(room: Room, now: Date): Promise<number> {
  if (!room.scheduledFor) return 0; // cannot happen (the claim needs a start time); keeps the copy honest
  const title = reminderTitle(room.title, new Date(room.scheduledFor), now); // the real time left, never a fixed "15"
  const rows = await db.select({ userId: roomReminders.userId }).from(roomReminders).where(eq(roomReminders.roomId, room.id));
  const ids = new Set<string>([room.hostId, ...rows.map((r) => r.userId)]);
  let sent = 0;
  for (const userId of Array.from(ids)) {
    try {
      // Checked now, not when the reminder was set: someone who lost access (blocked, ban, revoked invite, lost the
      // friendship) gets nothing, and in a minors' room an adult without an acknowledged invite never does. The title
      // only goes to people who pass this.
      if (userId !== room.hostId) {
        if (!(await canViewRoom(room, userId))) continue;
        if (await rs.isBanned(room.id, userId)) continue;
      }
      await deliverNotification({
        userId, type: "room_starting", title, message: "Tap to open the room.",
        link: `/rooms/${room.id}`, relatedUserId: room.hostId, relatedEntityId: room.id,
      });
      await db.update(roomReminders).set({ notifiedAt: now }).where(and(eq(roomReminders.roomId, room.id), eq(roomReminders.userId, userId)));
      sent++;
    } catch (e) {
      console.error("[rooms] reminder send failed:", e);
    }
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Starts the once-a-minute pass. Safe to call twice; the timer never keeps the process alive. */
export function startReminderJob(): void {
  if (timer) return;
  timer = setInterval(() => { runReminderPass().catch((e) => console.error("[rooms] reminder pass failed:", e)); }, REMINDER_EVERY_MS);
  timer.unref();
}
