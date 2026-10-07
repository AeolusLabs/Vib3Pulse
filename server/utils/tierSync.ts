// Pure planning step for saving an event's ticket tiers on edit. Tiers the organiser
// kept are UPDATED IN PLACE (same id, so `sold` and issued tickets stay attached);
// new ones are inserted; removed ones are deleted only if nothing was ever sold.
// Previously the edit form deleted every tier and recreated them, which the
// tickets.ticket_tier_id FK blocks once anything has sold — leaving the event half-edited.

export class TierSyncError extends Error {}

export interface ExistingTier {
  id: string;
  name: string;
  sold: number; // max(ticket_tiers.sold, issued tickets) — either one means "has sales"
}

export function planTierSync<D extends { id?: string; name: string; quantity: number }>(
  existing: ExistingTier[],
  desired: D[],
): { update: Array<D & { id: string }>; insert: D[]; removeIds: string[] } {
  const byId = new Map(existing.map((t) => [t.id, t]));
  const kept = new Set<string>();
  const update: Array<D & { id: string }> = [];
  const insert: D[] = [];

  for (const d of desired) {
    const cur = d.id ? byId.get(d.id) : undefined;
    if (cur && !kept.has(cur.id)) {
      if (d.quantity < cur.sold) {
        throw new TierSyncError(`"${cur.name}" already has ${cur.sold} sold, so its quantity can't go below ${cur.sold}.`);
      }
      kept.add(cur.id);
      update.push({ ...d, id: cur.id });
    } else {
      insert.push(d); // no id, unknown id, or a duplicate id: treat as a brand-new tier
    }
  }

  const removed = existing.filter((t) => !kept.has(t.id));
  for (const t of removed) {
    if (t.sold > 0) {
      throw new TierSyncError(`"${t.name}" has ${t.sold} ticket${t.sold === 1 ? "" : "s"} sold and can't be removed. Set its quantity to ${t.sold} to close sales instead.`);
    }
  }
  return { update, insert, removeIds: removed.map((t) => t.id) };
}
