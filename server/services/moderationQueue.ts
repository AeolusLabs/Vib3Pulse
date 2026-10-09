import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../storage";
import { invalidateCache } from "../cache";
import { deliverNotification } from "../notifications";
import {
  bans, contentReports, eventModerations, events, moderationAppeals, userStrikes, userSuspensions, userTrust, users,
  type Event, type HostTrustTier,
} from "@shared/schema";
import { getConfig } from "./moderationConfig";
import { computeTier } from "./eventAbuse";
import { liftBan } from "./enforcement";
import { withAudit } from "./adminSecurity";

// The single moderation queue for PUBLIC social events: held for review, auto-hidden (report
// threshold or admin), auto-flagged, plus any event with an open appeal. Admin views here carry
// RSVP COUNTS only - never the exact address or guest names (those need a reveal; see revealGrants.ts).

export type QueueFilters = {
  flag?: string; // an auto-flag (external_link / contact_pattern / free_entry_payment) or a queue reason (report_threshold / new_account_review / auto_flag / admin_hidden)
  minReports?: number;
  tier?: HostTrustTier;
  minAgeHours?: number; // time in queue
  from?: Date; // event date range
  to?: Date;
  sort?: "event_date" | "queued_oldest" | "reports";
  limit?: number;
  offset?: number;
};

const CANDIDATE_CAP = 500; // the queue is small by design; tier/report filters are applied after enrichment

const hasOpenAppeal = sql`exists (select 1 from moderation_appeals a where a.subject_type = 'event' and a.subject_id = ${events.id} and a.status = 'open')`;

