// Weighted event ranking per the PRD's discovery spec: 40% recency, 30%
// follow-graph, 20% proximity, 10% engagement. Previously the main event
// feed was a plain `ORDER BY event_date` with no personalization at all.
//
// Each raw component is min-max normalized across the candidate set before
// the weights are applied, so the 40/30/20/10 split is meaningful regardless
// of each component's native scale (days-until-event vs. a 0/1 follow flag
// vs. miles vs. a weighted RSVP+ticket count).
import { calculateDistanceMiles } from "./geo.js";

export interface RankableEvent {
  id: string;
  eventDate: Date | string;
  organizerId: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface RankEventsOptions {
  // eventId -> weighted engagement count (e.g. rsvpCount*2 + ticketCount*3).
  engagementByEvent: Map<string, number>;
  // organizerIds the requesting user follows — empty set for a logged-out
  // request or one whose follow graph fetch failed, in which case the
  // follow-graph term contributes 0 to every event's score rather than
  // throwing, so ranking degrades gracefully instead of failing outright.
  followedOrganizerIds: Set<string>;
  userLat?: number;
  userLon?: number;
}

function minMaxNormalize(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    // No spread to rank by (e.g. one event, or every event tied) — treat
    // everything as equal instead of dividing by zero.
    return () => 0.5;
  }
  return (v: number) => (v - min) / (max - min);
}

export function rankEvents<T extends RankableEvent>(
  events: T[],
  { engagementByEvent, followedOrganizerIds, userLat, userLon }: RankEventsOptions
): (T & { rankScore: number; distance: number | null })[] {
  if (events.length === 0) return [];

  const now = Date.now();
  const hasLocation = userLat !== undefined && userLon !== undefined && Number.isFinite(userLat) && Number.isFinite(userLon);

  // Recency: sooner events score higher. Raw score decays with days-until —
  // a 7-day half-life-ish scale so "next week" still meaningfully outranks
  // "next month" without collapsing everything happening today to the same
  // ceiling value.
  const daysUntil = events.map(e => Math.max(0, (new Date(e.eventDate).getTime() - now) / 86_400_000));
  const rawRecency = daysUntil.map(d => 1 / (1 + d / 7));
  const normRecency = minMaxNormalize(rawRecency);

  // Proximity: closer events score higher. Events with no coordinates, or a
  // request with no location, fall back to a neutral 0.5 rather than being
  // penalized as "infinitely far".
  const rawDistance = events.map(e => {
    if (!hasLocation || e.latitude == null || e.longitude == null) return null;
    return calculateDistanceMiles(userLat!, userLon!, e.latitude, e.longitude);
  });
  const finiteDistances = rawDistance.filter((d): d is number => d !== null);
  const normDistanceFn = finiteDistances.length > 0 ? minMaxNormalize(finiteDistances) : () => 0.5;

  // Engagement: weighted RSVP+ticket count, same formula as getTrendingEvents.
  const rawEngagement = events.map(e => engagementByEvent.get(e.id) ?? 0);
  const normEngagement = minMaxNormalize(rawEngagement);

  const scored = events.map((event, i) => {
    const recencyScore = normRecency(rawRecency[i]);
    const followScore = followedOrganizerIds.has(event.organizerId) ? 1 : 0;
    const proximityScore = rawDistance[i] === null ? 0.5 : 1 - normDistanceFn(rawDistance[i] as number);
    const engagementScore = normEngagement(rawEngagement[i]);

    const rankScore =
      0.4 * recencyScore +
      0.3 * followScore +
      0.2 * proximityScore +
      0.1 * engagementScore;

    return { ...event, rankScore, distance: rawDistance[i] };
  });

  return scored.sort((a, b) => b.rankScore - a.rankScore);
}
