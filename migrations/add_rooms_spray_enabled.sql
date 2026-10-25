-- Rooms spray opt-in: rooms.spray_enabled (host switch, default off). Additive and idempotent, one transaction.
-- Mirrored in ensureSchema (server/storage.ts, via server/rooms/roomSprayEnabledMigration.ts, which must hold exactly the
-- statements between BEGIN and COMMIT) and in shared/schema.ts. Constant default: no table rewrite.
-- IMPORTANT: the rooms code selects this column (drizzle select() on rooms), so apply it before (or together with) the deploy.
-- Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_rooms_spray_enabled.sql
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_enabled boolean NOT NULL DEFAULT false;
COMMIT;
