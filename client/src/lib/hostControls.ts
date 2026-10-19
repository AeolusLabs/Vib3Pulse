// Pure rules and copy for the host Controls sheet (task 3.4). No React, no network: tested by scripts/test-rooms-unit-controls.ts.
// The server is the gate (PATCH /api/rooms/:id, the room:mod / room:stage / room:live handlers); this only decides what to offer.

export type ControlsRole = "host" | "cohost";
export type ControlsTab = "requests" | "stage" | "people" | "settings";
type MemberRole = "host" | "cohost" | "guest";

export const CONTROLS_TABS: readonly ControlsTab[] = ["requests", "stage", "people", "settings"];
export const TAB_LABEL: Record<ControlsTab, string> = { requests: "Requests", stage: "Stage", people: "People", settings: "Settings" };

/** Mirrors SLOW_MODES and ROOM_LIMITS.pinned in shared/rooms.ts (task 3.1). The server validates either way. */
export const SLOW_MODE_OPTIONS = [0, 5, 15, 30] as const;
export const PINNED_MAX = 200;
export const slowModeLabel = (sec: number) => (sec === 0 ? "Off" : `${sec}s`);

/** What each role may do from the Controls sheet. A co-host gets the same four tabs, but Settings shows only the pinned message. */
export interface ControlsAbilities {
  tabs: readonly ControlsTab[];
  switchVoice: boolean;
  switchLive: boolean;
  makeCohost: boolean;
  editPinned: boolean;
  editSlowMode: boolean;
  lockRoom: boolean;
  endRoom: boolean;
  /** The existing host block (invite link, invite an adult, waves switch). */
  hostExtras: boolean;
}

export function controlsFor(role: ControlsRole): ControlsAbilities {
  const host = role === "host";
  return {
    tabs: CONTROLS_TABS,
    switchVoice: host, switchLive: host, makeCohost: host,
    editPinned: true,
    editSlowMode: host, lockRoom: host, endRoom: host, hostExtras: host,
  };
}

// ---------------------------------------------------------------- settings

export interface HostSettings { pinnedMessage: string | null; slowModeSec: number; locked: boolean }
export type SettingsPatch = Partial<HostSettings>;
export const DEFAULT_SETTINGS: HostSettings = { pinnedMessage: null, slowModeSec: 0, locked: false };

/** Reads the three settings from room records (socket room first, then the room details). Missing or odd values fall back. */
export function readSettings(...sources: Array<Record<string, unknown> | null | undefined>): HostSettings {
  const pick = <T,>(key: keyof HostSettings, ok: (v: unknown) => v is T, fallback: T): T => {
    for (const s of sources) if (s && key in s && ok(s[key])) return s[key] as T;
    return fallback;
  };
  return {
    pinnedMessage: pick("pinnedMessage", (v): v is string | null => v === null || typeof v === "string", null),
    slowModeSec: pick("slowModeSec", (v): v is number => typeof v === "number" && (SLOW_MODE_OPTIONS as readonly number[]).includes(v), 0),
    locked: pick("locked", (v): v is boolean => typeof v === "boolean", false),
  };
}

/** What the editor sends: trimmed, at most 200 characters, empty means no pinned message. The server strips markup again. */
export function normalizePinned(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, PINNED_MAX).trim();
  return t ? t : null;
}

/**
 * The PATCH body: only fields that changed and that this role may change. A co-host can only ever send pinnedMessage;
 * a slow mode outside 0/5/15/30 is dropped rather than sent.
 */
export function settingsPatch(current: HostSettings, draft: SettingsPatch, role: ControlsRole): SettingsPatch {
  const can = controlsFor(role);
  const out: SettingsPatch = {};
  if (can.editPinned && "pinnedMessage" in draft) {
    const p = normalizePinned(draft.pinnedMessage);
    if (p !== current.pinnedMessage) out.pinnedMessage = p;
  }
  if (can.editSlowMode && draft.slowModeSec !== undefined && (SLOW_MODE_OPTIONS as readonly number[]).includes(draft.slowModeSec) && draft.slowModeSec !== current.slowModeSec) {
    out.slowModeSec = draft.slowModeSec;
  }
  if (can.lockRoom && typeof draft.locked === "boolean" && draft.locked !== current.locked) out.locked = draft.locked;
  return out;
}

export const isEmptyPatch = (p: SettingsPatch) => Object.keys(p).length === 0;

/** Optimistic view: what was just asked for, over what the server last said. */
export const mergeOptimistic = (server: HostSettings, pending: SettingsPatch | null): HostSettings => (pending ? { ...server, ...pending } : server);

/** Every pending field now matches the server (room:settings arrived): the optimistic layer can go. */
export function pendingSettled(server: HostSettings, pending: SettingsPatch | null): boolean {
  if (!pending) return true;
  return (Object.keys(pending) as Array<keyof HostSettings>).every((k) => server[k] === pending[k]);
}

/** After this long without a matching room:settings, the server's value is shown again (the UI never claims a change for long). */
export const RECONCILE_MS = 1000;

