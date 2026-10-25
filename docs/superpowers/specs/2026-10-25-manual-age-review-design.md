# Manual age review (design)

Date: 2026-10-25. Status: owner decisions captured, awaiting spec review. Replaces the shelved provider-based plan (automated checks come later behind the same seam).

## Intent

Users can prove they are 18 or over without being forced to hand a government ID to a social platform. A human age reviewer looks at the proof and decides. The result feeds the rules that already exist ("ID-verified adult": `isIdVerifiedAdult`), so spray, tickets, paid rooms and payouts need no rule change. The birthdate typed at registration is the claim; the review must corroborate it.

## Findings (current code)

- Birthdate is typed at signup, locked once set, and a self-typed birthdate is never verified (`ageVerifiedAt` null; `server/routes/users-routes.ts`).
- `shared/ageVerification.ts`: `isIdVerifiedAdult` = `ageVerifiedAt` set AND age >= 18 by the stored birthdate. `AgeVerificationMethod = "admin" | "provider"`.
- `server/identity/ageVerification.ts`: `ageVerifier.start()` is a stub ("not available yet"). The only way to verify today is `POST /api/admin/users/:id/age-verification` (roles super_admin, admin, user_support), no evidence required. A birthdate-correction path exists (`server/services/dobCorrection.ts`, `PUT /api/admin/users/:id/date-of-birth`).
- Uploaded images live in Postgres (`media_uploads`, Railway-compatible); `server/objectStorage.ts` is Replit-only and not usable in production. Public media is served by id, so evidence must NOT use it.
- Admin roles: super_admin, admin, content_moderator, user_support, event_reviewer, finance_manager, analytics_viewer. Two accounts exist today, both super_admin. Voice/video: LiveKit (`server/rooms/voice/*`).

## Decided by the owner (2026-10-25)

1. **Two proof methods:** upload (ID photo plus a code selfie) or a private live video check with a reviewer (nothing recorded or stored).
2. **Who may review:** `super_admin`, `admin`, and a **new `age_reviewer`** role (granted only by a super_admin). `user_support` may not see evidence.
3. **Mismatch rule, strong proof wins safely:** under-18 on the ID moves the account to the teen group at once (one reviewer); an adult but different birthdate needs a second approval from a different `super_admin`.
4. Automated providers (Yoti, Persona, Didit, Smile ID), UniFace and BetterAgeVerify are shelved. Nothing in this design blocks adding a provider later: it would be another `method` behind the existing `AgeVerifier` seam.

## Flag and secrets

- `AGE_REVIEW` (exactly `1` or `true`, default off): with it off, no route, screen, queue or notification exists and every response is unchanged.
- `AGE_EVIDENCE_KEY`: 32 random bytes, base64 (same format and boot rule as `PAYMENT_TOKEN_KEY`). In production, flag on with a missing/invalid key refuses to start.

## User flow

- Entry: Account settings "Verify your age" card; and a link wherever a rule says `PAYER_NOT_VERIFIED`, `NOT_VERIFIED_ADULT`, `HOST_NOT_VERIFIED`, `RECIPIENT_NOT_ALLOWED`, `HOST_NOT_PAYABLE`.
- Card states: `none`, `in_review` (cancel allowed), `needs_more`, `verified` (method + date, never the birthdate), `declined` (reason category; retry rules below).
- Users registered as under 18 are not offered adult verification.
- **Upload:** choose document type (`passport`, `drivers_licence`, `national_id`, `nin_slip`); one photo of the document (guidance: everything except photo, name and date of birth may be covered); one selfie holding a one-time code. Code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, valid 30 minutes, stored hashed, tied to the request. Consent screen states: who sees it (age reviewers only), that it is deleted at the decision or after 7 days, what is kept.
- **Live check:** user taps "Request a live check"; a reviewer sends an invite (in-app notification + email) valid 15 minutes; both join a private LiveKit room `agecheck-<requestId>` (max 2 participants, camera + mic, no egress/recording, closes after 20 minutes). The screen says "not recorded". The reviewer decides at the end of the call.
- Limits: one open request per user; after declines, at most 3 attempts per 30 days with 24 hours between; evidence upload endpoints rate-limited per user.
- Result: in-app notification and email on every decision.

