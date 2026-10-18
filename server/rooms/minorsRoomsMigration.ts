// The minors' rooms schema change and backfill, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_minors_rooms.sql must contain exactly these statements inside BEGIN/COMMIT (a unit test checks it).
// Additive, idempotent and safe to re-run: the backfill only ever sets the flag, never clears it.

export const MINORS_ROOMS_DDL = `
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
`;

/**
 * Rooms created before the flag existed: every room that has not ended and whose host is under 18 today becomes a
 * minors' room. users.date_of_birth is text: only values starting YYYY-MM-DD are used (the same first 10 characters
 * ageFromDob reads), compared as text so a malformed value can never make the statement fail. Under 18 means born
 * after the date 18 years ago (born exactly 18 years ago is 18, as in ageFromDob).
 */
export const MINORS_ROOMS_BACKFILL = `
UPDATE rooms r SET minors_room = true
FROM users u
WHERE u.id = r.host_id
  AND r.status <> 'ended'
  AND r.minors_room = false
  AND u.date_of_birth ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
  AND substring(u.date_of_birth from 1 for 10) > to_char(current_date - interval '18 years', 'YYYY-MM-DD');
`;

/** Both, run as one statement batch (Postgres runs a multi-statement simple query as one transaction). */
export const MINORS_ROOMS_SCHEMA_SQL = MINORS_ROOMS_DDL + MINORS_ROOMS_BACKFILL;