/** One plain line for a failed save. A short server message is kept (it is already plain); anything else gets the fallback. */
export function settingsErrorMessage(serverMessage: unknown, fallback = "Couldn't save that. Try again."): string {
  const m = typeof serverMessage === "string" ? serverMessage.trim() : "";
  if (m && m.length <= 120 && !/[<>{}]/.test(m) && !/^\d{3}\b/.test(m)) return m;
  return fallback;
}

// ---------------------------------------------------------------- end the room

export function endRoomCopy(count: number): { title: string; body: string; confirm: string; cancel: string } {
  const others = Math.max(0, Math.floor(count) - 1); // everyone but the host
  const body = others === 0 ? "No one else is here. The room closes." : others === 1 ? "1 person will be sent out and the room closes." : `${others} people will be sent out and the room closes.`;
  return { title: "End for everyone?", body, confirm: "End room", cancel: "Keep going" };
}

// ---------------------------------------------------------------- people and the stage

/** Same rule as the avatar sheet and the server: the host acts on anyone but the host; a co-host only on guests; never yourself. */
export function canModerate(viewer: ControlsRole, target: { userId: string; role: MemberRole }, selfId: string | null): boolean {
  if (target.userId === selfId || target.role === "host") return false;
  return viewer === "host" || target.role === "guest";
}

export type PersonAction = "mute" | "unmute" | "kick" | "ban" | "report";

/** The People tab row for one person. Report is offered for anyone but yourself; moderation follows canModerate. */
export function personActions(viewer: ControlsRole, target: { userId: string; role: MemberRole; muted: boolean }, selfId: string | null): PersonAction[] {
  if (target.userId === selfId) return [];
  const out: PersonAction[] = [];
  if (canModerate(viewer, target, selfId)) out.push(target.muted ? "unmute" : "mute", "kick", "ban");
  out.push("report");
  return out;
}

/** Host only: a guest can be made a co-host, a co-host can be made a guest again. */
export function roleChange(viewer: ControlsRole, target: { userId: string; role: MemberRole }, selfId: string | null): "make-cohost" | "remove-cohost" | null {
  if (viewer !== "host" || target.userId === selfId || target.role === "host") return null;
  return target.role === "cohost" ? "remove-cohost" : "make-cohost";
}

export interface RequestItem { userId: string; kind: "hand" | "live" }

/** Hands up first (in the order they were raised), then go-live asks (only while live video is on). One row per person and kind. */
export function requestQueue(hands: readonly string[], asks: readonly string[], liveVideo: boolean, skip: ReadonlySet<string> = new Set()): RequestItem[] {
  const out: RequestItem[] = [];
  const seen = new Set<string>();
  for (const id of hands) if (!seen.has(`h:${id}`) && !skip.has(`hand:${id}`)) { seen.add(`h:${id}`); out.push({ userId: id, kind: "hand" }); }
  if (liveVideo) for (const id of asks) if (!seen.has(`l:${id}`) && !skip.has(`live:${id}`)) { seen.add(`l:${id}`); out.push({ userId: id, kind: "live" }); }
  return out;
}

export const REQUEST_LABEL: Record<RequestItem["kind"], string> = { hand: "Hand up", live: "Wants to go live" };

// ---------------------------------------------------------------- money (not built in this phase)

/**
 * The money placeholder renders only for the host, only while a money flag is on, and only in an 18+ or 21+ room with an
 * adult host (a minors' room always has a teen host). With both flags off it renders nothing at all.
 */
export function moneyPlaceholderVisible(v: { role: ControlsRole; flags: { paidRooms: boolean; spray: boolean } | null | undefined; ageLimit: string; minorsRoom: boolean | undefined }): boolean {
  if (v.role !== "host" || !v.flags || (!v.flags.paidRooms && !v.flags.spray)) return false;
  return (v.ageLimit === "18+" || v.ageLimit === "21+") && v.minorsRoom !== true;
}

// ---------------------------------------------------------------- copy

export const CONTROLS_COPY = {
  title: "Controls",
  hostSub: "Run the room. If you close this page the room ends shortly after.",
  cohostSub: "Help the host with requests, the stage and the people in the room.",
  requestsEmpty: "No requests right now.",
  requestsEmptySub: "Raised hands and go-live asks show up here.",
  oneOnCamera: "Only one person can be on camera at a time. Accepting someone else switches the picture.",
  pinnedLabel: "Pinned message",
  pinnedNote: "Plain text only. Everyone sees it above the chat.",
  pinnedSave: "Save",
  pinnedClear: "Remove",
  slowModeLabel: "Slow mode",
  slowModeNote: "How long people wait between chat messages. You and your co-hosts are never slowed.",
  lockLabel: "Lock the room",
  lockNote: "No one new can join. People already in, co-hosts and anyone holding your invite can still come back.",
  voiceLabel: "Voice",
  liveLabel: "Live video",
  moneyLabel: "Paid entry and spray",
  moneyNote: "Not available yet.",
  endButton: "End room",
  cohostSettingsNote: "Only the host can change slow mode, the lock and the switches.",
  peopleEmpty: "No one else is here yet.",
  kick: "Remove for 10 minutes",
  ban: "Ban from room",
  report: "Report",
  makeCohost: "Make co-host",
  removeCohost: "Make guest",
  sendFailed: "Couldn't reach the room. Try again.",
} as const;
