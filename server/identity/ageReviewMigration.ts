// age_review_requests and age_review_evidence, as one source used by ensureSchema (server/storage.ts) and the tests.
// migrations/add_age_review.sql must contain exactly this SQL inside BEGIN/COMMIT. Additive and idempotent.
// Evidence rows cascade with their request, so deleting a request (or the user) can never leave images behind.

export const AGE_REVIEW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS age_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  document_type text,
  code text,
  code_expires_at timestamp,
  document_fingerprint text,
  registered_dob_snapshot text,
  reviewer_id varchar,
  second_approver_id varchar,
  outcome text,
  decline_reason text,
  dob_match boolean,
  more_requests integer NOT NULL DEFAULT 0,
  live_invite_expires_at timestamp,
  consent_version text,
  consented_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  submitted_at timestamp,
  decided_at timestamp,
  expires_at timestamp NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT age_review_requests_method_check CHECK (method IN ('upload', 'live')),
  CONSTRAINT age_review_requests_status_check CHECK (status IN ('draft', 'submitted', 'in_review', 'needs_more', 'pending_second_approval', 'approved', 'declined', 'expired', 'cancelled', 'closed_minor'))
);
CREATE UNIQUE INDEX IF NOT EXISTS age_review_requests_one_open_uniq ON age_review_requests (user_id) WHERE status IN ('draft', 'submitted', 'in_review', 'needs_more', 'pending_second_approval');
CREATE INDEX IF NOT EXISTS age_review_requests_status_created_idx ON age_review_requests (status, created_at);
CREATE INDEX IF NOT EXISTS age_review_requests_user_created_idx ON age_review_requests (user_id, created_at);
CREATE INDEX IF NOT EXISTS age_review_requests_fingerprint_idx ON age_review_requests (document_fingerprint) WHERE document_fingerprint IS NOT NULL;
CREATE TABLE IF NOT EXISTS age_review_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES age_review_requests(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mime text NOT NULL,
  bytes_enc bytea NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT age_review_evidence_kind_check CHECK (kind IN ('document', 'selfie'))
);
CREATE UNIQUE INDEX IF NOT EXISTS age_review_evidence_request_kind_uniq ON age_review_evidence (request_id, kind);
`;
