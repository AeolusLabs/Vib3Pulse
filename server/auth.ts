import bcrypt from "bcrypt";
import { User, AdminUser } from "@shared/schema";

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
] as const;

export type PublicUser = Omit<User, typeof SENSITIVE_USER_FIELDS[number]>;

export function toPublicUser(user: User): PublicUser {
  const {
    passwordHash,
    passwordResetToken,
    passwordResetExpires,
    emailVerificationToken,
    emailVerificationExpires,
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
]);