export async function getModerationQueue(f: QueueFilters = {}) {
  const [slaHours, windowDays, needClean] = await Promise.all([getConfig("queue_sla_hours"), getConfig("new_account_window_days"), getConfig("trusted_after_clean_events")]);

  const conds = [
    eq(events.kind, "social"),
    eq(events.visibility, "public"),
    or(inArray(events.moderationStatus, ["pending", "hidden"]), hasOpenAppeal)!,
  ];
  if (f.flag) conds.push(sql`(${f.flag} = any(${events.autoFlags}) or ${events.queueReason} = ${f.flag})`);
  if (f.from) conds.push(sql`${events.eventDate} >= ${f.from}`);
  if (f.to) conds.push(sql`${events.eventDate} <= ${f.to}`);
  if (f.minAgeHours) conds.push(sql`${events.queuedAt} <= now() - make_interval(hours => ${Math.floor(f.minAgeHours)})`);

  const rows = await db.select().from(events).where(and(...conds)).orderBy(asc(events.eventDate)).limit(CANDIDATE_CAP);
  if (rows.length === 0) return { items: [], total: 0, slaHours, slaBreached: 0 };

  const ids = rows.map((r) => r.id);
  const hostIds = Array.from(new Set(rows.map((r) => r.organizerId)));

  const [hostRows, trustRows, strikeRows, hostEventRows, reportRows, receivedRows, appealRows, bannedRows] = await Promise.all([
    db.select({ id: users.id, username: users.username, displayName: users.displayName, createdAt: users.createdAt, isVerified: users.isVerified, phoneVerifiedAt: users.phoneVerifiedAt, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, hostIds)),
    db.select().from(userTrust).where(inArray(userTrust.userId, hostIds)),
    db
      .select({
        userId: userStrikes.userId,
        total: sql<number>`count(*) filter (where ${userStrikes.type} = 'strike')::int`,
        active: sql<number>`count(*) filter (where ${userStrikes.type} = 'strike' and ${userStrikes.revokedAt} is null and (${userStrikes.expiresAt} is null or ${userStrikes.expiresAt} > now()))::int`,
        warns: sql<number>`count(*) filter (where ${userStrikes.type} = 'warn')::int`,
      })
      .from(userStrikes)
      .where(inArray(userStrikes.userId, hostIds))
      .groupBy(userStrikes.userId),
    db
      .select({
        organizerId: events.organizerId,
        total: sql<number>`count(*)::int`,
        clean: sql<number>`count(*) filter (where ${events.moderationStatus} = 'approved' and ${events.eventDate} < now())::int`,
        removed: sql<number>`count(*) filter (where ${events.moderationStatus} in ('rejected','removed'))::int`,
      })
      .from(events)
      .where(and(inArray(events.organizerId, hostIds), eq(events.kind, "social")))
      .groupBy(events.organizerId),
    db
      .select({ eventId: contentReports.contentId, reporterId: contentReports.reporterId, reason: contentReports.reason, status: contentReports.status, abusive: userTrust.abusiveReporterAt })
      .from(contentReports)
      .leftJoin(userTrust, eq(userTrust.userId, contentReports.reporterId))
      .where(and(eq(contentReports.contentType, "event"), inArray(contentReports.contentId, ids))),
    db
      .select({ organizerId: events.organizerId, n: sql<number>`count(*)::int` })
      .from(contentReports)
      .innerJoin(events, eq(events.id, contentReports.contentId))
      .where(and(eq(contentReports.contentType, "event"), inArray(events.organizerId, hostIds)))
      .groupBy(events.organizerId),
    db.select().from(moderationAppeals).where(and(eq(moderationAppeals.subjectType, "event"), inArray(moderationAppeals.subjectId, ids), eq(moderationAppeals.status, "open"))),
    db.select({ id: bans.valueHash }).from(bans).where(and(eq(bans.kind, "user"), inArray(bans.valueHash, hostIds), isNull(bans.liftedAt))),
  ]);

  const hostBy = new Map(hostRows.map((h) => [h.id, h]));
  const trustBy = new Map(trustRows.map((t) => [t.userId, t]));
  const strikesBy = new Map(strikeRows.map((s) => [s.userId, s]));
  const evBy = new Map(hostEventRows.map((e) => [e.organizerId, e]));
  const receivedBy = new Map(receivedRows.map((r) => [r.organizerId, r.n]));
  const bannedSet = new Set(bannedRows.map((b) => b.id));
  const appealBy = new Map(appealRows.map((a) => [a.subjectId, a]));
  const reportsBy = new Map<string, typeof reportRows>();
  for (const r of reportRows) reportsBy.set(r.eventId, [...(reportsBy.get(r.eventId) ?? []), r]);

  const now = Date.now();
  let items = rows.map((e) => {
    const h = hostBy.get(e.organizerId);
    const t = trustBy.get(e.organizerId);
    const st = strikesBy.get(e.organizerId);
    const he = evBy.get(e.organizerId);
    const ageDays = h ? (now - new Date(h.createdAt).getTime()) / 86400000 : 0;
    const tier = computeTier({
      ageDays,
      override: t?.tierOverrideAt ? (t.trustTier as HostTrustTier) : null,
      windowDays,
      cleanEvents: he?.clean ?? 0,
      needCleanEvents: needClean,
      activeStrikes: st?.active ?? 0,
    });
    const reports = reportsBy.get(e.id) ?? [];
    const credible = new Set(reports.filter((r) => !r.abusive && r.status !== "dismissed").map((r) => r.reporterId));
    const reasonCounts = new Map<string, number>();
    for (const r of reports) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
    const appeal = appealBy.get(e.id);
    const hoursInQueue = e.queuedAt ? Math.max(0, (now - new Date(e.queuedAt).getTime()) / 3600000) : null;
    return {
      eventId: e.id,
      title: e.title,
      description: e.description,
      socialType: e.socialType,
      eventDate: e.eventDate,
      area: e.location,
      city: e.city,
      ageRestriction: e.ageRestriction,
      servesAlcohol: e.servesAlcohol,
      imageUrl: e.imageUrl,
      createdAt: e.createdAt,
      // RSVP counts only. No names, no address.
      rsvp: { capacity: e.ticketsAvailable, headcount: e.ticketsSold },
      moderationStatus: e.moderationStatus,
      queueReason: e.queueReason,
      flags: e.autoFlags,
      queuedAt: e.queuedAt,
      hoursInQueue,
      slaBreached: hoursInQueue !== null && hoursInQueue > slaHours,
      reports: { total: reports.length, credible: credible.size, reasons: Array.from(reasonCounts, ([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count) },
      openAppeal: appeal ? { id: appeal.id, message: appeal.message, createdAt: appeal.createdAt } : null,
      host: {
        id: e.organizerId,
        username: h?.username ?? null,
        displayName: h?.displayName ?? null,
        accountAgeDays: Math.floor(ageDays),
        emailVerified: !!h?.isVerified,
        phoneVerified: !!h?.phoneVerifiedAt,
        deleted: !!h?.deletedAt,
        tier,
        tierOverridden: !!t?.tierOverrideAt,
        featuredEligible: t?.featuredOverrideAt ? t.featuredEligible : null,
        banned: bannedSet.has(e.organizerId),
        pastEvents: he?.total ?? 0,
        removedOrRejectedEvents: he?.removed ?? 0,
        strikes: { active: st?.active ?? 0, total: st?.total ?? 0, warns: st?.warns ?? 0 },
        reportsReceived: receivedBy.get(e.organizerId) ?? 0,
      },
    };
  });

  if (f.tier) items = items.filter((i) => i.host.tier === f.tier);
  if (f.minReports) items = items.filter((i) => i.reports.credible >= f.minReports!);

  const upcomingFirst = (a: { eventDate: Date }, b: { eventDate: Date }) => {
    const pa = new Date(a.eventDate).getTime() < now ? 1 : 0;
    const pb = new Date(b.eventDate).getTime() < now ? 1 : 0;
    return pa - pb || new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime();
  };
  const sort = f.sort ?? "event_date";
  if (sort === "queued_oldest") items.sort((a, b) => (a.queuedAt ? new Date(a.queuedAt).getTime() : Infinity) - (b.queuedAt ? new Date(b.queuedAt).getTime() : Infinity));
  else if (sort === "reports") items.sort((a, b) => b.reports.credible - a.reports.credible || upcomingFirst(a, b));
  else items.sort(upcomingFirst); // default: events happening soonest first, finished ones last

  const total = items.length;
  const offset = Math.max(0, f.offset ?? 0);
  const limit = Math.min(Math.max(1, f.limit ?? 50), 100);
  return { items: items.slice(offset, offset + limit), total, slaHours, slaBreached: items.filter((i) => i.slaBreached).length };
}

// ---------------------------------------------------------------- actions
export type ModAction = "approve" | "reject" | "hide" | "restore" | "request_edit" | "remove";

const TRANSITIONS: Record<ModAction, { from: string[]; to: string }> = {
  approve: { from: ["pending", "changes_requested"], to: "approved" },
  reject: { from: ["pending", "changes_requested"], to: "rejected" },
  hide: { from: ["approved", "pending"], to: "hidden" },
  restore: { from: ["hidden", "rejected"], to: "approved" },
  request_edit: { from: ["pending", "approved", "hidden"], to: "changes_requested" },
  remove: { from: ["pending", "approved", "hidden", "rejected", "changes_requested"], to: "removed" }, // permanent: nothing restores it except an upheld appeal
};

export type ActionResult = { ok: true; status: string } | { ok: false; code: "not_found" | "invalid_transition" | "host_banned"; message: string };

const VERB: Record<ModAction, string> = {
  approve: "was approved and is now visible in discovery",
  restore: "was restored and is visible in discovery again",
  reject: "wasn't approved",
  hide: "was hidden while we review it",
  request_edit: "needs changes before it can go live",
  remove: "was removed",
};

function notifyHost(e: Event, action: ModAction, reason: string) {
  const good = action === "approve" || action === "restore";
  const tail = good ? "" : action === "request_edit" ? " Edit the event and it will be reviewed again." : " You can appeal from the event page.";
  deliverNotification({
    userId: e.organizerId,
    type: "event_moderation",
    title: good ? "Your event is live" : action === "request_edit" ? "Changes requested" : "Your event was taken down",
    message: `"${e.title}" ${VERB[action]}.${good ? "" : ` Reason: ${reason}.`}${tail}`,
    link: `/social-events/${e.id}`,
    relatedEntityId: e.id,
  }).catch((err) => console.error("[Moderation] host notification failed:", err));
}

export async function applyModerationAction(p: { eventId: string; adminId: string; action: ModAction; reason: string; ip?: string | null }): Promise<ActionResult> {
  const [ev] = await db.select().from(events).where(and(eq(events.id, p.eventId), eq(events.kind, "social"), eq(events.visibility, "public")));
  if (!ev) return { ok: false, code: "not_found", message: "Event not found" };
  const rule = TRANSITIONS[p.action];
  if (!rule.from.includes(ev.moderationStatus)) {
    return { ok: false, code: "invalid_transition", message: `You can't ${p.action.replace("_", " ")} an event that is ${ev.moderationStatus}.` };
  }
  if ((p.action === "approve" || p.action === "restore") && (await isHostBanned(ev.organizerId))) {
    return { ok: false, code: "host_banned", message: "This host is banned. Lift the ban before restoring their events." };
  }

  const flagged = ev.autoFlags.length > 0 && !ev.flagOutcome;
  const outcome = p.action === "approve" || p.action === "restore" ? "approved" : p.action === "reject" || p.action === "remove" ? "rejected" : null;
  const to = rule.to;

  await withAudit(
    { adminId: p.adminId, action: `moderation_${p.action}`, targetType: "event", targetId: ev.id, reason: p.reason, details: { from: ev.moderationStatus, to, title: ev.title }, ip: p.ip },
    async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(events)
          .set({
            moderationStatus: to,
            queueReason: p.action === "hide" ? "admin_hidden" : p.action === "request_edit" ? "edit_requested" : null,
            queuedAt: p.action === "hide" ? new Date() : null,
            ...(flagged && outcome ? { flagOutcome: outcome } : {}),
          })
          .where(eq(events.id, ev.id));
        await tx.insert(eventModerations).values({ eventId: ev.id, adminId: p.adminId, action: p.action, reason: p.reason, queuedAt: ev.queuedAt });
        if (to === "approved") {
          // Approving the event makes any open appeal on it moot.
          await tx
            .update(moderationAppeals)
            .set({ status: "upheld", resolvedBy: p.adminId, resolvedAt: new Date(), resolutionReason: `Resolved by moderation: ${p.reason}` })
            .where(and(eq(moderationAppeals.subjectType, "event"), eq(moderationAppeals.subjectId, ev.id), eq(moderationAppeals.status, "open")));
        }
      });
    },
  );
  invalidateCache.events();
  notifyHost(ev, p.action, p.reason);
  return { ok: true, status: to };
}

