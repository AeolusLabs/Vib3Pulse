-- Map sharing audience + user blocks. Additive and idempotent.
BEGIN;
CREATE TABLE IF NOT EXISTS map_sharing_prefs (
  user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  audience text NOT NULL DEFAULT 'friends'
);
CREATE TABLE IF NOT EXISTS map_allowed_viewers (
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS map_allowed_viewers_viewer_idx ON map_allowed_viewers (viewer_id);
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id);
COMMIT;
