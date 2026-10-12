-- Social plan periods (monthly tiers for Zernio cross-posting).
-- Idempotent. ensureSchema() in server/storage.ts runs the same statements on startup.
-- One row per paid period; recurring subscriptions add a row per renewal.

CREATE TABLE IF NOT EXISTS social_passes (
  id                        VARCHAR     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   VARCHAR     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                      VARCHAR(20) NOT NULL,
  billing                   VARCHAR(20) NOT NULL,
  provider                  VARCHAR(20) NOT NULL,
  currency                  VARCHAR(3)  NOT NULL,
  amount_paid               INTEGER     NOT NULL,
  provider_payment_id       TEXT        NOT NULL UNIQUE,
  provider_subscription_id  TEXT,
  provider_customer_id      TEXT,
  starts_at                 TIMESTAMP   NOT NULL DEFAULT now(),
  ends_at                   TIMESTAMP   NOT NULL,
  campaigns_used            INTEGER     NOT NULL DEFAULT 0,
  auto_renew                BOOLEAN     NOT NULL DEFAULT false,
  created_at                TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_passes_user_ends    ON social_passes(user_id, ends_at);
CREATE INDEX IF NOT EXISTS idx_social_passes_subscription ON social_passes(provider_subscription_id);

-- Scheduled social campaigns + expiry-reminder marker.
ALTER TABLE social_passes ADD COLUMN IF NOT EXISTS expiry_reminder_sent_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS social_campaigns (
  id                 VARCHAR      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            VARCHAR      NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  event_id           VARCHAR      NOT NULL REFERENCES events(id)        ON DELETE CASCADE,
  pass_id            VARCHAR      NOT NULL REFERENCES social_passes(id) ON DELETE CASCADE,
  platforms          JSONB        NOT NULL,
  timezone           TEXT         NOT NULL DEFAULT 'UTC',
  status             VARCHAR(20)  NOT NULL DEFAULT 'active',
  allowance_released BOOLEAN      NOT NULL DEFAULT false,
  created_at         TIMESTAMP    NOT NULL DEFAULT now(),
  cancelled_at       TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_social_campaigns_user ON social_campaigns(user_id, created_at);

CREATE TABLE IF NOT EXISTS social_campaign_sends (
  id          VARCHAR      PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id VARCHAR      NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
  send_index  INTEGER      NOT NULL,
  run_at      TIMESTAMP    NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'scheduled',
  attempts    INTEGER      NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMP,
  finished_at TIMESTAMP,
  result      JSONB,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_social_sends_due      ON social_campaign_sends(status, run_at);
CREATE INDEX IF NOT EXISTS idx_social_sends_campaign ON social_campaign_sends(campaign_id);

-- Venue promotion, Zernio webhook confirmation, reconnect flag, launch notice.
ALTER TABLE social_posts ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS venue_id VARCHAR REFERENCES venues(id) ON DELETE CASCADE;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS venue_night_id VARCHAR REFERENCES venue_entry_nights(id) ON DELETE CASCADE;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS platform_post_url TEXT;
ALTER TABLE social_campaigns ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE social_campaigns ADD COLUMN IF NOT EXISTS venue_id VARCHAR REFERENCES venues(id) ON DELETE CASCADE;
ALTER TABLE social_campaigns ADD COLUMN IF NOT EXISTS venue_night_id VARCHAR REFERENCES venue_entry_nights(id) ON DELETE CASCADE;
ALTER TABLE connected_socials ADD COLUMN IF NOT EXISTS needs_reconnect BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE connected_socials ADD COLUMN IF NOT EXISTS plan_notice_sent_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS zernio_webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TIMESTAMP NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_social_posts_venue ON social_posts(venue_id);

-- Top-ups; posts remember their campaign/send.
ALTER TABLE social_passes ADD COLUMN IF NOT EXISTS extra_campaigns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_passes ADD COLUMN IF NOT EXISTS extra_platforms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS campaign_id VARCHAR REFERENCES social_campaigns(id) ON DELETE SET NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS send_id VARCHAR REFERENCES social_campaign_sends(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_campaign ON social_posts(campaign_id);
CREATE TABLE IF NOT EXISTS social_topups (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pass_id VARCHAR NOT NULL REFERENCES social_passes(id) ON DELETE CASCADE,
      pack VARCHAR(30) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      amount INTEGER NOT NULL,
      provider VARCHAR(20) NOT NULL,
      currency VARCHAR(3) NOT NULL,
      amount_paid INTEGER NOT NULL,
      provider_payment_id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
CREATE INDEX IF NOT EXISTS idx_social_topups_pass ON social_topups(pass_id);
