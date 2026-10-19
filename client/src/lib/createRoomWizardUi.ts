// Pure helpers and words for the create-a-room wizard and the quick start sheet (no React, no network, no storage).
// The rules about what a host may pick live in createRoomRules.ts (task 3.2); the server is always the gate.
import type { RoomVisibility } from "@shared/rooms";
import { ROOM_LIMITS } from "@shared/rooms";
import type { WizardState } from "@/lib/createRoomRules";

/** The steps this UI knows how to draw. stepsFor() may name others later (a price step); unknown names are skipped. */
export const KNOWN_STEPS = ["basics", "audience", "features", "when", "review"] as const;
export type WizardStep = (typeof KNOWN_STEPS)[number];
export const isKnownStep = (s: string): s is WizardStep => (KNOWN_STEPS as readonly string[]).includes(s);

/** Pinned message limit. Mirrors ROOM_LIMITS.pinned from task 3.1; kept here so this file works before that lands. */
export const PINNED_MAX = 200;
export const SLOW_MODE_CHOICES = [0, 5, 15, 30] as const;
export const slowModeLabel = (sec: number) => (sec === 0 ? "Off" : `${sec}s`);

/** Where a host's last picked visibility is remembered (adults only, this browser only). */
export const LAST_VISIBILITY_KEY = "rooms.lastVisibility";
/** Same key the old create dialog used, so a teen who already dismissed the note is not shown it again. */
export const TEEN_NOTE_KEY = "rooms.teenHostNote.seen";

export const STEP_TITLE: Record<WizardStep, string> = {
  basics: "What is it about?",
  audience: "Who can join?",
  features: "How does it run?",
  when: "When does it start?",
  review: "Ready?",
};

export const COPY = {
  wizardTitle: "Start a room",
  close: "Close",
  back: "Back",
  next: "Continue",
  goLive: "Go live now",
  schedule: "Schedule room",
  working: "Making your room",
  needsDob: "Add your date of birth in your profile before you host a room.",
  leaveTitle: "Leave without making the room?",
  leaveBody: "What you picked here will be lost.",
  leaveStay: "Keep editing",
  leaveGo: "Leave",
  titleLabel: "Title",
  titlePlaceholder: "Friday pre-party",
  descLabel: "About (optional)",
  kindLabel: "Kind of room",
  capacityLabel: "How many people",
  capacityHelp: `Between 2 and ${ROOM_LIMITS.capacityMax}.`,
  linkLabel: "Attach to your event or venue (optional)",
  linkNone: "Not attached",
  linkedEvent: "This room is attached to your event.",
  linkedVenue: "This room is attached to your venue.",
  ageLegend: "Age rule",
  ageHelp: "Works like a bouncer: people below the limit can see the room but can't get in.",
  visibilityLegend: "Who can find it",
  voiceLabel: "Voice on the stage",
  voiceHelp: "Guests raise a hand, you bring them up.",
  videoLabel: "Live video",
  videoHelp: "You or a guest you pick can go on camera.",
  videoNeedsVoice: "Turn voice on first.",
  slowLegend: "Slow mode",
  slowHelp: "How long each guest waits between chat messages. You and your co-hosts are never slowed.",
  pinnedLabel: "Pinned message (optional)",
  pinnedPlaceholder: "House rules. Be kind, no sharing phone numbers.",
  directLabel: "Waves and private reactions",
  directHelp: "Guests can still chat and react to the whole room.",
  screenLabel: "Screen link (optional)",
  screenPlaceholder: "Paste a YouTube, Vimeo, Spotify, Apple Music or SoundCloud link",
  screenHelp: "Everyone plays it from the provider with their own account. Nothing is recorded or relayed.",
  screenBad: "That link can't be used on the screen.",
  moneyPlaceholder: "Paid rooms and spray notes are not available here yet.",
  whenNow: "Go live now",
  whenLater: "Schedule",
  whenInputLabel: "Start time",
  whenHelp: "Pick a time in the future, within 90 days.",
  scheduledFeatures: "You turn voice and live video on when you start the room.",
  reviewAge: "Who can join",
  reviewVisibility: "Visibility",
  reviewPeople: "People",
  reviewWhen: "When",
  reviewNow: "Now",
  reviewNone: "None",
  reviewFeatures: "Features",
  reviewSlow: "Slow mode",
  reviewPinned: "Pinned",
  reviewLinked: "Attached to",
  reviewSafety: "Age rules are checked on every account. The server checks everything again when you go live.",
  doneLiveTitle: "You are live",
  doneLiveBody: "Guests can join now. Head into your room soon so it stays open.",
  doneScheduledTitle: "Room scheduled",
  doneScheduledBody: "It shows under Upcoming. Start it from the room page when it is time.",
  doneInviteOnce: "Only people with this link can find it. It's shown once, so copy it now.",
  doneLinkLabel: "Room link",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Copy it from the box above",
  share: "Share",
  goToRoom: "Go to room",
  startedLate: "Room created, but it didn't go live",
  voiceLate: "Your room is live, but voice didn't switch on. You can turn it on in the room.",
  videoLate: "Your room is live, but live video didn't switch on. You can turn it on in the room.",
  quickTitle: "Start a room",
  quickDesc: "Go live in one tap, or set it up yourself.",
  quickVoice: "Voice room",
  quickVoiceSub: "Talk with people now",
  quickVideo: "Live video",
  quickVideoSub: "Go on camera with a stage",
  quickLater: "Schedule for later",
  quickLaterSub: "Pick a time, people see it under Upcoming",
  quickCustom: "Set it up yourself",
  quickCustomSub: "Pick who can join, features and more",
  quickFriends: "Friends can find it.",
  quickPublic: "Anyone old enough can find it.",
  quickInvite: "Only people with your link can find it.",
} as const;

