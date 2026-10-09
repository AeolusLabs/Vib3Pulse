import { and, count, eq, gte, inArray, isNotNull, isNull, or, gt, sql } from "drizzle-orm";
import { db } from "../storage";
import { invalidateCache } from "../cache";
import { bans, contentReports, events, userStrikes, userTrust, users, type HostTrustTier } from "@shared/schema";
import { getConfig } from "./moderationConfig";
import { isBanned } from "./enforcement";
import { scanContent, hasBlockingFlag, type ContentFlag } from "./contentScan";

// Policy for PUBLIC social events: who may host, how new hosts are throttled and reviewed,
// when content is blocked vs queued, when reports auto-hide an event, who may be featured.
// Every threshold comes from moderation_config (admin-editable), never a constant here.

const DAY_MS = 24 * 3600 * 1000;

export type TrustInfo = { tier: HostTrustTier; isNew: boolean; ageDays: number };

// The single definition of a host's effective tier, shared by hosting checks and the admin queue.
export function computeTier(p: {
  ageDays: number;
  override: HostTrustTier | null; // explicit admin override, if any
  windowDays: number;
  cleanEvents: number; // completed, approved public events
  needCleanEvents: number;
  activeStrikes: number;
}): HostTrustTier {
  if (p.override) return p.override;
  if (p.ageDays < p.windowDays) return "new";
  if (p.needCleanEvents > 0 && p.cleanEvents >= p.needCleanEvents && p.activeStrikes === 0) return "trusted";
  return "standard";
}

// Tier precedence: an explicit admin override always wins; otherwise
//   new      = account younger than new_account_window_days
//   trusted  = >= trusted_after_clean_events completed approved public events and no active strikes
//   standard = everyone else
export async function getTrustInfo(user: { id: string; createdAt: Date }): Promise<TrustInfo> {
  const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / DAY_MS;
  const [row] = await db.select().from(userTrust).where(eq(userTrust.userId, user.id));
  if (row?.tierOverrideAt) {
    const tier = row.trustTier as HostTrustTier;
    return { tier, isNew: tier === "new", ageDays };
  }
  const window = await getConfig("new_account_window_days");
  if (ageDays < window) return { tier: "new", isNew: true, ageDays };

  const need = await getConfig("trusted_after_clean_events");
  if (need > 0) {
    const [done] = await db
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.organizerId, user.id), eq(events.kind, "social"), eq(events.visibility, "public"), eq(events.moderationStatus, "approved"), sql`${events.eventDate} < now()`));
    if (Number(done.n) >= need && (await activeStrikeCount(user.id)) === 0) return { tier: "trusted", isNew: false, ageDays };
  }
  return { tier: "standard", isNew: false, ageDays };
}

async function activeStrikeCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(userStrikes)
    .where(and(eq(userStrikes.userId, userId), eq(userStrikes.type, "strike"), isNull(userStrikes.revokedAt), or(isNull(userStrikes.expiresAt), gt(userStrikes.expiresAt, new Date()))));
  return Number(r.n);
}

export type HostCheck =
  | { ok: true; trust: TrustInfo }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

export async function checkCanHostPublic(user: { id: string; createdAt: Date; verifiedPhone: string | null; phoneVerifiedAt: Date | null }, deviceHash?: string | null): Promise<HostCheck> {
  if (await isBanned({ userId: user.id, verifiedPhone: user.verifiedPhone, deviceHash })) {
    return { ok: false, status: 403, code: "BANNED", message: "You can't host public events on this account." };
  }
  if (!user.verifiedPhone || !user.phoneVerifiedAt) {
    return { ok: false, status: 403, code: "PHONE_NOT_VERIFIED", message: "Verify your phone number to host a public event." };
  }
  const minAge = await getConfig("min_account_age_days");
  const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / DAY_MS;
  if (ageDays < minAge) {
    const daysRemaining = Math.ceil(minAge - ageDays);
    return { ok: false, status: 403, code: "ACCOUNT_TOO_NEW", message: `Accounts need to be ${minAge} day${minAge === 1 ? "" : "s"} old to host a public event. Try again in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}.`, details: { daysRemaining } };
  }
  const trust = await getTrustInfo(user);
  if (trust.isNew) {
    const limit = await getConfig("new_account_weekly_public_limit");
    const [r] = await db
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.organizerId, user.id), eq(events.kind, "social"), eq(events.visibility, "public"), gte(events.createdAt, new Date(Date.now() - 7 * DAY_MS))));
    if (Number(r.n) >= limit) {
      return { ok: false, status: 429, code: "WEEKLY_LIMIT", message: `New accounts can create ${limit} public event${limit === 1 ? "" : "s"} per week. Try again later, or host a private event.` };
    }
  }
  return { ok: true, trust };
}

export type ContentFields = {
  title?: string | null;
  description?: string | null;
  location?: string | null;
  dressCode?: string | null;
  schedule?: Array<{ name: string; time?: string }> | null;
};

