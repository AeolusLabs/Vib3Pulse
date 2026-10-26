// Pure helpers for the age reviewer screens. No DOM, no network. Copy here has no dashes.

export const CHECKLIST_KEYS = ["faceMatches", "codeMatches", "documentTypeMatches", "notExpired", "birthdateReadable", "noEditing"] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];
export type Checklist = Record<ChecklistKey, boolean>;

export const CHECKLIST_LABEL: Record<ChecklistKey, string> = {
  faceMatches: "The face matches the selfie",
  codeMatches: "The code in the selfie matches",
  documentTypeMatches: "The document is the type the user chose",
  notExpired: "The document has not expired",
  birthdateReadable: "The birthdate is readable",
  noEditing: "There are no signs of editing",
};
export const emptyChecklist = (): Checklist => ({ faceMatches: false, codeMatches: false, documentTypeMatches: false, notExpired: false, birthdateReadable: false, noEditing: false });
export type ReviewMethod = "upload" | "live";
/** A live check has no selfie code, so the server asks for the other five checks only. */
export const requiredChecks = (method: ReviewMethod = "upload"): readonly ChecklistKey[] =>
  method === "live" ? CHECKLIST_KEYS.filter((k) => k !== "codeMatches") : CHECKLIST_KEYS;
export const checklistComplete = (c: Partial<Checklist>, method: ReviewMethod = "upload"): boolean => requiredChecks(method).every((k) => c[k] === true);

export type Outcome = "verify" | "teen_correction" | "birthdate_change" | "needs_more" | "decline" | "not_eligible_minor";
export const OUTCOME_LABEL: Record<Outcome, string> = {
  verify: "Verify",
  teen_correction: "Under 18: move to teen group",
  birthdate_change: "Different adult birthdate",
  needs_more: "Ask for another photo",
  decline: "Decline",
  not_eligible_minor: "Matches, but under 18",
};
export const OUTCOME_HELP: Record<Outcome, string> = {
  verify: "The ID birthdate equals the registered one and the person is 18 or over.",
  teen_correction: "The ID shows under 18 while the account says adult. This moves the account to the teen group now.",
  birthdate_change: "The ID shows a different adult birthdate. A different super admin must approve before anything changes.",
  needs_more: "Asks the user for a clearer photo. Allowed twice per request.",
  decline: "Closes the request with a reason the user sees as a category.",
  not_eligible_minor: "The ID matches the registered birthdate and shows under 18. Nothing changes and the request closes.",
};
export const DECLINE_REASONS = ["unreadable", "expired", "face_mismatch", "code_missing", "looks_edited", "other"] as const;
export const DECLINE_LABEL: Record<(typeof DECLINE_REASONS)[number], string> = {
  unreadable: "Unreadable",
  expired: "Expired",
  face_mismatch: "Face does not match",
  code_missing: "Code missing",
  looks_edited: "Looks edited",
  other: "Other",
};
/** Outcomes that need a second look before they are sent. */
export const CONFIRM_TEXT: Partial<Record<Outcome, string>> = {
  teen_correction: "This moves the account to the teen group now. Adult only features end straight away.",
  birthdate_change: "This asks a different super admin to approve a new birthdate. Nothing changes until they do.",
};

export const outcomesFor = (method: ReviewMethod): Outcome[] =>
  (["verify", "teen_correction", "birthdate_change", "needs_more", "decline", "not_eligible_minor"] as Outcome[]).filter((o) => !(method === "live" && o === "needs_more"));
export const DOC_TYPES = ["passport", "drivers_licence", "national_id", "nin_slip"] as const;
export const DOC_TYPE_LABEL: Record<(typeof DOC_TYPES)[number], string> = { passport: "Passport", drivers_licence: "Driver's licence", national_id: "National ID card", nin_slip: "NIN slip" };
/** Outcomes that read the document: they need its type. teen_correction does not (the server only uses the ID birthdate). */
const ID_OUTCOMES: Outcome[] = ["verify", "birthdate_change"];
/** verify and birthdate_change both fingerprint the document number, so they share the full checklist and the duplicate check. */
export const needsDocumentNumber = (o: Outcome | null): boolean => o === "verify" || o === "birthdate_change";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export interface DecisionForm {
  outcome: Outcome | null;
  checklist: Checklist;
  idBirthdate: string;
  documentNumber: string;
  documentType: string;
  /** Full name on the document: asked only when the user chose to receive money. Never logged or kept after a submit. */
  legalName: string;
  declineReason: string;
  note: string;
  overrideReason: string;
}