export const VISIBILITY_HELP: Record<RoomVisibility, string> = {
  public: "Anyone old enough can find it in Rooms.",
  friends: "Only people you follow and who follow you back.",
  invite: "Only people with your invite link.",
};

// ---------------------------------------------------------------- server refusals
/** Mirrors HOST_MESSAGES in server/rooms/roomRoutes.ts word for word (a test reads that file to keep them equal). */
export const HOST_REFUSAL: Record<"AGE_UNKNOWN" | "HOST_BELOW_LIMIT" | "TEEN_PUBLIC" | "ACCOUNT_TOO_NEW", string> = {
  AGE_UNKNOWN: "Add your date of birth in your profile to host rooms.",
  HOST_BELOW_LIMIT: "You can't host a room with that age limit.",
  TEEN_PUBLIC: "Public rooms are for adults. Try a friends-only or invite-only room.",
  ACCOUNT_TOO_NEW: "Your account is too new to host a public room. Try a friends-only or invite-only room.",
};

export const CREATE_ERROR: Record<string, string> = {
  ...HOST_REFUSAL,
  RATE_LIMITED: "You're doing that too fast. Please try again in a bit.",
  SCHEDULED_LIMIT: "You have as many scheduled rooms as you can have. Start or end one first.",
  LIVE_LIMIT: "You already have a live room. End it before starting another.",
  NOT_OWNER: "You can only attach your own event or venue.",
  HOST_NOT_MINOR: "This room was set up for under 18s, so it can't be started now. Create a new room instead.",
  BAD_STATE: "This room can't be started now.",
};

export const FIELD_ERROR: Record<string, string> = {
  title: "Give the room a title.",
  description: `Keep the description under ${ROOM_LIMITS.description} characters.`,
  kind: "Pick a kind of room.",
  visibility: "Pick who can find it.",
  ageLimit: "Pick an age rule.",
  capacity: `Capacity must be between 2 and ${ROOM_LIMITS.capacityMax}.`,
  scheduledFor: "Pick a time in the future, within 90 days.",
  screenUrl: "That screen link can't be used.",
  eventId: "That event can't be attached.",
  venueId: "That venue can't be attached.",
  slowModeSec: "Pick a slow mode: off, 5, 15 or 30 seconds.",
  pinnedMessage: `Keep the pinned message under ${PINNED_MAX} characters.`,
};

export const OFFLINE_ERROR = "Couldn't reach Vib3Pulse. Check your connection and try again.";
export const GENERIC_CREATE_ERROR = "Couldn't create the room. Try again.";

export interface ApiFailure { status: number; code?: string; field?: string }

/** Plain words for a refused create or start. Never the server's raw text, so every line follows the copy rules. */
export function createErrorMessage(f: ApiFailure): string {
  if (f.code && CREATE_ERROR[f.code]) return CREATE_ERROR[f.code];
  if (f.status === 0) return OFFLINE_ERROR;
  if (f.status === 429) return CREATE_ERROR.RATE_LIMITED;
  if (f.field && FIELD_ERROR[f.field]) return FIELD_ERROR[f.field];
  return GENERIC_CREATE_ERROR;
}

/** Which step to send the host back to for a refused field or code; null keeps them where they are. */
export function stepForFailure(f: { code?: string; field?: string }): WizardStep | null {
  if (f.code === "TEEN_PUBLIC" || f.code === "ACCOUNT_TOO_NEW" || f.code === "HOST_BELOW_LIMIT") return "audience";
  if (f.code === "NOT_OWNER") return "basics";
  return f.field ? stepOfField(f.field) : null;
}

