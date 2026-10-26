-- Verified legal name for payouts: user_verified_names, plus age_review_requests.wants_payouts and proposed_legal_name_enc.
-- Additive and idempotent, one transaction. Mirrored in ensureSchema (server/storage.ts, via server/identity/payoutNamesMigration.ts,
-- which must hold exactly the statements between BEGIN and COMMIT) and in shared/schema.ts. The name is AES-256-GCM encrypted and
-- never selected by a users query. Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_payout_names.sql
BEGIN;
CREATE TABLE IF NOT EXISTS user_verified_names (
  user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name_enc bytea NOT NULL,
  request_id uuid,
  set_by varchar,
  created_at timestamp NOT NULL DEFAULT now()
);
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS wants_payouts boolean NOT NULL DEFAULT false;
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS proposed_legal_name_enc bytea;
COMMIT;
