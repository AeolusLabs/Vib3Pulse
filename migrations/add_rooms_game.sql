-- Rooms gaming: rooms.game_format, rooms.game_drop_timeout_ms, rooms.age_lane, rooms.parent_room_id + a partial index.
-- Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via server/rooms/roomGameMigration.ts,
-- which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts. No table rewrite (constant defaults).
-- IMPORTANT: the gaming code selects these columns (drizzle select() on rooms), so this must be applied before (or together
-- with) the deploy. ensureSchema also applies it at boot.
-- Run from the repo root (the orchestrator applies it after reading it):  node --env-file=.env scripts/run-room-peak-migration.mjs add_rooms_game.sql
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_format smallint CONSTRAINT rooms_game_format_check CHECK (game_format IS NULL OR (game_format >= 1 AND game_format <= 4));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_drop_timeout_ms integer NOT NULL DEFAULT 120000 CONSTRAINT rooms_game_drop_timeout_check CHECK (game_drop_timeout_ms IN (0, 30000, 120000));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS age_lane text CONSTRAINT rooms_age_lane_check CHECK (age_lane IS NULL OR age_lane IN ('teen', 'adult'));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS parent_room_id varchar;
CREATE INDEX IF NOT EXISTS rooms_parent_idx ON rooms (parent_room_id) WHERE parent_room_id IS NOT NULL;
COMMIT;
