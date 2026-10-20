// Rooms phase 6 (recaps) schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_room_peak.sql must contain exactly this SQL inside BEGIN/COMMIT (scripts/test-rooms-unit-recap.ts checks it).
// Additive and idempotent: three columns, nothing dropped, nothing rewritten. ADD COLUMN with a constant default is a catalog
// change only on Postgres 11+ (no table rewrite), so it is safe on the live database. Names match shared/schema.ts so
// drizzle-kit push agrees.
//  - rooms.peak_members: the most people in the room at once (RoomHub), raised while live and on end; null = not tracked.
//  - room_members.seconds_in: seconds spent in the room over every visit (added on each leave, database clock).
//  - room_members.messages_sent: chat lines sent in the room.
// room_members already existed (phase 1) and is kept after a room ends, so it is the membership record the recap uses.

export const ROOM_PEAK_SCHEMA_SQL = `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS peak_members integer;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS seconds_in integer NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS messages_sent integer NOT NULL DEFAULT 0;
`;
