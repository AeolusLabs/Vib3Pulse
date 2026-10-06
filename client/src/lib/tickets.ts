import type { Event } from "@shared/schema";

// Tickets left for an event. List endpoints send a tier-aware `ticketsRemaining`;
// otherwise fall back to the flat event row (correct for events with no tiers).
export function ticketsRemaining(event: Event & { ticketsRemaining?: number }): number {
  return Math.max(0, event.ticketsRemaining ?? event.ticketsAvailable - event.ticketsSold);
}
