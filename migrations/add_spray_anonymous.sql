-- Anonymous spray: spray_payments.anonymous (the payer shows as "Anonymous" in the room). Additive and idempotent, one transaction.
-- Mirrored in ensureSchema (server/storage.ts, via server/rooms/sprayAnonymousMigration.ts, which must hold exactly the
-- statements between BEGIN and COMMIT) and in shared/schema.ts. Constant default: no table rewrite.
-- IMPORTANT: spray code selects this column (drizzle select() on spray_payments), so apply it before (or together with) the deploy.
-- Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_spray_anonymous.sql
BEGIN;
ALTER TABLE spray_payments ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
COMMIT;
