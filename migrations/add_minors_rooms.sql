-- Minors' rooms (rooms phase 2): a room hosted by someone under 18 admits adults only with a personal invite that the
-- adult has acknowledged. Additive and idempotent. Mirrored in ensureSchema (server/storage.ts).
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS minors_room boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS room_adult_invites (
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  acknowledged_at timestamp,
  revoked_at timestamp,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_adult_invites_user_idx ON room_adult_invites (user_id) WHERE revoked_at IS NULL;
COMMIT;
