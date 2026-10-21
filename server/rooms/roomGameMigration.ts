// Rooms gaming schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_rooms_game.sql must contain exactly this SQL inside BEGIN/COMMIT.
// Additive and idempotent: four nullable or constant-default columns and one partial index, nothing dropped or rewritten
// (constant defaults are a catalog change only on Postgres 11+). Names and checks match shared/schema.ts so drizzle-kit push agrees.
//  - rooms.game_format: players per side (1 to 4), null = not a game room.
//  - rooms.game_drop_timeout_ms: how long a dropped player keeps their slot: 30000, 120000 (default) or 0 (hold the slot).
//  - rooms.age_lane: "teen" or "adult" on a lane room, null otherwise.
//  - rooms.parent_room_id: the game room a lane room belongs to (not a foreign key: kept as a plain reference, checked in code).

export const ROOM_GAME_SCHEMA_SQL = `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_format smallint CONSTRAINT rooms_game_format_check CHECK (game_format IS NULL OR (game_format >= 1 AND game_format <= 4));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_drop_timeout_ms integer NOT NULL DEFAULT 120000 CONSTRAINT rooms_game_drop_timeout_check CHECK (game_drop_timeout_ms IN (0, 30000, 120000));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS age_lane text CONSTRAINT rooms_age_lane_check CHECK (age_lane IS NULL OR age_lane IN ('teen', 'adult'));
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS parent_room_id varchar;
CREATE INDEX IF NOT EXISTS rooms_parent_idx ON rooms (parent_room_id) WHERE parent_room_id IS NOT NULL;
`;
