// age_review_reveal_nonces, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_age_review_v3.sql must contain exactly this SQL inside BEGIN/COMMIT. Additive and idempotent.

export const AGE_REVIEW_V3_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS age_review_reveal_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS age_review_reveal_nonces_expires_idx ON age_review_reveal_nonces (expires_at);
`;
