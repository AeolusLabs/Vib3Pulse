-- Performance indexes — run outside a transaction (CONCURRENTLY requires it)
-- Safe to re-run: IF NOT EXISTS is a no-op on already-present indexes

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_organizer_id
  ON events (organizer_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_event_date
  ON events (event_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_id
  ON posts (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_created_at
  ON posts (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rsvps_event_id
  ON rsvps (event_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rsvps_user_id
  ON rsvps (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_event_id
  ON tickets (event_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_user_id
  ON tickets (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_post_id
  ON comments (post_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_likes_post_id
  ON likes (post_id);

-- story_views(story_id) and story_likes(story_id) are already covered by their
-- unique(story_id, user_id) constraints — the leading column is indexed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stories_user_id
  ON stories (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stories_created_at
  ON stories (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_conversation_id
  ON conversation_messages (conversation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_created_at
  ON conversation_messages (created_at);

-- conversation_participants has unique(conversation_id, user_id); user_id is the
-- trailing column so user_id-only lookups need their own index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_participants_user_id
  ON conversation_participants (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_id
  ON notifications (user_id);

-- follows has unique(follower_id, following_id); following_id is trailing so
-- follower-list lookups need their own index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_follows_following_id
  ON follows (following_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_expire
  ON session (expire);
