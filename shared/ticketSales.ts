// Ticket-sales window helpers shared by the server (checkout gate) and the client (labels).
// The organiser picks a DATE ("sales end 20 Oct"), stored as that day's 00:00 UTC. They mean
// "through the 20th", so a date-only value stays on sale until the end of that day.

const DAY = 24 * 60 * 60 * 1000;

const isDateOnly = (d: Date) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

// Instant at which sales stop (exclusive), or null when the tier has no end date.
export function salesEndInstant(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return isDateOnly(d) ? d.getTime() + DAY : d.getTime();
}

export function salesHaveEnded(value: string | Date | null | undefined, now = Date.now()): boolean {
  const end = salesEndInstant(value);
  return end !== null && now >= end;
}

// Whole calendar days from "today" (viewer's local date) to the last day of sales.
// 0 = last day, 1 = tomorrow, negative = already ended.
export function salesDaysLeft(value: string | Date, now = new Date()): number {
  const d = new Date(value);
  // Date-only values name a calendar day (read in UTC); timed values are read in the viewer's zone.
  const last = isDateOnly(d)
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((last - today) / DAY);
}

export function daysLeftLabel(days: number): string {
  if (days < 0) return "Sales ended";
  if (days === 0) return "Last day";
  return days === 1 ? "1 day left" : `${days} days left`;
}
