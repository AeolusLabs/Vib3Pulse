// Recurring venue events — "every Friday" etc. Deliberately the simplest
// thing that actually works: generate real, independent rows for each
// occurrence up front (capped) rather than a virtual/computed recurrence
// rule that every reader would need to expand. Each generated row is a
// completely normal venue event afterwards — existing listing, editing,
// ticketing, and check-in code needs zero changes to handle them.

export type RecurrenceInterval = "weekly" | "biweekly" | "monthly";

// Upper bound on how many occurrences a single recurring series creates,
// regardless of how far out recurrenceEndDate asks for — guards against a
// runaway/typo'd end date silently generating years of events.
const MAX_OCCURRENCES = 12;

function stepDate(date: Date, interval: RecurrenceInterval): Date {
  if (interval === "weekly") return new Date(date.getTime() + 7 * 86_400_000);
  if (interval === "biweekly") return new Date(date.getTime() + 14 * 86_400_000);
  // monthly — JS Date normalizes month overflow, so the 31st of a
  // 30-day month rolls to the 1st/2nd/3rd of the month after; a known,
  // minor edge case for end-of-month recurrence, not worth extra guarding.
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

// Returns the dates for occurrences AFTER firstDate (the caller already has
// that one), stopping at MAX_OCCURRENCES total or recurrenceEndDate,
// whichever comes first.
export function generateRecurrenceDates(
  firstDate: Date,
  interval: RecurrenceInterval,
  recurrenceEndDate?: Date,
): Date[] {
  const dates: Date[] = [];
  let current = firstDate;
  for (let i = 1; i < MAX_OCCURRENCES; i++) {
    current = stepDate(current, interval);
    if (recurrenceEndDate && current > recurrenceEndDate) break;
    dates.push(current);
  }
  return dates;
}

// Shifts a nullable secondary timestamp (endTime, doorsCloseTime, ...) by the
// same delta the primary date moved, so e.g. "doors close 1h after start"
// stays true for every generated occurrence.
export function shiftByDelta(value: Date | null | undefined, deltaMs: number): Date | null {
  if (!value) return null;
  return new Date(value.getTime() + deltaMs);
}
