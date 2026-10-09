import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../storage";
import { deliverNotification } from "../notifications";
import { invalidateCache } from "../cache";
import { adminUsers, bans, contentReports, events, moderationAppeals, userStrikes, userSuspensions, userTrust, users, type HostTrustTier } from "@shared/schema";
import { getConfig } from "./moderationConfig";
import { computeTier, getFeaturableHostIds } from "./eventAbuse";
import { addStrike, banUser, getLinkedAccounts, liftBan } from "./enforcement";
import { withAudit } from "./adminSecurity";

// Host controls for the admin side. Every mutation needs a reason, is audited before it runs,
// and (where it affects the host) notifies them with that reason and where to appeal.
// Phone numbers are never shown in full: last four digits and a verified flag only.

const DAY = 86400000;

export async function searchHosts(q: string) {
  const term = `%${q.trim()}%`;
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, createdAt: users.createdAt, isVerified: users.isVerified, phoneVerifiedAt: users.phoneVerifiedAt, deletedAt: users.deletedAt })
    .from(users)
    .where(or(ilike(users.username, term), ilike(users.displayName, term), ilike(users.email, term)))
    .orderBy(desc(users.createdAt))
    .limit(20);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [counts, banned] = await Promise.all([
    db.select({ organizerId: events.organizerId, n: sql<number>`count(*)::int` }).from(events).where(and(inArray(events.organizerId, ids), eq(events.kind, "social"))).groupBy(events.organizerId),
    db.select({ id: bans.valueHash }).from(bans).where(and(eq(bans.kind, "user"), inArray(bans.valueHash, ids), isNull(bans.liftedAt))),
  ]);
  const cBy = new Map(counts.map((c) => [c.organizerId, c.n]));
  const bSet = new Set(banned.map((b) => b.id));
  return rows.map((r) => ({ ...r, phoneVerified: !!r.phoneVerifiedAt, deleted: !!r.deletedAt, socialEvents: cBy.get(r.id) ?? 0, banned: bSet.has(r.id), accountAgeDays: Math.floor((Date.now() - new Date(r.createdAt).getTime()) / DAY) }));
}

