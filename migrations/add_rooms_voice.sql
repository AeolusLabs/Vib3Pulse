-- Rooms part 3a: live voice and synced playback. Additive and idempotent.
BEGIN;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS voice_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_speakers integer NOT NULL DEFAULT 6;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS screen_version integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS now_playing jsonb;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS on_stage boolean NOT NULL DEFAULT false;
COMMIT;
