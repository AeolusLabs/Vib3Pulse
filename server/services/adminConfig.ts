import { eq } from "drizzle-orm";
import { db } from "../storage";
import { adminUsers, moderationConfig, MODERATION_CONFIG_DEFAULTS, type AdminRole, type ModerationConfigKey } from "@shared/schema";
import { getConfig, invalidateConfigCache } from "./moderationConfig";
import { withAudit } from "./adminSecurity";

// Admin-editable moderation thresholds. Every change is validated, requires a reason, and is
// written to the audit log (with before/after) before it takes effect. Keys that govern reveal
// authority can only be changed by a super-admin: otherwise an admin could quietly lengthen the
// window a delegated grant stays open.

type Meta = { label: string; help: string; kind: "int" | "list"; min?: number; max?: number; superOnly?: boolean };

export const CONFIG_META: Record<ModerationConfigKey, Meta> = {
  report_auto_hide_threshold: { label: "Reports to auto-hide", help: "Distinct credible reporters that hide a public event pending review.", kind: "int", min: 1, max: 100 },
  new_account_weekly_public_limit: { label: "New-account public events per week", help: "How many public events a new account may create in 7 days.", kind: "int", min: 0, max: 50 },
  min_account_age_days: { label: "Minimum account age to host publicly (days)", help: "Accounts younger than this can't create public events.", kind: "int", min: 0, max: 365 },
  new_account_window_days: { label: "'New account' window (days)", help: "Accounts younger than this are the 'new' trust tier: held for review, links blocked.", kind: "int", min: 0, max: 365 },
  guest_data_retention_days: { label: "Guest data retention (days after the event)", help: "Guest names and RSVPs are deleted this long after the event.", kind: "int", min: 1, max: 365 },
  blocked_patterns: { label: "Blocked words and patterns", help: "Text that new accounts can't use in public events (links, messaging apps, contact phrases).", kind: "list" },
  reveal_grant_default_hours: { label: "Reveal grant default expiry (hours)", help: "Default life of a delegated reveal grant.", kind: "int", min: 1, max: 720, superOnly: true },
  reveal_grant_max_hours: { label: "Reveal grant hard maximum (hours)", help: "No grant can ever last longer than this.", kind: "int", min: 1, max: 720, superOnly: true },
  queue_sla_hours: { label: "Queue SLA (hours)", help: "Items older than this raise an alert.", kind: "int", min: 1, max: 720 },
  strikes_for_auto_ban: { label: "Strikes before automatic ban", help: "Active strikes that ban a host (0 turns auto-ban off).", kind: "int", min: 0, max: 20 },
  guest_data_hold_extra_days: { label: "Extra retention while a case is open (days)", help: "Guest data normally goes at the retention limit. If a moderation case about the event is still open it may be kept this much longer, then it goes regardless.", kind: "int", min: 0, max: 365 },
  trusted_after_clean_events: { label: "Clean events to become 'trusted'", help: "Completed approved public events (no strikes) before a host counts as trusted (0 disables).", kind: "int", min: 0, max: 100 },
};

export type ConfigEntry = { key: ModerationConfigKey; label: string; help: string; kind: "int" | "list"; value: unknown; default: unknown; min?: number; max?: number; superOnly: boolean; editable: boolean; updatedBy: string | null; updatedAt: Date | null };

export async function listConfigWithValues(role: AdminRole): Promise<ConfigEntry[]> {
  const rows = await db.select({ c: moderationConfig, by: adminUsers.displayName }).from(moderationConfig).leftJoin(adminUsers, eq(adminUsers.id, moderationConfig.updatedBy));
  const byKey = new Map(rows.map((r) => [r.c.key, r]));
  const keys = Object.keys(CONFIG_META) as ModerationConfigKey[];
  return Promise.all(
    keys.map(async (key) => {
      const m = CONFIG_META[key];
      const row = byKey.get(key);
      return { key, label: m.label, help: m.help, kind: m.kind, min: m.min, max: m.max, superOnly: !!m.superOnly, editable: !m.superOnly || role === "super_admin", value: await getConfig(key), default: MODERATION_CONFIG_DEFAULTS[key], updatedBy: row?.by ?? null, updatedAt: row?.c.updatedAt ?? null };
    }),
  );
}

export type SetResult = { ok: true; before: unknown; after: unknown } | { ok: false; status: number; code: string; message: string };

export async function setConfigValue(p: { adminId: string; role: AdminRole; key: string; value: unknown; reason: string; ip?: string | null }): Promise<SetResult> {
  const meta = CONFIG_META[p.key as ModerationConfigKey];
  if (!meta) return { ok: false, status: 404, code: "UNKNOWN_KEY", message: "Unknown setting" };
  if (meta.superOnly && p.role !== "super_admin") return { ok: false, status: 403, code: "SUPER_ADMIN_ONLY", message: "Only a super-admin can change this setting" };
  const key = p.key as ModerationConfigKey;

  let value: unknown;
  if (meta.kind === "int") {
    if (typeof p.value !== "number" || !Number.isInteger(p.value) || p.value < (meta.min ?? 0) || p.value > (meta.max ?? 1_000_000)) {
      return { ok: false, status: 400, code: "OUT_OF_RANGE", message: `${meta.label} must be a whole number from ${meta.min ?? 0} to ${meta.max}` };
    }
    value = p.value;
  } else {
    if (!Array.isArray(p.value) || p.value.length > 200 || p.value.some((s) => typeof s !== "string" || s.trim().length < 2 || s.trim().length > 100)) {
      return { ok: false, status: 400, code: "BAD_LIST", message: "Provide up to 200 entries, each 2 to 100 characters" };
    }
    value = Array.from(new Set((p.value as string[]).map((s) => s.trim().toLowerCase())));
  }

  // The hard maximum can never sit below the default expiry (and vice versa).
  if (key === "reveal_grant_max_hours" && (value as number) < (await getConfig("reveal_grant_default_hours"))) return { ok: false, status: 400, code: "MAX_BELOW_DEFAULT", message: "The hard maximum can't be below the default expiry" };
  if (key === "reveal_grant_default_hours" && (value as number) > (await getConfig("reveal_grant_max_hours"))) return { ok: false, status: 400, code: "DEFAULT_ABOVE_MAX", message: "The default expiry can't exceed the hard maximum" };

  const before = await getConfig(key);
  await withAudit({ adminId: p.adminId, action: "config_changed", targetType: "config", targetId: key, reason: p.reason, details: { key, before, after: value }, ip: p.ip }, async () => {
    await db.insert(moderationConfig).values({ key, value: value as never, updatedBy: p.adminId }).onConflictDoUpdate({ target: moderationConfig.key, set: { value: value as never, updatedBy: p.adminId, updatedAt: new Date() } });
  });
  invalidateConfigCache();
  return { ok: true, before, after: value };
}
