import type { OpeningHours } from "@shared/schema";

export type OpenStatus = {
  state: "open" | "closed" | "unknown";
  label: string; // "Open now" | "Closed" | ""
  detail: string; // "closes 4:00 am" | "opens Fri 10:00 pm" | ""
};

const WEEK = 7 * 1440;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNKNOWN: OpenStatus = { state: "unknown", label: "", detail: "" };

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

// Venue-local weekday (0 = Sunday) and minute-of-day for an instant.
function localParts(now: Date, timeZone: string): { dow: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dow = DAY_NAMES.indexOf(get("weekday"));
    if (dow < 0) return null;
    return { dow, minute: Number(get("hour")) * 60 + Number(get("minute")) };
  } catch {
    return null; // invalid timezone
  }
}

/**
 * Open/closed status at `now` for structured hours. A session belongs to the day it
 * opens on; close <= open means it runs past midnight (close === open = open 24h).
 * Evaluated in the venue's wall-clock time, so a session straddling a DST change can
 * be off by the DST hour at its far end.
 */
export function getOpenStatus(openingHours: OpeningHours | null | undefined, now: Date = new Date()): OpenStatus {
  if (!openingHours?.days || !openingHours.timezone) return UNKNOWN;
  const local = localParts(now, openingHours.timezone);
  if (!local) return UNKNOWN;
  const cur = local.dow * 1440 + local.minute;

  // Absolute week-minute sessions; each day's session is also tried one week back so
  // Saturday-night sessions are seen from early Sunday.
  const sessions: { start: number; end: number; day: number; closeStr: string; openStr: string }[] = [];
  for (let d = 0; d < 7; d++) {
    const s = openingHours.days[String(d) as keyof OpeningHours["days"]];
    if (!s) continue;
    const o = toMinutes(s.open);
    const c = toMinutes(s.close);
    const len = (c - o + 1440) % 1440 || 1440;
    sessions.push({ start: d * 1440 + o, end: d * 1440 + o + len, day: d, closeStr: s.close, openStr: s.open });
  }
  if (sessions.length === 0) return { state: "closed", label: "Closed", detail: "" };

  for (const s of sessions) {
    for (const shift of [0, -WEEK]) {
      if (cur >= s.start + shift && cur < s.end + shift) {
        return { state: "open", label: "Open now", detail: `closes ${formatTime(s.closeStr)}` };
      }
    }
  }

  // Closed: soonest upcoming session start (wrapping into next week).
  let best: (typeof sessions)[number] | null = null;
  let bestWait = Infinity;
  for (const s of sessions) {
    const wait = (s.start - cur + WEEK) % WEEK;
    if (wait < bestWait) { bestWait = wait; best = s; }
  }
  const sameDay = best!.day === local.dow && bestWait < 1440;
  return {
    state: "closed",
    label: "Closed",
    detail: `opens ${sameDay ? "" : DAY_NAMES[best!.day] + " "}${formatTime(best!.openStr)}`,
  };
}
