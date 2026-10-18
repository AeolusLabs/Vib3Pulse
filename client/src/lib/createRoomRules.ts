// Create-room wizard rules. Pure: no React, no window, no clock. The server (canHostRoom / validateRoomInput) is the gate;
// this module only mirrors it so the wizard never offers a choice the server will refuse.
import { AGE_LIMITS, ageBand, type AgeLimit } from "@shared/age";
import { ROOM_LIMITS, type RoomKind, type RoomVisibility } from "@shared/rooms";

// mirror of shared SLOW_MODES from task 3.1
export const WIZARD_SLOW_MODES: readonly number[] = [0, 5, 15, 30];
export const PINNED_MAX = 200;

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

export function wizardOptions(host: WizardHost, flags: WizardFlags, minAccountAgeDays = 0, ageLimit: AgeLimit = "all"): WizardOptions {
  const teen = isTeenHost(host);
  const ageOptions: AgeOption[] = AGE_LIMITS.map((value) => ({
    value, ...AGE_COPY[value],
    ...(teen && isAdultLimit(value) ? { disabledReason: ADULT_ONLY } : {}),
  }));
  const publicReason = teen ? TEEN_PUBLIC : host.accountAgeDays < minAccountAgeDays ? ACCOUNT_TOO_NEW : undefined;
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
  const slow = WIZARD_SLOW_MODES.includes(s.slowModeSec)
    ? s.slowModeSec
    : WIZARD_SLOW_MODES.reduce((best, v) => (Math.abs(v - s.slowModeSec) < Math.abs(best - s.slowModeSec) ? v : best), WIZARD_SLOW_MODES[0]);
  const cap = Number.isFinite(s.capacity) ? Math.round(s.capacity) : ROOM_LIMITS.capacityDefault;
  return {
    ...s,
    ageLimit: teen && isAdultLimit(s.ageLimit) ? "13+" : s.ageLimit,
    visibility: teen && s.visibility === "public" ? "friends" : s.visibility,
    slowModeSec: Number.isFinite(s.slowModeSec) ? slow : 0,
    pinned: s.pinned.trim().slice(0, PINNED_MAX),
    capacity: Math.min(ROOM_LIMITS.capacityMax, Math.max(2, cap)),
    scheduledFor: s.when === "now" ? null : s.scheduledFor,
  };
}

/** `now` is passed in so this stays pure. `scheduledFor` is anything `new Date()` can read (datetime-local or ISO). */
export function validateWizard(s: WizardState, host: WizardHost, now: Date): WizardValidation {
  const title = s.title.trim();
  if (title.length < 1) return { ok: false, field: "title", reason: "Give your room a name." };
  if (title.length > ROOM_LIMITS.title) return { ok: false, field: "title", reason: `Keep the name to ${ROOM_LIMITS.title} characters.` };
  if (s.description.length > ROOM_LIMITS.description) return { ok: false, field: "description", reason: `Keep the description to ${ROOM_LIMITS.description} characters.` };
  if (host.age === null) return { ok: false, field: "ageLimit", reason: "Add your date of birth in your profile to host rooms." };
  if (isTeenHost(host) && isAdultLimit(s.ageLimit)) return { ok: false, field: "ageLimit", reason: ADULT_ONLY };
  if (isTeenHost(host) && s.visibility === "public") return { ok: false, field: "visibility", reason: TEEN_PUBLIC };
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
