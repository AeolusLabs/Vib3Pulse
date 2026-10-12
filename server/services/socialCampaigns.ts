import * as Sentry from "@sentry/node";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  socialCampaigns,
  socialCampaignSends,
  socialPasses,
  events,
  venues,
  venueEntryNights,
  type SocialCampaignSend,
} from "@shared/schema";
import {
  SCHEDULE_CANCEL_CUTOFF_MINUTES,
  SCHEDULE_MIN_GAP_MINUTES,
  SCHEDULE_MIN_LEAD_MINUTES,
  SOCIAL_LAPSE_GRACE_DAYS,
  SOCIAL_PLANS_LAUNCHED_AT,
  SOCIAL_TIER_DEFS,
  isSocialTier,
} from "@shared/socialPlans";
import * as zernioClient from "../zernio";
import { postToSocials, type SocialPromoteResult } from "./socialPromotionService";
import { fail, loadTarget, recheckTarget, type Fail, type TargetInput } from "./promoTargets";
import { sendSocialPlanExpiryEmail, sendSocialPlansNoticeEmail } from "../emailService";
import {
  getActivePass,
  passLimits,
  platformsOverDailyLimit,
  releaseCampaign,
  tryConsumeCampaign,
} from "./socialPlans";
import type { LoadedTarget } from "./promoTargets";

const MINUTE = 60_000;
const STUCK_SEND_MINUTES = 10;
const SEND_BATCH = 20;

export type { Fail };

// ── Create ──────────────────────────────────────────────────────────────────

export interface ScheduleInput extends TargetInput {
  userId: string;
  platforms: string[];
  times: Date[];
  timezone: string;
}

// Books one campaign from the plan allowance and stores each send time. Nothing
// is posted here; the send job does that when each time arrives.
export async function createScheduledCampaign(input: ScheduleInput): Promise<{ ok: true; campaignId: string } | Fail> {
  const { userId } = input;
  const platforms = Array.from(new Set(input.platforms));
  const now = Date.now();

  const loaded = await loadTarget(userId, input);
  if (!loaded.ok) return loaded;
  const { target } = loaded;

  const pass = await getActivePass(userId);
  const limits = pass ? passLimits(pass) : undefined;
  if (!pass || !limits) return fail(402, "NO_PLAN", "Choose a social plan to schedule promotions.");
  const def = limits.def;
  if (platforms.length > limits.maxPlatforms) {
    return fail(403, "PLATFORM_LIMIT", `Your ${def.label} plan allows ${limits.maxPlatforms} platforms.`);
  }

  const unconnected: string[] = [];
  for (const platform of platforms) {
    if (!(await storage.getConnectedSocial(userId, platform))) unconnected.push(platform);
  }
  if (unconnected.length > 0) return fail(400, "NOT_CONNECTED", `Connect these platforms first: ${unconnected.join(", ")}`);

  const times = [...input.times].sort((a, b) => a.getTime() - b.getTime());
  if (times.length < 1) return fail(400, "NO_TIMES", "Pick at least one time.");
  if (times.length > def.timesPerCampaign) {
    return fail(403, "TIMES_LIMIT", `Your ${def.label} plan allows ${def.timesPerCampaign} times per campaign.`);
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i].getTime();
    if (Number.isNaN(t)) return fail(400, "BAD_TIME", "Invalid time.");
    if (t < now + SCHEDULE_MIN_LEAD_MINUTES * MINUTE) {
      return fail(400, "TOO_SOON", `Each time must be at least ${SCHEDULE_MIN_LEAD_MINUTES} minutes from now.`);
    }
    if (target.startsAt && t >= target.startsAt.getTime()) {
      return fail(400, "AFTER_EVENT", "Each time must be before the event starts.");
    }
    if (t >= pass.endsAt.getTime()) {
      return fail(400, "AFTER_PLAN", `Each time must fall within your plan period (ends ${pass.endsAt.toLocaleDateString("en-GB")}).`);
    }
    if (i > 0 && t - times[i - 1].getTime() < SCHEDULE_MIN_GAP_MINUTES * MINUTE) {
      return fail(400, "TOO_CLOSE", `Times must be at least ${SCHEDULE_MIN_GAP_MINUTES} minutes apart.`);
    }
  }

  if (!(await tryConsumeCampaign(pass.id, def.campaignsPerPass))) {
    return fail(403, "NO_CAMPAIGNS_LEFT", `You've used all ${limits.campaigns} campaigns on your ${def.label} plan. A top-up adds more.`);
  }

  try {
    const campaignId = await db.transaction(async (tx) => {
      const [campaign] = await tx.insert(socialCampaigns).values({
        userId, ...target.cols, passId: pass.id, platforms, timezone: input.timezone,
      }).returning();
      await tx.insert(socialCampaignSends).values(
        times.map((runAt, sendIndex) => ({ campaignId: campaign.id, sendIndex, runAt })),
      );
      return campaign.id;
    });
    return { ok: true, campaignId };
  } catch (err) {
    await releaseCampaign(pass.id); // the booking failed — don't keep the allowance
    throw err;
  }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

