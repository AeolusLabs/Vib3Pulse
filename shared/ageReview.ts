// Manual age review: constants and pure rules shared by server and client. No database.
import { ageFromDob } from "./age";

export const CONSENT_VERSION = "2026-10-v1";
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 30 * 60 * 1000;
export const REQUEST_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVE_INVITE_TTL_MS = 15 * 60 * 1000;
export const LIVE_ROOM_MAX_MS = 20 * 60 * 1000;
export const LIVE_ROOM_MAX_PARTICIPANTS = 2;
export const EVIDENCE_MAX_BYTES = 3 * 1024 * 1024;
export const EVIDENCE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_NEEDS_MORE_ROUNDS = 2;
export const MAX_DECLINES_PER_WINDOW = 3;
export const DECLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DECLINE_GAP_MS = 24 * 60 * 60 * 1000;
export const REVEAL_TOKEN_TTL_SEC = 60;
export const REVEAL_LIMIT_PER_HOUR = 60;
export const DOCUMENT_TYPES = ["passport", "drivers_licence", "national_id", "nin_slip"] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export type AgeReviewStatus = "draft" | "submitted" | "in_review" | "needs_more" | "pending_second_approval" | "approved" | "declined" | "expired" | "cancelled" | "closed_minor";
export const OPEN_STATUSES: readonly AgeReviewStatus[] = ["draft", "submitted", "in_review", "needs_more", "pending_second_approval"];
/** The user may cancel up to the point a second approver is involved. */
export const CANCELLABLE_STATUSES: readonly AgeReviewStatus[] = ["draft", "submitted", "in_review", "needs_more"];

export function isOpenStatus(s: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(s);
}

const FINAL: AgeReviewStatus[] = [];
const TRANSITIONS: Record<AgeReviewStatus, readonly AgeReviewStatus[]> = {
  draft: ["submitted", "cancelled", "expired"],
  submitted: ["in_review", "needs_more", "pending_second_approval", "approved", "declined", "closed_minor", "cancelled", "expired"],
  in_review: ["submitted", "needs_more", "pending_second_approval", "approved", "declined", "closed_minor", "cancelled", "expired"],
  needs_more: ["submitted", "declined", "cancelled", "expired"],
  pending_second_approval: ["approved", "declined", "expired"],
  approved: FINAL, declined: FINAL, expired: FINAL, cancelled: FINAL, closed_minor: FINAL,
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from as AgeReviewStatus] ?? []).includes(to as AgeReviewStatus);
}

/** Uniform pick of CODE_LENGTH characters. `rand(n)` returns an integer in [0, n); the default is unbiased (rejection sampling). */
export function generateCode(rand: (n: number) => number = secureInt): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return out;
}

function secureInt(n: number): number {
  const limit = 256 - (256 % n);
  const b = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(b);
    if (b[0] < limit) return b[0] % n;
  }
}

export function registeredEligibility(dob: string | null | undefined, now: Date = new Date()): "ok" | "under_18" | "no_dob" {
  const age = ageFromDob(dob, now);
  if (age === null) return "no_dob";
  return age < 18 ? "under_18" : "ok";
}

/** Only declines count: 3 per 30 days, and 24 hours after the latest one. */
export function attemptState(
  history: { status: string; decidedAt: Date | null }[],
  now: Date = new Date(),
): { attemptsLeft: number; retryAfter: Date | null } {
  const t = now.getTime();
  const declines = history
    .filter((h) => h.status === "declined" && h.decidedAt && t - h.decidedAt.getTime() < DECLINE_WINDOW_MS)
    .map((h) => h.decidedAt!.getTime())
    .sort((a, b) => a - b);
  const attemptsLeft = Math.max(0, MAX_DECLINES_PER_WINDOW - declines.length);
  let retry = 0;
  if (declines.length > 0) retry = declines[declines.length - 1] + DECLINE_GAP_MS;
  // The window frees a slot when the decline that makes it full ages out.
  if (attemptsLeft === 0) retry = Math.max(retry, declines[declines.length - MAX_DECLINES_PER_WINDOW] + DECLINE_WINDOW_MS);
  return { attemptsLeft, retryAfter: retry > t ? new Date(retry) : null };
}

export const CHECKLIST_KEYS = ["faceMatches", "codeMatches", "documentTypeMatches", "notExpired", "birthdateReadable", "noEditing"] as const;
export type ChecklistKey = typeof CHECKLIST_KEYS[number];
export const DECISION_OUTCOMES = ["verify", "teen_correction", "birthdate_change", "needs_more", "decline", "not_eligible_minor"] as const;
export type DecisionOutcome = typeof DECISION_OUTCOMES[number];
export const DECLINE_REASONS = ["unreadable", "expired", "face_mismatch", "code_missing", "looks_edited", "other"] as const;
export type DeclineReason = typeof DECLINE_REASONS[number];
