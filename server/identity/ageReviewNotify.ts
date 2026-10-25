// In-app notification + email for age review outcomes. Never throws, never logs user data or evidence.
export type AgeReviewNoticeKind = "approved" | "declined" | "needs_more" | "teen_moved" | "live_invite" | "expired" | "update";

export const AGE_REVIEW_NOTICE_COPY: Record<AgeReviewNoticeKind, { title: string; message: string }> = {
  approved: { title: "Your age is verified", message: "You can now use the adult only features, like tipping and tickets. Your photos have been deleted." },
  declined: { title: "We could not verify your age", message: "Open Vib3Pulse to see why and what you can do next. Your photos have been deleted." },
  needs_more: { title: "We need one more photo", message: "A reviewer asked for another photo. Open Vib3Pulse to add it." },
  teen_moved: { title: "Your account has been updated", message: "We moved your account to the right age group. Your photos have been deleted." },
  live_invite: { title: "Your live age check is ready", message: "A reviewer is waiting. Join within 15 minutes. Nothing is recorded." },
  update: { title: "Your age review has an update", message: "Open Vib3Pulse to see what to do next. Your photos may need to be added again." },
  expired: { title: "Your age check expired", message: "Nobody reviewed it in time and your photos were deleted. You can start again any time." },
};

export async function notifyAgeReview(userId: string, kind: AgeReviewNoticeKind, detail?: string): Promise<void> {
  const c = AGE_REVIEW_NOTICE_COPY[kind];
  const link = "/account/settings#verify-age";
  const message = detail ? `${c.message} ${detail}` : c.message;
  try {
    const { deliverNotification } = await import("../notifications");
    await deliverNotification({ userId, type: "age_review", title: c.title, message, link, push: { title: "Vib3Pulse", body: "Your age review has an update" } }); // neutral: a lock screen must not show the outcome
  } catch {
    console.error(`[AGE-REVIEW] in-app notice failed (${kind})`);
  }
  try {
    const { storage } = await import("../storage");
    const u = await storage.getUser(userId);
    if (u?.email && !u.deletedAt) {
      const { sendAgeReviewEmail } = await import("../emailService");
      const base = (process.env.APP_URL || "").replace(/\/+$/, "");
      // Without a known site address there is no link at all: a relative link in an email goes nowhere.
      await sendAgeReviewEmail({ to: u.email, userName: u.displayName ?? undefined, subject: c.title, body: message, link: base ? base + link : undefined });
    }
  } catch {
    console.error(`[AGE-REVIEW] email notice failed (${kind})`);
  }
}
