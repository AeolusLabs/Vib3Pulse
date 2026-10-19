// Spraying (phase 5) schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_spray.sql must contain exactly this SQL inside BEGIN/COMMIT (scripts/test-rooms-unit-spray.ts checks it).
// Additive and idempotent: one nullable column on users (plus a named check added only when missing), four new tables,
// indexes IF NOT EXISTS. Nothing is dropped, nothing existing is rewritten. Names match shared/schema.ts so drizzle-kit push
// agrees.
//
// spray_payments and host_clawbacks are money records: their room/user/spray references are ON DELETE RESTRICT, so they
// never vanish with a deleted row (storage.deleteUser refuses first, see assertNoRoomMoneyRecords). user_payment_methods
// goes with its user (a soft-deleted saved card holds no money); spray_payments.payment_method_id is RESTRICT too.
// room_spend is a reservation counter (the money is in spray_payments), so it cascades with its room or user.
// The idempotency key is unique PER PAYER (never global), provider_ref is unique for ever.

export const SPRAY_SCHEMA_SQL = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS spray_daily_limit_kobo integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_spray_daily_limit_kobo_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_spray_daily_limit_kobo_check CHECK (spray_daily_limit_kobo IS NULL OR spray_daily_limit_kobo > 0);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  auth_enc text NOT NULL,
  last4 text,
  brand text,
  bank text,
  reusable boolean NOT NULL DEFAULT false,
  signature text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp,
  CONSTRAINT user_payment_methods_user_signature_key UNIQUE (user_id, signature)
);
CREATE TABLE IF NOT EXISTS spray_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  host_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payer_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tier text NOT NULL,
  v3c bigint NOT NULL,
  amount_kobo integer NOT NULL,
  vat_kobo integer NOT NULL,
  fee_kobo integer NOT NULL,
  reserve_kobo integer NOT NULL,
  platform_kobo integer NOT NULL,
  host_kobo integer NOT NULL,
  guest_kobo integer,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  payment_method_id uuid REFERENCES user_payment_methods(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'created',
  reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  paid_at timestamp,
  delivered_at timestamp,
  reversed_at timestamp,
  refund_requested_at timestamp,
  CONSTRAINT spray_payments_provider_ref_key UNIQUE (provider_ref),
  CONSTRAINT spray_payments_payer_key_key UNIQUE (payer_id, idempotency_key),
  CONSTRAINT spray_payments_status_check CHECK (status IN ('created', 'pending', 'paid', 'delivered', 'reversing', 'reversed', 'failed', 'disputed')),
  CONSTRAINT spray_payments_tier_check CHECK (tier IN ('note', 'bundle', 'bag', 'rain')),
  CONSTRAINT spray_payments_amounts_check CHECK (amount_kobo >= 50000 AND v3c = amount_kobo AND vat_kobo >= 0 AND fee_kobo >= 0 AND reserve_kobo >= 0 AND platform_kobo >= 0 AND host_kobo >= 0 AND (guest_kobo IS NULL OR guest_kobo >= 0) AND vat_kobo + fee_kobo + reserve_kobo + platform_kobo + host_kobo + COALESCE(guest_kobo, 0) = amount_kobo),
  CONSTRAINT spray_payments_not_self_check CHECK (payer_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS spray_payments_room_status_idx ON spray_payments (room_id, status);
CREATE INDEX IF NOT EXISTS spray_payments_payer_created_idx ON spray_payments (payer_id, created_at);
CREATE INDEX IF NOT EXISTS spray_payments_status_created_idx ON spray_payments (status, created_at);
CREATE TABLE IF NOT EXISTS room_spend (
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_kobo integer NOT NULL,
  spent_kobo integer NOT NULL DEFAULT 0,
  CONSTRAINT room_spend_pkey PRIMARY KEY (room_id, user_id),
  CONSTRAINT room_spend_spent_check CHECK (spent_kobo >= 0 AND spent_kobo <= limit_kobo)
);
CREATE TABLE IF NOT EXISTS host_clawbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  beneficiary_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  spray_id uuid NOT NULL REFERENCES spray_payments(id) ON DELETE RESTRICT,
  amount_kobo integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  written_off_by varchar REFERENCES users(id) ON DELETE RESTRICT,
  written_off_reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  recovered_at timestamp,
  CONSTRAINT host_clawbacks_spray_beneficiary_key UNIQUE (spray_id, beneficiary_id),
  CONSTRAINT host_clawbacks_status_check CHECK (status IN ('open', 'recovered', 'written_off')),
  CONSTRAINT host_clawbacks_amount_check CHECK (amount_kobo > 0)
);
CREATE INDEX IF NOT EXISTS host_clawbacks_host_status_idx ON host_clawbacks (host_id, status);
`;
