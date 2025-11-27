import bcrypt from "bcrypt";
import { User } from "@shared/schema";

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
  };
}

declare global {
  namespace Express {
    interface User extends SessionUser {}
  }
}
