import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import { adminUsers, events, moderationConfig } from "@shared/schema";
import { getConfig, invalidateConfigCache } from "./moderationConfig";

// Alerts admins when the moderation queue has items older than queue_sla_hours. It emails every
// active moderator/admin/super-admin, at most once per cooldown, so a long backlog doesn't spam.
// (The queue page and dashboard also show the breach count live; this is the push.)

const ALERT_COOLDOWN_MS = 6 * 3600 * 1000;
const LAST_ALERT_KEY = "internal_sla_last_alert_ms";

export type SlaMailer = (to: string, info: { count: number; oldestHours: number; slaHours: number }) => Promise<unknown>;
let mailer: SlaMailer | null = null;
export function setSlaMailerForTests(m: SlaMailer | null) {
  mailer = m;
}
async function defaultMailer(to: string, info: { count: number; oldestHours: number; slaHours: number }) {
  const { sendQueueSlaAlertEmail } = await import("../emailService");
  return sendQueueSlaAlertEmail({ to, ...info, link: `${process.env.APP_URL || ""}/admin/moderation` });
}

export async function checkQueueSla(): Promise<{ breached: number; oldestHours: number; alerted: boolean; recipients: number }> {
  const slaHours = await getConfig("queue_sla_hours");
  const [b] = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<number>`coalesce(max(extract(epoch from (now() - ${events.queuedAt})) / 3600), 0)::float` })
    .from(events)
    .where(and(eq(events.kind, "social"), eq(events.visibility, "public"), inArray(events.moderationStatus, ["pending", "hidden"]), sql`${events.queuedAt} <= now() - make_interval(hours => ${slaHours})`));
  const breached = b?.n ?? 0;
  if (breached === 0) return { breached: 0, oldestHours: 0, alerted: false, recipients: 0 };

  const [last] = await db.select().from(moderationConfig).where(eq(moderationConfig.key, LAST_ALERT_KEY));
  const lastMs = typeof last?.value === "number" ? last.value : 0;
  if (Date.now() - lastMs < ALERT_COOLDOWN_MS) return { breached, oldestHours: b.oldest, alerted: false, recipients: 0 };

  const people = await db.select({ email: adminUsers.email }).from(adminUsers).where(and(eq(adminUsers.isActive, true), inArray(adminUsers.role, ["super_admin", "admin", "content_moderator", "event_reviewer"])));
  const send = mailer ?? defaultMailer;
  const info = { count: breached, oldestHours: Math.round(b.oldest), slaHours };
  let sent = 0;
  for (const p of people) {
    try { await send(p.email, info); sent++; } catch (e) { console.error("[SLA] alert email failed:", (e as Error).message); }
  }
  // Record the alert even if every send failed, so a broken mailer doesn't retry every 15 minutes.
  await db.insert(moderationConfig).values({ key: LAST_ALERT_KEY, value: Date.now() as never }).onConflictDoUpdate({ target: moderationConfig.key, set: { value: Date.now() as never, updatedAt: new Date() } });
  invalidateConfigCache();
  return { breached, oldestHours: b.oldest, alerted: true, recipients: sent };
}

export function startModerationSlaJob() {
  const t = setInterval(() => checkQueueSla().catch((e) => console.error("[SLA] check failed:", e.message)), 15 * 60 * 1000);
  t.unref?.();
}
