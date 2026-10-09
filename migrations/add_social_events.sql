-- Social events (free invite/RSVP events) - Phase 1 schema.
-- Idempotent and additive. The only relaxation of an existing constraint is
-- tickets.user_id DROP NOT NULL (every existing row keeps its value; old code
-- keeps working). Applied by scripts/run-social-events-migration.mjs.
BEGIN;

-- ---------- users ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMP;
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_phone_unique ON users (verified_phone);

-- ---------- events ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'commercial';
ALTER TABLE events ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE events ADD COLUMN IF NOT EXISTS social_type TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS exact_address TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_plus_ones INTEGER NOT NULL DEFAULT 0;
-- invite_code was this column's first name; it collided with conversations.invite_code
-- (group chats), which must stay visible in API responses, so it became invite_token.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='invite_code') THEN
    ALTER TABLE events RENAME COLUMN invite_code TO invite_token;
  END IF;
END $$;
ALTER TABLE events ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS serves_alcohol BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS queue_reason TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS auto_flags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE events ADD COLUMN IF NOT EXISTS flag_outcome TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP;
ALTER TABLE events ADD COLUMN IF NOT EXISTS guest_data_purged_at TIMESTAMP;
DROP INDEX IF EXISTS events_invite_code_unique;
CREATE UNIQUE INDEX IF NOT EXISTS events_invite_token_unique ON events (invite_token);
CREATE INDEX IF NOT EXISTS idx_events_kind_visibility ON events (kind, visibility);

-- ---------- tickets ----------
ALTER TABLE tickets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS guest_token_hash TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS plus_one_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS address_approved_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS purged_at TIMESTAMP;
CREATE UNIQUE INDEX IF NOT EXISTS tickets_guest_token_hash_unique ON tickets (guest_token_hash);
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_user_or_guest_chk
    CHECK (user_id IS NOT NULL OR guest_token_hash IS NOT NULL OR purged_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- admin_activity_logs ----------
ALTER TABLE admin_activity_logs ADD COLUMN IF NOT EXISTS reason TEXT;

-- ---------- new tables ----------
CREATE TABLE IF NOT EXISTS phone_verifications (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  ip_address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user ON phone_verifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_devices (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  last_ip TEXT,
  first_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_user_id_device_hash_unique UNIQUE (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_hash ON user_devices (device_hash);

CREATE TABLE IF NOT EXISTS bans (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  admin_id VARCHAR NOT NULL REFERENCES admin_users(id),
  lifted_at TIMESTAMP,
  lifted_by VARCHAR REFERENCES admin_users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT bans_kind_chk CHECK (kind IN ('phone','device','user'))
);
CREATE INDEX IF NOT EXISTS idx_bans_lookup ON bans (kind, value_hash) WHERE lifted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_strikes (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id VARCHAR REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  admin_id VARCHAR NOT NULL REFERENCES admin_users(id),
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT user_strikes_type_chk CHECK (type IN ('warn','strike'))
);
CREATE INDEX IF NOT EXISTS idx_user_strikes_user ON user_strikes (user_id);

CREATE TABLE IF NOT EXISTS user_trust (
  user_id VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trust_tier TEXT NOT NULL DEFAULT 'new',
  tier_override_by VARCHAR REFERENCES admin_users(id),
  tier_override_reason TEXT,
  tier_override_at TIMESTAMP,
  featured_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  featured_override_by VARCHAR REFERENCES admin_users(id),
  featured_override_reason TEXT,
  featured_override_at TIMESTAMP,
  abusive_reporter_at TIMESTAMP,
  abusive_reporter_by VARCHAR REFERENCES admin_users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT user_trust_tier_chk CHECK (trust_tier IN ('new','standard','trusted'))
);

CREATE TABLE IF NOT EXISTS moderation_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by VARCHAR REFERENCES admin_users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
INSERT INTO moderation_config (key, value) VALUES
  ('report_auto_hide_threshold',      '3'::jsonb),
  ('new_account_weekly_public_limit', '1'::jsonb),
  ('min_account_age_days',            '7'::jsonb),
  ('new_account_window_days',         '30'::jsonb),
  ('guest_data_retention_days',       '30'::jsonb),
  ('blocked_patterns',                '["whatsapp","telegram","t.me/","wa.me/","dm me","contact me on","http://","https://","www."]'::jsonb),
  ('reveal_grant_default_hours',      '48'::jsonb),
  ('reveal_grant_max_hours',          '168'::jsonb),
  ('queue_sla_hours',                 '24'::jsonb),
  ('strikes_for_auto_ban',            '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS guest_data_audit (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL,
  actor_user_id VARCHAR, -- no FK: ON DELETE SET NULL would be an UPDATE the append-only trigger blocks
  actor_admin_id VARCHAR REFERENCES admin_users(id),
  event_id VARCHAR NOT NULL,
  ticket_id VARCHAR,
  data_accessed TEXT NOT NULL,
  grant_id VARCHAR,
  case_type TEXT,
  case_id VARCHAR,
  reason TEXT,
  ip_address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT guest_data_audit_actor_chk CHECK (actor_type IN ('host','super_admin','grantee','system'))
);
CREATE INDEX IF NOT EXISTS idx_guest_data_audit_event ON guest_data_audit (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reveal_grants (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_id VARCHAR NOT NULL REFERENCES admin_users(id),
  grantee_id VARCHAR NOT NULL REFERENCES admin_users(id),
  event_id VARCHAR NOT NULL REFERENCES events(id),
  case_type TEXT NOT NULL,
  case_id VARCHAR NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  revoked_by VARCHAR REFERENCES admin_users(id),
  CONSTRAINT reveal_grants_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT reveal_grants_not_self_chk CHECK (grantor_id <> grantee_id),
  CONSTRAINT reveal_grants_case_type_chk CHECK (case_type IN ('report','moderation_item'))
);
CREATE INDEX IF NOT EXISTS idx_reveal_grants_grantee ON reveal_grants (grantee_id, event_id);

CREATE TABLE IF NOT EXISTS moderation_appeals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id VARCHAR NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by VARCHAR REFERENCES admin_users(id),
  resolved_at TIMESTAMP,
  resolution_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT moderation_appeals_status_chk CHECK (status IN ('open','upheld','denied'))
);
CREATE INDEX IF NOT EXISTS idx_moderation_appeals_open ON moderation_appeals (status, created_at);

CREATE TABLE IF NOT EXISTS admin_mfa (
  admin_id VARCHAR PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  enabled_at TIMESTAMP,
  last_used_step INTEGER,
  recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------- immutability: audit tables are append-only ----------
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_activity_logs_immutable ON admin_activity_logs;
CREATE TRIGGER admin_activity_logs_immutable
  BEFORE UPDATE OR DELETE ON admin_activity_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
DROP TRIGGER IF EXISTS admin_activity_logs_no_truncate ON admin_activity_logs;
CREATE TRIGGER admin_activity_logs_no_truncate
  BEFORE TRUNCATE ON admin_activity_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

DROP TRIGGER IF EXISTS guest_data_audit_immutable ON guest_data_audit;
CREATE TRIGGER guest_data_audit_immutable
  BEFORE UPDATE OR DELETE ON guest_data_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
DROP TRIGGER IF EXISTS guest_data_audit_no_truncate ON guest_data_audit;
CREATE TRIGGER guest_data_audit_no_truncate
  BEFORE TRUNCATE ON guest_data_audit
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();

COMMIT;
