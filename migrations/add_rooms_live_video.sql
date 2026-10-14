-- Rooms live screen: the host can switch on live camera + mic streaming for a room. Additive and idempotent.
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS live_video boolean NOT NULL DEFAULT false;
COMMIT;
