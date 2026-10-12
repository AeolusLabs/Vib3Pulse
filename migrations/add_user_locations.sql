-- Live map positions. Additive and idempotent. One row per sharing user, no history.
BEGIN;
CREATE TABLE IF NOT EXISTS user_locations (
  user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_locations_updated_idx ON user_locations (updated_at);
COMMIT;
