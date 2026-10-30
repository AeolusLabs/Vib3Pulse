// Run: npx tsx server/utils/publicProfile.check.ts
import assert from "node:assert/strict";
import { toPublicProfile, hidePrivateContact } from "./publicProfile";

const row = {
  id: "u1", username: "djk", displayName: "DJ K", avatarUrl: "/a.png", bio: "hi", userType: "organizer",
  organizationName: "Club K", isVerified: true, isOfficial: false, location: "Lagos",
  email: "k@example.com", dateOfBirth: "1990-01-01", phoneNumber: "+234", verifiedPhone: "+234",
  googleId: "g1", zernioProfileId: "z1", passwordHash: "h", passwordResetToken: "t", emailVerificationToken: "t2",
  freePromotionCredits: 3, someFutureColumn: "x",
};

const pub = toPublicProfile(row) as Record<string, unknown>;

for (const k of ["id", "username", "displayName", "avatarUrl", "userType", "organizationName", "isVerified"]) {
  assert.equal(pub[k], (row as any)[k], `${k} must be kept`);
}
for (const k of ["email", "dateOfBirth", "phoneNumber", "verifiedPhone", "googleId", "zernioProfileId",
  "passwordHash", "passwordResetToken", "emailVerificationToken", "freePromotionCredits"]) {
  assert.ok(!(k in pub), `${k} must be removed`);
}
// allow-list: a column added to users later is hidden until someone opts it in
assert.ok(!("someFutureColumn" in pub), "unknown columns must be hidden by default");
assert.equal(row.email, "k@example.com", "input must not be mutated");

// chat keeps every other field (e.g. readReceiptsEnabled) and drops only contact/age data
const chat = hidePrivateContact({ ...row, readReceiptsEnabled: false, gender: "f" }) as Record<string, unknown>;
for (const k of ["email", "dateOfBirth", "phoneNumber", "verifiedPhone"]) assert.ok(!(k in chat), `${k} must be removed from chat users`);
assert.equal(chat.readReceiptsEnabled, false, "readReceiptsEnabled must survive (chat Seen status)");
assert.equal(chat.gender, "f");
assert.equal(chat.username, "djk");
assert.equal(row.email, "k@example.com", "input must not be mutated");
console.log("publicProfile: ok");
