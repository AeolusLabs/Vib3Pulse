// age_review_requests.proposed_dob, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_age_review_v2.sql must contain exactly this SQL inside BEGIN/COMMIT. Additive and idempotent.

export const AGE_REVIEW_V2_SCHEMA_SQL = `
ALTER TABLE age_review_requests ADD COLUMN IF NOT EXISTS proposed_dob text;
`;
