-- ID-verification seam: when (and how) an admin or provider confirmed a user is who their birthdate says.
-- Additive and idempotent. Mirrored in ensureSchema (server/storage.ts).
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_verified_at timestamp;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_verified_method text;
COMMIT;
