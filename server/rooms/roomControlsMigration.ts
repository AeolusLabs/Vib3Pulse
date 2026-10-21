// Admin money controls (rooms admin plan, task 1): two additive tables, used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_room_controls.sql must contain exactly this SQL inside BEGIN/COMMIT.
//  - room_controls: one row per global switch ("sprays_paused", "tickets_paused"); a missing row means off.
//  - room_host_freezes: one row per frozen host; no sprays, no ticket sales, payouts held. Removed on unfreeze.
// Names match shared/schema.ts so drizzle-kit push agrees.

export const ROOM_CONTROLS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_controls (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  reason text,
  updated_by varchar,
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS room_host_freezes (
  host_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  frozen_by varchar NOT NULL,
  frozen_at timestamp NOT NULL DEFAULT now()
);
`;
