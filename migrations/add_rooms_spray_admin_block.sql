-- Rooms admin spray block: an admin can switch spraying off for one room; only an admin can switch it back on. Additive and idempotent, one transaction.
-- Mirrored in ensureSchema (server/storage.ts, via server/rooms/roomSprayBlockMigration.ts, which must hold exactly the
-- statements between BEGIN and COMMIT) and in shared/schema.ts. Constant default: no table rewrite.
-- IMPORTANT: the rooms code selects these columns (drizzle select() on rooms), so apply it before (or together with) the deploy.
-- Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_rooms_spray_admin_block.sql
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_admin_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_block_reason text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_blocked_by varchar;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_blocked_at timestamp;
COMMIT;
