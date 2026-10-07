// Calendar + maps helpers for the event details view. All client-side, no API.

export interface CalendarEvent {
  title: string;
  description?: string | null;
  location: string;
  start: Date;
  end?: Date | null;
}

// Events with no end time are treated as 3h long, matching the rest of the app.
const endOf = (e: CalendarEvent) => e.end ?? new Date(e.start.getTime() + 3 * 60 * 60 * 1000);

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function googleCalendarUrl(e: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${stamp(e.start)}/${stamp(endOf(e))}`,
    details: (e.description ?? "").slice(0, 800),
    location: e.location,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

export function downloadIcs(e: CalendarEvent): void {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vib3Pulse//Event//EN",
    "BEGIN:VEVENT",
    `UID:${stamp(e.start)}-${encodeURIComponent(e.title)}@vib3pulse`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(endOf(e))}`,
    `SUMMARY:${icsText(e.title)}`,
    `DESCRIPTION:${icsText((e.description ?? "").slice(0, 800))}`,
    `LOCATION:${icsText(e.location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${e.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "event"}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Opens the user's default maps app on phones, Google Maps on desktop.
export function directionsUrl(location: string, lat?: number | null, lon?: number | null): string {
  const destination = lat != null && lon != null ? `${lat},${lon}` : location;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
