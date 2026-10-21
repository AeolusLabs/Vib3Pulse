BEGIN;

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

COMMIT;
