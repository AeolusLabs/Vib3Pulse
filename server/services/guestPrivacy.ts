import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import { invalidateCache } from "../cache";
import { events, guestDataAudit, moderationAppeals, notifications, phoneVerifications, tickets, userDevices, users } from "@shared/schema";
import { getConfig } from "./moderationConfig";

// Guest data = what a guest hands over to RSVP: a name, yes/no, and a plus-one COUNT (nothing else is
// collected). It is deleted when
//   * the guest opts out of an event          (removeGuestRsvp)
//   * N days have passed since the event       (runRetentionPurge, N = guest_data_retention_days)
//   * either side's account is deleted         (eraseSocialDataForUser)
// Every deletion writes a guest_data_audit row (actor 'system') with the event and a reason; the audit
// log holds no personal data, only ids and counts.

const END_OF_EVENT = sql`coalesce(${events.eventEndDate}, ${events.eventDate} + interval '12 hours')`;
// Anything that mentions a guest by name or links guest <-> event on the host's side.
const GUEST_NOTIFICATION_TYPES = ["event_rsvp", "rsvp_approved", "rsvp_removed"];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function auditPurge(tx: Tx | typeof db, eventId: string, reason: string, ticketId?: string) {
  await tx.insert(guestDataAudit).values({ actorType: "system", eventId, ticketId: ticketId ?? null, dataAccessed: "purge", reason });
}

// ---------------------------------------------------------------- opt-out / withdraw
// A guest (with or without an account) deletes their own response and name. Their seats are freed.
export async function removeGuestRsvp(p: { eventId: string; userId?: string | null; tokenHash?: string | null }): Promise<boolean> {
  if (!p.userId && !p.tokenHash) return false;
  const done = await db.transaction(async (tx) => {
    const [ev] = await tx.select({ id: events.id, visibility: events.visibility }).from(events).where(and(eq(events.id, p.eventId), eq(events.kind, "social"))).for("update");
    if (!ev) return null;
    const match = p.userId ? eq(tickets.userId, p.userId) : eq(tickets.guestTokenHash, p.tokenHash!);
    const [t] = await tx.select().from(tickets).where(and(eq(tickets.eventId, p.eventId), match));
    if (!t) return null;
    if (t.status === "confirmed") {
      await tx.update(events).set({ ticketsSold: sql`greatest(${events.ticketsSold} - ${1 + t.plusOneCount}, 0)` }).where(eq(events.id, p.eventId));
    }
    await tx.delete(tickets).where(eq(tickets.id, t.id));
    await auditPurge(tx, p.eventId, "guest opted out and deleted their response", t.id);
    return ev;
  });
  if (done?.visibility === "public") invalidateCache.events();
  return !!done;
}

// ---------------------------------------------------------------- one event
export async function purgeEventGuestData(eventId: string, reason: string): Promise<number> {
  const removed = await db.transaction(async (tx) => {
    const [ev] = await tx.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.kind, "social"))).for("update");
    if (!ev) return -1;
    const gone = await tx.delete(tickets).where(eq(tickets.eventId, eventId)).returning({ id: tickets.id });
    await tx.delete(notifications).where(and(eq(notifications.relatedEntityId, eventId), inArray(notifications.type, GUEST_NOTIFICATION_TYPES)));
    await tx.update(events).set({ guestDataPurgedAt: new Date() }).where(eq(events.id, eventId));
    await auditPurge(tx, eventId, `${reason}: ${gone.length} RSVP record${gone.length === 1 ? "" : "s"} deleted`);
    return gone.length;
  });
  return Math.max(removed, 0);
}

// ---------------------------------------------------------------- retention
export type PurgeSummary = { eventsPurged: number; rsvpsDeleted: number; heldForCase: number };

