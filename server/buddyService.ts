import crypto from "crypto";
import { storage } from "./storage.js";
import { wsManager } from "./websocket.js";
import { sendUKSMS } from "./twilioService.js";
import { sendNigeriaSMS } from "./termiiService.js";
import type { SafetyBuddy } from "@shared/schema";

const MAX_PHONE_BUDDIES = 5;
const MAX_APP_BUDDIES = 5;
const TOKEN_TTL_HOURS = 48;

// Normalize any phone number to E.164 format
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");

  // Nigerian formats: starts with 0 (local) or 234 (national)
  if (digits.startsWith("234") && digits.length >= 13) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11 && !digits.startsWith("044")) {
    // Disambiguate: 07xxx is UK mobile — check for 07 pattern
    if (digits.startsWith("07") || digits.startsWith("08") || digits.startsWith("09")) {
      // Could be UK 07xxx or Nigerian 08xxx/09xxx — if explicitly +234 prefix was stripped, treat as Nigerian
      // Without country context we can't be certain; heuristic: if stored in DB as +44 or +234, use that
      // Here we treat 08/09 prefix as Nigerian, 07 as UK
      if (digits.startsWith("07")) return normalizeUKPhone(raw);
      return `+234${digits.slice(1)}`;
    }
  }
  if (digits.startsWith("44") && digits.length >= 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11 && digits.startsWith("07")) {
    return normalizeUKPhone(raw);
  }

  // Fallback for E.164 already or unknown format
  return raw.startsWith("+") ? raw : `+${digits}`;
}

