-- Building avatar (style + accent) for venues and events. Additive, nullable, idempotent. Null = category default.
BEGIN;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS building jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS building jsonb;
COMMIT;
