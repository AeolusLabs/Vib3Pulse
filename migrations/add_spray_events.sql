-- Spray event log: spray_events (append-only; one row per status change of a spray or a team-spray batch).
-- Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via server/rooms/sprayEventsMigration.ts,
-- which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts.
-- The code tolerates the table being absent (a failed log write is console.error'd and never fails a payment), but the admin
-- ledger needs it. Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_spray_events.sql
BEGIN;
CREATE TABLE IF NOT EXISTS spray_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spray_id uuid,
  batch_id uuid,
  room_id varchar NOT NULL,
  at timestamp NOT NULL DEFAULT now(),
  from_status text,
  to_status text NOT NULL,
  source text NOT NULL,
  detail text,
  CONSTRAINT spray_events_source_check CHECK (source IN ('api', 'callback', 'sweep', 'admin', 'system')),
  CONSTRAINT spray_events_subject_check CHECK (spray_id IS NOT NULL OR batch_id IS NOT NULL),
  CONSTRAINT spray_events_detail_check CHECK (detail IS NULL OR char_length(detail) <= 300)
);
CREATE INDEX IF NOT EXISTS spray_events_spray_at_idx ON spray_events (spray_id, at);
CREATE INDEX IF NOT EXISTS spray_events_batch_at_idx ON spray_events (batch_id, at);
CREATE INDEX IF NOT EXISTS spray_events_room_at_idx ON spray_events (room_id, at);
CREATE INDEX IF NOT EXISTS spray_events_to_status_at_idx ON spray_events (to_status, at);
COMMIT;