## Privacy notice (pop-up)

- A privacy pop-up opens **before anything is captured or uploaded**, every time a request is started (a bottom sheet on phones, a dialog on desktop). It cannot be dismissed by tapping outside. The user must tick "I understand how my information is used" and tap "Continue"; "Not now" closes it and nothing is stored.
- It is also reachable at any time from a small "How your ID is handled" link on the Verify card, the upload screen and the live-check waiting screen (read-only the second time).
- The consent is recorded on the request: `consent_version` (for example `2026-10-v1`) and `consented_at`. If the copy changes, an open draft must be re-accepted. Reviewers only see "consent recorded".
- Copy (plain words, no dashes; final wording to be checked by the owner/a lawyer):
  - **Title:** Before you verify your age
  - **Why we ask:** Tipping, buying tickets and hosting paid rooms are for adults only. We check once. You can use the rest of Vib3Pulse without it.
  - **Who sees it:** Only trained Vib3Pulse age reviewers. No other staff and no other members.
  - **What happens:** A reviewer compares your document with the birthdate you gave when you signed up. Upload: we delete your photos as soon as a decision is made, or after 7 days if nobody has looked. Live check: nothing is recorded or saved.
  - **What we keep:** Only the result: verified or not, the date, the type of document, and whether the birthdate matched. Never your photos, the name on the document or the document number.
  - **Your choices:** Cover everything except your photo, name and date of birth. Cancel any time before a decision and your photos are deleted. Choose the live check instead of uploading. Saying no only means the adult only features stay off.
  - **Your safety:** If your document shows you are under 18, we will move your account to the right age group.
  - **Links:** "Read the full privacy policy" and "Ask about your data".
- The upload-version and live-version of the "what happens" line are chosen by the method the user picked.
- A **Privacy Policy page does not exist in the app yet**. Before enabling `AGE_REVIEW` the owner must provide one (a simple page or a link to the hosted policy) and the contact address for data requests; the pop-up links to it. Until then the link is hidden and the pop-up says so only in the reviewer-facing handover note, not to users.
- Live check call screen carries a persistent "Not recorded" badge.

## Reviewer flow and decisions

- Queue lists requests oldest first with status. Detail shows registered birthdate, document type, and the images blurred until "Reveal" (each reveal logged). A reviewer never sees anything else about the user beyond display name and registered birthdate.
- Decisions (`POST /api/admin/age-reviews/:id/decide`):
  - `verify`: ID birthdate equals the registered birthdate and the person is 18+. Sets verified (`method` = `admin_upload` or `admin_live`), deletes evidence.
  - `teen_correction`: ID shows under 18 while registered as adult. One reviewer suffices. Applies the birthdate correction through the existing `dobCorrection` path (adult-only memberships end, money features off), clears verification, deletes evidence, notifies the user.
  - `birthdate_change`: ID shows a different adult birthdate. Status `pending_second_approval`; a different `super_admin` approves (`POST .../second-approve`) or rejects. Only on approval: correct the birthdate through `dobCorrection` and verify. Until then nothing changes.
  - `needs_more`: ask for another photo (max 2 per request).
  - `decline` with reason: `unreadable`, `expired`, `face_mismatch`, `code_missing`, `looks_edited`, `other`.
  - `not_eligible_minor`: ID matches the registered birthdate and shows under 18: no change, request closed.
- The old direct button (`POST /api/admin/users/:id/age-verification`) is kept as an emergency override for `super_admin`, `admin`, `age_reviewer` only (user_support removed), reason required (3..300 chars), audited.
- After any final outcome the request keeps only: reviewer id(s), timestamps, method, outcome, document type, `dob_match` boolean. No images, names or document numbers are stored.

## Data model (additive, applied to the real DB with the code)

