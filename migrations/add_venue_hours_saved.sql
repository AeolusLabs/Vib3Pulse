-- Venue structured opening hours + saved venues. Additive and idempotent.
BEGIN;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS opening_hours jsonb;
CREATE TABLE IF NOT EXISTS saved_venues (
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id varchar NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, venue_id)
);
CREATE INDEX IF NOT EXISTS saved_venues_venue_idx ON saved_venues (venue_id);
COMMIT;
