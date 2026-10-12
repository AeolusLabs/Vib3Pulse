import { sql } from "drizzle-orm";
import { db } from "../storage";
import {
  ASSUMED_CARD_FEE_FIXED_GBP,
  ASSUMED_CARD_FEE_PCT,
  ASSUMED_NGN_PER_GBP,
  ASSUMED_USD_PER_GBP,
  ASSUMED_X_USD_PER_POST,
  SOCIAL_TIERS,
  SOCIAL_TIER_DEFS,
  zernioMonthlyBillUsd,
} from "@shared/socialPlans";

type Row = Record<string, any>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const n = (v: unknown) => Number(v ?? 0);

// Everything the admin social screen shows about plans: what came in, what Zernio and X
// are costing us, and the health checks (should-be-zero lists). Costs are ESTIMATES from the
// assumptions in shared/socialPlans.ts, not Zernio's invoice.
export async function getSocialPlanAdminStats() {
  const tierMaxCase = sql.raw(
    `CASE p.tier ${SOCIAL_TIERS.map((t) => `WHEN '${t}' THEN ${SOCIAL_TIER_DEFS[t].maxPlatforms}`).join(" ")} ELSE 0 END`,
  );

  const [plans, revenue, accounts, xPosts, health] = await Promise.all([
    rows(sql`
      SELECT tier, billing, count(*)::int AS n FROM social_passes
      WHERE starts_at <= now() AND ends_at > now() GROUP BY tier, billing`),
    rows(sql`
      SELECT currency, coalesce(sum(gross_amount), 0)::bigint AS total, count(*)::int AS payments
      FROM payment_transactions
      WHERE type = 'social_promotion' AND status = 'succeeded' AND created_at > now() - interval '30 days'
      GROUP BY currency`),
    rows(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE needs_reconnect)::int AS reconnect
             FROM connected_socials WHERE disconnected_at IS NULL`),
    rows(sql`SELECT count(*)::int AS n FROM social_posts
             WHERE platform = 'twitter' AND status = 'posted' AND posted_at > now() - interval '30 days'`),
    rows(sql`
      SELECT
        (SELECT count(*)::int FROM (
           SELECT cs.user_id FROM connected_socials cs
           WHERE cs.disconnected_at IS NULL GROUP BY cs.user_id
           HAVING count(*) > coalesce((
             SELECT max(${tierMaxCase} + p.extra_platforms) FROM social_passes p
             WHERE p.user_id = cs.user_id AND p.starts_at <= now() AND p.ends_at > now()), 0)
         ) over_cap) AS over_cap_users,
        (SELECT count(*)::int FROM social_passes p
           WHERE p.ends_at > now() AND p.ends_at < now() + interval '7 days' AND p.auto_renew = false
             AND NOT EXISTS (SELECT 1 FROM social_passes q WHERE q.user_id = p.user_id AND q.ends_at > p.ends_at)) AS expiring_7d,
        (SELECT count(*)::int FROM social_campaign_sends
           WHERE status = 'scheduled' AND run_at > now() AND run_at < now() + interval '24 hours') AS scheduled_24h,
        (SELECT count(*)::int FROM social_campaign_sends
           WHERE status IN ('failed', 'partial') AND finished_at > now() - interval '7 days') AS failed_sends_7d,
        (SELECT count(*)::int FROM social_campaign_sends
           WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes') AS stuck_sending,
        (SELECT count(*)::int FROM social_posts
           WHERE status = 'posted' AND confirmed_at IS NULL AND posted_at < now() - interval '1 hour'
             AND posted_at > now() - interval '7 days') AS unconfirmed_posts`),
  ]);

  const byTier: Record<string, { recurring: number; one_off: number }> = {};
  for (const t of SOCIAL_TIERS) byTier[t] = { recurring: 0, one_off: 0 };
  for (const p of plans) if (byTier[p.tier]) byTier[p.tier][p.billing as "recurring" | "one_off"] = n(p.n);

  // Revenue → GBP, using the same assumptions the pricing was built on.
  const revenueByCurrency: Record<string, number> = {};
  let revenueGbp = 0;
  let payments = 0;
  for (const r of revenue) {
    const major = n(r.total) / 100;
    revenueByCurrency[r.currency] = major;
    revenueGbp += r.currency === "NGN" ? major / ASSUMED_NGN_PER_GBP : major;
    payments += n(r.payments);
  }

  const accountCount = n(accounts[0]?.n);
  const xPostCount = n(xPosts[0]?.n);
  const zernioUsd = zernioMonthlyBillUsd(accountCount);
  const xUsd = xPostCount * ASSUMED_X_USD_PER_POST;
  const zernioGbp = zernioUsd / ASSUMED_USD_PER_GBP;
  const xGbp = xUsd / ASSUMED_USD_PER_GBP;
  const cardFeesGbp = revenueGbp * ASSUMED_CARD_FEE_PCT + payments * ASSUMED_CARD_FEE_FIXED_GBP;
  const costGbp = zernioGbp + xGbp + cardFeesGbp;
  const marginGbp = revenueGbp - costGbp;
  const h = health[0] ?? {};

  return {
    activePlans: { total: plans.reduce((s, p) => s + n(p.n), 0), byTier },
    revenue30d: { byCurrency: revenueByCurrency, gbp: round(revenueGbp), payments },
    costs30d: {
      zernioAccountsBilled: accountCount,
      zernioGbp: round(zernioGbp),
      xPosts: xPostCount,
      xGbp: round(xGbp),
      cardFeesGbp: round(cardFeesGbp),
      totalGbp: round(costGbp),
    },
    marginGbp: round(marginGbp),
    marginPct: revenueGbp > 0 ? Math.round((marginGbp / revenueGbp) * 100) : null,
    health: {
      overCapUsers: n(h.over_cap_users),
      needsReconnect: n(accounts[0]?.reconnect),
      expiring7d: n(h.expiring_7d),
      scheduled24h: n(h.scheduled_24h),
      failedSends7d: n(h.failed_sends_7d),
      stuckSending: n(h.stuck_sending),
      unconfirmedPosts: n(h.unconfirmed_posts),
    },
    assumptions: {
      usdPerGbp: ASSUMED_USD_PER_GBP,
      ngnPerGbp: ASSUMED_NGN_PER_GBP,
      xUsdPerPost: ASSUMED_X_USD_PER_POST,
      cardFeePct: ASSUMED_CARD_FEE_PCT,
      cardFeeFixedGbp: ASSUMED_CARD_FEE_FIXED_GBP,
    },
  };
}

const round = (v: number) => Math.round(v * 100) / 100;