- `age_review_requests`: `id uuid pk`, `user_id`, `method` ('upload'|'live'), `status` ('draft','submitted','in_review','needs_more','pending_second_approval','approved','declined','expired','cancelled','closed_minor'), `document_type`, `code_hash`, `code_expires_at`, `registered_dob_snapshot` text, `reviewer_id`, `second_approver_id`, `outcome`, `decline_reason`, `dob_match` boolean, `more_requests` int default 0, `live_invite_expires_at`, `consent_version`, `consented_at`, `created_at`, `submitted_at`, `decided_at`, `expires_at` (created + 7 days). Partial unique index: one open request per user.
- `age_review_evidence`: `id uuid pk`, `request_id`, `kind` ('document'|'selfie'), `mime`, `bytes_enc bytea` (AES-256-GCM, `v1:` key id prefix), `created_at`. Rows are DELETEd at the decision, on cancel, and by an hourly expiry sweep.
- Admin roles: add `age_reviewer` to `adminRoles` (shared/schema.ts) and to the admin-user create/edit validators.
- `AgeVerificationMethod` becomes `"admin" | "provider" | "admin_upload" | "admin_live"`; `toAgeVerification` maps the new values.

## Endpoints

- User (`requireAuth`, flag on): `GET /api/age-review/me`, `POST /api/age-review/requests` {method, documentType, consentVersion} (refused with `CONSENT_REQUIRED` unless the current copy version is accepted), `POST /api/age-review/requests/:id/evidence` (multipart-free: JSON base64 like existing upload routes, <= 3 MB each, JPEG/PNG/WebP by magic bytes), `POST .../submit`, `POST .../cancel`, `POST .../live-join` (token only while a valid invite exists).
- Admin (`requireRole("super_admin","admin","age_reviewer")` except second-approve = `super_admin`): `GET /api/admin/age-reviews`, `GET .../:id`, `GET .../:id/evidence/:evidenceId` (decrypt + stream, `Cache-Control: no-store`, logs the reveal), `POST .../:id/decide`, `POST .../:id/second-approve`, `POST .../:id/invite-live`, `POST .../:id/live-join`.
- Audit rows through `storage.logAdminActivity` for: reveal, decide, second approve, invite, override, expiry delete count.
- Global response redaction learns the evidence field names; no endpoint returns evidence bytes in JSON.

## Security rules

- Evidence only in `age_review_evidence`, never in `media_uploads`, never behind a public id or URL, never logged.
- A reviewer cannot decide a request about themselves, and the second approver must differ from the first reviewer.
- Stale/forged requests: only the owner can add evidence to their own `draft`/`needs_more` request; a user can never read evidence back.
- Re-encode images client-side (downscale to 1600 px longest edge, strips EXIF); the server validates magic bytes and size and strips metadata server-side if `sharp` is already a dependency.
- Recommended, owner to confirm: require two-factor login for any admin role that can reveal evidence (`admin`, `age_reviewer`), as is already required for `super_admin`.

## Privacy policy page (added 2026-10-25)

- New public page at `/privacy` (no login needed), content kept in one file (`shared/privacyPolicy.ts`: sections, `version`, `lastUpdated`) so counsel can edit wording without touching code. Contact for data requests: `info@aeoluslabsltd.com` (shown as a mailto link).
- Sections only state facts verified against the codebase (a data inventory is produced first): what we collect, why, who sees it, how long we keep it, who processes it for us (payments, video, email, hosting), where it is stored, children and age groups, the age-review section (copy matches the pop-up), your rights and how to use them, security, changes to the policy, contact.
- Linked from the sign-up page, the app footer/settings, the age-review pop-up and the Verify card. The pop-up's "Read the full privacy policy" and "Ask about your data" links go here (mailto for the second).
- The page ships regardless of `AGE_REVIEW`. The owner's lawyers review the text before `AGE_REVIEW` is turned on.

## Guardrails (added 2026-10-25)

