-- Rooms phase 3 host settings: pinned message, slow mode and room lock. Additive and idempotent, one transaction.
-- Mirrored in ensureSchema (server/storage.ts) and shared/schema.ts.
-- Run from the repo root:  node --env-file=.env scripts/run-rooms-host-settings-migration.mjs
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS pinned_message text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slow_mode_sec integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
COMMIT;