// Normalize UK phone numbers to E.164 (+44...)
// 07700900000 → +447700900000, +447700900000 → +447700900000
export function normalizeUKPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("44") && digits.length >= 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+44${digits.slice(1)}`;
  return `+${digits}`;
}

function isNigerianNumber(phone: string): boolean {
  return phone.startsWith("+234");
}


async function sendBuddySMS(
  phone: string,
  userName: string,
  eventName: string
): Promise<void> {
  const ukTemplate = `${userName} is going to ${eventName} and has added you as their safety buddy on Vib3Pulse. If they need help, we will text you their location — no app needed. Reply YES to confirm or NO to decline. Vib3Pulse`;
  const ngTemplate = `${userName} is going to ${eventName} and has added you as their safety buddy on Vib3Pulse. If they need help, we go text you their location — no app needed. Reply YES to confirm or NO to decline. Vib3Pulse`;

  if (isNigerianNumber(phone)) {
    await sendNigeriaSMS(phone, ngTemplate);
  } else {
    await sendUKSMS(phone, ukTemplate);
  }
}

export async function sendAlertSMS(
  phone: string,
  senderName: string,
  alertMessage: string,
  locationText?: string | null
): Promise<void> {
  const locationPart = locationText ? ` Location: ${locationText}` : "";
  const body = `URGENT: ${senderName} needs help! "${alertMessage}"${locationPart} — Vib3Pulse Safety Alert`;
  try {
    if (isNigerianNumber(phone)) {
      await sendNigeriaSMS(phone, body);
    } else {
      await sendUKSMS(phone, body);
    }
  } catch (err: any) {
    console.error(`[BuddyService] Alert SMS failed to ${phone}:`, err.message);
  }
}

export async function assignBuddy(
  userId: string,
  name: string,
  rawPhone: string
): Promise<SafetyBuddy> {
  const phone = normalizePhone(rawPhone);

  // Enforce max 5 confirmed buddies
  const confirmed = await storage.getConfirmedBuddies(userId);
  if (confirmed.length >= MAX_PHONE_BUDDIES) {
    throw new Error(`Maximum of ${MAX_PHONE_BUDDIES} confirmed buddies allowed`);
  }

  // Don't allow duplicate pending invitation to same number
  const existing = await storage.getPendingBuddyByPhone(userId, phone);
  if (existing) {
    throw new Error("An invitation is already pending for this phone number");
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);

  const buddy = await storage.createBuddy({
    userId,
    name,
    phoneNumber: phone,
    confirmationStatus: "pending",
    confirmationToken: token,
    tokenExpiresAt: expiresAt,
    isPrimary: confirmed.length === 0, // first buddy is primary by default
  });

  // Look up user name for SMS
  const user = await storage.getUser(userId);
  const displayName = user?.displayName || user?.username || "Someone";

  // Get current event name if they have an upcoming ticket — fall back to a generic placeholder
  const eventName = "their next event";

  sendBuddySMS(phone, displayName, eventName).catch((err: any) => {
    console.error(`[BuddyService] SMS send failed to ${phone}:`, err.message);
  });

  console.log(`[BuddyService] Invitation sent to ${phone} for user ${userId}, token expires ${expiresAt.toISOString()}`);

  return buddy;
}

export async function processBuddySMSReply(
  fromNumber: string,
  replyText: string
): Promise<{ updated: boolean; userId?: string }> {
  const normalizedFrom = normalizePhone(fromNumber);
  const reply = replyText.trim().toUpperCase();

  if (reply !== "YES" && reply !== "NO") {
    console.log(`[BuddyService] Non-YES/NO reply from ${normalizedFrom}: "${replyText}"`);
    return { updated: false };
  }

  // Find the most recent pending buddy record for this phone
  const buddy = await storage.getPendingBuddyByPhoneGlobal(normalizedFrom);
  if (!buddy) {
    console.log(`[BuddyService] No pending buddy for ${normalizedFrom}`);
    return { updated: false };
  }

  // Check token hasn't expired
  if (buddy.tokenExpiresAt && new Date() > buddy.tokenExpiresAt) {
    await storage.updateBuddy(buddy.id, { confirmationStatus: "expired", confirmationToken: null });
    console.log(`[BuddyService] Token expired for buddy ${buddy.id}`);
    return { updated: false };
  }

  const newStatus = reply === "YES" ? "confirmed" : "declined";
  await storage.updateBuddy(buddy.id, {
    confirmationStatus: newStatus,
    confirmationToken: null, // one-time use
    tokenExpiresAt: null,
  });

  console.log(`[BuddyService] Buddy ${buddy.id} (${normalizedFrom}) replied ${reply} → status: ${newStatus}`);
  return { updated: true, userId: buddy.userId };
}

export async function expirePendingBuddies(): Promise<number> {
  const expired = await storage.getExpiredPendingBuddies();
  let count = 0;

  for (const buddy of expired) {
    try {
      await storage.updateBuddy(buddy.id, {
        confirmationStatus: "expired",
        confirmationToken: null,
        tokenExpiresAt: null,
      });

      // Notify the user in-app that their invitation expired
      await storage.createNotification({
        userId: buddy.userId,
        type: "buddy_request",
        title: "Buddy Invitation Expired",
        message: `Your invitation to ${buddy.name} (${buddy.phoneNumber}) has expired after 48 hours. Add them again to send a new invitation.`,
        link: "/safety/settings",
      });

      console.log(`[BuddyService] Expired invitation for buddy ${buddy.id} (${buddy.phoneNumber})`);
      count++;
    } catch (err: any) {
      console.error(`[BuddyService] Error expiring buddy ${buddy.id}:`, err.message);
    }
  }

  return count;
}

export async function getConfirmedBuddies(userId: string): Promise<SafetyBuddy[]> {
  return storage.getConfirmedBuddies(userId);
}

export async function removeBuddy(userId: string, buddyId: string): Promise<void> {
  const buddy = await storage.getBuddy(buddyId);
  if (!buddy) throw new Error("Buddy not found");
  if (buddy.userId !== userId) throw new Error("Forbidden");
  await storage.deleteBuddy(buddyId);
}

export async function assignAppBuddy(
  userId: string,
  targetUserId: string,
  name: string
): Promise<SafetyBuddy> {
  if (userId === targetUserId) throw new Error("You cannot add yourself as a buddy");

  const appCount = await storage.getAppBuddyCount(userId);
  if (appCount >= MAX_APP_BUDDIES) {
    throw new Error(`Maximum of ${MAX_APP_BUDDIES} in-app buddies allowed`);
  }

  // Check not already an app buddy with this user (any status)
  const existingBuddies = await storage.getBuddiesByUser(userId);
  const alreadyExists = existingBuddies.find((b) => b.buddyUserId === targetUserId);
  if (alreadyExists) throw new Error("You have already sent a buddy request to this person");

  const buddy = await storage.createBuddy({
    userId,
    buddyUserId: targetUserId,
    name,
    phoneNumber: null,
    confirmationStatus: "pending",
    confirmationToken: null,
    tokenExpiresAt: null,
    isPrimary: false,
  });

  const requester = await storage.getUser(userId);
  const requesterName = requester?.displayName || requester?.username || "Someone";

  // Notify the target user in-app
  await storage.createNotification({
    userId: targetUserId,
    type: "buddy_request",
    title: "Safety Buddy Request",
    message: `${requesterName} wants you to be their safety buddy on Vib3Pulse.`,
    link: "/buddy/settings",
  });

  wsManager.sendToUser(targetUserId, {
    type: "notification",
    data: { type: "buddy_request", fromUserId: userId, fromName: requesterName },
  });

  console.log(`[BuddyService] App buddy request sent from ${userId} to ${targetUserId}`);
  return buddy;
}

export async function acceptBuddyRequest(
  buddyId: string,
  acceptingUserId: string
): Promise<void> {
  const buddy = await storage.getBuddy(buddyId);
  if (!buddy) throw new Error("Buddy request not found");
  if (buddy.buddyUserId !== acceptingUserId) throw new Error("Forbidden");
  if (buddy.confirmationStatus !== "pending") throw new Error("Request is no longer pending");

  await storage.updateBuddy(buddyId, { confirmationStatus: "confirmed" });

  const accepter = await storage.getUser(acceptingUserId);
  const accepterName = accepter?.displayName || accepter?.username || "Your buddy";

  await storage.createNotification({
    userId: buddy.userId,
    type: "buddy_request_response",
    title: "Buddy Request Accepted!",
    message: `${accepterName} accepted your safety buddy request.`,
    link: "/buddy/settings",
  });

  wsManager.sendToUser(buddy.userId, {
    type: "notification",
    data: { type: "buddy_confirmed", buddyId },
  });

  console.log(`[BuddyService] App buddy ${buddyId} accepted by ${acceptingUserId}`);
}

export async function declineBuddyRequest(
  buddyId: string,
  decliningUserId: string
): Promise<void> {
  const buddy = await storage.getBuddy(buddyId);
  if (!buddy) throw new Error("Buddy request not found");
  if (buddy.buddyUserId !== decliningUserId) throw new Error("Forbidden");
  if (buddy.confirmationStatus !== "pending") throw new Error("Request is no longer pending");

  await storage.updateBuddy(buddyId, { confirmationStatus: "declined" });

  const decliner = await storage.getUser(decliningUserId);
  const declinerName = decliner?.displayName || decliner?.username || "Your buddy";

  await storage.createNotification({
    userId: buddy.userId,
    type: "buddy_request_response",
    title: "Buddy Request Declined",
    message: `${declinerName} declined your safety buddy request.`,
    link: "/buddy/settings",
  });

  wsManager.sendToUser(buddy.userId, {
    type: "notification",
    data: { type: "buddy_declined", buddyId },
  });

  console.log(`[BuddyService] App buddy ${buddyId} declined by ${decliningUserId}`);
}
