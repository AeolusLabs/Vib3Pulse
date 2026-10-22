-- migrations/add_spray_batches.sql : team spray (rooms gaming). One charge = one spray_batches row; each player's share is a
-- spray_payments row with batch_id set (so limits, caps, clawbacks and earnings count it as they are). Additive and idempotent.
-- Run from the repo root (the orchestrator applies it):  node --env-file=.env scripts/run-room-peak-migration.mjs add_spray_batches.sql
BEGIN;
CREATE TABLE IF NOT EXISTS spray_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  host_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payer_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  featured_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  side text NOT NULL,
  tier text NOT NULL,
  amount_kobo integer NOT NULL,
  vat_kobo integer NOT NULL,
  fee_kobo integer NOT NULL,
  reserve_kobo integer NOT NULL,
  host_subaccount text NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  payment_method_id uuid REFERENCES user_payment_methods(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'created',
  reason text,
  authorization_url text,
  created_at timestamp NOT NULL DEFAULT now(),
  paid_at timestamp,
  delivered_at timestamp,
  reversed_at timestamp,
  refund_requested_at timestamp,
  check_attempts integer NOT NULL DEFAULT 0,
  last_checked_at timestamp,
  next_check_at timestamp,
  CONSTRAINT spray_batches_payer_key_key UNIQUE (payer_id, idempotency_key),
  CONSTRAINT spray_batches_provider_ref_key UNIQUE (provider_ref),
  CONSTRAINT spray_batches_side_check CHECK (side IN ('A', 'B')),
  CONSTRAINT spray_batches_tier_check CHECK (tier IN ('note', 'bundle', 'bag', 'rain')),
  CONSTRAINT spray_batches_status_check CHECK (status IN ('created', 'pending', 'paid', 'delivered', 'reversing', 'reversed', 'failed', 'disputed')),
  CONSTRAINT spray_batches_amounts_check CHECK (amount_kobo >= 50000 AND vat_kobo >= 0 AND fee_kobo >= 0 AND reserve_kobo >= 0 AND vat_kobo + fee_kobo + reserve_kobo < amount_kobo),
  CONSTRAINT spray_batches_not_self_check CHECK (payer_id <> featured_id)
);
CREATE INDEX IF NOT EXISTS spray_batches_room_status_idx ON spray_batches (room_id, status);
CREATE INDEX IF NOT EXISTS spray_batches_payer_created_idx ON spray_batches (payer_id, created_at);
CREATE INDEX IF NOT EXISTS spray_batches_status_created_idx ON spray_batches (status, created_at);
CREATE INDEX IF NOT EXISTS spray_batches_status_next_check_idx ON spray_batches (status, next_check_at);
ALTER TABLE spray_payments ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES spray_batches(id) ON DELETE RESTRICT;
ALTER TABLE spray_payments ADD COLUMN IF NOT EXISTS recipient_subaccount text;
CREATE INDEX IF NOT EXISTS spray_payments_batch_idx ON spray_payments (batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS spray_payments_batch_recipient_key ON spray_payments (batch_id, recipient_id) WHERE batch_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spray_payments_batch_subaccount_check') THEN
    ALTER TABLE spray_payments ADD CONSTRAINT spray_payments_batch_subaccount_check CHECK (batch_id IS NULL OR recipient_subaccount IS NOT NULL);
  END IF;
END $$;
COMMIT;
