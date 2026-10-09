import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { adminActivityLogs, adminUsers, contentReports, eventModerations, events, guestDataAudit, moderationAppeals, revealGrants, type AdminUser, type RevealGrant } from "@shared/schema";
import { getConfig } from "./moderationConfig";
import { audit, withAudit, MODERATOR_ROLES } from "./adminSecurity";

// Reveal authority. Admin views never show the exact address or guest names. Two ways to see them:
//   1. a super-admin reveals them for ONE event with a reason and a linked case; or
//   2. a super-admin delegates that to a moderator as a GRANT: scoped to one event + case, with a
//      mandatory reason, automatic expiry, revocable at any time, never re-delegable.
// Validity is decided in SQL against the database clock on EVERY use ("expires_at > now()"), so an
// expired or revoked grant stops working immediately. Every creation, use, denial, revocation and
// expiry is audited; every reveal also writes guest_data_audit (who, which grant, what data).

export type CaseRef = { caseType: "report" | "moderation_item"; caseId: string };
type Fail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

// A "case" must really exist and really concern this event.
export async function caseConcernsEvent(eventId: string, c: CaseRef): Promise<boolean> {
  if (c.caseType === "report") {
    const [r] = await db.select({ id: contentReports.id }).from(contentReports).where(and(eq(contentReports.id, c.caseId), eq(contentReports.contentType, "event"), eq(contentReports.contentId, eventId)));
    return !!r;
  }
  if (c.caseId === eventId) return true; // the moderation item IS the event's queue entry
  const [m] = await db.select({ id: eventModerations.id }).from(eventModerations).where(and(eq(eventModerations.id, c.caseId), eq(eventModerations.eventId, eventId)));
  if (m) return true;
  const [a] = await db.select({ id: moderationAppeals.id }).from(moderationAppeals).where(and(eq(moderationAppeals.id, c.caseId), eq(moderationAppeals.subjectType, "event"), eq(moderationAppeals.subjectId, eventId)));
  return !!a;
}

async function socialEvent(eventId: string) {
  const [e] = await db.select().from(events).where(and(eq(events.id, eventId), eq(events.kind, "social")));
  return e;
}

// ---------------------------------------------------------------- grants
export async function createGrant(p: { grantor: AdminUser; granteeId: string; eventId: string; case: CaseRef; reason: string; hours?: number; ip?: string | null }): Promise<{ ok: true; grant: RevealGrant } | Fail> {
  if (p.grantor.role !== "super_admin") return fail(403, "SUPER_ADMIN_ONLY", "Only a super-admin can grant reveal access");
  if (p.granteeId === p.grantor.id) return fail(400, "SELF_GRANT", "You can't grant reveal access to yourself");
  const ev = await socialEvent(p.eventId);
  if (!ev) return fail(404, "EVENT_NOT_FOUND", "Event not found");
  const [grantee] = await db.select().from(adminUsers).where(eq(adminUsers.id, p.granteeId));
  if (!grantee || !grantee.isActive) return fail(404, "GRANTEE_NOT_FOUND", "That admin account doesn't exist or is deactivated");
  if (!MODERATOR_ROLES.includes(grantee.role as never)) return fail(400, "GRANTEE_NOT_MODERATOR", "Reveal access can only be delegated to a moderator");
  if (!(await caseConcernsEvent(p.eventId, p.case))) return fail(400, "CASE_MISMATCH", "That case doesn't exist or isn't about this event");

  const [defaultH, maxH] = await Promise.all([getConfig("reveal_grant_default_hours"), getConfig("reveal_grant_max_hours")]);
  const hours = p.hours ?? defaultH;
  if (!Number.isInteger(hours) || hours < 1) return fail(400, "BAD_DURATION", "Duration must be at least 1 hour");
  if (hours > maxH) return fail(400, "DURATION_TOO_LONG", `Grants can last at most ${maxH} hours`);

  const grant = await withAudit(
    { adminId: p.grantor.id, action: "reveal_grant_created", targetType: "event", targetId: p.eventId, reason: p.reason, details: { granteeId: p.granteeId, grantee: grantee.username, caseType: p.case.caseType, caseId: p.case.caseId, hours }, ip: p.ip },
    async () => {
      // expires_at is computed by the database so it shares a clock with every later validity check.
      const [g] = await db
        .insert(revealGrants)
        .values({ grantorId: p.grantor.id, granteeId: p.granteeId, eventId: p.eventId, caseType: p.case.caseType, caseId: p.case.caseId, reason: p.reason, expiresAt: sql`now() + make_interval(hours => ${hours})` as unknown as Date })
        .returning();
      return g;
    },
  );
  return { ok: true, grant };
}