/** Whether the submit button is enabled. Verify stays off until all six checks are ticked. */
/**
 * Mirrors the server's normaliseLegalName (server/identity/verifiedName.ts) so a name the form accepts is one the server accepts:
 * NFC, whitespace collapsed and trimmed, 3 to 120 characters, letters of the scripts our users write (by char code, no regex
 * flags), combining marks, and space . ' U+2019 and hyphen between words. U+02BC is refused, like the server. Returns the
 * name the server will store, or null.
 */
export function normaliseLegalName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (n.length < 3 || n.length > 120) return null;
  const letter = (ch: string) => {
    if (/[A-Za-z]/.test(ch)) return true;
    const c = ch.charCodeAt(0);
    return (c >= 0xc0 && c <= 0x2af && c !== 0xd7 && c !== 0xf7) || (c >= 0x300 && c <= 0x36f) || (c >= 0x370 && c <= 0x1fff) || (c >= 0x3040 && c <= 0x9fff);
  };
  const punct = (ch: string) => ch === " " || ch === "." || ch === "'" || ch === "’" || ch === "-";
  for (let i = 0; i < n.length; i++) if (!letter(n[i]) && !punct(n[i])) return null;
  return letter(n[0]) ? n : null;
}
export const legalNameValid = (raw: string): boolean => normaliseLegalName(raw) !== null;
export const LEGAL_NAME_HINT = "Letters, spaces, hyphens, apostrophes and dots, 3 to 120 characters";
/** Shown under the field once something is typed and it is not usable yet. */
export const legalNameProblem = (raw: string): string | null => (raw.trim() === "" || legalNameValid(raw) ? null : LEGAL_NAME_HINT);
export function decisionReady(f: DecisionForm, method: ReviewMethod = "upload", wantsPayouts = false): boolean {
  if (wantsPayouts && needsDocumentNumber(f.outcome) && !legalNameValid(f.legalName)) return false;
  if (f.outcome && ID_OUTCOMES.includes(f.outcome) && !(DOC_TYPES as readonly string[]).includes(f.documentType)) return false;
  if (f.outcome === "needs_more" && method === "live") return false;
  switch (f.outcome) {
    case "verify":
    case "birthdate_change": return checklistComplete(f.checklist, method) && isIsoDate(f.idBirthdate) && f.documentNumber.trim().length >= 3;
    case "teen_correction": return isIsoDate(f.idBirthdate);
    case "decline": return (DECLINE_REASONS as readonly string[]).includes(f.declineReason);
    case "needs_more":
    case "not_eligible_minor": return true;
    default: return false;
  }
}

