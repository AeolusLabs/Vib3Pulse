// Pure rules and words for the minors' room screens (no React, no network). The server is the gate; this only decides what to show.
import { DENIED_MESSAGE } from "./roomsApi";
import { MINORS_ROOM_CODES, type MinorsRoomCode } from "@shared/rooms";
import { cleanWarning } from "./roomReducer";

export const ADULT_LISTEN_LINE = "In this room adults can listen and chat.";
export const TEEN_HOST_NOTE = "Only people under 18 can join. You can invite an adult yourself.";
export const ENTER_BUTTON = "I understand, enter";
export const BACK_BUTTON = "Back to Rooms";
export const WARNING_TITLE = "You can't enter this room";
export const RELOAD_FAILED_COPY = "Couldn't open the room. Try again.";
export const ALREADY_INVITED_COPY = "Everyone who matches is already invited.";
export const INVITE_SHEET_TITLE = "Invite an adult";
export const INVITE_SHEET_HELP = "An adult can only come in if you invite them, and they must read a safety notice first. You can take the invite back at any time.";

export const isMinorsCode = (code: unknown): code is MinorsRoomCode => typeof code === "string" && (MINORS_ROOM_CODES as readonly string[]).includes(code);

/**
 * Which warning screen a refusal gets. Only the two minors' room codes ever show it, so a teen (who is never refused with
 * these codes) can never land on it. "ack" has the enter button; "refuse" has only the way back.
 */
export function warningScreenFor(code: unknown): "refuse" | "ack" | null {
  if (code === "MINORS_ROOM") return "refuse";
  if (code === "MINORS_ROOM_ACK") return "ack";
  return null;
}

/** What the page keeps from a 403 on GET /api/rooms/:id: the code, nothing else (no title, host, counts or the body's text). */
export interface MinorsDenied { minorsDenied: MinorsRoomCode; /** The server's warning text (a teen lane's wording differs from a plain minors' room's). */ warning?: string }
export interface AgeUnknownDenied { denied: "AGE_UNKNOWN" }
/** A lane parent's door: no lane for this viewer (404 NO_LANE) or not their age group (403 AGE_LIMIT). The text is the server's. */
export interface LaneDenied { laneDenied: "AGE_LIMIT" | "NO_LANE"; warning?: string }
export type RoomDenial = MinorsDenied | AgeUnknownDenied | LaneDenied;
export const isLaneDenied = (x: unknown): x is LaneDenied => !!x && typeof x === "object" && ((x as { laneDenied?: unknown }).laneDenied === "AGE_LIMIT" || (x as { laneDenied?: unknown }).laneDenied === "NO_LANE");
export const isMinorsDenied = (x: unknown): x is MinorsDenied => !!x && typeof x === "object" && isMinorsCode((x as { minorsDenied?: unknown }).minorsDenied);
export const isAgeUnknownDenied = (x: unknown): x is AgeUnknownDenied => !!x && typeof x === "object" && (x as { denied?: unknown }).denied === "AGE_UNKNOWN";
export const isRoomDenial = (x: unknown): x is RoomDenial => isMinorsDenied(x) || isAgeUnknownDenied(x) || isLaneDenied(x);

export function parseRoomDenial(status: number, body: unknown): RoomDenial | null {
  if ((status !== 403 && status !== 404) || !body || typeof body !== "object") return null;
  const code = (body as { code?: unknown }).code;
  const warning = cleanWarning((body as { warning?: unknown }).warning);
  if (status === 403 && code === "AGE_UNKNOWN") return { denied: "AGE_UNKNOWN" }; // no warning and no room details: they may be a teen
  if ((code === "NO_LANE" && (status === 404 || status === 403)) || (code === "AGE_LIMIT" && status === 403)) return { laneDenied: code, ...(warning ? { warning } : {}) };
  return status === 403 && isMinorsCode(code) ? { minorsDenied: code, ...(warning ? { warning } : {}) } : null;
}

/** The warning screen's code, from the HTTP answer or from the socket's join refusal. HTTP wins (it is the same decision, read first). */
export function minorsCodeFor(http: MinorsDenied | null | undefined, socket: { phase: string; error: string | null }): MinorsRoomCode | null {
  if (isMinorsDenied(http)) return http.minorsDenied;
  return socket.phase === "denied" && isMinorsCode(socket.error) ? socket.error : null;
}

