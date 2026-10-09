import { db } from "../storage";
import { moderationConfig, MODERATION_CONFIG_DEFAULTS, type ModerationConfigKey } from "@shared/schema";

// Admin-editable thresholds live in the moderation_config table (seeded by migration);
// the TS defaults are only the fallback for a missing/garbled row. Phase 4 adds the
// audited admin write path and calls invalidateConfigCache() after it.

export type ConfigShape = { [K in ModerationConfigKey]: K extends "blocked_patterns" ? string[] : number };

const TTL_MS = 15_000;
let cache: { at: number; rows: Map<string, unknown> } | null = null;

async function load(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = new Map<string, unknown>();
  for (const r of await db.select().from(moderationConfig)) rows.set(r.key, r.value);
  cache = { at: Date.now(), rows };
  return rows;
}

export function invalidateConfigCache(): void {
  cache = null;
}

export async function getConfig<K extends ModerationConfigKey>(key: K): Promise<ConfigShape[K]> {
  const fallback = MODERATION_CONFIG_DEFAULTS[key] as unknown;
  const stored = (await load()).get(key);
  if (key === "blocked_patterns") {
    const ok = Array.isArray(stored) && stored.every((s) => typeof s === "string");
    return (ok ? stored : [...(fallback as readonly string[])]) as ConfigShape[K];
  }
  const ok = typeof stored === "number" && Number.isFinite(stored) && stored >= 0;
  return (ok ? stored : fallback) as ConfigShape[K];
}
