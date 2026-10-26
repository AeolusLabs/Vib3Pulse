// user_verified_names and the two age_review_requests payout columns, as one source used by ensureSchema (server/storage.ts) and the
// tests. migrations/add_payout_names.sql must contain exactly this SQL inside BEGIN/COMMIT. Additive and idempotent.

export const PAYOUT_NAMES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_verified_names (
  user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name_enc bytea NOT NULL,
  request_id uuid,
  set_by varchar,
  created_at timestamp NOT NULL DEFAULT now()
);
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS wants_payouts boolean NOT NULL DEFAULT false;
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS proposed_legal_name_enc bytea;
`;
