// What another person may see of a user when it rides along inside someone else's data
// (an event's organiser, a search result). An allow-list on purpose: a column added to
// `users` later stays hidden until it is listed here, so it can't leak by default.
const PUBLIC_PROFILE_FIELDS = [
  "id", "username", "displayName", "avatarUrl", "avatar", "profilePhotoUrl", "bio", "userType",
  "organizationName", "location", "interests", "socialMediaLinks",
  "bannerMode", "bannerVibe", "bannerColor", "isVerified", "isOfficial", "createdAt",
] as const;

type PublicProfileField = typeof PUBLIC_PROFILE_FIELDS[number];

export function toPublicProfile<T extends object>(user: T): Pick<T, Extract<keyof T, PublicProfileField>> {
  const src = user as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_PROFILE_FIELDS) if (k in src) out[k] = src[k];
  return out as Pick<T, Extract<keyof T, PublicProfileField>>;
}

// For chat and DMs, where screens read more of a user than the feed does (e.g. readReceiptsEnabled for "Seen").
// Block-list on purpose: removes only what no other person should see and keeps every other field,
// so a chat screen can't lose a field it needs. Credentials are already removed by toPublicUser.
const HIDDEN_FROM_OTHERS = ["email", "dateOfBirth", "phoneNumber", "verifiedPhone"] as const;

export function hidePrivateContact<T extends object>(user: T): Omit<T, typeof HIDDEN_FROM_OTHERS[number]> {
  const out: Record<string, unknown> = { ...(user as Record<string, unknown>) };
  for (const k of HIDDEN_FROM_OTHERS) delete out[k];
  return out as Omit<T, typeof HIDDEN_FROM_OTHERS[number]>;
}