export function decisionBody(f: DecisionForm, opts: { overrideAllowed: boolean; wantsPayouts?: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = { outcome: f.outcome, checklist: f.checklist };
  if (f.outcome === "teen_correction") body.idBirthdate = f.idBirthdate;
  if (f.outcome && ID_OUTCOMES.includes(f.outcome)) { body.idBirthdate = f.idBirthdate; body.documentType = f.documentType; }
  if (needsDocumentNumber(f.outcome)) body.documentNumber = f.documentNumber.trim();
  // Only for a request that asked for payouts; otherwise the server answers NAME_NOT_REQUESTED.
  if (opts.wantsPayouts === true && needsDocumentNumber(f.outcome)) body.legalName = normaliseLegalName(f.legalName) ?? f.legalName.trim();
  if (f.outcome === "decline") body.declineReason = f.declineReason;
  if (f.note.trim()) body.note = f.note.trim();
  if (needsDocumentNumber(f.outcome) && opts.overrideAllowed && f.overrideReason.trim().length >= 3) body.overrideDuplicate = { reason: f.overrideReason.trim() };
  return body;
}

// ---- statuses (an icon name and words, never colour alone) ----
export type StatusTone = "wait" | "work" | "good" | "bad" | "idle";
export const STATUS_META: Record<string, { label: string; icon: "clock" | "eye" | "check" | "x" | "alert" | "users"; tone: StatusTone }> = {
  draft: { label: "Draft", icon: "clock", tone: "idle" },
  submitted: { label: "Waiting for review", icon: "clock", tone: "wait" },
  in_review: { label: "Being reviewed", icon: "eye", tone: "work" },
  needs_more: { label: "Waiting for the user", icon: "alert", tone: "wait" },
  pending_second_approval: { label: "Waiting for second approval", icon: "users", tone: "wait" },
  approved: { label: "Approved", icon: "check", tone: "good" },
  declined: { label: "Declined", icon: "x", tone: "bad" },
  expired: { label: "Expired", icon: "clock", tone: "idle" },
  cancelled: { label: "Cancelled", icon: "x", tone: "idle" },
  closed_minor: { label: "Closed, under 18", icon: "x", tone: "idle" },
};
export const statusMeta = (s: string) => STATUS_META[s] ?? { label: s.replace(/_/g, " "), icon: "clock" as const, tone: "idle" as const };
export const QUEUE_FILTERS = [
  { value: "", label: "Open" },
  { value: "submitted", label: "Waiting" },
  { value: "in_review", label: "Being reviewed" },
  { value: "pending_second_approval", label: "Second approval" },
  { value: "needs_more", label: "Waiting for user" },
] as const;
export const methodLabel = (m: string) => (m === "live" ? "Live" : "Upload");

export function registeredAge(dob: string, now: Date = new Date()): number | null {
  if (!isIsoDate(dob)) return null;
  const y = Number(dob.slice(0, 4)), m = Number(dob.slice(5, 7)), d = Number(dob.slice(8, 10));
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age >= 0 ? age : null;
}

// ---- roles ----
export const ADMIN_ROLES = ["super_admin", "admin", "content_moderator", "user_support", "event_reviewer", "finance_manager", "analytics_viewer", "age_reviewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const REVIEW_ROLES: readonly string[] = ["super_admin", "admin", "age_reviewer"];
export const AGE_REVIEW_PATH = "/admin/age-reviews";
/** A role's nav: age reviewers see only the Age reviews page; every other role is unchanged. */
export const navAllowed = (role: string, itemPath: string, itemRoles: readonly string[]): boolean =>
  role === "age_reviewer" ? itemPath === AGE_REVIEW_PATH : itemRoles.includes(role);
export const canReview = (role: string) => REVIEW_ROLES.includes(role);
export const canSeeHealth = (role: string) => role === "super_admin" || role === "admin";
export const canSecondApprove = (role: string) => role === "super_admin";
export const canPurge = (role: string) => role === "super_admin";
export const canOverrideDuplicate = (role: string) => role === "super_admin";
/** Marking a user verified is an override: super admin and admin only. Revoking is also open to age reviewers. */
export const canMarkVerified = (role: string) => role === "super_admin" || role === "admin";
export const canRevoke = (role: string) => REVIEW_ROLES.includes(role);
/** The Age reviews nav item shows only when the role may use it and the feature is switched on (unknown counts as off). */
export const navVisible = (role: string, itemPath: string, itemRoles: readonly string[], ageReviewOn: boolean | undefined): boolean =>
  navAllowed(role, itemPath, itemRoles) && (itemPath !== AGE_REVIEW_PATH || ageReviewOn === true);

/** Pausing: super_admin or admin. Resuming: super_admin only. */
export const canSetPause = (role: string, on: boolean) => (on ? role === "super_admin" || role === "admin" : role === "super_admin");
export const RESUME_DISABLED_REASON = "Only a super admin can switch age checks back on.";
export const pauseDisabledReason = (role: string, on: boolean): string | null =>
  canSetPause(role, on) ? null : on ? "Your role cannot pause age checks." : RESUME_DISABLED_REASON;

export const PURGE_WORD = "PURGE";
export const purgeReady = (typed: string, reason: string): boolean => typed === PURGE_WORD && reason.trim().length >= 3;
export const reasonOk = (reason: string): boolean => reason.trim().length >= 3 && reason.trim().length <= 300;

// ---- evidence reveal ----
export const REBLUR_MS = 30_000;
export const watermarkText = (username: string, requestId: string, now: Date = new Date()): string =>
  `${username} · ${requestId.slice(0, 8)} · ${now.toISOString().slice(11, 19)} UTC`;

/** Starts the re-blur countdown. When it fires, the image source is dropped; cancel() stops it. Timer functions are injectable for tests. */
export function startReblur(
  onExpire: () => void,
  ms: number = REBLUR_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (fn, t) => setTimeout(fn, t), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
): { cancel: () => void } {
  const h = timers.set(onExpire, ms);
  return { cancel: () => timers.clear(h) };
}

// ---- health ----
export const STALE_TEXT = "Evidence older than its request: investigate";
export const isStale = (h: { staleEvidence: number }): boolean => h.staleEvidence > 0;
export function ageText(hours: number | null): string {
  if (hours === null || hours === undefined) return "None held";
  if (hours < 1) return "Under an hour";
  if (hours < 48) return `${Math.floor(hours)} hours`;
  return `${Math.floor(hours / 24)} days`;
}

// ---- errors ----
export const ADMIN_ERROR_CODES = [
  "CONSENT_REQUIRED", "AGE_REVIEW_PAUSED", "OPEN_REQUEST_EXISTS", "RATE_LIMITED", "NOT_OFFERED", "BAD_FILE", "TOO_LARGE",
  "EVIDENCE_INCOMPLETE", "WRONG_STATE", "CODE_EXPIRED", "NOT_ALLOWED", "SECOND_APPROVER_MUST_DIFFER", "SELF_REVIEW",
  "CHECKLIST_INCOMPLETE", "DUPLICATE_DOCUMENT", "REVEAL_LIMIT", "TOKEN_INVALID", "REASON_REQUIRED",
  "BIRTHDATE_MISMATCH", "EVIDENCE_UNAVAILABLE", "NOT_FOUND", "BAD_REQUEST", "VOICE_UNAVAILABLE", "AGE_REVIEW_OFF",
  "NAME_REQUIRED", "NAME_NOT_REQUESTED", "ALREADY_VERIFIED",
] as const;
const ADMIN_ERROR: Record<(typeof ADMIN_ERROR_CODES)[number], string> = {
  CONSENT_REQUIRED: "The user has not accepted the privacy notice yet.",
  AGE_REVIEW_PAUSED: "Age checks are paused. Decisions and cancels still work, but invites and new uploads do not.",
  OPEN_REQUEST_EXISTS: "This user already has a request open.",
  RATE_LIMITED: "Too many attempts. Please wait a bit.",
  NOT_OFFERED: "This account was registered under 18, so adult verification is not offered.",
  BAD_FILE: "That file was not a usable image.",
  TOO_LARGE: "That file is too large.",
  EVIDENCE_INCOMPLETE: "The user has not added both photos yet.",
  WRONG_STATE: "This request has changed, for example the user cancelled or it expired. The list was refreshed.",
  CODE_EXPIRED: "The selfie code has run out.",
  NOT_ALLOWED: "Your role cannot do that.",
  SECOND_APPROVER_MUST_DIFFER: "The second approver must be a different super admin from the first reviewer.",
  SELF_REVIEW: "You cannot review a request about your own account.",
  CHECKLIST_INCOMPLETE: "Tick all six checks before you verify.",
  DUPLICATE_DOCUMENT: "This document was already used to verify another account. A super admin can override with a reason.",
  REVEAL_LIMIT: "You have viewed too many images this hour. Try again later.",
  TOKEN_INVALID: "That image link has expired or was already used. Press Reveal again.",
  REASON_REQUIRED: "Please write a reason (3 to 300 characters).",
  BIRTHDATE_MISMATCH: "The ID birthdate does not fit this outcome. Check the date, or pick the outcome that matches.",
  EVIDENCE_UNAVAILABLE: "The image could not be opened. It may be gone or unreadable.",
  NOT_FOUND: "That request no longer exists.",
  BAD_REQUEST: "Something in the form is not valid. Check the fields and try again.",
  VOICE_UNAVAILABLE: "Live video is not available right now.",
  AGE_REVIEW_OFF: "Age review is not switched on.",
  NAME_REQUIRED: "This user asked to receive money, so type the full name on the document before you verify.",
  NAME_NOT_REQUESTED: "This user did not ask to receive money, so no name is needed. Clear the name field and try again.",
  ALREADY_VERIFIED: "This user is already verified.",
};
export function adminErrorMessage(code: string | undefined | null, extra?: { retryAfter?: string | null }): string {
  if (code === "RATE_LIMITED" && extra?.retryAfter) return "Too many attempts. Please wait a bit and try again.";
  if (code && Object.prototype.hasOwnProperty.call(ADMIN_ERROR, code)) return ADMIN_ERROR[code as keyof typeof ADMIN_ERROR];
  return "Something went wrong. Please try again.";
}

export const OFF_PANEL = { title: "Age review is not switched on", body: "Nothing is wrong. Ask a super admin to switch the age review feature on when you are ready to use it." } as const;
export const isAgeReviewOff = (e: { status?: number; code?: string } | null | undefined): boolean => !!e && e.code === "AGE_REVIEW_OFF";

export function approveDescription(approve: boolean, registeredDob: string, proposedDob: string | null): string {
  if (!approve) return "Nothing changes and the request is declined.";
  return proposedDob ? `Change ${registeredDob || "the registered birthdate"} to ${proposedDob} and verify the account.` : "The birthdate is corrected to the one on the ID and the account is verified.";
}

/** Makes a blob URL only if the screen is still there; a late reveal after close or unmount creates nothing to leak. */
export function urlUnlessCancelled(blob: Blob, cancelled: () => boolean, create: (b: Blob) => string): string | null {
  return cancelled() ? null : create(blob);
}

/** The second approver's body: the override reason is sent only after the server answered 409 DUPLICATE_DOCUMENT, and only by a super admin. */
export function secondApproveBody(approve: boolean, reason: string, override: { allowed: boolean; reason: string }): Record<string, unknown> {
  const body: Record<string, unknown> = { approve, reason };
  if (approve && override.allowed && override.reason.trim().length >= 3) body.overrideDuplicate = { reason: override.reason.trim() };
  return body;
}