// Stops every send that hasn't started. The campaign goes back to the allowance only if
// nothing has been posted and the first send is still comfortably in the future.
export async function cancelCampaign(userId: string, campaignId: string): Promise<{ ok: true; allowanceReturned: boolean } | Fail> {
  const [campaign] = await db.select().from(socialCampaigns)
    .where(and(eq(socialCampaigns.id, campaignId), eq(socialCampaigns.userId, userId))).limit(1);
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");
  if (campaign.status === "cancelled") return { ok: true, allowanceReturned: false };

  await db.update(socialCampaigns).set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(eq(socialCampaigns.id, campaignId), eq(socialCampaigns.status, "active")));
  await db.update(socialCampaignSends).set({ status: "cancelled", finishedAt: new Date(), note: "Cancelled by you" })
    .where(and(eq(socialCampaignSends.campaignId, campaignId), eq(socialCampaignSends.status, "scheduled")));

  const sends = await db.select().from(socialCampaignSends).where(eq(socialCampaignSends.campaignId, campaignId));
  const started = sends.some((s) => ["sending", "sent", "partial", "failed"].includes(s.status));
  const firstRunAt = Math.min(...sends.map((s) => s.runAt.getTime()));
  const eligible = !started && firstRunAt - Date.now() >= SCHEDULE_CANCEL_CUTOFF_MINUTES * MINUTE;

  let allowanceReturned = false;
  if (eligible) {
    // The flag makes this happen at most once, even if cancel is hit twice.
    const claimed = await db.update(socialCampaigns).set({ allowanceReleased: true })
      .where(and(eq(socialCampaigns.id, campaignId), eq(socialCampaigns.allowanceReleased, false)))
      .returning({ id: socialCampaigns.id });
    if (claimed.length > 0) {
      await releaseCampaign(campaign.passId);
      allowanceReturned = true;
    }
  }
  return { ok: true, allowanceReturned };
}

// ── List ────────────────────────────────────────────────────────────────────

export interface CampaignView {
  id: string;
  eventId: string | null;
  venueId: string | null;
  venueNightId: string | null;
  eventTitle: string;
  platforms: string[];
  timezone: string;
  status: string;
  createdAt: string;
  sends: Array<{ id: string; sendIndex: number; runAt: string; status: string; note: string | null; postsCreated: number | null }>;
}

export async function listCampaigns(userId: string, filter: TargetInput = {}): Promise<CampaignView[]> {
  const conditions = [eq(socialCampaigns.userId, userId)];
  if (filter.eventId) conditions.push(eq(socialCampaigns.eventId, filter.eventId));
  if (filter.venueNightId) conditions.push(eq(socialCampaigns.venueNightId, filter.venueNightId));
  else if (filter.venueId) conditions.push(eq(socialCampaigns.venueId, filter.venueId));

  const rows = await db.select({ c: socialCampaigns, eventTitle: events.title, venueName: venues.name, nightName: venueEntryNights.name })
    .from(socialCampaigns)
    .leftJoin(events, eq(events.id, socialCampaigns.eventId))
    .leftJoin(venues, eq(venues.id, socialCampaigns.venueId))
    .leftJoin(venueEntryNights, eq(venueEntryNights.id, socialCampaigns.venueNightId))
    .where(and(...conditions))
    .orderBy(desc(socialCampaigns.createdAt))
    .limit(50);
  if (rows.length === 0) return [];

  const sends = await db.select().from(socialCampaignSends)
    .where(inArray(socialCampaignSends.campaignId, rows.map((r) => r.c.id)))
    .orderBy(asc(socialCampaignSends.sendIndex));

  return rows.map(({ c, eventTitle, venueName, nightName }) => ({
    id: c.id,
    eventId: c.eventId,
    venueId: c.venueId,
    venueNightId: c.venueNightId,
    eventTitle: eventTitle ?? (nightName && venueName ? `${nightName} at ${venueName}` : venueName ?? "Promotion"),
    platforms: c.platforms,
    timezone: c.timezone,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    sends: sends.filter((x) => x.campaignId === c.id).map((x) => ({
      id: x.id,
      sendIndex: x.sendIndex,
      runAt: x.runAt.toISOString(),
      status: x.status,
      note: x.note,
      postsCreated: (x.result as SocialPromoteResult | null)?.postsCreated ?? null,
    })),
  }));
}

