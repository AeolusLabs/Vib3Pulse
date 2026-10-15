-- Virtual rooms (alpha). Additive and idempotent. users.room_privacy null = defaults.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_privacy jsonb;

CREATE TABLE IF NOT EXISTS rooms (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'party',
  visibility text NOT NULL DEFAULT 'public',
  event_id varchar REFERENCES events(id) ON DELETE SET NULL,
  venue_id varchar REFERENCES venues(id) ON DELETE SET NULL,
  invite_token_hash text,
  scheduled_for timestamp,
  started_at timestamp,
  ended_at timestamp,
  status text NOT NULL DEFAULT 'scheduled',
  age_limit text NOT NULL DEFAULT 'all',
  capacity integer NOT NULL DEFAULT 50,
  no_direct_interactions boolean NOT NULL DEFAULT false,
  screen jsonb,
  moderation_status text NOT NULL DEFAULT 'approved',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms (status, visibility);
CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms (host_id, status);
CREATE INDEX IF NOT EXISTS rooms_event_idx ON rooms (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rooms_venue_idx ON rooms (venue_id) WHERE venue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS room_members (
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'guest',
  joined_at timestamp NOT NULL DEFAULT now(),
  left_at timestamp,
  muted boolean NOT NULL DEFAULT false,
  banned boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, user_id)
);
COMMIT;