// Deletes guest data for every social event that ended more than guest_data_retention_days ago.
// An event with an OPEN moderation case (pending/hidden/changes requested, open appeal, or an
// unreviewed report) is held for up to guest_data_hold_extra_days more, then purged regardless.
export async function runRetentionPurge(limit = 200): Promise<PurgeSummary> {
  const [days, extra] = await Promise.all([getConfig("guest_data_retention_days"), getConfig("guest_data_hold_extra_days")]);
  const held = sql`(${events.moderationStatus} in ('pending','hidden','changes_requested')
    or exists (select 1 from moderation_appeals a where a.subject_type = 'event' and a.subject_id = ${events.id} and a.status = 'open')
    or exists (select 1 from content_reports r where r.content_type = 'event' and r.content_id = ${events.id} and r.status = 'pending'))`;
  const rows = await db
    .select({ id: events.id, held: sql<boolean>`${held}`, hardDeadlinePassed: sql<boolean>`(${END_OF_EVENT} + make_interval(days => ${days + extra}) <= now())` })
    .from(events)
    .where(and(eq(events.kind, "social"), sql`${events.guestDataPurgedAt} is null`, sql`${END_OF_EVENT} + make_interval(days => ${days}) <= now()`))
    .limit(limit);

  const summary: PurgeSummary = { eventsPurged: 0, rsvpsDeleted: 0, heldForCase: 0 };
  for (const r of rows) {
    if (r.held && !r.hardDeadlinePassed) { summary.heldForCase++; continue; }
    const n = await purgeEventGuestData(r.id, r.held ? `retention period (+${extra}d case hold) ended` : `retention period (${days}d after the event) ended`);
    summary.eventsPurged++;
    summary.rsvpsDeleted += n;
  }
  return summary;
}

export function startGuestRetentionJob() {
  const run = () => runRetentionPurge().then((s) => s.eventsPurged && console.log(`[Privacy] retention purge: ${s.eventsPurged} events, ${s.rsvpsDeleted} RSVPs deleted`)).catch((e) => console.error("[Privacy] retention purge failed:", e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 6 * 3600 * 1000).unref?.();
}

// ---------------------------------------------------------------- account deletion
// Called by the delete-account route BEFORE the user row is anonymised.
//   as a guest: every RSVP they made is deleted (seats freed)
//   as a host:  their social events are closed and all guest data on them is deleted, along with the
//               exact address and invite link (the host's own personal data)
//   either way: phone verification codes, devices and the verified phone number are deleted
// Ban records are deliberately kept (hashed): they exist to keep abusers out and hold no readable data.
export async function eraseSocialDataForUser(userId: string): Promise<{ rsvpsRemoved: number; eventsClosed: number }> {
  let rsvpsRemoved = 0;
  const mine = await db
    .select({ id: tickets.id, eventId: tickets.eventId, status: tickets.status, plus: tickets.plusOneCount })
    .from(tickets)
    .innerJoin(events, eq(events.id, tickets.eventId))
    .where(and(eq(tickets.userId, userId), eq(events.kind, "social")));
  for (const t of mine) {
    await db.transaction(async (tx) => {
      await tx.select({ id: events.id }).from(events).where(eq(events.id, t.eventId)).for("update");
      if (t.status === "confirmed") await tx.update(events).set({ ticketsSold: sql`greatest(${events.ticketsSold} - ${1 + t.plus}, 0)` }).where(eq(events.id, t.eventId));
      await tx.delete(tickets).where(eq(tickets.id, t.id));
      await auditPurge(tx, t.eventId, "guest account deleted", t.id);
    });
    rsvpsRemoved++;
  }

  const hosted = await db.select({ id: events.id, eventDate: events.eventDate }).from(events).where(and(eq(events.organizerId, userId), eq(events.kind, "social")));
  for (const e of hosted) {
    await purgeEventGuestData(e.id, "host account deleted");
    await db
      .update(events)
      .set({ isCancelled: sql`${events.isCancelled} or ${events.eventDate} > now()`, cancelledAt: sql`coalesce(${events.cancelledAt}, now())`, isPublished: false, moderationStatus: "removed", queueReason: null, queuedAt: null, exactAddress: null, inviteToken: null })
      .where(eq(events.id, e.id));
  }

  await db.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
  await db.delete(userDevices).where(eq(userDevices.userId, userId));
  await db.update(users).set({ verifiedPhone: null, phoneVerifiedAt: null }).where(eq(users.id, userId));
  await db.delete(moderationAppeals).where(eq(moderationAppeals.userId, userId));
  if (hosted.length) invalidateCache.events();
  return { rsvpsRemoved, eventsClosed: hosted.length };
}
