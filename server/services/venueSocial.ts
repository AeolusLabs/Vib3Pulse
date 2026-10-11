import { sql } from "drizzle-orm";
import { db } from "../storage";

// Public-safe slice of a user. Only these columns are ever selected, so no credential or
// contact field can ride along (see toPublicUser in server/auth.ts for the full-row version).
export type PublicPerson = { id: string; username: string; displayName: string | null; avatarUrl: string | null };

export type NightSocialProof = { going: number; friendsCount: number; friends: PublicPerson[] };

// A night stays "current" for a few hours after it starts, so people checking in late still see it.
const NIGHT_WINDOW = sql`now() - interval '6 hours'`;

/**
 * Per upcoming night at a venue: how many confirmed tickets, and which of the viewer's
 * MUTUAL follows hold one. Mutual only, on purpose: showing "X is going" to anyone who merely
 * follows X would reveal where X will be on a night out to people X never agreed to tell.
 */
export async function getVenueNightsSocialProof(
  venueId: string,
  viewerId: string | null,
): Promise<Record<string, NightSocialProof>> {
  const counts = await db.execute(sql`
    SELECT vt.venue_entry_night_id AS night_id, COUNT(*)::int AS going
    FROM venue_tickets vt
    JOIN venue_entry_nights n ON n.id = vt.venue_entry_night_id
    WHERE n.venue_id = ${venueId} AND n.date >= ${NIGHT_WINDOW} AND vt.status = 'confirmed'
    GROUP BY vt.venue_entry_night_id
  `);

  const result: Record<string, NightSocialProof> = {};
  for (const row of counts.rows as Array<{ night_id: string; going: number }>) {
    result[row.night_id] = { going: row.going, friendsCount: 0, friends: [] };
  }

  if (viewerId) {
    const friends = await db.execute(sql`
      SELECT DISTINCT vt.venue_entry_night_id AS night_id, u.id, u.username, u.display_name, u.avatar_url
      FROM venue_tickets vt
      JOIN venue_entry_nights n ON n.id = vt.venue_entry_night_id
      JOIN users u ON u.id = vt.user_id
      WHERE n.venue_id = ${venueId} AND n.date >= ${NIGHT_WINDOW} AND vt.status = 'confirmed'
        AND u.id <> ${viewerId} AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${viewerId} AND f.following_id = u.id)
        AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = ${viewerId})
    `);
    for (const r of friends.rows as Array<any>) {
      const entry = result[r.night_id];
      if (!entry) continue;
      entry.friendsCount += 1;
      if (entry.friends.length < 3) {
        entry.friends.push({ id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url });
      }
    }
  }
  return result;
}

export type VenueReview = {
  id: string;
  rating: number;
  reviewText: string;
  createdAt: string;
  user: PublicPerson;
};

/** Written reviews only (a rating with no text has nothing to show). Newest first. */
export async function getVenueReviews(venueId: string, limit: number, offset: number): Promise<VenueReview[]> {
  const res = await db.execute(sql`
    SELECT r.id, r.rating, r.review_text, r.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url
    FROM venue_ratings r
    JOIN users u ON u.id = r.user_id
    WHERE r.venue_id = ${venueId} AND r.review_text IS NOT NULL AND btrim(r.review_text) <> '' AND u.deleted_at IS NULL
    ORDER BY r.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return (res.rows as Array<any>).map((r) => ({
    id: r.id,
    rating: r.rating,
    reviewText: r.review_text,
    createdAt: new Date(r.created_at).toISOString(),
    user: { id: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
  }));
}
