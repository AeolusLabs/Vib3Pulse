// Rooms admin spray block schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_rooms_spray_admin_block.sql must contain exactly this SQL inside BEGIN/COMMIT.
// Additive and idempotent: one constant-default column plus three nullable ones. Existing rooms read "not blocked".

export const ROOM_SPRAY_BLOCK_SCHEMA_SQL = `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_admin_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_block_reason text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_blocked_by varchar;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS spray_blocked_at timestamp;
`;
