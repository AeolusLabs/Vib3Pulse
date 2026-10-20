-- Rooms phase 6 (recaps): rooms.peak_members, room_members.seconds_in, room_members.messages_sent.
-- Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via server/rooms/roomPeakMigration.ts,
-- which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts. No table rewrite (constant defaults).
-- IMPORTANT: the phase 6 code selects these columns (drizzle select() on rooms and room_members), so this must be applied
-- before (or together with) the deploy. ensureSchema also applies it at boot.
-- Run from the repo root (the orchestrator applies it after reading it):  node --env-file=.env scripts/run-room-peak-migration.mjs
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS peak_members integer;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS seconds_in integer NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS messages_sent integer NOT NULL DEFAULT 0;
COMMIT;