/** The field to mark for a refusal, so the message shows next to the control it is about. */
export function fieldForFailure(f: { code?: string; field?: string }): string {
  if (f.field) return f.field;
  if (f.code === "TEEN_PUBLIC" || f.code === "ACCOUNT_TOO_NEW") return "visibility";
  if (f.code === "HOST_BELOW_LIMIT") return "ageLimit";
  if (f.code === "NOT_OWNER") return "eventId";
  return "";
}

/**
 * Words for a validateWizard() failure. Its `reason` is shown when it reads as a sentence; a bare code ("past") falls back
 * to this file's line for the field, so a code never reaches the screen.
 */
export function ruleMessage(field: string, reason: string | undefined): string {
  if (reason && /\s/.test(reason.trim())) return reason;
  return FIELD_ERROR[field] ?? GENERIC_CREATE_ERROR;
}

/** The step that owns a WizardState or request field (validateWizard and the server both name fields). */
export function stepOfField(field: string): WizardStep | null {
  switch (field) {
    case "title": case "description": case "kind": case "capacity": case "eventId": case "venueId": return "basics";
    case "ageLimit": case "visibility": return "audience";
    case "voice": case "liveVideo": case "slowModeSec": case "pinned": case "pinnedMessage": case "screenUrl": case "noDirectInteractions": return "features";
    case "when": case "scheduledFor": return "when";
    default: return null;
  }
}

// ---------------------------------------------------------------- links
export interface RoomLink { eventId?: string; venueId?: string }

/** "event:<id>" | "venue:<id>" | "none", as the attach select stores it. */
export function linkChoiceOf(link?: RoomLink | null): string {
  if (link?.eventId) return `event:${link.eventId}`;
  if (link?.venueId) return `venue:${link.venueId}`;
  return "none";
}

export function parseLinkChoice(choice: string): RoomLink {
  const i = choice.indexOf(":");
  if (i < 0) return {};
  const kind = choice.slice(0, i), id = choice.slice(i + 1);
  if (!id) return {};
  if (kind === "event") return { eventId: id };
  if (kind === "venue") return { venueId: id };
  return {};
}

// ---------------------------------------------------------------- payload
export interface WizardExtras {
  /** The old dialog's "Waves and private reactions" switch, inverted. Kept so nothing it did is lost. */
  noDirectInteractions?: boolean;
  /** Only sent while link screens are switched on (LINK_SCREENS). */
  screenUrl?: string;
}

export interface CreateRoomPayload {
  title: string;
  description?: string;
  kind: WizardState["kind"];
  visibility: WizardState["visibility"];
  ageLimit: WizardState["ageLimit"];
  capacity: number;
  scheduledFor?: string;
  noDirectInteractions: boolean;
  screenUrl?: string;
  slowModeSec: number;
  pinnedMessage?: string;
  eventId?: string;
  venueId?: string;
}

/** Cut to `max` characters (code points, so an emoji is never split in half). */
export const cutText = (s: string, max: number) => Array.from(s).slice(0, max).join("");

/**
 * The POST /api/rooms body for a wizard state. Voice and live video are not part of it: they are switched on after the
 * room goes live (PUT /voice, PUT /live-video). A schedule that does not parse is sent as typed, so the server names the field.
 */
export function buildCreatePayload(s: WizardState, extras: WizardExtras = {}, link: RoomLink = {}): CreateRoomPayload {
  const description = s.description.trim();
  const pinned = cutText(s.pinned.trim(), PINNED_MAX).trim();
  let scheduledFor: string | undefined;
  if (s.when === "later" && s.scheduledFor) {
    const t = Date.parse(s.scheduledFor);
    scheduledFor = Number.isNaN(t) ? s.scheduledFor : new Date(t).toISOString();
  }
  const screenUrl = extras.screenUrl?.trim();
  const eventId = link.eventId || undefined;
  const venueId = eventId ? undefined : link.venueId || undefined; // the server refuses both at once
  return {
    title: s.title.trim(),
    ...(description ? { description } : {}),
    kind: s.kind,
    visibility: s.visibility,
    ageLimit: s.ageLimit,
    capacity: s.capacity,
    ...(scheduledFor ? { scheduledFor } : {}),
    noDirectInteractions: extras.noDirectInteractions === true,
    ...(screenUrl ? { screenUrl } : {}),
    slowModeSec: s.slowModeSec,
    ...(pinned ? { pinnedMessage: pinned } : {}),
    ...(eventId ? { eventId } : {}),
    ...(venueId ? { venueId } : {}),
  };
}

// ---------------------------------------------------------------- defaults and quick start
export function defaultWizardState(defaults: Partial<WizardState> = {}): WizardState {
  return {
    title: "",
    description: "",
    kind: "party",
    ageLimit: "all",
    visibility: "public",
    voice: true,
    liveVideo: false,
    slowModeSec: 0,
    pinned: "",
    capacity: ROOM_LIMITS.capacityDefault,
    when: "now",
    scheduledFor: null,
    ...defaults,
  };
}

