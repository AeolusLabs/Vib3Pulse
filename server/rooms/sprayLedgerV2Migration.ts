// Spray ledger v2, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_spray_ledger_v2.sql must contain exactly this SQL inside BEGIN/COMMIT. Additive and idempotent.
//  - spray_payments_created_idx: the ledger's main scan (newest first, keyset on created_at, id).
//  - spray_events.seq: write order inside one transaction (every event in a transaction shares one at under now()).
//  - spray_events.at default clock_timestamp(): real write time instead of transaction start.

export const SPRAY_LEDGER_V2_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS spray_payments_created_idx ON spray_payments (created_at, id);
ALTER TABLE spray_events ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE spray_events ALTER COLUMN at SET DEFAULT clock_timestamp();
`;
