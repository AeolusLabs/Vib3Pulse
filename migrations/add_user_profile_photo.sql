-- Parked real photo while the avatar is the profile picture. Additive, nullable, idempotent.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url text;
COMMIT;