export async function applyBulk(p: { eventIds: string[]; adminId: string; action: ModAction; reason: string; ip?: string | null }) {
  const results: Array<{ eventId: string; ok: boolean; status?: string; message?: string }> = [];
  for (const eventId of Array.from(new Set(p.eventIds))) {
    try {
      const r = await applyModerationAction({ ...p, eventId });
      results.push(r.ok ? { eventId, ok: true, status: r.status } : { eventId, ok: false, message: r.message });
    } catch (e) {
      results.push({ eventId, ok: false, message: "Failed" });
      console.error("[Moderation] bulk item failed:", (e as Error).message);
    }
  }
  return results;
}

async function isHostBanned(userId: string): Promise<boolean> {
  const [b] = await db.select({ id: bans.id }).from(bans).where(and(eq(bans.kind, "user"), eq(bans.valueHash, userId), isNull(bans.liftedAt))).limit(1);
  return !!b;
}

// ---------------------------------------------------------------- appeals
export async function listOpenAppeals() {
  const rows = await db
    .select({ a: moderationAppeals, username: users.username, displayName: users.displayName })
    .from(moderationAppeals)
    .innerJoin(users, eq(users.id, moderationAppeals.userId))
    .where(eq(moderationAppeals.status, "open"))
    .orderBy(asc(moderationAppeals.createdAt));
  return rows.map((r) => ({ ...r.a, appellant: { username: r.username, displayName: r.displayName }, hoursOpen: (Date.now() - new Date(r.a.createdAt).getTime()) / 3600000 }));
}

