// spray_events (append-only status log for sprays and team-spray batches), as one source used by ensureSchema
// (server/storage.ts) and the tests. migrations/add_spray_events.sql must contain exactly this SQL inside BEGIN/COMMIT.
// Additive and idempotent. No foreign keys: a log row must never block or be blocked by the money tables.

export const SPRAY_EVENTS_SCHEMA_SQL = `
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
`;
