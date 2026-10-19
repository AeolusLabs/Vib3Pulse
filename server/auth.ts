import bcrypt from "bcrypt";
import { User, AdminUser } from "@shared/schema";
import type { AvatarConfig } from "@shared/avatar";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export type SessionUser = {
  id: string;
  username: string;
  email: string;
  userType: string;
  displayName?: string | null;
  organizationName?: string | null;
  gender?: string | null;
  genderEditedAt?: Date | null;
  canManageVenues?: boolean | null;
  isVerified?: boolean | null;
  isOfficial?: boolean | null;
  avatarUrl?: string | null;
  avatar?: AvatarConfig | null;
  onboardingComplete: boolean;
  hasPassword: boolean;
};

export function userToSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    userType: user.userType,
    displayName: user.displayName,
    organizationName: user.organizationName,
    gender: user.gender,
    genderEditedAt: user.genderEditedAt,
    canManageVenues: user.canManageVenues,
    isVerified: user.isVerified,
    isOfficial: user.isOfficial,
    avatarUrl: user.avatarUrl,
    avatar: user.avatar ?? null,
    onboardingComplete: user.onboardingComplete,
    hasPassword: !!user.passwordHash,
  };
}

declare global {
  namespace Express {
    interface User extends SessionUser {}
  }
}

// The one place a raw `users` row gets turned into something safe to embed in
// an API response. Every storage.ts function that joins the users table and
// returns a `User` object to a route MUST pass it through this first — do not
// hand-roll another `const { passwordHash, ...rest } = user` destructure.
// Credentials and live tokens have leaked through this exact class of forgotten
// destructure repeatedly (see feedback_schema_migrations.md / the passwordHash
// leak audit) because there was no single shared definition of "safe" to reuse.
const SENSITIVE_USER_FIELDS = [
  "passwordHash",
  "passwordResetToken",
  "passwordResetExpires",
  "emailVerificationToken",
  "emailVerificationExpires",
  // The phone number a host verified for social events. Never part of a public user object: it would
  // otherwise ride along in every feed, event organiser block and admin list that embeds a user.
  "verifiedPhone",
] as const;

// Hidden from every public user object (feeds, organiser blocks, admin lists) but, unlike the fields above,
// NOT stripped by key name from all responses: safety buddies legitimately return a "phoneNumber" to their owner.
// ageVerifiedAt/Method: the owner reads them from GET /api/users/me/age-verification.
// roomPrivacy: another user's room settings are theirs; the owner reads them from GET /api/users/me/room-privacy.
// sprayDailyLimitKobo: the owner reads it from GET /api/users/me/spray as dailyLimitKobo.
const PUBLIC_HIDDEN_USER_FIELDS = ["phoneNumber", "roomPrivacy", "ageVerifiedAt", "ageVerifiedMethod", "sprayDailyLimitKobo"] as const;

export type PublicUser = Omit<User, typeof SENSITIVE_USER_FIELDS[number] | typeof PUBLIC_HIDDEN_USER_FIELDS[number]>;

export function toPublicUser(user: User): PublicUser {
  const {
    passwordHash,
    passwordResetToken,
    passwordResetExpires,
    emailVerificationToken,
    emailVerificationExpires,
    verifiedPhone,
    phoneNumber,
    roomPrivacy,
    ageVerifiedAt,
    ageVerifiedMethod,
    sprayDailyLimitKobo,
    ...safe
  } = user;
  return safe;
}

export type PublicAdminUser = Omit<AdminUser, "passwordHash">;

export function toPublicAdminUser(admin: AdminUser): PublicAdminUser {
  const { passwordHash, ...safe } = admin;
  return safe;
}

// Belt-and-suspenders for API responses: recursively strips these same field
// names from any outgoing JSON body, so a future function that forgets to call
// toPublicUser()/toPublicAdminUser() still can't leak them to the client.
// Wired up as global response middleware in server/index.ts.
export const SENSITIVE_RESPONSE_KEYS = new Set<string>([
  ...SENSITIVE_USER_FIELDS,
  // Social events: these ride along on any `select()` of events/tickets. The
  // social routes emit them deliberately under different keys (address, inviteUrl,
  // name) after their own access checks, so a generic endpoint can never leak them.
  "exactAddress",
  "inviteToken",
  "inviteTokenHash",
  "guestTokenHash",
  "guestName",
  // ID-verification columns: the owner reads them via GET /api/users/me/age-verification, which uses the
  // different keys verified/band/at/method, so a stray raw users row can never carry them out.
  "ageVerifiedAt",
  "ageVerifiedMethod",
  "age_verified_at",
  "age_verified_method",
  // Spraying (phase 5): a saved card's encrypted authorization code, its card signature and any raw provider authorization
  // code are secrets. The spray routes never return them; this strips them from any body that forgets. The daily limit
  // column is private (the owner gets it as dailyLimitKobo).
  "authEnc",
  "auth_enc",
  "signature",
  "authorizationCode",
  "authorization_code",
  "sprayDailyLimitKobo",
  "spray_daily_limit_kobo",
]);
