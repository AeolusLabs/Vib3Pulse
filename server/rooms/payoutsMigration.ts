// Rooms phase 6 (task 6.1) schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_room_payout_account.sql must contain exactly this SQL inside BEGIN/COMMIT (scripts/test-rooms-unit-earnings.ts
// checks it). Additive and idempotent: five nullable columns on organizer_payment_accounts (existing organiser onboarding
// never writes them and keeps working), one audit table, two indexes IF NOT EXISTS. Nothing is dropped or rewritten. Names
// match shared/schema.ts so drizzle-kit push agrees.
//
// organizer_payment_accounts:
//   bank_code, bank_name, account_last4  what the rooms payout page shows (never the full number, never the account name)
//   room_verified_subaccount_code        the subaccount that passed the rooms name check; nameMatches is true only while it
//                                        is still the row's paystack_subaccount_code (an organiser re-onboarding makes a new
//                                        code, so an unchecked account can never inherit "name matches")
//   name_matched_at                      when that check passed
//   holder_name_enc                      the bank's account-holder name (encrypted) of an account saved BEFORE the person's ID name was
//                                        recorded; compared once the name exists, then cleared. Never returned by a route.
// room_payout_account_events: one row per attempt and per outcome. The audit log of every account change, and the durable
// per-user rate limit for the bank lookup (counted across server instances). Not a money record: goes with its user.
// room_payouts (host_id, status): the "payout in flight" check made before an account change.

export const ROOM_PAYOUT_ACCOUNT_SCHEMA_SQL = `
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
`;