export async function getHostProfile(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const [windowDays, needClean] = await Promise.all([getConfig("new_account_window_days"), getConfig("trusted_after_clean_events")]);
  const [[t], strikes, banRows, suspensions, evs, linked, received, appeals, feat] = await Promise.all([
    db.select().from(userTrust).where(eq(userTrust.userId, userId)),
    db.select({ s: userStrikes, adminName: adminUsers.displayName }).from(userStrikes).innerJoin(adminUsers, eq(adminUsers.id, userStrikes.adminId)).where(eq(userStrikes.userId, userId)).orderBy(desc(userStrikes.createdAt)),
    db.select().from(bans).where(and(eq(bans.userId, userId))).orderBy(desc(bans.createdAt)),
    db.select().from(userSuspensions).where(eq(userSuspensions.userId, userId)).orderBy(desc(userSuspensions.createdAt)),
    db.select({ id: events.id, title: events.title, visibility: events.visibility, moderationStatus: events.moderationStatus, eventDate: events.eventDate, createdAt: events.createdAt, headcount: events.ticketsSold, capacity: events.ticketsAvailable }).from(events).where(and(eq(events.organizerId, userId), eq(events.kind, "social"))).orderBy(desc(events.createdAt)).limit(50),
    getLinkedAccounts(userId),
    db.select({ reason: contentReports.reason, n: sql<number>`count(*)::int` }).from(contentReports).innerJoin(events, eq(events.id, contentReports.contentId)).where(and(eq(contentReports.contentType, "event"), eq(events.organizerId, userId))).groupBy(contentReports.reason),
    db.select().from(moderationAppeals).where(and(eq(moderationAppeals.userId, userId), eq(moderationAppeals.status, "open"))),
    getFeaturableHostIds([userId]),
  ]);
  const activeStrikes = strikes.filter((x) => x.s.type === "strike" && !x.s.revokedAt && (!x.s.expiresAt || new Date(x.s.expiresAt) > new Date())).length;
  const cleanEvents = evs.filter((e) => e.moderationStatus === "approved" && e.visibility === "public" && new Date(e.eventDate) < new Date()).length;
  const ageDays = (Date.now() - new Date(u.createdAt).getTime()) / DAY;
  const tier = computeTier({ ageDays, override: t?.tierOverrideAt ? (t.trustTier as HostTrustTier) : null, windowDays, cleanEvents, needCleanEvents: needClean, activeStrikes });
  const linkedWithBans = linked.length
    ? await db.select({ id: bans.valueHash }).from(bans).where(and(eq(bans.kind, "user"), inArray(bans.valueHash, linked.map((l) => l.userId)), isNull(bans.liftedAt)))
    : [];
  const linkedBanned = new Set(linkedWithBans.map((b) => b.id));
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    createdAt: u.createdAt,
    accountAgeDays: Math.floor(ageDays),
    emailVerified: u.isVerified,
    phone: { verified: !!u.phoneVerifiedAt, last4: u.verifiedPhone ? u.verifiedPhone.slice(-4) : null },
    deleted: !!u.deletedAt,
    trust: {
      tier,
      override: t?.tierOverrideAt ? { tier: t.trustTier, reason: t.tierOverrideReason, at: t.tierOverrideAt } : null,
      featuredEligible: feat.has(userId),
      featuredOverride: t?.featuredOverrideAt ? { eligible: t.featuredEligible, reason: t.featuredOverrideReason, at: t.featuredOverrideAt } : null,
      abusiveReporter: !!t?.abusiveReporterAt,
    },
    strikes: strikes.map((x) => ({ id: x.s.id, type: x.s.type, reason: x.s.reason, eventId: x.s.eventId, by: x.adminName, createdAt: x.s.createdAt, expiresAt: x.s.expiresAt, revokedAt: x.s.revokedAt, active: x.s.type === "strike" && !x.s.revokedAt && (!x.s.expiresAt || new Date(x.s.expiresAt) > new Date()) })),
    activeStrikes,
    bans: banRows.map((b) => ({ id: b.id, kind: b.kind, reason: b.reason, createdAt: b.createdAt, liftedAt: b.liftedAt })), // hashes are never exposed
    banned: banRows.some((b) => b.kind === "user" && !b.liftedAt),
    suspensions: suspensions.map((s) => ({ id: s.id, reason: s.reason, active: s.isActive, permanent: s.isPermanent, until: s.suspendedUntil, createdAt: s.createdAt })),
    linkedAccounts: linked.map((l) => ({ ...l, banned: linkedBanned.has(l.userId) })),
    events: evs,
    reportsReceived: { total: received.reduce((s, r) => s + r.n, 0), byReason: received.sort((a, b) => b.n - a.n) },
    openAppeals: appeals.map((a) => ({ id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, message: a.message, createdAt: a.createdAt })),
  };
}

const APPEAL_NOTE = "If you think this is a mistake you can appeal from your Invitations page.";

function notifyHost(userId: string, title: string, message: string, link = "/social-events") {
  deliverNotification({ userId, type: "host_sanction", title, message, link }).catch((e) => console.error("[Hosts] notification failed:", e));
}

export async function issueStrike(p: { adminId: string; userId: string; type: "warn" | "strike"; reason: string; eventId?: string | null; expiresInDays?: number | null; ip?: string | null }) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
  if (!u) return null;
  const expiresAt = p.expiresInDays ? new Date(Date.now() + p.expiresInDays * DAY) : null;
  const result = await withAudit({ adminId: p.adminId, action: p.type === "warn" ? "host_warn" : "host_strike", targetType: "user", targetId: p.userId, reason: p.reason, details: { eventId: p.eventId ?? null, expiresInDays: p.expiresInDays ?? null }, ip: p.ip }, () =>
    addStrike({ userId: p.userId, eventId: p.eventId ?? null, type: p.type, reason: p.reason, adminId: p.adminId, expiresAt }),
  );
  notifyHost(p.userId, p.type === "warn" ? "You've received a warning" : result.autoBanned ? "Your account has been banned from hosting" : "You've received a strike", p.type === "warn" ? `Reason: ${p.reason}. ${APPEAL_NOTE}` : result.autoBanned ? `Reason: ${p.reason}. This was your final strike, so hosting is now disabled. ${APPEAL_NOTE}` : `Reason: ${p.reason}. Repeated strikes lead to a ban from hosting. ${APPEAL_NOTE}`);
  if (result.autoBanned) invalidateCache.events();
  return result;
}

