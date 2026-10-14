import { eq, inArray } from "drizzle-orm";
import type { Response } from "express";
import { db } from "../storage";
import { conversations, users } from "@shared/schema";
import { ageBand, ageFromDob } from "@shared/age";
import { resolveRoomPrivacy } from "@shared/rooms";

/**
 * Rooms put strangers of every age in one place, so a private channel between an adult and an under-18 needs both
 * people's consent: each has "allow direct messages between adults and under-18s" (off by default) and both must turn
 * it on. When it is allowed the person starting the chat still gets a warning first, and the other person sees a notice
 * in the thread. Unknown ages (no birthdate) are not treated as a gap. Existing threads are never blocked.
 */
export type AgeGap =
  | { gap: false }
  | { gap: true; blockedBy: "you" | "them" | null; otherIs: "minor" | "adult" };

export async function ageGapBetween(actorId: string, otherId: string): Promise<AgeGap> {
  const rows = await db.select({ id: users.id, dob: users.dateOfBirth, privacy: users.roomPrivacy }).from(users).where(inArray(users.id, [actorId, otherId]));
  const a = rows.find((r) => r.id === actorId), o = rows.find((r) => r.id === otherId);
  if (!a || !o) return { gap: false };
  const ab = ageBand(ageFromDob(a.dob)), ob = ageBand(ageFromDob(o.dob));
  if (!ab || !ob || ab === ob) return { gap: false };
  const blockedBy = !resolveRoomPrivacy(a.privacy).allowCrossAgeDm ? "you" : !resolveRoomPrivacy(o.privacy).allowCrossAgeDm ? "them" : null;
  return { gap: true, blockedBy, otherIs: ob === "teen" ? "minor" : "adult" };
}

export const AGE_GAP_MESSAGES = {
  // Shown to whoever tries: the restriction is described, never who has it set, beyond "you" vs "they".
  YOU: "Your privacy settings don't allow direct messages between adults and under-18s. You can change this in Settings > Privacy.",
  THEM: "This person has restrictions on who can message them.",
  warning: (otherIs: "minor" | "adult") =>
    otherIs === "minor"
      ? "This person is under 18. Think carefully about whether messaging them is appropriate."
      : "This person is an adult. We advise against messaging adults you don't know.",
  notice: (otherIs: "minor" | "adult") =>
    otherIs === "minor"
      ? "The other person is under 18."
      : "The other person is an adult. We advise against chatting privately with adults you don't know.",
} as const;

/**
 * Applies the rule to one person starting a chat with another. Returns true when the request may go ahead; otherwise it has
 * already answered (403 restricted, or 409 asking the actor to acknowledge the warning once).
 */
export async function enforceAgeGap(res: Response, actorId: string, otherId: string, opts: { acknowledged?: boolean; needAck?: boolean } = {}): Promise<boolean> {
  const g = await ageGapBetween(actorId, otherId);
  if (!g.gap) return true;
  if (g.blockedBy) {
    res.status(403).json({ message: g.blockedBy === "you" ? AGE_GAP_MESSAGES.YOU : AGE_GAP_MESSAGES.THEM, code: g.blockedBy === "you" ? "AGE_GAP_SELF_RESTRICTED" : "AGE_GAP_RESTRICTED" });
    return false;
  }
  if (opts.needAck && !opts.acknowledged) {
    res.status(409).json({ message: AGE_GAP_MESSAGES.warning(g.otherIs), code: "AGE_GAP_WARNING", otherIs: g.otherIs });
    return false;
  }
  return true;
}

export async function directThreadExists(a: string, b: string): Promise<boolean> {
  const [row] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.directKey, [a, b].sort().join(":"))).limit(1);
  return !!row;
}
