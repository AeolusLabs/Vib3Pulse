-- Manual age review v2: age_review_requests.proposed_dob (the birthdate a reviewer saw on the ID when it differs from the registered one,
-- held until a different super_admin approves). Additive and idempotent, one transaction. Mirrored in ensureSchema
-- (server/storage.ts, via server/identity/ageReviewMigrationV2.ts, which must hold exactly the statements between BEGIN and COMMIT)
-- and in shared/schema.ts. Run from the repo root:  node --env-file=.env scripts/run-room-peak-migration.mjs add_age_review_v2.sql
BEGIN;
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS proposed_dob text;
COMMIT;
