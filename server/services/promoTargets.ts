import { storage } from "../storage";
import {
  buildPostContent,
  buildVenueContent,
  buildVenueNightContent,
  type PromoCols,
} from "./socialPromotionService";

// What a social campaign promotes: an event, a venue, or one night at a venue.
// Everything that differs between those (who may promote it, whether it is
// currently promotable, the post text, when posting must stop) lives here so the
// posting and scheduling code never branches on the kind.

export type Fail = { ok: false; status: number; code: string; message: string };
export const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

export interface TargetInput {
  eventId?: string | null;
  venueId?: string | null;
  venueNightId?: string | null;
}

export interface LoadedTarget {
  kind: "event" | "venue" | "venue_night";
  cols: PromoCols;
  label: string;
  content: string;
  // Posts must go out before this. Null = no natural end (a venue itself).
  startsAt: Date | null;
}

// userId set → this is a new request: the caller must own the thing.
// userId null → re-checking a stored campaign at send time: ownership was settled when
// it was created, only "is it still promotable right now" matters.
async function resolve(input: TargetInput, userId: string | null): Promise<{ ok: true; target: LoadedTarget } | Fail> {
  const hasEvent = !!input.eventId;
  const hasVenue = !!input.venueId || !!input.venueNightId;
  if (hasEvent === hasVenue) return fail(400, "BAD_TARGET", "Choose an event, a venue, or a venue night to promote.");

  if (hasEvent) {
    const event = await storage.getEvent(input.eventId!);
    if (!event) return fail(404, "NOT_FOUND", "Event not found");
    if (event.kind === "social") return fail(400, "EVENT_KIND", "Social events can't be promoted");
    if (userId && event.organizerId !== userId) return fail(403, "NOT_OWNER", "You can only promote your own events");
    if (event.moderationStatus !== "approved") return fail(403, "NOT_APPROVED", "Event must be approved before it can be promoted");
    if (event.isCancelled) return fail(400, "EVENT_CANCELLED", "This event has been cancelled");
    const startsAt = new Date(event.eventDate);
    if (startsAt.getTime() <= Date.now()) return fail(400, "EVENT_PAST", "This event has already started");
    return {
      ok: true,
      target: {
        kind: "event",
        cols: { eventId: event.id, venueId: null, venueNightId: null },
        label: event.title,
        content: buildPostContent(event),
        startsAt,
      },
    };
  }

  if (input.venueNightId) {
    const night = await storage.getVenueEntryNight(input.venueNightId);
    if (!night) return fail(404, "NOT_FOUND", "Venue night not found");
    if (input.venueId && input.venueId !== night.venueId) return fail(400, "BAD_TARGET", "That night does not belong to this venue.");
    const venue = await storage.getVenue(night.venueId);
    if (!venue) return fail(404, "NOT_FOUND", "Venue not found");
    if (userId && venue.ownerId !== userId) return fail(403, "NOT_OWNER", "You can only promote your own venues");
    if (!night.isActive) return fail(400, "NIGHT_INACTIVE", "This night is not active");
    if (night.moderationStatus !== "approved") return fail(403, "NOT_APPROVED", "This night must be approved before it can be promoted");
    const startsAt = new Date(night.date);
    if (startsAt.getTime() <= Date.now()) return fail(400, "EVENT_PAST", "This night has already started");
    return {
      ok: true,
      target: {
        kind: "venue_night",
        cols: { eventId: null, venueId: venue.id, venueNightId: night.id },
        label: `${night.name} at ${venue.name}`,
        content: buildVenueNightContent(night, venue),
        startsAt,
      },
    };
  }

  const venue = await storage.getVenue(input.venueId!);
  if (!venue) return fail(404, "NOT_FOUND", "Venue not found");
  if (userId && venue.ownerId !== userId) return fail(403, "NOT_OWNER", "You can only promote your own venues");
  return {
    ok: true,
    target: {
      kind: "venue",
      cols: { eventId: null, venueId: venue.id, venueNightId: null },
      label: venue.name,
      content: buildVenueContent(venue),
      startsAt: null,
    },
  };
}

export const loadTarget = (userId: string, input: TargetInput) => resolve(input, userId);
export const recheckTarget = (input: TargetInput) => resolve(input, null);
