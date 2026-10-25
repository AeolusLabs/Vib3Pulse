// Rooms spray opt-in schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_rooms_spray_enabled.sql must contain exactly this SQL inside BEGIN/COMMIT.
// Additive and idempotent: one constant-default column (catalog change only on Postgres 11+). Existing rooms read false.

export const ROOM_SPRAY_ENABLED_SCHEMA_SQL = `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_enabled boolean NOT NULL DEFAULT false;
`;
