-- Door check-in: typeable staff PINs + check-in audit log. Additive and idempotent.
-- Staff PIN: nullable 6-digit, unique per event / venue night (existing rows keep NULL; Postgres
-- unique indexes ignore NULLs, so legacy rows never collide).
BEGIN;

ALTER TABLE event_staff_access_codes ADD COLUMN IF NOT EXISTS pin varchar(6);
ALTER TABLE venue_staff_access_codes ADD COLUMN IF NOT EXISTS pin varchar(6);

CREATE UNIQUE INDEX IF NOT EXISTS event_staff_codes_event_pin_uniq
  ON event_staff_access_codes (event_id, pin);
CREATE UNIQUE INDEX IF NOT EXISTS venue_staff_codes_night_pin_uniq
  ON venue_staff_access_codes (venue_entry_night_id, pin);

-- event_id holds events.id (kind 'event') or venue_entry_nights.id (kind 'venue'), so no FK.
CREATE TABLE IF NOT EXISTS check_in_log (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  event_id varchar NOT NULL,
  ticket_id varchar NOT NULL,
  action text NOT NULL,
  actor_type text NOT NULL,
  staff_code_id varchar,
  actor_name text NOT NULL,
  holder_name text NOT NULL,
  tier_name text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS check_in_log_event_created_idx
  ON check_in_log (event_id, created_at DESC);
-- Undo looks up the latest admit for one ticket.
CREATE INDEX IF NOT EXISTS check_in_log_ticket_idx
  ON check_in_log (ticket_id, created_at DESC);

COMMIT;
