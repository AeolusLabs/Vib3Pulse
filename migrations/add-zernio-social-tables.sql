-- Zernio Social Media Integration
-- Run once against the production database.
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS column).
-- ensureSchema() in server/storage.ts runs these automatically on startup,
-- so manual execution is only needed if you are running migrations by hand.

-- ── users: add Zernio profile reference ──────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS zernio_profile_id VARCHAR(255) UNIQUE;

-- ── connected_socials ─────────────────────────────────────────────────────────
-- One row per organizer per platform.
-- UNIQUE(user_id, platform) enforces one active connection per platform.
-- Reconnecting the same platform uses an upsert that sets disconnected_at = NULL
-- rather than inserting a duplicate — the unique constraint is never violated.
-- oauth_state + oauth_state_expires_at carry the PKCE state token for the
-- duration of the OAuth popup flow and are cleared by the callback handler.

CREATE TABLE IF NOT EXISTS connected_socials (
  id                    VARCHAR       PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               VARCHAR       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform              VARCHAR(50)   NOT NULL,
  zernio_account_id     VARCHAR(255)  NOT NULL,
  handle                VARCHAR(255),
  connected_at          TIMESTAMP     NOT NULL DEFAULT now(),
  disconnected_at       TIMESTAMP,
  oauth_state           VARCHAR(128),
  oauth_state_expires_at TIMESTAMP,
  UNIQUE(user_id, platform)
);

-- ── social_posts ──────────────────────────────────────────────────────────────
-- One row per platform per promote call.
-- zernio_post_id is UNIQUE but nullable: failed posts have no Zernio ID and
-- NULL values do not trigger the unique constraint, so retries insert cleanly.
-- cost_usd is DECIMAL(10,2) — store Zernio's exact charge per post.

CREATE TABLE IF NOT EXISTS social_posts (
  id              VARCHAR       PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        VARCHAR       NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  user_id         VARCHAR       NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  platform        VARCHAR(50)   NOT NULL,
  zernio_post_id  VARCHAR(255)  UNIQUE,
  content         TEXT,
  status          VARCHAR(50)   NOT NULL DEFAULT 'posted',
  error_message   TEXT,
  posted_at       TIMESTAMP     NOT NULL DEFAULT now(),
  cost_usd        DECIMAL(10,2) NOT NULL DEFAULT 0
);

-- ── indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_connected_socials_user   ON connected_socials(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_user        ON social_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_event       ON social_posts(event_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform    ON social_posts(platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_posted_at   ON social_posts(posted_at);