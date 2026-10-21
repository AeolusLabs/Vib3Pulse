BEGIN;

CREATE TABLE IF NOT EXISTS room_rates (
  key text PRIMARY KEY,
  value numeric(6,2) NOT NULL,
  updated_by varchar,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_rate_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  before_value numeric(6,2) NOT NULL,
  after_value numeric(6,2) NOT NULL,
  reason text NOT NULL,
  admin_id varchar NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_rate_changes_created_idx ON room_rate_changes (created_at DESC);

COMMIT;
