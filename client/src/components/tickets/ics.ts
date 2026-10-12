import { format } from "date-fns";
import { endOf, type WalletTicket } from "./ticketModel";

const stamp = (d: Date) => format(new Date(d.getTime() + d.getTimezoneOffset() * 60000), "yyyyMMdd'T'HHmmss'Z'");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** A one-event calendar file for a ticket. */
export function ticketToIcs(t: WalletTicket): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vib3Pulse//Tickets//EN",
    "BEGIN:VEVENT",
    `UID:${t.id}@vib3pulse`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(t.startsAt)}`,
    `DTEND:${stamp(endOf(t))}`,
    `SUMMARY:${esc(t.title)}`,
    `LOCATION:${esc(t.address ?? t.place)}`,
    `DESCRIPTION:${esc(`Vib3Pulse ticket ${t.shortCode}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Download the .ics so the phone offers to add it to the calendar. */
export function downloadIcs(t: WalletTicket): void {
  const url = URL.createObjectURL(new Blob([ticketToIcs(t)], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${t.title.replace(/[^\w]+/g, "-").toLowerCase()}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