// ── Send job ────────────────────────────────────────────────────────────────

async function finishSend(id: string, status: string, result: SocialPromoteResult | null, note: string | null): Promise<void> {
  await db.update(socialCampaignSends)
    .set({ status, result: result as any, note, finishedAt: new Date() })
    .where(eq(socialCampaignSends.id, id));
}

// A campaign is "spent" if anything it posted is still standing. If it has nothing left to
// run and every post it made failed (immediately, or later via the Zernio webhook) or it made
// none, the campaign goes back to the plan allowance. Releasing is at most once: the flag +
// WHERE make it idempotent, and this is called again after each late failure.
async function settleCampaign(campaignId: string): Promise<void> {
  const released = await db.execute(sql`
    UPDATE social_campaigns c SET allowance_released = true
    WHERE c.id = ${campaignId} AND c.status = 'active' AND c.allowance_released = false
      AND NOT EXISTS (
        SELECT 1 FROM social_campaign_sends s
        WHERE s.campaign_id = c.id AND s.status IN ('scheduled', 'sending')
      )
      AND NOT EXISTS (
        SELECT 1 FROM social_posts p WHERE p.campaign_id = c.id AND p.status = 'posted'
      )
    RETURNING c.pass_id
  `);
  const passId = (released.rows[0] as { pass_id?: string } | undefined)?.pass_id;
  if (passId) await releaseCampaign(passId);
}

