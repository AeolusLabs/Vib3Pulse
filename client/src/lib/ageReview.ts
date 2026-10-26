// Pure helpers for the "Verify your age" screens. No DOM, no network. Copy here must never contain dashes or the word "cash".

export type AgeReviewState = "none" | "in_review" | "needs_more" | "verified" | "declined" | "cooldown" | "not_offered";
export type AgeReviewMethod = "upload" | "live";
export type DocumentType = "passport" | "drivers_licence" | "national_id" | "nin_slip";

export interface AgeReviewRequest {
  id: string;
  method: AgeReviewMethod;
  status: string;
  documentType: string | null;
  canCancel: boolean;
  needsMore: boolean;
  hasDocument: boolean;
  hasSelfie: boolean;
  code: string | null;
  codeExpiresAt: string | null;
  liveInviteExpiresAt: string | null;
  submittedAt: string | null;
  declineReason: string | null;
  consentedAt: string | null;
  /** The user asked to receive money, so the reviewer also records the name on the document. */
  wantsPayouts?: boolean;
}

export interface AgeReviewMe {
  enabled: true;
  paused: boolean;
  consentVersion: string;
  state: AgeReviewState;
  verified: { method: "admin" | "admin_upload" | "admin_live"; at: string } | null;
  request: AgeReviewRequest | null;
  retryAfter: string | null;
  attemptsLeft: number;
  /** A name for payouts is on file (never the name itself). Absent on an older server. */
  hasPayoutName?: boolean;
}

export type CardTone = "neutral" | "pending" | "success" | "warning";
export interface CardAction { id: "start" | "continue"; label: string }
export interface CardView { title: string; body: string; action: CardAction | null; tone: CardTone }

export const DOCUMENT_TYPES: readonly DocumentType[] = ["passport", "drivers_licence", "national_id", "nin_slip"];
const DOC_LABEL: Record<string, string> = {
  passport: "Passport",
  drivers_licence: "Driver's licence",
  national_id: "National ID card",
  nin_slip: "NIN slip",
};
export const documentTypeLabel = (t: string | null | undefined): string => (t && DOC_LABEL[t]) || "Document";

const DECLINE_LABEL: Record<string, string> = {
  unreadable: "the photo was hard to read",
  expired: "the document had expired",
  face_mismatch: "the face did not match the selfie",
  code_missing: "the code was not in the selfie",
  looks_edited: "the document looked edited",
  other: "the reviewer could not confirm it",
};
const VERIFY_LABEL: Record<string, string> = { admin: "a reviewer check", admin_upload: "a photo check", admin_live: "a live check" };

export const COPY = {
  cardTitle: "Verify your age",
  scopeNote: "Verification is only needed for tipping, buying tickets and hosting paid rooms. You can use the rest of Vib3Pulse without it.",
  choiceUpload: "Upload an ID photo and a selfie",
  choiceLive: "Private live check with a reviewer",
  choiceLiveHint: "Nothing is recorded or saved.",
  wantsPayoutsLabel: "I also want to receive money (tips and ticket sales)",
  wantsPayoutsHelp: "We will also note the name on your ID to check your bank account later.",
  verifyNameAction: "Verify your name for payouts",
  verifyNameHelp: "Only needed if you want to receive money. A reviewer notes the name on your ID.",
  recheckLink: "Redo my payouts check",
  payoutsDraftTitle: "Continue your payouts check",
  payoutsDraftBody: "Finish this so a reviewer can note the name on your ID. It is only for receiving money.",
  payoutsContinueButton: "Continue your payouts check",
  payoutsPaused: "Verification is paused for now. Please come back later to verify your name for payouts.",
  agePaused: "Verification is paused for now. Please come back later to verify your age.",
  payoutsInReview: "Your payouts check is being reviewed",
  payoutsInReviewBody: "We will tell you when it is done. You do not need to start another one.",
  choiceUploadHint: "Your photos are deleted after the final decision.",
  cancel: "Cancel my request",
  howHandled: "How your ID is handled",
  paused: "Age checks are paused for a short while. Please try again later.",
  verifyLink: "Verify your age",
  notRecorded: "Not recorded",
  guidance: "You can cover everything except your photo, name and date of birth.",
  waiting: "Waiting for a reviewer. We will tell you here and in your notifications when it is time to join.",
  joinReady: "A reviewer is ready. Join within the time shown.",
} as const;

