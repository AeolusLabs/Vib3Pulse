-- Inbox rows show who sent the last message ("Amara: ..."). Additive and idempotent.
-- Also re-derives every conversation's preview from its latest non-deleted message, which fixes
-- previews that still showed the text of a message that had since been deleted.
BEGIN;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_sender_id varchar;

UPDATE conversations c SET
  last_message_sender_id = m.sender_id,
  last_message_preview = CASE
    WHEN m.content IS NOT NULL AND btrim(m.content) <> '' THEN
      CASE WHEN length(m.content) > 60 THEN substr(m.content, 1, 60) || '…' ELSE m.content END
    WHEN m.message_type = 'poll' THEN 'Created a poll'
    WHEN m.message_type = 'image' THEN 'Sent an image'
    WHEN m.message_type = 'video' THEN 'Sent a video'
    WHEN m.message_type = 'event' THEN 'Shared an event'
    WHEN m.message_type = 'venue' THEN 'Shared a venue'
    WHEN m.message_type = 'post' THEN 'Shared a post'
    WHEN m.message_type = 'story_reply' THEN 'Replied to your story'
    ELSE 'Sent a message'
  END
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_id, content, message_type
  FROM conversation_messages
  WHERE is_deleted = false
  ORDER BY conversation_id, created_at DESC
) m
WHERE m.conversation_id = c.id;

-- Conversations whose messages are all deleted: nothing left to preview.
UPDATE conversations c SET last_message_preview = NULL, last_message_sender_id = NULL
WHERE NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.is_deleted = false)
  AND (c.last_message_preview IS NOT NULL OR c.last_message_sender_id IS NOT NULL);
COMMIT;
