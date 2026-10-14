import { ageFromDob, MIN_PLATFORM_AGE } from "@shared/age";
import { storage } from "../storage";
import { toPublicUser } from "../auth";

type Result = { ok: true; user: ReturnType<typeof toPublicUser> } | { ok: false; status: 400 | 404; message: string };

/** The only way a stored birthdate changes after signup. Admin-initiated, reasoned, audited. */
export async function correctDateOfBirth(a: {
  adminId: string; userId: string; dateOfBirth: string; reason: string; ip?: string;
}): Promise<Result> {
  const reason = a.reason?.trim();
  if (!reason) return { ok: false, status: 400, message: "A reason is required" };
  const age = ageFromDob(a.dateOfBirth);
  if (age === null || age < MIN_PLATFORM_AGE || age >= 120) {
    return { ok: false, status: 400, message: `Date of birth must make the user at least ${MIN_PLATFORM_AGE}` };
  }
  const user = await storage.getUser(a.userId);
  if (!user) return { ok: false, status: 404, message: "User not found" };
  const updated = await storage.updateUser(a.userId, { dateOfBirth: a.dateOfBirth.slice(0, 10) } as any);
  await storage.logAdminActivity({
    adminId: a.adminId, action: "user.dob_corrected", targetType: "user", targetId: a.userId,
    details: `DOB ${user.dateOfBirth ?? "none"} -> ${a.dateOfBirth.slice(0, 10)}: ${reason}`, reason, ipAddress: a.ip,
  });
  return { ok: true, user: toPublicUser(updated) };
}