export const PRIVACY = {
  title: "Before you verify your age",
  why: { h: "Why we ask", p: "Tipping, buying tickets and hosting paid rooms are for adults only. We check once. You can use the rest of Vib3Pulse without it." },
  who: { h: "Who sees it", p: "Only Vib3Pulse staff who review ages (administrators, super administrators and age reviewers). Your images are encrypted in our database and are opened one at a time, with every viewing logged." },
  whoLive: "A reviewer sees you on a private call. Nothing is recorded or saved.",
  whatUpload: "A reviewer compares your document with the birthdate you gave when you signed up. We delete your photos after the final decision, or after 7 days from when you started, whichever comes first. If a second approval is needed, they are kept until that is decided, within the 7 days.",
  whatLive: "A reviewer compares your document with the birthdate you gave when you signed up. Nothing is recorded or saved.",
  whatHeading: "What happens",
  keep: { h: "What we keep", p: "We keep a record of the decision: who made it, when, the type of document, whether the birthdate matched, and the reason if it was declined. A reviewer may also write a short note about the decision (up to 300 characters), which is kept in our staff audit log. We also keep the birthdate you registered with at the time, and a one-way code made from your document number. The code cannot be turned back into the number without our secret key, and it only stops the same document being used on several accounts. We do not keep your photos or the document number itself. Notifications and emails about the result do not contain your documents." },
  choices: { h: "Your choices", p: "Cover everything except your photo, name and date of birth. Cancel any time before a decision and your photos are deleted. Choose the live check instead of uploading. Saying no only means the adult only features stay off." },
  safety: { h: "Your safety", p: "If your document shows you are under 18, we will move your account to the right age group." },
  keepPayouts: "Because you chose to receive money, we also keep the full name on your document, encrypted. It is used only to check that your bank account is in your name. We delete it if you delete your account or an administrator removes your verification.",
  tick: "I understand how my information is used",
  cont: "Continue",
  notNow: "Not now",
  close: "Close",
  policy: "Read the full privacy policy",
  ask: "Ask about your data",
  policyHref: "/privacy",
  askHref: "mailto:info@aeoluslabsltd.com",
} as const;

/** "What we keep": the payouts variant adds the name sentence, the plain one does not. */
export const keepFor = (wantsPayouts: boolean): string => (wantsPayouts ? `${PRIVACY.keep.p} ${PRIVACY.keepPayouts}` : PRIVACY.keep.p);
export const whoSees = (m: AgeReviewMethod): string => (m === "live" ? PRIVACY.whoLive : PRIVACY.who.p);
export const whatHappens = (m: AgeReviewMethod): string => (m === "live" ? PRIVACY.whatLive : PRIVACY.whatUpload);

const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** "in about 5 hours" style wait; never negative. */
export function waitLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "later";
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 60_000) return "in a moment";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `on ${dateLabel(iso)}`;
}

export function cardView(me: AgeReviewMe, now: Date = new Date()): CardView {
  const canStart: CardAction | null = me.paused ? null : { id: "start", label: "Start verification" };
  const pausedNote = me.paused ? ` ${COPY.paused}` : "";
  switch (me.state) {
    case "verified":
      return {
        title: "Age verified",
        body: `You were verified${me.verified ? ` on ${dateLabel(me.verified.at)} by ${VERIFY_LABEL[me.verified.method] ?? "a reviewer check"}` : ""}. Tipping, tickets and paid rooms are open to you.`,
        action: null,
        tone: "success",
      };
    case "in_review":
      return {
        title: "A reviewer is looking at it",
        body: me.request?.method === "live"
          ? "Your live check is requested. A reviewer will invite you to join a private call."
          : "Your photos are with a reviewer. You do not need to do anything else. You can cancel at any time before the final decision.",
        action: null,
        tone: "pending",
      };
    case "needs_more":
      return {
        title: "One more photo, please",
        body: "The reviewer needs a clearer photo to decide. Add it and send it again.",
        action: { id: "continue", label: "Add a photo" },
        tone: "warning",
      };
    case "declined": {
      const why = me.request?.declineReason ? DECLINE_LABEL[me.request.declineReason] ?? DECLINE_LABEL.other : null;
      return {
        title: "We could not verify you",
        body: `${why ? `The reviewer said ${why}. ` : ""}${me.attemptsLeft > 0 ? "You can try again with a new photo." : "You have no tries left right now."}${pausedNote}`,
        action: me.attemptsLeft > 0 && canStart ? { id: "start", label: "Try again" } : null,
        tone: "warning",
      };
    }
    case "cooldown":
      return {
        title: "Please wait before trying again",
        body: `You can try again ${waitLabel(me.retryAfter, now)}.`,
        action: null,
        tone: "neutral",
      };
    case "not_offered":
      return {
        title: "Not available on this account",
        body: "Adult verification is not offered on accounts registered as under 18.",
        action: null,
        tone: "neutral",
      };
    default:
      // A verified person part way through a payouts check is not asked to "verify their age" again.
      if (openRequest(me)?.wantsPayouts === true) {
        return { title: COPY.payoutsDraftTitle, body: COPY.payoutsDraftBody, action: null, tone: "neutral" };
      }
      return {
        title: COPY.cardTitle,
        body: `Tipping, buying tickets and hosting paid rooms are for adults only. We check once.${pausedNote}`,
        action: canStart,
        tone: "neutral",
      };
  }
}