export type AppealResult = { ok: true } | { ok: false; code: "not_found" | "already_resolved" | "subject_missing"; message: string };

export async function resolveAppeal(p: { appealId: string; adminId: string; decision: "uphold" | "deny"; reason: string; ip?: string | null }): Promise<AppealResult> {
  const [a] = await db.select().from(moderationAppeals).where(eq(moderationAppeals.id, p.appealId));
  if (!a) return { ok: false, code: "not_found", message: "Appeal not found" };
  if (a.status !== "open") return { ok: false, code: "already_resolved", message: "This appeal has already been decided" };

  let subjectTitle = a.subjectType;
  await withAudit(
    { adminId: p.adminId, action: `appeal_${p.decision}`, targetType: "appeal", targetId: a.id, reason: p.reason, details: { subjectType: a.subjectType, subjectId: a.subjectId }, ip: p.ip },
    async () => {
      if (p.decision === "uphold") {
        if (a.subjectType === "event") {
          const [ev] = await db.select().from(events).where(eq(events.id, a.subjectId));
          if (!ev) throw new Error("subject_missing");
          subjectTitle = `"${ev.title}"`;
          await db.update(events).set({ moderationStatus: "approved", queueReason: null, queuedAt: null }).where(eq(events.id, ev.id));
          await db.insert(eventModerations).values({ eventId: ev.id, adminId: p.adminId, action: "appeal_upheld", reason: p.reason, queuedAt: ev.queuedAt });
          invalidateCache.events();
        } else if (a.subjectType === "strike") {
          await db.update(userStrikes).set({ revokedAt: new Date() }).where(and(eq(userStrikes.id, a.subjectId), isNull(userStrikes.revokedAt)));
          subjectTitle = "your strike";
        } else if (a.subjectType === "ban") {
          const [b] = await db.select().from(bans).where(eq(bans.id, a.subjectId));
          if (!b?.userId) throw new Error("subject_missing");
          for (const row of await db.select({ id: bans.id }).from(bans).where(and(eq(bans.userId, b.userId), isNull(bans.liftedAt)))) await liftBan(row.id, p.adminId);
          subjectTitle = "your ban";
        } else if (a.subjectType === "suspension") {
          await db.update(userSuspensions).set({ isActive: false }).where(eq(userSuspensions.id, a.subjectId));
          subjectTitle = "your suspension";
        }
      }
      await db
        .update(moderationAppeals)
        .set({ status: p.decision === "uphold" ? "upheld" : "denied", resolvedBy: p.adminId, resolvedAt: new Date(), resolutionReason: p.reason })
        .where(and(eq(moderationAppeals.id, a.id), eq(moderationAppeals.status, "open")));
    },
  ).catch((e) => {
    if ((e as Error).message === "subject_missing") return "missing" as const;
    throw e;
  });

  const [after] = await db.select({ status: moderationAppeals.status }).from(moderationAppeals).where(eq(moderationAppeals.id, a.id));
  if (after.status === "open") return { ok: false, code: "subject_missing", message: "The thing being appealed no longer exists" };
  deliverNotification({
    userId: a.userId,
    type: "appeal_resolved",
    title: p.decision === "uphold" ? "Your appeal was successful" : "Your appeal was decided",
    message: p.decision === "uphold" ? `We've reversed the decision on ${subjectTitle}. Note from the team: ${p.reason}` : `We reviewed your appeal about ${subjectTitle} and the decision stands. Note from the team: ${p.reason}`,
    link: a.subjectType === "event" ? `/social-events/${a.subjectId}` : "/social-events",
    relatedEntityId: a.subjectId,
  }).catch((e) => console.error("[Moderation] appeal notification failed:", e));
  return { ok: true };
}