export async function revokeGrant(p: { admin: AdminUser; grantId: string; reason: string; ip?: string | null }): Promise<{ ok: true } | Fail> {
  if (p.admin.role !== "super_admin") return fail(403, "SUPER_ADMIN_ONLY", "Only a super-admin can revoke reveal access");
  const [g] = await db.select().from(revealGrants).where(eq(revealGrants.id, p.grantId));
  if (!g) return fail(404, "NOT_FOUND", "Grant not found");
  if (g.revokedAt) return fail(409, "ALREADY_REVOKED", "That grant was already revoked");
  await withAudit({ adminId: p.admin.id, action: "reveal_grant_revoked", targetType: "reveal_grant", targetId: g.id, reason: p.reason, details: { eventId: g.eventId, granteeId: g.granteeId }, ip: p.ip }, async () => {
    await db.update(revealGrants).set({ revokedAt: sql`now()` as unknown as Date, revokedBy: p.admin.id }).where(eq(revealGrants.id, g.id));
  });
  return { ok: true };
}

// Writes the expiry entry for every grant that has lapsed and doesn't have one yet. Called by the
// periodic job and lazily before any listing, so the audit trail doesn't depend on someone looking.
export async function logGrantExpiries(): Promise<number> {
  const r = await db.execute(sql`
    insert into admin_activity_logs (admin_id, action, target_type, target_id, reason, details)
    select g.grantor_id, 'reveal_grant_expired', 'reveal_grant', g.id, 'Grant expired automatically',
           json_build_object('eventId', g.event_id, 'granteeId', g.grantee_id, 'expiredAt', g.expires_at)::text
    from reveal_grants g
    where g.revoked_at is null and g.expires_at <= now()
      and not exists (select 1 from admin_activity_logs l where l.action = 'reveal_grant_expired' and l.target_id = g.id)`);
  return r.rowCount ?? 0;
}

const statusSql = sql<string>`case when ${revealGrants.revokedAt} is not null then 'revoked' when ${revealGrants.expiresAt} <= now() then 'expired' else 'active' end`;

export async function listGrantsForSuperAdmin(limit = 200) {
  await logGrantExpiries();
  const rows = await db.execute(sql`
    select g.id, g.event_id as "eventId", e.title as "eventTitle", g.case_type as "caseType", g.case_id as "caseId", g.reason,
           to_char(g.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt", to_char(g.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt", to_char(g.revoked_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "revokedAt",
           ga.display_name as "grantorName", ge.display_name as "granteeName", ge.username as "granteeUsername", g.grantee_id as "granteeId",
           case when g.revoked_at is not null then 'revoked' when g.expires_at <= now() then 'expired' else 'active' end as status,
           greatest(extract(epoch from (g.expires_at - now())), 0)::int as "secondsLeft"
    from reveal_grants g
    join events e on e.id = g.event_id
    join admin_users ga on ga.id = g.grantor_id
    join admin_users ge on ge.id = g.grantee_id
    order by g.created_at desc limit ${limit}`);
  return rows.rows;
}

// A moderator sees only their own live grants (with a countdown), never anyone else's.
export async function listMyActiveGrants(adminId: string) {
  const rows = await db.execute(sql`
    select g.id, g.event_id as "eventId", e.title as "eventTitle", g.case_type as "caseType", g.case_id as "caseId",
           to_char(g.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt", greatest(extract(epoch from (g.expires_at - now())), 0)::int as "secondsLeft"
    from reveal_grants g join events e on e.id = g.event_id
    where g.grantee_id = ${adminId} and g.revoked_at is null and g.expires_at > now()
    order by g.expires_at asc`);
  return rows.rows;
}

// ---------------------------------------------------------------- reveal
export type Scope = "address" | "guests";

