-- Manual age review v3: age_review_reveal_nonces (single-use evidence reveal tokens, consumed in the database so a restart or a
-- second server cannot replay one). Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via
-- server/identity/ageReviewMigrationV3.ts, which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts.
-- Rows are deleted by the hourly age review sweep once expired. Run from the repo root:
--   node --env-file=.env scripts/run-room-peak-migration.mjs add_age_review_v3.sql
BEGIN;
CREATE TABLE IF NOT EXISTS age_review_reveal_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS age_review_reveal_nonces_expires_idx ON age_review_reveal_nonces (expires_at);
COMMIT;
