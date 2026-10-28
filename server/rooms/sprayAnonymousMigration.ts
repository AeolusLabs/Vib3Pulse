// Anonymous spray schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_spray_anonymous.sql must contain exactly this SQL inside BEGIN/COMMIT.
// Additive and idempotent: one constant-default column (catalog change only on Postgres 11+). Existing sprays read false.

export const SPRAY_ANONYMOUS_SCHEMA_SQL = `
ALTER TABLE spray_payments ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
`;
