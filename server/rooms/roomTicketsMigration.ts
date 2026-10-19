// Paid rooms (phase 4) schema change, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_room_tickets.sql must contain exactly this SQL inside BEGIN/COMMIT (a unit test checks it).
// Additive and idempotent: new nullable/defaulted columns on rooms, two new tables, named constraints added only when
// missing. Nothing is dropped, nothing existing is rewritten. Names match shared/schema.ts so drizzle-kit push agrees.
//
// Money columns are integer kobo. A paid ticket is unique per (room, person) while it is paid; provider_ref (the payment
// reference) is unique for ever, which is what makes issuing a ticket idempotent.
// room_payouts keeps its room and host references WITHOUT cascade on purpose, and room_tickets references its room and
// buyer ON DELETE RESTRICT: a money record must never vanish because a room or an account row was deleted
// (storage.deleteUser refuses first with RoomMoneyRecordsError). A database that already has room_tickets from the earlier
// CASCADE draft (a scratch test database only; never applied for real) keeps its old foreign keys under CREATE TABLE IF NOT
// EXISTS: rebuild it with drizzle-kit push (schema.ts says restrict) or drop the table before applying.

export const ROOM_TICKETS_SCHEMA_SQL = `
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
  room_id varchar NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
`;