const VISIBILITIES: readonly RoomVisibility[] = ["public", "friends", "invite"];
export const isVisibility = (v: unknown): v is RoomVisibility => typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v);

/** "Mara's room", from the host's name; a plain default when there is no name. Never longer than the title limit. */
export function defaultRoomTitle(name?: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "My room";
  return cutText(`${n}'s room`, ROOM_LIMITS.title);
}

/**
 * One-tap "Start a room now". A host under 18 always gets Friends (public is for adults). An adult gets the visibility
 * they used last time when there is one, otherwise Friends. Unknown age gets Friends too; the server refuses it anyway.
 * A last-used "invite" also gives Friends: the invite link is shown only once, and one tap goes straight into the room,
 * so nobody would ever see it. Invite rooms are made through the full wizard, which has the Done screen for the link.
 */
export function quickStartState(host: { age: number | null }, opts: { name?: string | null; lastVisibility?: unknown; liveVideo?: boolean } = {}): WizardState {
  const adult = host.age !== null && host.age >= 18;
  const visibility: RoomVisibility = adult && opts.lastVisibility === "public" ? "public" : "friends";
  return defaultWizardState({
    title: defaultRoomTitle(opts.name),
    visibility,
    voice: true,
    liveVideo: opts.liveVideo === true,
    when: "now",
    scheduledFor: null,
  });
}

/** What the quick start sheet says about where the room will show. */
export const quickVisibilityLine = (v: RoomVisibility) => (v === "public" ? COPY.quickPublic : v === "invite" ? COPY.quickInvite : COPY.quickFriends);

// ---------------------------------------------------------------- time
const pad = (n: number) => String(n).padStart(2, "0");
/** A Date as a datetime-local value in the browser's own time zone ("2026-10-18T20:30"). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Earliest pickable start: the next whole minute, so "now" itself is never offered as a schedule. */
export const minScheduleInput = (now: Date) => toLocalInput(new Date(Math.ceil((now.getTime() + 1) / 60_000) * 60_000));
export const maxScheduleInput = (now: Date) => toLocalInput(new Date(now.getTime() + 90 * 86_400_000));
/** True when a typed schedule is missing, unreadable, in the past, or more than 90 days away. */
export function scheduleProblem(value: string | null, now: Date): boolean {
  if (!value) return true;
  const t = Date.parse(value);
  return Number.isNaN(t) || t <= now.getTime() || t > now.getTime() + 90 * 86_400_000;
}

/**
 * The wizard's own last check before it moves on or submits, on top of validateWizard (task 3.2): the fields whose
 * failure would otherwise be silently replaced by a server default (an empty capacity is sent as null and becomes 50).
 */
export function localProblem(s: WizardState, now: Date): { field: string; reason: string } | null {
  if (!s.title.trim()) return { field: "title", reason: FIELD_ERROR.title };
  if (!Number.isInteger(s.capacity) || s.capacity < 2 || s.capacity > ROOM_LIMITS.capacityMax) return { field: "capacity", reason: FIELD_ERROR.capacity };
  if (!(SLOW_MODE_CHOICES as readonly number[]).includes(s.slowModeSec)) return { field: "slowModeSec", reason: FIELD_ERROR.slowModeSec };
  if (Array.from(s.pinned.trim()).length > PINNED_MAX) return { field: "pinned", reason: FIELD_ERROR.pinnedMessage };
  if (s.when === "later" && scheduleProblem(s.scheduledFor, now)) return { field: "scheduledFor", reason: FIELD_ERROR.scheduledFor };
  return null;
}

/** Full link for the Done screen: the invite link (shown once) for invite rooms, else the room page. */
export function roomShareUrl(origin: string, roomId: string, inviteLink?: string | null): string {
  return inviteLink ? `${origin}${inviteLink}` : `${origin}/rooms/${encodeURIComponent(roomId)}`;
}

/** "Step 2 of 5: Who can join?" for the live region. */
export const progressLine = (index: number, total: number, title: string) => `Step ${index + 1} of ${total}: ${title}`;

/** Every sentence this file adds, so one test can check the copy rules over all of them. */
export const WIZARD_UI_COPY: readonly string[] = [
  ...Object.values(COPY), ...Object.values(STEP_TITLE), ...Object.values(VISIBILITY_HELP),
  ...Object.values(CREATE_ERROR), ...Object.values(FIELD_ERROR), OFFLINE_ERROR, GENERIC_CREATE_ERROR,
  ...SLOW_MODE_CHOICES.map(slowModeLabel), defaultRoomTitle(null), defaultRoomTitle("Mara"),
];
