// ID-verification seam. Pure; shared by server and client.
import { ageFromDob, ageBand } from "./age";

export const AGE_VERIFICATION_METHODS = ["admin", "provider", "admin_upload", "admin_live"] as const;
export type AgeVerificationMethod = typeof AGE_VERIFICATION_METHODS[number];

/** What the owner is told about their own verification. Never carries the birthdate. */
export interface AgeVerification {
  verified: boolean;
  band: "adult" | "teen" | null;
  at: string | null;
  method: AgeVerificationMethod | null;
}

/** True only when ID-verified AND the stored birthdate makes them 18 or over. */
export function isIdVerifiedAdult(u: { ageVerifiedAt: Date | null; dateOfBirth: string | null }, now: Date = new Date()): boolean {
  if (!u.ageVerifiedAt) return false;
  const age = ageFromDob(u.dateOfBirth, now);
  return age !== null && age >= 18;
}

export function toAgeVerification(
  u: { ageVerifiedAt: Date | null; ageVerifiedMethod: string | null; dateOfBirth: string | null },
  now: Date = new Date(),
): AgeVerification {
  const verified = !!u.ageVerifiedAt;
  const method = (AGE_VERIFICATION_METHODS as readonly string[]).includes(u.ageVerifiedMethod ?? "") ? (u.ageVerifiedMethod as AgeVerificationMethod) : null;
  return {
    verified,
    band: verified ? ageBand(ageFromDob(u.dateOfBirth, now)) : null,
    at: u.ageVerifiedAt ? u.ageVerifiedAt.toISOString() : null,
    method: verified ? method : null,
  };
}