export async function revokeStrike(p: { adminId: string; strikeId: string; reason: string; ip?: string | null }) {
  const [s] = await db.select().from(userStrikes).where(eq(userStrikes.id, p.strikeId));
  if (!s || s.revokedAt) return null;
  await withAudit({ adminId: p.adminId, action: "strike_revoked", targetType: "user", targetId: s.userId, reason: p.reason, details: { strikeId: s.id }, ip: p.ip }, async () => {
    await db.update(userStrikes).set({ revokedAt: new Date() }).where(eq(userStrikes.id, s.id));
  });
  return s;
}

export async function banHost(p: { adminId: string; userId: string; reason: string; ip?: string | null }) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
  if (!u) return null;
  const r = await withAudit({ adminId: p.adminId, action: "host_ban", targetType: "user", targetId: p.userId, reason: p.reason, ip: p.ip }, () => banUser({ userId: p.userId, reason: p.reason, adminId: p.adminId }));
  notifyHost(p.userId, "Your account has been banned from hosting", `Reason: ${p.reason}. Your public events were hidden. ${APPEAL_NOTE}`);
  return r;
}

export async function liftBanById(p: { adminId: string; banId: string; reason: string; ip?: string | null }) {
  const [b] = await db.select().from(bans).where(eq(bans.id, p.banId));
  if (!b || b.liftedAt) return null;
  await withAudit({ adminId: p.adminId, action: "ban_lifted", targetType: "user", targetId: b.userId ?? b.id, reason: p.reason, details: { banId: b.id, kind: b.kind }, ip: p.ip }, async () => {
    await liftBan(b.id, p.adminId);
  });
  return b;
}

// Tier / featured overrides. null clears the override and returns the host to the computed value.
export async function setTierOverride(p: { adminId: string; userId: string; tier: HostTrustTier | null; reason: string; ip?: string | null }) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
  if (!u) return false;
  await withAudit({ adminId: p.adminId, action: "trust_tier_override", targetType: "user", targetId: p.userId, reason: p.reason, details: { tier: p.tier }, ip: p.ip }, async () => {
    const set = p.tier
      ? { trustTier: p.tier, tierOverrideBy: p.adminId, tierOverrideReason: p.reason, tierOverrideAt: new Date(), updatedAt: new Date() }
      : { trustTier: "new", tierOverrideBy: null, tierOverrideReason: null, tierOverrideAt: null, updatedAt: new Date() };
    await db.insert(userTrust).values({ userId: p.userId, ...set }).onConflictDoUpdate({ target: userTrust.userId, set });
  });
  return true;
}

export async function setFeaturedOverride(p: { adminId: string; userId: string; eligible: boolean | null; reason: string; ip?: string | null }) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
  if (!u) return false;
  await withAudit({ adminId: p.adminId, action: "featured_override", targetType: "user", targetId: p.userId, reason: p.reason, details: { eligible: p.eligible }, ip: p.ip }, async () => {
    const set =
      p.eligible === null
        ? { featuredEligible: false, featuredOverrideBy: null, featuredOverrideReason: null, featuredOverrideAt: null, updatedAt: new Date() }
        : { featuredEligible: p.eligible, featuredOverrideBy: p.adminId, featuredOverrideReason: p.reason, featuredOverrideAt: new Date(), updatedAt: new Date() };
    await db.insert(userTrust).values({ userId: p.userId, ...set }).onConflictDoUpdate({ target: userTrust.userId, set });
  });
  invalidateCache.events();
  return true;
}

export async function setAbusiveReporter(p: { adminId: string; userId: string; abusive: boolean; reason: string; ip?: string | null }) {
  await withAudit({ adminId: p.adminId, action: p.abusive ? "reporter_marked_abusive" : "reporter_unmarked", targetType: "user", targetId: p.userId, reason: p.reason, ip: p.ip }, async () => {
    const set = p.abusive ? { abusiveReporterAt: new Date(), abusiveReporterBy: p.adminId, updatedAt: new Date() } : { abusiveReporterAt: null, abusiveReporterBy: null, updatedAt: new Date() };
    await db.insert(userTrust).values({ userId: p.userId, ...set }).onConflictDoUpdate({ target: userTrust.userId, set });
  });
}
