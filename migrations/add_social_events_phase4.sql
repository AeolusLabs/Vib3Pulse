-- Social events Phase 4 (admin side). Additive and idempotent.
BEGIN;

-- Snapshot of when the event entered the queue, so "median time-to-review" survives the
-- event's queued_at being cleared on resolution.
ALTER TABLE event_moderations ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_event_moderations_created ON event_moderations (created_at);

-- Defence in depth for "only a super-admin can create a reveal grant": even if application
-- code were bypassed, a grant whose grantor is not an active super_admin is refused, and the
-- grantee must be an active non-super admin (a grant can't be handed to another super-admin
-- to launder it, nor re-delegated: grantee is never a grantor because grantors are super-admins).
CREATE OR REPLACE FUNCTION enforce_reveal_grant_parties() RETURNS trigger AS $fn$
DECLARE
  grantor_role TEXT;
  grantor_active BOOLEAN;
  grantee_role TEXT;
  grantee_active BOOLEAN;
BEGIN
  SELECT role, is_active INTO grantor_role, grantor_active FROM admin_users WHERE id = NEW.grantor_id;
  SELECT role, is_active INTO grantee_role, grantee_active FROM admin_users WHERE id = NEW.grantee_id;
  IF grantor_role IS DISTINCT FROM 'super_admin' OR grantor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'reveal grants can only be created by an active super_admin';
  END IF;
  IF grantee_role IS NULL OR grantee_role = 'super_admin' OR grantee_active IS NOT TRUE THEN
    RAISE EXCEPTION 'reveal grants can only be issued to an active non-super admin';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reveal_grants_parties ON reveal_grants;
CREATE TRIGGER reveal_grants_parties
  BEFORE INSERT ON reveal_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_reveal_grant_parties();

-- A grant is immutable apart from being revoked: scope, grantee, reason and expiry can never
-- be edited afterwards (so nobody can "extend" one).
CREATE OR REPLACE FUNCTION reveal_grants_only_revoke() RETURNS trigger AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.grantor_id IS DISTINCT FROM OLD.grantor_id
     OR NEW.grantee_id IS DISTINCT FROM OLD.grantee_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.case_type IS DISTINCT FROM OLD.case_type
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'reveal grants are immutable; revoke and issue a new one';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'a revoked reveal grant cannot be changed';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reveal_grants_immutable ON reveal_grants;
CREATE TRIGGER reveal_grants_immutable
  BEFORE UPDATE ON reveal_grants
  FOR EACH ROW EXECUTE FUNCTION reveal_grants_only_revoke();

COMMIT;
