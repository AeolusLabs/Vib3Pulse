// Create-room wizard rules. Pure: no React, no window, no clock. The server (canHostRoom / validateRoomInput) is the gate;
// this module only mirrors it so the wizard never offers a choice the server will refuse.
import { AGE_LIMITS, ageBand, minAgeForLimit, type AgeLimit } from "@shared/age";
import { ROOM_LIMITS, SLOW_MODES, type RoomKind, type RoomVisibility } from "@shared/rooms";

const SLOW: readonly number[] = SLOW_MODES as readonly number[];

export interface WizardHost { age: number | null; accountAgeDays: number; idVerifiedAdult: boolean }

export interface WizardState {
  title: string;
  description: string;
  kind: RoomKind;
  ageLimit: AgeLimit;
  visibility: RoomVisibility;
  voice: boolean;
  liveVideo: boolean;
  slowModeSec: number;
  pinned: string;
  capacity: number;
  when: "now" | "later";
  scheduledFor: string | null;
  /**
   * Gamers live (shown only while the server's gaming flag is on): players per side, 1 to 4, or null for an ordinary room.
   * Optional so every existing state and fixture stays valid. Sent as a PATCH after live video is on, never in the create body.
   */
  gameFormat?: 1 | 2 | 3 | 4 | null;
  /** How long a dropped player keeps their slot (ms): 30000, 120000 or 0 = hold it. Only read when gameFormat is set. */
  gameDropTimeoutMs?: 30000 | 120000 | 0;
}

export interface WizardFlags { paidRooms: boolean; spray: boolean }

export interface AgeOption { value: AgeLimit; label: string; sub: string; disabledReason?: string }
export interface VisibilityOption { value: RoomVisibility; disabledReason?: string }
export interface WizardOptions {
  ageOptions: AgeOption[];
  visibilityOptions: VisibilityOption[];
  moneyLocked: string | null;
  teenHostNote: boolean;
}

export type WizardStep = "basics" | "audience" | "features" | "money" | "when" | "review";
export type WizardValidation = { ok: true } | { ok: false; field: string; reason: string };

const ADULT_ONLY = "You need to be 18 to host an adult room.";
const NEED_16 = "You need to be 16 to host a 16+ room.";
const NEED_21 = "You need to be 21 to host a 21+ room.";
// same wording as HOST_BELOW_LIMIT in server/rooms/roomRoutes.ts (only reachable for an account under the platform age)
const BELOW_LIMIT = "You can't host a room with that age limit.";
const TEEN_PUBLIC = "Public rooms are for adults. Try a friends-only or invite-only room.";
// same wording as ACCOUNT_TOO_NEW in server/rooms/roomRoutes.ts
const ACCOUNT_TOO_NEW = "Your account is too new to host a public room. Try a friends-only or invite-only room.";
const MONEY_OFF = "Paid rooms and spray are not available yet.";
const MONEY_ADULT_ONLY = "Money features are only for adult rooms.";

const AGE_COPY: Record<AgeLimit, { label: string; sub: string }> = {
  all: { label: "All ages", sub: "Anyone on Vib3Pulse aged 13 or over" },
  "13+": { label: "13+", sub: "Ages 13 and over" },
  "16+": { label: "16+", sub: "Ages 16 and over" },
  "18+": { label: "18+", sub: "Adults only" },
  "21+": { label: "21+", sub: "Ages 21 and over" },
};

const isAdultHost = (h: WizardHost) => ageBand(h.age) === "adult";
const isTeenHost = (h: WizardHost) => ageBand(h.age) === "teen";
const isAdultLimit = (l: AgeLimit) => l === "18+" || l === "21+";

/**
 * Why this host may not use this age limit, or undefined when they may. Mirrors the server's HOST_BELOW_LIMIT
 * (host age below the limit's minimum). Unknown age is not judged here: validateWizard and the server refuse it as a whole.
 */
function ageLimitReason(host: WizardHost, l: AgeLimit): string | undefined {
  if (host.age === null || host.age >= minAgeForLimit(l)) return undefined;
  if (isTeenHost(host) && isAdultLimit(l)) return ADULT_ONLY;
  if (l === "16+") return NEED_16;
  if (l === "21+") return NEED_21;
  if (l === "18+") return ADULT_ONLY;
  return BELOW_LIMIT;
}

/**
 * The age limit to use instead of one the host may not pick: a teen's 18+/21+ becomes 13+ (revisions rule); otherwise the
 * highest lower limit the host may use (a 13 to 15 host's 16+ becomes 13+, an 18 to 20 host's 21+ becomes 18+).
 */
function allowedAgeLimit(host: WizardHost, l: AgeLimit): AgeLimit {
  if (host.age === null || host.age >= minAgeForLimit(l)) return l;
  if (isTeenHost(host) && isAdultLimit(l)) return "13+";
  for (let i = AGE_LIMITS.indexOf(l) - 1; i >= 0; i--) if (host.age >= minAgeForLimit(AGE_LIMITS[i])) return AGE_LIMITS[i];
  return l; // below the platform age nothing fits; the server refuses it
}

