-- Rooms phase 6 (task 6.1): payout account display columns on organizer_payment_accounts, the account-change audit table,
-- and an index for the "payout in flight" check. Additive and idempotent, one transaction. Mirrored in ensureSchema
-- (server/storage.ts, via server/rooms/payoutsMigration.ts, which must hold exactly the statements between BEGIN and COMMIT)
-- and in shared/schema.ts. Run from the repo root (the orchestrator applies it after reading it):
--   node --env-file=.env scripts/run-room-payout-account-migration.mjs
BEGIN;
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS bank_code text;
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS account_last4 text;
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS room_verified_subaccount_code varchar(255);
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS name_matched_at timestamp;
ALTER TABLE organizer_payment_accounts ADD COLUMN IF NOT EXISTS holder_name_enc bytea;
CREATE TABLE IF NOT EXISTS room_payout_account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  outcome text NOT NULL,
  bank_code text,
  account_last4 text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT room_payout_account_events_action_check CHECK (action IN ('attempt', 'account_set', 'account_refused'))
);
CREATE INDEX IF NOT EXISTS room_payout_account_events_user_created_idx ON room_payout_account_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS room_payouts_host_status_idx ON room_payouts (host_id, status);
COMMIT;
