-- Spray ledger v2: spray_payments (created_at, id) index, spray_events.seq (write order) and a clock_timestamp() default for
-- spray_events.at. Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via
-- server/rooms/sprayLedgerV2Migration.ts, which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts.
-- Apply after add_spray_events.sql. Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_spray_ledger_v2.sql
BEGIN;
CREATE INDEX IF NOT EXISTS spray_payments_created_idx ON spray_payments (created_at, id);
ALTER TABLE spray_events ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE spray_events ALTER COLUMN at SET DEFAULT clock_timestamp();
COMMIT;