/** True when public rooms are closed to this host because the account is younger than the server's minimum. */
export const accountTooNewFor = (host: WizardHost, minAccountAgeDays: number) => host.accountAgeDays < minAccountAgeDays;

export function wizardOptions(host: WizardHost, flags: WizardFlags, minAccountAgeDays = 0, ageLimit: AgeLimit = "all"): WizardOptions {
  const teen = isTeenHost(host);
  const ageOptions: AgeOption[] = AGE_LIMITS.map((value) => {
    const reason = ageLimitReason(host, value);
    return { value, ...AGE_COPY[value], ...(reason ? { disabledReason: reason } : {}) };
  });
  const publicReason = teen ? TEEN_PUBLIC : accountTooNewFor(host, minAccountAgeDays) ? ACCOUNT_TOO_NEW : undefined;
  const visibilityOptions: VisibilityOption[] = [
    { value: "public", ...(publicReason ? { disabledReason: publicReason } : {}) },
    { value: "friends" },
    { value: "invite" },
  ];
  const anyFlag = flags.paidRooms || flags.spray;
  const moneyLocked =
    !(isAdultLimit(ageLimit) && isAdultHost(host)) ? MONEY_ADULT_ONLY : anyFlag ? null : MONEY_OFF;
  return { ageOptions, visibilityOptions, moneyLocked, teenHostNote: teen };
}

export function normalizeWizard(s: WizardState, host: WizardHost): WizardState {
  const teen = isTeenHost(host);
  const slow = SLOW.includes(s.slowModeSec)
    ? s.slowModeSec
    : SLOW.reduce((best, v) => (Math.abs(v - s.slowModeSec) < Math.abs(best - s.slowModeSec) ? v : best), SLOW[0]);
  const cap = Number.isFinite(s.capacity) ? Math.round(s.capacity) : ROOM_LIMITS.capacityDefault;
  return {
    ...s,
    ageLimit: allowedAgeLimit(host, s.ageLimit),
    visibility: teen && s.visibility === "public" ? "friends" : s.visibility,
    slowModeSec: Number.isFinite(s.slowModeSec) ? slow : 0,
    // whole code points, so an emoji is never cut in half
    pinned: Array.from(s.pinned.trim()).slice(0, ROOM_LIMITS.pinned).join(""),
    capacity: Math.min(ROOM_LIMITS.capacityMax, Math.max(2, cap)),
    scheduledFor: s.when === "now" ? null : s.scheduledFor,
  };
}

/**
 * `now` is passed in so this stays pure. `scheduledFor` is anything `new Date()` can read (datetime-local or ISO).
 * `minAccountAgeDays` is the server's minimum account age for public rooms (GET /api/rooms/config `host`); 0 when unknown.
 */
export function validateWizard(s: WizardState, host: WizardHost, now: Date, minAccountAgeDays = 0): WizardValidation {
  const title = s.title.trim();
  if (title.length < 1) return { ok: false, field: "title", reason: "Give your room a name." };
  if (title.length > ROOM_LIMITS.title) return { ok: false, field: "title", reason: `Keep the name to ${ROOM_LIMITS.title} characters.` };
  if (s.description.length > ROOM_LIMITS.description) return { ok: false, field: "description", reason: `Keep the description to ${ROOM_LIMITS.description} characters.` };
  if (host.age === null) return { ok: false, field: "ageLimit", reason: "Add your date of birth in your profile to host rooms." };
  const ageReason = ageLimitReason(host, s.ageLimit);
  if (ageReason) return { ok: false, field: "ageLimit", reason: ageReason };
  if (isTeenHost(host) && s.visibility === "public") return { ok: false, field: "visibility", reason: TEEN_PUBLIC };
  if (s.visibility === "public" && accountTooNewFor(host, minAccountAgeDays)) return { ok: false, field: "visibility", reason: ACCOUNT_TOO_NEW };
  if (s.when === "later") {
    const t = s.scheduledFor ? new Date(s.scheduledFor).getTime() : NaN;
    if (Number.isNaN(t)) return { ok: false, field: "scheduledFor", reason: "Pick a start time." };
    if (t <= now.getTime()) return { ok: false, field: "scheduledFor", reason: "Pick a start time in the future." };
  }
  return { ok: true };
}

/** The wizard's own steps. The final "done" screen is added by the UI. A money step appears only when money is unlocked and a flag is on. */
export function stepsFor(s: WizardState, flags: WizardFlags, host: WizardHost): WizardStep[] {
  const steps: WizardStep[] = ["basics", "audience", "features"];
  const moneyOn = (flags.paidRooms || flags.spray) && wizardOptions(host, flags, 0, s.ageLimit).moneyLocked === null;
  if (moneyOn) steps.push("money");
  steps.push("when", "review");
  return steps;
}