// ---------------------------------------------------------------- report management
export async function listEventReports(eventId: string) {
  const rows = await db
    .select({ r: contentReports, username: users.username, abusive: userTrust.abusiveReporterAt })
    .from(contentReports)
    .innerJoin(users, eq(users.id, contentReports.reporterId))
    .leftJoin(userTrust, eq(userTrust.userId, contentReports.reporterId))
    .where(and(eq(contentReports.contentType, "event"), eq(contentReports.contentId, eventId)))
    .orderBy(desc(contentReports.createdAt));
  return rows.map((x) => ({ id: x.r.id, reason: x.r.reason, description: x.r.description, status: x.r.status, createdAt: x.r.createdAt, reporter: { id: x.r.reporterId, username: x.username, markedAbusive: !!x.abusive } }));
}

export async function dismissReport(p: { reportId: string; adminId: string; reason: string; ip?: string | null }): Promise<boolean> {
  const [r] = await db.select().from(contentReports).where(eq(contentReports.id, p.reportId));
  if (!r) return false;
  await withAudit({ adminId: p.adminId, action: "report_dismiss", targetType: "report", targetId: r.id, reason: p.reason, details: { contentType: r.contentType, contentId: r.contentId }, ip: p.ip }, async () => {
    await db.update(contentReports).set({ status: "dismissed", reviewedBy: p.adminId, reviewedAt: new Date(), resolution: p.reason }).where(eq(contentReports.id, r.id));
  });
  return true;
}

// Marks the REPORTER as abusive: their reports stop counting toward auto-hide, and their other
// open reports are dismissed. (If the event was hidden by their reports, it stays in the queue
// for a human, but the queue now shows how many credible reporters remain.)
export async function markAbusiveReporter(p: { reportId: string; adminId: string; reason: string; ip?: string | null }): Promise<{ reporterId: string } | null> {
  const [r] = await db.select().from(contentReports).where(eq(contentReports.id, p.reportId));
  if (!r) return null;
  await withAudit({ adminId: p.adminId, action: "reporter_marked_abusive", targetType: "user", targetId: r.reporterId, reason: p.reason, details: { reportId: r.id }, ip: p.ip }, async () => {
    await db.insert(userTrust).values({ userId: r.reporterId, abusiveReporterAt: new Date(), abusiveReporterBy: p.adminId }).onConflictDoUpdate({ target: userTrust.userId, set: { abusiveReporterAt: new Date(), abusiveReporterBy: p.adminId, updatedAt: new Date() } });
    await db.update(contentReports).set({ status: "dismissed", reviewedBy: p.adminId, reviewedAt: new Date(), resolution: `Abusive reporter: ${p.reason}` }).where(and(eq(contentReports.reporterId, r.reporterId), eq(contentReports.status, "pending")));
  });
  return { reporterId: r.reporterId };
}