// Called when Zernio tells us (after the fact) that posts failed. Re-derives each affected
// send's status from its posts, then lets the campaign be un-spent if nothing is left standing.
export async function reconcileLateFailures(refs: Array<{ campaign_id: string | null; send_id: string | null }>): Promise<void> {
  const sendIds = Array.from(new Set(refs.map((r) => r.send_id).filter((x): x is string => !!x)));
  const campaignIds = Array.from(new Set(refs.map((r) => r.campaign_id).filter((x): x is string => !!x)));

  for (const sendId of sendIds) {
    const [row] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'posted')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS bad
      FROM social_posts WHERE send_id = ${sendId}
    `)).rows as Array<{ ok: number; bad: number }>;
    const status = row.ok === 0 ? "failed" : row.bad > 0 ? "partial" : "sent";
    await db.execute(sql`
      UPDATE social_campaign_sends SET status = ${status}, note = ${status === "sent" ? null : "Some posts were rejected by the platform"}
      WHERE id = ${sendId} AND status IN ('sent', 'partial')
    `);
  }
  for (const campaignId of campaignIds) await settleCampaign(campaignId);
}

export interface SendOutcome {
  status: string;
  result: SocialPromoteResult | null;
  note: string | null;
}

// Decides what a send should do right now and does it. Never throws for "can't post" cases —
// those are outcomes (skipped / failed) with a reason the organizer can read.
async function decideAndPost(send: SocialCampaignSend): Promise<SendOutcome> {
  const [campaign] = await db.select().from(socialCampaigns).where(eq(socialCampaigns.id, send.campaignId)).limit(1);
  const skip = (note: string): SendOutcome => ({ status: "skipped", result: null, note });
  if (!campaign || campaign.status !== "active") return { status: "cancelled", result: null, note: "Campaign cancelled" };

  const loaded = await recheckTarget(campaign);
  if (!loaded.ok) return skip(loaded.message);
  const { target } = loaded;

  const [pass] = await db.select().from(socialPasses).where(eq(socialPasses.id, campaign.passId)).limit(1);
  if (!pass || pass.endsAt.getTime() <= Date.now()) return skip("Plan ended");

  // X posts once per campaign: at the first send where it actually succeeds.
  const earlier = await db.select({ result: socialCampaignSends.result }).from(socialCampaignSends).where(and(
    eq(socialCampaignSends.campaignId, campaign.id),
    inArray(socialCampaignSends.status, ["sent", "partial"]),
  ));
  const xDone = earlier.some((r) =>
    ((r.result as SocialPromoteResult | null)?.platforms ?? []).some((p) => p.platform === "twitter" && p.success));

  let platforms = campaign.platforms.filter((p) => !(p === "twitter" && xDone));
  const stillConnected: string[] = [];
  for (const p of platforms) {
    if (await storage.getConnectedSocial(campaign.userId, p)) stillConnected.push(p);
  }
  const over = new Set(await platformsOverDailyLimit(campaign.userId, stillConnected));
  platforms = stillConnected.filter((p) => !over.has(p));
  if (platforms.length === 0) return skip("No connected platforms available for this send");

  const result = await postToSocials(target, campaign.userId, platforms as any, { campaignId: campaign.id, sendId: send.id });
  const status = result.postsCreated === 0 ? "failed" : result.failed?.length ? "partial" : "sent";
  return { status, result, note: result.failed?.length ? `Failed: ${result.failed.join(", ")}` : null };
}

async function executeSend(send: SocialCampaignSend): Promise<SendOutcome> {
  let outcome: SendOutcome = { status: "failed", result: null, note: "Unexpected error while posting" };
  try {
    outcome = await decideAndPost(send);
  } catch (err) {
    Sentry.captureException(err, { extra: { sendId: send.id } });
    console.error("[SocialCampaign] send failed:", err instanceof Error ? err.message : err);
  }
  await finishSend(send.id, outcome.status, outcome.result, outcome.note);
  await settleCampaign(send.campaignId);
  return outcome;
}

// "Post now" is a campaign with one send that is due immediately and run on the spot. Going
// through the same path as scheduled sends means one set of rules, and the posts are tied to a
// campaign, so a later Zernio failure can still give the allowance back.
export async function runImmediateCampaign(input: {
  userId: string;
  target: LoadedTarget;
  platforms: string[];
  passId: string;
}): Promise<SendOutcome & { campaignId: string }> {
  const [campaign] = await db.insert(socialCampaigns).values({
    userId: input.userId, ...input.target.cols, passId: input.passId, platforms: input.platforms, timezone: "UTC",
  }).returning();
  const [send] = await db.insert(socialCampaignSends).values({
    campaignId: campaign.id, sendIndex: 0, runAt: new Date(), status: "sending", claimedAt: new Date(), attempts: 1,
  }).returning();
  const outcome = await executeSend(send);
  return { ...outcome, campaignId: campaign.id };
}

// Claim due sends atomically (SKIP LOCKED: another instance can run this at the same
// moment and will get different rows), then run them one at a time.
export async function runDueSends(): Promise<number> {
  const claimed = await db.execute(sql`
    UPDATE social_campaign_sends SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM social_campaign_sends
      WHERE status = 'scheduled' AND run_at <= now()
      ORDER BY run_at
      LIMIT ${SEND_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = claimed.rows.map((r) => (r as { id: string }).id);
  if (ids.length === 0) return 0;

  const sends = await db.select().from(socialCampaignSends).where(inArray(socialCampaignSends.id, ids));
  for (const send of sends) await executeSend(send);
  return sends.length;
}

// A send stuck in 'sending' means the process died mid-post. It is NOT retried: it may
// already have posted, and a duplicate public post is worse than a missed one.
export async function failStuckSends(): Promise<number> {
  const stuck = await db.execute(sql`
    UPDATE social_campaign_sends
    SET status = 'failed', finished_at = now(), note = 'Interrupted while posting'
    WHERE status = 'sending' AND claimed_at < now() - ${STUCK_SEND_MINUTES + " minutes"}::interval
    RETURNING campaign_id
  `);
  const campaignIds = Array.from(new Set(stuck.rows.map((r) => (r as { campaign_id: string }).campaign_id)));
  for (const id of campaignIds) await settleCampaign(id);
  return stuck.rows.length;
}

// ── Plan lifecycle ──────────────────────────────────────────────────────────

// Accounts whose plan ended more than the grace period ago (or that never had one) stop
// costing us: revoked on Zernio, then marked disconnected locally.
export async function disconnectLapsedAccounts(): Promise<number> {
  const grace = `${SOCIAL_LAPSE_GRACE_DAYS} days`;
  const lapsed = await db.execute(sql`
    SELECT cs.user_id, cs.platform, cs.zernio_account_id
    FROM connected_socials cs
    WHERE cs.disconnected_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM social_passes p
        WHERE p.user_id = cs.user_id AND p.ends_at > now() - ${grace}::interval
      )
      AND (
        -- had a plan and it ended more than the grace period ago
        EXISTS (SELECT 1 FROM social_passes p2 WHERE p2.user_id = cs.user_id)
        -- never had one (connected before plans existed): grace counts from launch
        OR GREATEST(cs.connected_at, ${SOCIAL_PLANS_LAUNCHED_AT}::timestamp) < now() - ${grace}::interval
      )
  `);
  for (const row of lapsed.rows as Array<{ user_id: string; platform: string; zernio_account_id: string }>) {
    try {
      await zernioClient.disconnectAccount(row.zernio_account_id);
    } catch (err) {
      console.error(`[SocialLifecycle] Zernio disconnect failed for ${row.user_id}/${row.platform}, disconnecting locally:`,
        err instanceof Error ? err.message : err);
    }
    await storage.disconnectSocial(row.user_id, row.platform);
  }
  return lapsed.rows.length;
}

// One-off passes don't renew, so warn 3 days before they end (once). The marker is set
// first so two instances can't both send; it's cleared again if the email fails.
export async function sendExpiryReminders(): Promise<number> {
  const claimed = await db.execute(sql`
    UPDATE social_passes p SET expiry_reminder_sent_at = now()
    WHERE p.billing = 'one_off' AND p.expiry_reminder_sent_at IS NULL
      AND p.ends_at > now() AND p.ends_at < now() + interval '3 days'
      AND NOT EXISTS (SELECT 1 FROM social_passes q WHERE q.user_id = p.user_id AND q.id <> p.id AND q.ends_at > p.ends_at)
    RETURNING p.id
  `);
  let sent = 0;
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  for (const row of claimed.rows as Array<{ id: string }>) {
    const [pass] = await db.select().from(socialPasses).where(eq(socialPasses.id, row.id)).limit(1);
    const user = pass ? await storage.getUser(pass.userId) : undefined;
    if (!pass || !user?.email || !isSocialTier(pass.tier)) continue;
    const ok = await sendSocialPlanExpiryEmail({
      to: user.email,
      userName: user.displayName || user.username,
      planLabel: SOCIAL_TIER_DEFS[pass.tier].label,
      endsAt: pass.endsAt,
      graceDays: SOCIAL_LAPSE_GRACE_DAYS,
      link: `${base}/organizer/social`,
    });
    if (ok) sent++;
    else await db.update(socialPasses).set({ expiryReminderSentAt: null }).where(eq(socialPasses.id, pass.id));
  }
  return sent;
}

// One-time heads-up to organizers whose accounts were connected before plans existed: those
// accounts are disconnected after the launch grace period unless they pick a plan. The marker
// is set first (so two instances can't both mail) and cleared again if the email fails.
export async function sendLegacyConnectionNotices(): Promise<number> {
  const claimed = await db.execute(sql`
    UPDATE connected_socials cs SET plan_notice_sent_at = now()
    WHERE cs.disconnected_at IS NULL AND cs.plan_notice_sent_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM social_passes p WHERE p.user_id = cs.user_id)
    RETURNING cs.user_id, cs.platform
  `);
  const byUser = new Map<string, string[]>();
  for (const r of claimed.rows as Array<{ user_id: string; platform: string }>) {
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.platform]);
  }

  const cutoff = new Date(new Date(SOCIAL_PLANS_LAUNCHED_AT).getTime() + SOCIAL_LAPSE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  let sent = 0;
  for (const [userId, platforms] of Array.from(byUser.entries())) {
    const user = await storage.getUser(userId);
    const ok = user?.email
      ? await sendSocialPlansNoticeEmail({
          to: user.email,
          userName: user.displayName || user.username,
          platforms,
          cutoff,
          link: `${base}/organizer/social`,
        })
      : false;
    if (ok) sent++;
    else await db.execute(sql`UPDATE connected_socials SET plan_notice_sent_at = NULL WHERE user_id = ${userId}`);
  }
  return sent;
}