export async function revealEventData(p: {
  admin: AdminUser;
  eventId: string;
  scope: Scope;
  grantId?: string;
  case?: CaseRef;
  reason?: string;
  ip?: string | null;
}): Promise<{ ok: true; data: unknown } | Fail> {
  const ev = await socialEvent(p.eventId);
  if (!ev) return fail(404, "EVENT_NOT_FOUND", "Event not found");
  const what = p.scope === "address" ? "exact_address" : "guest_list";

  let actorType: "super_admin" | "grantee";
  let grantId: string | null = null;
  let caseType: string;
  let caseId: string;
  let reason: string;

  if (p.admin.role === "super_admin") {
    if (!p.reason || p.reason.trim().length < 10) return fail(400, "REASON_REQUIRED", "A reason of at least 10 characters is required");
    if (!p.case || !(await caseConcernsEvent(p.eventId, p.case))) return fail(400, "CASE_REQUIRED", "Link a real report or moderation item about this event");
    actorType = "super_admin";
    caseType = p.case.caseType;
    caseId = p.case.caseId;
    reason = p.reason.trim();
  } else if (MODERATOR_ROLES.includes(p.admin.role as never)) {
    if (!p.grantId) return fail(403, "GRANT_REQUIRED", "Reveal access needs a grant from a super-admin");
    // One query decides validity using the database clock; scope, owner, revocation and expiry all inline.
    const [g] = await db
      .select({ g: revealGrants, live: sql<boolean>`(${revealGrants.revokedAt} is null and ${revealGrants.expiresAt} > now())` })
      .from(revealGrants)
      .where(eq(revealGrants.id, p.grantId));
    if (!g || g.g.granteeId !== p.admin.id || g.g.eventId !== p.eventId) {
      await audit({ adminId: p.admin.id, action: "reveal_denied", targetType: "event", targetId: p.eventId, reason: "No valid grant for this event", details: { grantId: p.grantId, scope: what }, ip: p.ip }).catch(() => {});
      return fail(403, "GRANT_NOT_VALID", "You don't have a valid grant for this event");
    }
    if (!g.live) {
      const code = g.g.revokedAt ? "GRANT_REVOKED" : "GRANT_EXPIRED";
      await audit({ adminId: p.admin.id, action: "reveal_denied", targetType: "reveal_grant", targetId: g.g.id, reason: code, details: { eventId: p.eventId, scope: what }, ip: p.ip }).catch(() => {});
      return fail(403, code, code === "GRANT_REVOKED" ? "This grant was revoked" : "This grant has expired");
    }
    actorType = "grantee";
    grantId = g.g.id;
    caseType = g.g.caseType;
    caseId = g.g.caseId;
    reason = g.g.reason;
  } else {
    return fail(403, "NOT_ALLOWED", "Your role can't reveal guest data");
  }

  // Log BEFORE returning anything: no reveal without a record.
  await db.transaction(async (tx) => {
    await tx.insert(guestDataAudit).values({ actorType, actorAdminId: p.admin.id, eventId: ev.id, dataAccessed: what, grantId, caseType, caseId, reason, ipAddress: p.ip ?? null });
    await tx.insert(adminActivityLogs).values({
      adminId: p.admin.id,
      action: actorType === "grantee" ? "reveal_grant_used" : "reveal_super_admin",
      targetType: "event",
      targetId: ev.id,
      reason,
      details: JSON.stringify({ data: what, grantId, caseType, caseId }),
      ipAddress: p.ip ?? null,
    });
  });

  if (p.scope === "address") return { ok: true, data: { address: ev.exactAddress } };
  // JSON only. There is deliberately no export of guest data from the admin side, for any role.
  const guests = await storage.getSocialGuests(ev.id);
  return { ok: true, data: { guests: guests.map((g) => ({ name: g.name, attending: g.attending, plusOneCount: g.plusOneCount, hasAccount: g.hasAccount, removed: g.removed })) } };
}

// ---------------------------------------------------------------- super-admin review view
export async function getRevealActivity(limit = 200) {
  await logGrantExpiries();
  const [reveals, events_] = await Promise.all([
    db
      .select({ a: guestDataAudit, adminName: adminUsers.displayName, adminRole: adminUsers.role })
      .from(guestDataAudit)
      .leftJoin(adminUsers, eq(adminUsers.id, guestDataAudit.actorAdminId))
      .where(inArray(guestDataAudit.actorType, ["super_admin", "grantee"]))
      .orderBy(desc(guestDataAudit.createdAt))
      .limit(limit),
    db
      .select({ l: adminActivityLogs, adminName: adminUsers.displayName })
      .from(adminActivityLogs)
      .innerJoin(adminUsers, eq(adminUsers.id, adminActivityLogs.adminId))
      .where(like(adminActivityLogs.action, "reveal_%"))
      .orderBy(desc(adminActivityLogs.createdAt))
      .limit(limit),
  ]);
  const merged = [
    ...reveals.map((r) => ({ at: r.a.createdAt, kind: "data_revealed" as const, actor: r.adminName, actorRole: r.adminRole, actorType: r.a.actorType, eventId: r.a.eventId, data: r.a.dataAccessed, grantId: r.a.grantId, caseType: r.a.caseType, caseId: r.a.caseId, reason: r.a.reason })),
    ...events_.map((r) => ({ at: r.l.createdAt, kind: r.l.action, actor: r.adminName, actorRole: null as string | null, actorType: null as string | null, eventId: r.l.targetType === "event" ? r.l.targetId : null, data: null as string | null, grantId: r.l.targetType === "reveal_grant" ? r.l.targetId : null, caseType: null as string | null, caseId: null as string | null, reason: r.l.reason })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return merged.slice(0, limit);
}

export function startRevealExpiryJob() {
  const t = setInterval(() => logGrantExpiries().catch((e) => console.error("[Reveal] expiry sweep failed:", e.message)), 5 * 60 * 1000);
  t.unref?.();
}
