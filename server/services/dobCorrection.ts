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
  // Same UPDATE clears ID verification: it vouched for the old birthdate, not the corrected one.
  const updated = await storage.updateUser(a.userId, { dateOfBirth: a.dateOfBirth.slice(0, 10), ageVerifiedAt: null, ageVerifiedMethod: null } as any);
  await storage.logAdminActivity({
    adminId: a.adminId, action: "user.dob_corrected", targetType: "user", targetId: a.userId,
    details: `DOB ${user.dateOfBirth ?? "none"} -> ${a.dateOfBirth.slice(0, 10)}: ${reason}`, reason, ipAddress: a.ip,
  });
  // Rooms: someone corrected from under 18 to an adult while inside a minors' room is taken out unless the host invited
  // them; a host corrected to under 18 has every open room made a minors' room, and uninvited adults are taken out.
  await import("../rooms/roomSocket").then((m) => m.applyDobCorrection(a.userId)).catch((e) => console.error("[rooms] minors' room re-check failed:", e));
  return { ok: true, user: toPublicUser(updated) };
}
