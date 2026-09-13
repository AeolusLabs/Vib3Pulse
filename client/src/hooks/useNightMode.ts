import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { Rsvp, Ticket, Event } from "@shared/schema";

interface Buddy {
  name: string;
  isPrimary: boolean;
  confirmationStatus: "pending" | "confirmed" | "declined" | "expired";
}

type RsvpWithEvent = Rsvp & { event: Event };
type TicketWithEvent = Ticket & { event: Event };

const DISMISS_KEY_PREFIX = "vibepulse_nightmode_dismissed_";
const OVERRIDE_KEY = "vibepulse_nightmode_force_on";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function readLocalFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "true");
    else localStorage.removeItem(key);
  } catch {
    // localStorage unavailable (private mode, etc.) — degrade silently
  }
}

// Night mode is active 18:00 → 06:00 the next morning, around a confirmed
// ticket/RSVP for an event starting after 21:00 that same day.
function isEligibleWindowNow(eventDate: Date): boolean {
  const now = new Date();
  const eventHour = eventDate.getHours();
  if (eventHour < 21) return false;

  const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const windowStart = new Date(eventDay.getTime());
  windowStart.setHours(18, 0, 0, 0);
  const windowEnd = new Date(eventDay.getTime() + 24 * 60 * 60_000);
  windowEnd.setHours(6, 0, 0, 0);

  return now >= windowStart && now <= windowEnd;
}

function isFridayOrSaturdayNight(): boolean {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  return (day === 5 || day === 6) && now.getHours() >= 22;
}

export function useNightMode() {
  const [, forceRender] = useState(0);

  const { data: rsvps, isLoading: rsvpsLoading } = useQuery<RsvpWithEvent[]>({
    queryKey: ["/api/rsvps"],
  });
  const { data: tickets, isLoading: ticketsLoading } = useQuery<TicketWithEvent[]>({
    queryKey: ["/api/tickets"],
  });
  const { data: buddiesData, isLoading: buddiesLoading } = useQuery<{ buddies: Buddy[] }>({
    queryKey: ["/api/safety/buddies"],
  });

  const isLoading = rsvpsLoading || ticketsLoading || buddiesLoading;

  const confirmedBuddies = useMemo(
    () => (buddiesData?.buddies ?? []).filter((b) => b.confirmationStatus === "confirmed"),
    [buddiesData]
  );
  const hasConfirmedBuddy = confirmedBuddies.length > 0;
  const primaryBuddyName = useMemo(() => {
    const primary = confirmedBuddies.find((b) => b.isPrimary) ?? confirmedBuddies[0];
    return primary?.name ?? null;
  }, [confirmedBuddies]);

  const eligibility = useMemo(() => {
    const qualifyingTicket = (tickets ?? []).find(
      (t) => t.status === "confirmed" && isEligibleWindowNow(new Date(t.event.eventDate))
    );
    if (qualifyingTicket) {
      return { reason: "ticket" as const, eventName: qualifyingTicket.event.title };
    }
    const qualifyingRsvp = (rsvps ?? []).find(
      (r) => r.status === "confirmed" && isEligibleWindowNow(new Date(r.event.eventDate))
    );
    if (qualifyingRsvp) {
      return { reason: "rsvp" as const, eventName: qualifyingRsvp.event.title };
    }
    return { reason: null, eventName: null };
  }, [tickets, rsvps]);

  const manualOverride = readLocalFlag(OVERRIDE_KEY);
  const isDismissedToday = readLocalFlag(DISMISS_KEY_PREFIX + todayKey());

  // Pure eligibility + manual override — intentionally ignores dismiss, since
  // dismissing the shield only hides UI, it never disarms a safety feature
  // (e.g. Phase 3's shake-to-SOS gating reads this field, not shieldVisible).
  const isActive = !!eligibility.reason || manualOverride;
  const reason: "ticket" | "rsvp" | "manual_override" | null = manualOverride && !eligibility.reason
    ? "manual_override"
    : eligibility.reason;

  const shieldVisible = isActive && !isDismissedToday;

  const hasQualifyingTicketOrRsvp = !!eligibility.reason;
  const shouldShowSoftPrompt = !hasQualifyingTicketOrRsvp && !hasConfirmedBuddy && isFridayOrSaturdayNight();

  const dismissForTonight = useCallback(() => {
    writeLocalFlag(DISMISS_KEY_PREFIX + todayKey(), true);
    forceRender((n) => n + 1);
  }, []);

  const setManualOverride = useCallback((on: boolean) => {
    writeLocalFlag(OVERRIDE_KEY, on);
    forceRender((n) => n + 1);
  }, []);

  return {
    isActive,
    reason,
    eventName: eligibility.eventName,
    primaryBuddyName,
    hasConfirmedBuddy,
    shieldVisible,
    shouldShowSoftPrompt,
    isLoading,
    dismissForTonight,
    setManualOverride,
    manualOverride,
  };
}
