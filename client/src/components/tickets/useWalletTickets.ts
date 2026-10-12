import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { readWalletCache, writeWalletCache } from "@/lib/walletCache";
import { buildWalletTickets, isPast, type EventTicketRow, type VenueTicketRow, type WalletTicket } from "./ticketModel";

/**
 * Event and venue-entry tickets in one list. Upcoming tickets are cached on the device, so the wallet
 * and every QR still open with no signal; the cache is wiped on log out (see logout() in useAuth).
 */
export function useWalletTickets() {
  const { data: user } = useAuth();
  const userId = user?.id;
  const cached = useMemo(() => (userId ? readWalletCache(userId) : null), [userId]);

  // The app's default staleTime is Infinity, which would pin the on-device copy forever. Show the copy
  // instantly, then always refresh (check-in status and new purchases must not go stale).
  const fresh = { staleTime: 0, refetchOnMount: "always" as const };
  const events = useQuery<EventTicketRow[]>({
    queryKey: ["/api/tickets"],
    enabled: !!userId,
    initialData: cached ? (cached.event as EventTicketRow[]) : undefined,
    initialDataUpdatedAt: cached?.savedAt,
    ...fresh,
  });
  const venues = useQuery<VenueTicketRow[]>({
    queryKey: ["/api/my-venue-tickets"],
    enabled: !!userId,
    initialData: cached ? (cached.venue as VenueTicketRow[]) : undefined,
    initialDataUpdatedAt: cached?.savedAt,
    ...fresh,
  });

  const tickets = useMemo(
    () => buildWalletTickets(events.data ?? [], venues.data ?? []).sort((a, b) => +a.startsAt - +b.startsAt),
    [events.data, venues.data],
  );

  // Refresh the on-device copy whenever fresh data arrives. Only tickets that can still be used are kept.
  useEffect(() => {
    if (!userId || !events.isSuccess || !venues.isSuccess || events.isFetching || venues.isFetching) return;
    const keepEvent = (events.data ?? []).filter((t) => !isPast(buildWalletTickets([t], [])[0]));
    const keepVenue = (venues.data ?? []).filter((t) => !isPast(buildWalletTickets([], [t])[0]));
    writeWalletCache(userId, keepEvent, keepVenue);
  }, [userId, events.data, venues.data, events.isSuccess, venues.isSuccess, events.isFetching, venues.isFetching]);

  return {
    tickets: tickets as WalletTicket[],
    isLoading: (events.isLoading && !events.data) || (venues.isLoading && !venues.data),
    isError: events.isError && venues.isError,
    /** True when we are showing the on-device copy because the network request failed. */
    offline: (events.isError || venues.isError) && tickets.length > 0,
  };
}
