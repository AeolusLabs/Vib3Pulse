-- Rooms phase 4 (paid rooms): ticket price and capacity on rooms, room_tickets, room_payouts. Additive and idempotent,
-- one transaction. Mirrored in ensureSchema (server/storage.ts, via server/rooms/roomTicketsMigration.ts, which must hold
-- exactly the statements between BEGIN and COMMIT) and in shared/schema.ts.
-- Run from the repo root:  node --env-file=.env scripts/run-room-tickets-migration.mjs
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ticket_price_kobo integer;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ticket_capacity integer;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS refund_before_start boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_ticket_price_kobo_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_ticket_price_kobo_check CHECK (ticket_price_kobo IS NULL OR ticket_price_kobo > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_ticket_capacity_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_ticket_capacity_check CHECK (ticket_capacity IS NULL OR (ticket_capacity >= 20 AND ticket_capacity <= 150));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_ticket_both_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_ticket_both_check CHECK ((ticket_price_kobo IS NULL) = (ticket_capacity IS NULL));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS room_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_kobo integer NOT NULL,
  vat_kobo integer NOT NULL,
  fee_kobo integer NOT NULL,
  reserve_kobo integer NOT NULL,
  platform_kobo integer NOT NULL,
  host_kobo integer NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  status text NOT NULL DEFAULT 'paid',
  created_at timestamp NOT NULL DEFAULT now(),
  refunded_at timestamp,
  refund_reason text,
  CONSTRAINT room_tickets_provider_ref_key UNIQUE (provider_ref),
  CONSTRAINT room_tickets_status_check CHECK (status IN ('paid', 'refunded')),
  CONSTRAINT room_tickets_amounts_check CHECK (amount_kobo > 0 AND vat_kobo >= 0 AND fee_kobo >= 0 AND reserve_kobo >= 0 AND platform_kobo >= 0 AND host_kobo >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS room_tickets_paid_uniq ON room_tickets (room_id, user_id) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS room_tickets_user_idx ON room_tickets (user_id);
CREATE TABLE IF NOT EXISTS room_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id varchar NOT NULL REFERENCES rooms(id),
  host_id varchar NOT NULL REFERENCES users(id),
  amount_kobo integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',
  release_at timestamp NOT NULL,
  transfer_ref text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  paid_at timestamp,
  CONSTRAINT room_payouts_room_id_key UNIQUE (room_id),
  CONSTRAINT room_payouts_transfer_ref_key UNIQUE (transfer_ref),
  CONSTRAINT room_payouts_status_check CHECK (status IN ('held', 'queued', 'paid', 'failed')),
  CONSTRAINT room_payouts_amount_check CHECK (amount_kobo >= 0)
);
CREATE INDEX IF NOT EXISTS room_payouts_status_release_idx ON room_payouts (status, release_at);
COMMIT;