export type ContentVerdict =
  | { action: "block"; flags: ContentFlag[] }
  | { action: "queue"; flags: ContentFlag[]; reason: "new_account_review" | "auto_flag" }
  | { action: "publish"; flags: ContentFlag[] };

// What happens to a public event's text.
//   new tier      : links / contact details are rejected outright; anything else is held for review
//   standard      : links / contact details are flagged into the queue (not rejected)
//   trusted       : only the free-entry-to-payment check applies
//   free-entry-to-payment is queued for every tier.
export async function judgeContent(c: ContentFields, trust: TrustInfo): Promise<ContentVerdict> {
  const patterns = await getConfig("blocked_patterns");
  const flags = scanContent([c.title, c.description, c.location, c.dressCode, ...(c.schedule ?? []).flatMap((s) => [s.name, s.time])], patterns);
  const relevant = trust.tier === "trusted" ? flags.filter((f) => f === "free_entry_payment") : flags;

  if (trust.isNew && hasBlockingFlag(relevant)) return { action: "block", flags: relevant };
  if (relevant.length > 0) return { action: "queue", flags: relevant, reason: "auto_flag" };
  if (trust.isNew) return { action: "queue", flags: [], reason: "new_account_review" };
  return { action: "publish", flags: [] };
}

// ---------------------------------------------------------------- reports → takedown
// Distinct reporters (the DB unique key already stops one account reporting twice), minus
// reporters an admin has marked abusive so report-bombing can't take an event down.
export async function countCredibleReporters(eventId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${contentReports.reporterId})::int` })
    .from(contentReports)
    .leftJoin(userTrust, eq(userTrust.userId, contentReports.reporterId))
    .where(and(eq(contentReports.contentType, "event"), eq(contentReports.contentId, eventId), isNull(userTrust.abusiveReporterAt), sql`${contentReports.status} <> 'dismissed'`));
  return Number(r.n);
}

// Returns true when this call is the one that hid the event.
export async function hideIfReportThresholdMet(eventId: string): Promise<boolean> {
  const threshold = await getConfig("report_auto_hide_threshold");
  if (threshold <= 0) return false;
  if ((await countCredibleReporters(eventId)) < threshold) return false;
  const hidden = await db
    .update(events)
    .set({ moderationStatus: "hidden", queueReason: "report_threshold", queuedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.kind, "social"), eq(events.moderationStatus, "approved")))
    .returning({ id: events.id });
  if (hidden.length > 0) invalidateCache.events(); // discovery list is cached for 10 minutes
  return hidden.length > 0;
}

// ---------------------------------------------------------------- featured placement
// A host is featurable only with a clean history: not banned, no active strikes, never had a
// public event rejected/removed, and not a 'new' tier, unless an admin set an explicit override
// (which then wins in both directions).
export async function getFeaturableHostIds(hostIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(hostIds));
  if (ids.length === 0) return new Set();
  const [people, trustRows, struck, banned, burned] = await Promise.all([
    db.select({ id: users.id, createdAt: users.createdAt }).from(users).where(inArray(users.id, ids)),
    db.select().from(userTrust).where(inArray(userTrust.userId, ids)),
    db.selectDistinct({ id: userStrikes.userId }).from(userStrikes).where(and(inArray(userStrikes.userId, ids), eq(userStrikes.type, "strike"), isNull(userStrikes.revokedAt), or(isNull(userStrikes.expiresAt), gt(userStrikes.expiresAt, new Date())))),
    db.selectDistinct({ id: bans.valueHash }).from(bans).where(and(eq(bans.kind, "user"), inArray(bans.valueHash, ids), isNull(bans.liftedAt))),
    db.selectDistinct({ id: events.organizerId }).from(events).where(and(inArray(events.organizerId, ids), eq(events.kind, "social"), inArray(events.moderationStatus, ["rejected", "removed"]))),
  ]);
  const window = await getConfig("new_account_window_days");
  const trustBy = new Map(trustRows.map((t) => [t.userId, t]));
  const dirty = new Set(struck.concat(banned, burned).map((r) => r.id));
  const out = new Set<string>();
  for (const p of people) {
    const t = trustBy.get(p.id);
    if (t?.featuredOverrideAt) {
      if (t.featuredEligible) out.add(p.id);
      continue;
    }
    const ageDays = (Date.now() - new Date(p.createdAt).getTime()) / DAY_MS;
    const tierNew = t?.tierOverrideAt ? t.trustTier === "new" : ageDays < window;
    if (!dirty.has(p.id) && !tierNew) out.add(p.id);
  }
  return out;
}

// ---------------------------------------------------------------- age gate
export function ageFromDob(dob: string | null | undefined, now = new Date()): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const d = new Date(dob.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export const minAgeFor = (restriction: string): number => (restriction === "21+" ? 21 : restriction === "18+" ? 18 : 0);
