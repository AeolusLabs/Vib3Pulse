-- Venue menu pages (images). Additive and idempotent.
BEGIN;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS menu_image_urls text[] DEFAULT '{}';
COMMIT;
