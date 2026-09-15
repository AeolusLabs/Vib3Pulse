-- Group chat messages could already attach images (image_urls) but had nowhere
-- to store a video attachment, unlike posts which have a dedicated video_url.
-- Safe to re-run: IF NOT EXISTS makes this a no-op on repeat.

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS video_url text;