/** Host-only, minors' rooms only. A normal room, a guest, a co-host: nothing. */
export const showAdultInvite = (v: { isHost: boolean; minorsRoom: boolean | undefined }) => v.isHost === true && v.minorsRoom === true;

/** The note for a teen creating a room. Known age 17 or under; unknown age shows nothing (the server decides anyway). */
export const showTeenHostNote = (age: number | null | undefined) => typeof age === "number" && age < 18;

/**
 * Adults only listen and chat in a minors' room. The mic, hand and camera offers show only to someone known to be under 18;
 * while the age is not known yet they stay hidden (the server refuses them anyway).
 */
export function listenOnlyHere(v: { minorsRoom: boolean | undefined; age: number | null | undefined }): boolean {
  if (v.minorsRoom !== true) return false;
  return !(typeof v.age === "number" && v.age < 18);
}

/** The "adults can listen and chat" line shows only when the viewer is KNOWN to be 18 or over, so a teen never sees it while the age loads. */
export const showListenLine = (v: { minorsRoom: boolean | undefined; age: number | null | undefined }): boolean =>
  v.minorsRoom === true && typeof v.age === "number" && v.age >= 18;

export type InviteStatus = "invited" | "acknowledged" | "revoked";
export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = { invited: "Invited", acknowledged: "Read the notice", revoked: "Revoked" };
export const inviteStatus = (i: { acknowledged: boolean }, revoked = false): InviteStatus => (revoked ? "revoked" : i.acknowledged ? "acknowledged" : "invited");

export function inviteErrorMessage(status: number, code?: string): string {
  if (status === 429 || code === "RATE_LIMITED") return "Slow down a little, then try again.";
  if (code === "NOT_ALLOWED") return "You can't invite this person.";
  if (code === "HOST_NOT_MINOR") return "Only hosts under 18 can do this in a room for under 18s.";
  if (status === 403 && !code) return "That didn't work. Try again."; // a stale session token looks like this; the call already retried once
  if (code === "NOT_MINORS_ROOM") return "This room doesn't need adult invites.";
  if (code === "ROOM_ENDED") return DENIED_MESSAGE.ROOM_ENDED;
  return "That didn't work. Try again.";
}

export function acknowledgeErrorMessage(status: number, code?: string): string {
  if (code === "ROOM_ENDED") return DENIED_MESSAGE.ROOM_ENDED; // one source for the ended copy
  if (code === "AGE_UNKNOWN") return "Add your date of birth in your profile to join rooms.";
  if (status === 429) return "Slow down a little, then try again.";
  if (code === "MINORS_ROOM") return "The host took back your invite, or you can't come into this room.";
  if (status === 404) return "This room isn't available.";
  return "That didn't work. Try again.";
}

/** Already acknowledged, or not needed for you: nothing to record, so carry on and try to join. */
export const ackAlreadyDone = (status: number, code?: string) => status === 409 && code === "NOT_NEEDED";

/** Every sentence this feature adds, so one test can check the copy rules over all of them. */
export const MINORS_UI_COPY: readonly string[] = [
  ADULT_LISTEN_LINE, TEEN_HOST_NOTE, ENTER_BUTTON, BACK_BUTTON, WARNING_TITLE, RELOAD_FAILED_COPY, ALREADY_INVITED_COPY, INVITE_SHEET_TITLE, INVITE_SHEET_HELP,
  "Search by username", "Invite", "Revoke", "Invite again", "Nobody invited yet.", "Got it",
  ...Object.values(INVITE_STATUS_LABEL),
  ...[0, 403, 429].flatMap((s) => ["RATE_LIMITED", "NOT_ALLOWED", "HOST_NOT_MINOR", "NOT_MINORS_ROOM", "ROOM_ENDED", undefined].map((c) => inviteErrorMessage(s, c))),
  ...[0, 403, 404, 429].flatMap((s) => ["ROOM_ENDED", "AGE_UNKNOWN", "MINORS_ROOM", undefined].map((c) => acknowledgeErrorMessage(s, c))),
];
