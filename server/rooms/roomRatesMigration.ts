// Editable money rates (rooms rates plan, task 2): two additive tables, used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_room_rates.sql must contain exactly this SQL inside BEGIN/COMMIT.
//  - room_rates: one row per rate an admin has CHANGED (percent, two decimals). A missing row means the default from shared/money.ts.
//  - room_rate_changes: the append-only log, one row per real change (who, what, before, after, why, when).
// Names match shared/schema.ts so drizzle-kit push agrees.

export const ROOM_RATES_SCHEMA_SQL = `
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
`;
