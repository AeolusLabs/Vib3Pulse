-- Minors' rooms (rooms phase 2): a room hosted by someone under 18 admits adults only with a personal invite that the
-- adult has acknowledged. Additive and idempotent; the backfill only ever sets the flag. Same statements as
-- server/rooms/minorsRoomsMigration.ts (used by ensureSchema; a unit test keeps the two identical).
BEGIN;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS minors_room boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS room_adult_invites (
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by varchar REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  acknowledged_at timestamp,
  first_acknowledged_at timestamp,
  revoked_at timestamp,
  PRIMARY KEY (room_id, user_id)
);
ALTER TABLE room_adult_invites ADD COLUMN IF NOT EXISTS first_acknowledged_at timestamp;
CREATE INDEX IF NOT EXISTS room_adult_invites_user_idx ON room_adult_invites (user_id) WHERE revoked_at IS NULL;

UPDATE rooms r SET minors_room = true
FROM users u
WHERE u.id = r.host_id
  AND r.status <> 'ended'
  AND r.minors_room = false
  AND u.date_of_birth ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
  AND substring(u.date_of_birth from 1 for 10) > to_char(current_date - interval '18 years', 'YYYY-MM-DD');

COMMIT;
