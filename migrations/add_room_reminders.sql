-- Room reminders (phase 3.7). Additive and idempotent. One transaction.
-- Apply: node --env-file=.env scripts/run-room-reminders-migration.mjs add_room_reminders.sql
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS reminder_notified_at timestamp;
CREATE TABLE IF NOT EXISTS room_reminders (
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  notified_at timestamp,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_reminders_user_idx ON room_reminders (user_id);
COMMIT;
