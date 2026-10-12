-- Customizable avatar config. Additive, nullable, idempotent. Null = user has not created one yet.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar jsonb;
COMMIT;
