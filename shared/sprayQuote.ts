// What a spray pays out, for the confirm sheet: who gets what, and the service charge (everything else: payment fees, VAT and
// the platform). Built from the same split functions the real spray uses, so the quote and the charge can never disagree.
// Two kinds of line only: the people who get money, and one service charge. A stage guest's spray also names the host (their
// share of a stage spray); a team spray names the players' pool and the host's share.
import { SPRAY_CATALOGUE, teamSprayBreakdown, type Rates, type SprayTier } from "./money";
import { spraySplit } from "./spray";

export interface QuotePart { kind: "recipient" | "host"; userId: string; kobo: number }
export interface SprayQuote {
  priceKobo: number;
  /** Everything that is not paid to a person: payment fees, VAT and the platform. */
  serviceKobo: number;
  parts: QuotePart[];
  /** A team spray: how many players share the pool equally, and the pool. */
  team?: { players: number; poolKobo: number };
}

const finish = (priceKobo: number, parts: QuotePart[], team?: SprayQuote["team"]): SprayQuote => {
  const paid = parts.reduce((a, p) => a + p.kobo, 0);
  return { priceKobo, serviceKobo: priceKobo - paid, parts, ...(team ? { team } : {}) };
};

/** One spray at the host, or at a co-host or stage guest (the host then takes their share of a stage spray). */
export function singleQuote(tier: SprayTier, hostId: string, targetId: string, rates: Rates): SprayQuote {
  const price = SPRAY_CATALOGUE[tier].kobo;
  const s = spraySplit(tier, targetId === hostId ? "host" : "stage", rates);
  return targetId === hostId
    ? finish(price, [{ kind: "recipient", userId: hostId, kobo: s.hostKobo }])
    : finish(price, [{ kind: "recipient", userId: targetId, kobo: s.guestKobo as number }, { kind: "host", userId: hostId, kobo: s.hostKobo }]);
}

/** One spray at a whole team: the pool is split equally between the players; the host also takes a share when a guest plays. */
export function teamQuote(tier: SprayTier, hostId: string, players: { userId: string; isHost: boolean }[], featuredId: string | null, rates: Rates): SprayQuote {
  const bd = teamSprayBreakdown(tier, players, featuredId, rates);
  const parts: QuotePart[] = bd.shares.map((s) => ({ kind: "recipient" as const, userId: s.userId, kobo: s.recipient }));
  if (bd.whole.host > 0) parts.push({ kind: "host", userId: hostId, kobo: bd.whole.host });
  return finish(SPRAY_CATALOGUE[tier].kobo, parts, { players: players.length, poolKobo: bd.whole.pool });
}