// ---------------------------------------------------------------- metrics
export async function getSocialMetrics(days: number) {
  const d = Math.min(Math.max(1, Math.floor(days)), 365);
  const [created, queue, median, takedowns, reportsPerDay, activeBans, newBans, precision, slaHours] = await Promise.all([
    db.select({ visibility: events.visibility, n: sql<number>`count(*)::int` }).from(events).where(and(eq(events.kind, "social"), sql`${events.createdAt} >= now() - make_interval(days => ${d})`)).groupBy(events.visibility),
    db
      .select({ n: sql<number>`count(*)::int`, breached: sql<number>`0::int` })
      .from(events)
      .where(and(eq(events.kind, "social"), eq(events.visibility, "public"), or(inArray(events.moderationStatus, ["pending", "hidden"]), hasOpenAppeal))),
    db.execute(sql`
      select percentile_cont(0.5) within group (order by extract(epoch from (em.created_at - em.queued_at))) as secs, count(*)::int as n
      from event_moderations em join events e on e.id = em.event_id
      where e.kind = 'social' and em.queued_at is not null and em.action in ('approve','reject','restore','remove','request_edit')
        and em.created_at >= now() - make_interval(days => ${d})`),
    db.execute(sql`
      select count(*)::int as n from event_moderations em join events e on e.id = em.event_id
      where e.kind = 'social' and em.action in ('hide','remove','reject') and em.created_at >= now() - make_interval(days => ${d})`),
    db.execute(sql`
      select to_char(date_trunc('day', cr.created_at), 'YYYY-MM-DD') as day, count(*)::int as n
      from content_reports cr join events e on e.id = cr.content_id
      where cr.content_type = 'event' and e.kind = 'social' and cr.created_at >= now() - make_interval(days => ${d})
      group by 1 order by 1`),
    db.select({ n: sql<number>`count(*)::int` }).from(bans).where(and(eq(bans.kind, "user"), isNull(bans.liftedAt))),
    db.select({ n: sql<number>`count(*)::int` }).from(bans).where(and(eq(bans.kind, "user"), sql`${bans.createdAt} >= now() - make_interval(days => ${d})`)),
    db.select({ outcome: events.flagOutcome, n: sql<number>`count(*)::int` }).from(events).where(and(eq(events.kind, "social"), sql`cardinality(${events.autoFlags}) > 0`, sql`${events.flagOutcome} is not null`, sql`${events.createdAt} >= now() - make_interval(days => ${d})`)).groupBy(events.flagOutcome),
    getConfig("queue_sla_hours"),
  ]);
  const med = (median.rows[0] as { secs: number | null; n: number }) ?? { secs: null, n: 0 };
  const approved = precision.find((p) => p.outcome === "approved")?.n ?? 0;
  const rejected = precision.find((p) => p.outcome === "rejected")?.n ?? 0;
  const [breached] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.kind, "social"), eq(events.visibility, "public"), inArray(events.moderationStatus, ["pending", "hidden"]), sql`${events.queuedAt} <= now() - make_interval(hours => ${slaHours})`));
  return {
    days: d,
    eventsCreated: { public: created.find((c) => c.visibility === "public")?.n ?? 0, private: created.find((c) => c.visibility === "private")?.n ?? 0 },
    queue: { size: queue[0]?.n ?? 0, slaHours, slaBreached: breached?.n ?? 0 },
    medianTimeToReviewHours: med.secs === null ? null : Math.round((Number(med.secs) / 3600) * 10) / 10,
    reviewedCount: med.n,
    takedowns: (takedowns.rows[0] as { n: number }).n,
    reportsPerDay: reportsPerDay.rows as Array<{ day: string; n: number }>,
    bans: { active: activeBans[0]?.n ?? 0, newInPeriod: newBans[0]?.n ?? 0 },
    // "Precision": of auto-flagged events that a human has since decided, how many were confirmed bad.
    autoFlagPrecision: { flaggedLaterApproved: approved, flaggedLaterRejected: rejected, precision: approved + rejected > 0 ? Math.round((rejected / (approved + rejected)) * 1000) / 10 : null },
  };
}