export const ERROR_CODES = [
  "CONSENT_REQUIRED", "AGE_REVIEW_PAUSED", "OPEN_REQUEST_EXISTS", "RATE_LIMITED", "NOT_OFFERED", "BAD_FILE", "TOO_LARGE",
  "EVIDENCE_INCOMPLETE", "WRONG_STATE", "CODE_EXPIRED", "NOT_ALLOWED", "SECOND_APPROVER_MUST_DIFFER", "SELF_REVIEW",
  "CHECKLIST_INCOMPLETE", "DUPLICATE_DOCUMENT", "REVEAL_LIMIT", "TOKEN_INVALID", "REASON_REQUIRED", "ALREADY_VERIFIED",
] as const;

const GENERIC_STAFF = "Something went wrong with this request. Please try again later.";
const ERROR_TEXT: Record<(typeof ERROR_CODES)[number], string> = {
  CONSENT_REQUIRED: "Please read and accept how your information is used, then try again.",
  AGE_REVIEW_PAUSED: "Age checks are paused for a short while. Please try again later.",
  OPEN_REQUEST_EXISTS: "You already have a request open. Finish or cancel it first.",
  RATE_LIMITED: "You have tried too many times. Please wait a bit.",
  NOT_OFFERED: "Adult verification is not offered on accounts registered as under 18.",
  BAD_FILE: "That file could not be used. Please take a new photo (JPEG, PNG or WebP).",
  TOO_LARGE: "That photo is too large. Please take it again.",
  EVIDENCE_INCOMPLETE: "Add both the document photo and the selfie before you send.",
  WRONG_STATE: "This request has changed. Refresh and try again.",
  CODE_EXPIRED: "Your code ran out. Get a new code and take the selfie again.",
  NOT_ALLOWED: "You cannot do that on this request.",
  SECOND_APPROVER_MUST_DIFFER: GENERIC_STAFF,
  SELF_REVIEW: GENERIC_STAFF,
  CHECKLIST_INCOMPLETE: GENERIC_STAFF,
  DUPLICATE_DOCUMENT: GENERIC_STAFF,
  REVEAL_LIMIT: GENERIC_STAFF,
  TOKEN_INVALID: "That link has expired. Please start again.",
  REASON_REQUIRED: GENERIC_STAFF,
  ALREADY_VERIFIED: "You are already verified. To receive money, choose 'Verify your name for payouts'.",
};

export function errorMessage(code: string | undefined | null, extra?: { retryAfter?: string | null; now?: Date }): string {
  if (code === "RATE_LIMITED" && extra?.retryAfter) return `You have tried too many times. You can try again ${waitLabel(extra.retryAfter, extra.now)}.`;
  if (code && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code)) return ERROR_TEXT[code as keyof typeof ERROR_TEXT];
  return "Something went wrong. Please try again.";
}

/** Longest edge capped at `max`; never enlarges. */
export function fitWithin(w: number, h: number, max = 1600): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const longest = Math.max(w, h);
  if (longest <= max) return { w: Math.round(w), h: Math.round(h) };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** True when the user has not accepted the copy version the server currently wants. */
export const consentRequired = (me: Pick<AgeReviewMe, "consentVersion">, acceptedVersion: string | null | undefined): boolean =>
  acceptedVersion !== me.consentVersion;

/** Continue stays disabled until the box is ticked (and while a request is in flight). */
export const continueEnabled = (ticked: boolean, busy = false): boolean => ticked && !busy;