Failure mode 1, evidence leaks (logs, caches, shared links, screenshots):
- Evidence bytes are fetched only after a reviewer clicks Reveal. Reveal is a POST that returns a **single-use, 60-second token** bound to that reviewer, that image and the request; the image URL with the token cannot be reused or shared. Plain GET without a token is 404.
- Response headers on every evidence response: `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Content-Security-Policy: sandbox`; no `ETag`.
- Revealed images re-blur after 30 seconds and carry a visible overlay with the reviewer's username, the request id and the time (a deterrent against screenshots).
- Request logging and error handlers never print bodies on the age-review paths; a structure test fails if evidence bytes, decrypted buffers or base64 payloads are passed to any logger, error message or audit detail. Global redaction covers the field names.
- Reveal rate limit per reviewer (60 per hour); exceeding it blocks further reveals and raises an `ALERT` log line plus an audit row. A super-admin "Age review health" strip shows reveals today per reviewer.
- A decryption failure fails closed (the request shows "evidence unavailable", nothing is returned).

Failure mode 2, evidence left behind:
- A decision (or cancel, or expiry) changes the status and deletes the evidence rows in **one transaction**; the evidence table has a foreign key to the request with `ON DELETE CASCADE`, and a unique index on (`request_id`, `kind`) so a request can hold at most one document and one selfie (a replacement overwrites).
- Hourly sweep plus a sweep at server start. An **invariant check** counts evidence rows whose request is final or older than 7 days: any non-zero count logs an `ALERT` and shows red in the health strip (with oldest evidence age and last sweep time).
- Deleting a user account purges their requests and evidence in the same operation.
- **Emergency purge** (super_admin only, reason required, audited): deletes all evidence immediately.
- **Intake pause**: a new control `age_review_paused` (super_admin or admin can pause; resume is super_admin only, matching the other admin-off switches) stops new uploads and invites at once, with a notice to users. Existing requests can still be decided or cancelled.

Failure mode 3, a minor passing with someone else's ID or one ID verifying many accounts:
- The **Verify button stays disabled until the reviewer ticks a checklist**: the face matches the selfie, the code on the selfie matches, the document type matches the one chosen, the document is not expired, the birthdate is readable, there are no signs of editing.
- **Duplicate-document guard:** the reviewer types the document number into a field that is never stored; the server computes a keyed hash (HMAC-SHA-256 with a key derived from `AGE_EVIDENCE_KEY`, plus document type) and stores only that fingerprint on the request. A second account whose fingerprint already verified another account cannot be verified without a super-admin override (reason required). This is the one place a derived identifier of the document number is kept, and it is flagged for counsel.
- A reviewer cannot decide their own request; the second approver differs from the first reviewer; direct override requires a reason and is audited.
- **Revoke verification** (super_admin, admin, age_reviewer; reason required, audited) clears the verified flag, so suspicious cases found later (a chargeback, a report that a verified account is a minor) can be re-checked.

## Testing

Unit: decision rules (all outcomes, second-approval rule, minor correction), code generation/expiry, `isIdVerifiedAdult` unchanged. API: role matrix (user_support/finance 403), user cannot read evidence, owner-only upload, one open request, rate limits, encrypt/decrypt round trip, deletion after every outcome/cancel/7-day expiry, second approver differs, reveal and decisions audited, evidence never in any JSON. WS/video with the fake voice service: invite, join, 2-participant cap, expiry. UI: card states, privacy pop-up (cannot continue without the tick, re-shown when `consent_version` changes, no capture before consent, copy has no dashes), upload form, reviewer queue, blur-until-reveal. Flag off: no new keys/routes. Guardrail tests: reveal token single use, 60 s expiry and wrong-admin refusal; no-store headers; no ETag; logger structure test; cascade delete; atomic decision + delete; invariant check and sweep; account-deletion purge; emergency purge and intake pause (super-admin only resume); checklist gating; duplicate-document refusal and override; fingerprint never reveals the number; revoke. One real-browser pass (user + reviewer).

## Non-goals (v1)

Automated checks or face estimation; a user who registered as under 18 but is really an adult (they use the existing birthdate-correction route through support, not this flow); BVN/NIN lookups; reusable credentials; scheduling slots for live checks; re-verification on expiry (a verification does not expire; birthdate changes go through the correction path).

## Open items

Two-factor for evidence-viewing roles (recommended yes); a short privacy notice and lawful-basis check under Nigeria's NDPA 2023 and, for UK users, UK GDPR before enabling; reviewer guidance for what counts as a valid document; target review time shown to users.
