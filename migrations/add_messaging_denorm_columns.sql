-- Denormalization columns for messaging read performance
-- Safe to re-run: IF NOT EXISTS / default handling makes these no-ops on repeat

-- Tracks unread messages per participant without a COUNT(*) at read time.
-- Incremented when a message is sent, reset to 0 when the participant reads.
ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS unread_count integer NOT NULL DEFAULT 0;

-- Stores a short preview of the last message so getUserConversations
-- never needs to join conversation_messages just to show the inbox list.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_preview text;