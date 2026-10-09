-- Social events Phase 3 (public events + abuse controls). Additive and idempotent.
-- events had no creation timestamp; the "new accounts: 1 public event per week" limit needs one.
-- Existing (commercial) rows are backfilled with the migration time, which nothing reads.
BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_events_organizer_kind_created ON events (organizer_id, kind, visibility, created_at);

INSERT INTO moderation_config (key, value) VALUES
  ('trusted_after_clean_events', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