/** "K7M29P" becomes "K7 M2 9P". */
export function formatCode(code: string | null | undefined): string {
  const c = (code ?? "").replace(/\s+/g, "").toUpperCase();
  return c.replace(/(.{2})(?=.)/g, "$1 ");
}

/** Whole minutes left, rounded up, never below zero. */
export function minutesLeft(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export const liveInviteActive = (r: Pick<AgeReviewRequest, "liveInviteExpiresAt"> | null | undefined, now: Date = new Date()): boolean =>
  minutesLeft(r?.liveInviteExpiresAt, now) > 0;

/** Poll only while something can change without the user doing anything. */
export const shouldPoll = (me: AgeReviewMe | null | undefined, now: Date = new Date()): boolean =>
  !!me && (me.state === "in_review" || liveInviteActive(me.request, now));

const OPEN_STATUSES = ["draft", "submitted", "in_review", "needs_more", "pending_second_approval"];
/** The request that blocks starting another one (the server allows a single open request per user). */
export const openRequest = (me: Pick<AgeReviewMe, "request">): AgeReviewRequest | null =>
  me.request && OPEN_STATUSES.includes(me.request.status) ? me.request : null;

export type CardMode = "choose" | "resume_upload" | "live" | "waiting" | "none";
/**
 * What the card body shows. The server reports a draft as state "none" WITH a request, so the state alone is not enough:
 * the choice buttons appear only when no request is open.
 */
export function cardMode(me: AgeReviewMe): CardMode {
  const r = openRequest(me);
  if (r) {
    if (r.method === "live") return "live";
    return r.status === "draft" || r.needsMore || r.status === "needs_more" ? "resume_upload" : "waiting";
  }
  return cardView(me).action?.id === "start" ? "choose" : "none";
}

/** Cancel is offered whenever the server says this request can be cancelled (draft, needs_more, submitted, in_review, pending_second_approval). */
export const cancelOffered = (me: Pick<AgeReviewMe, "request">): boolean => !!openRequest(me)?.canCancel;

/** A live check has nothing to upload, so it is submitted right after it is created. */
export async function startLiveRequest(
  deps: {
    create(v: { method: "live"; consentVersion: string; wantsPayouts?: boolean }): Promise<{ request: { id: string } }>;
    submit(id: string): Promise<unknown>;
  },
  consentVersion: string,
  wantsPayouts = false,
): Promise<void> {
  const { request } = await deps.create({ method: "live", consentVersion, ...(wantsPayouts ? { wantsPayouts: true } : {}) });
  await deps.submit(request.id);
}

/** The body of POST /api/age-review/requests. `wantsPayouts` is sent only when the box was ticked (or the payouts action was used). */
export function createBody(v: { method: AgeReviewMethod; documentType?: string; consentVersion: string; wantsPayouts?: boolean }): Record<string, unknown> {
  return { method: v.method, ...(v.documentType ? { documentType: v.documentType } : {}), consentVersion: v.consentVersion, ...(v.wantsPayouts === true ? { wantsPayouts: true } : {}) };
}

export type PayoutsAction = "verify_name" | "recheck" | null;
/** A verified user without a name on file is offered "Verify your name for payouts"; one with a name only gets a small recheck link. Nobody else is asked. */
export function payoutsAction(me: AgeReviewMe): PayoutsAction {
  if (me.state !== "verified" || me.paused || openRequest(me) || typeof me.hasPayoutName !== "boolean") return null;
  return me.hasPayoutName ? "recheck" : "verify_name";
}

/** `/account/settings?payouts=1#verify-age` preselects the payouts choice. */
export const payoutsPreselected = (search: string): boolean => new URLSearchParams(search).get("payouts") === "1";
/** What the payout page offers for the verify steps: the link, a paused notice, or "being reviewed" (no new check while one is in review). */
export type PayoutCta = "link" | "paused" | "in_review";
export function payoutCta(me: AgeReviewMe | null | undefined): PayoutCta {
  if (!me) return "link";
  const r = openRequest(me);
  if (r?.wantsPayouts === true && ["submitted", "in_review", "pending_second_approval"].includes(r.status)) return "in_review";
  if (me.paused) return "paused";
  return "link";
}
export const PAYOUTS_HREF = "/account/settings?payouts=1#verify-age";

export const VERIFY_HREF = "/account/settings#verify-age";
