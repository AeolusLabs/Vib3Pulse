import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import UnifiedShareModal from "@/components/UnifiedShareModal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import type { Event, Community } from "@shared/schema";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CalendarIcon, MapPinIcon, UsersIcon, TicketIcon, CheckCircleIcon, ExternalLinkIcon,
  Share2Icon, XIcon, ArrowLeftIcon, AlertTriangleIcon, ChevronDownIcon, ClockIcon, InfoIcon,
} from "@/components/ui/icons";
import { useEventRatings, useUserEventRating, useSubmitRating } from "@/hooks/use-ratings";
import RatingInput from "@/components/RatingInput";
import RatingDisplay from "@/components/RatingDisplay";
import { directionsUrl, downloadIcs, googleCalendarUrl, type CalendarEvent } from "@/lib/eventLinks";
import { formatPrice } from "@/components/event-details/format";
import OrganizerRow, { type PublicOrganizer } from "@/components/event-details/OrganizerRow";
import SimilarEvents from "@/components/event-details/SimilarEvents";
import TicketPicker, { nextSalesDeadline, tierStatus, type PickerTier, type Quote } from "@/components/event-details/TicketPicker";
import { daysLeftLabel } from "@shared/ticketSales";
import { trackEventClick, trackEventView } from "@/lib/eventTracking";

interface EventDetailsModalProps {
  event: Event;
  onClose: () => void;
}

const FLAT_TIER_ID = "__flat__";
const UNLIMITED_SPOTS = 9999; // CreateEventModal stores free events as 9999 = "no cap"
const THREE_HOURS = 3 * 60 * 60 * 1000;

// Staggered first-paint reveal (30–80ms steps). Opacity + transform only, off for reduced-motion.
const rise = (i: number) => ({
  className: "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 fill-mode-both motion-reduce:animate-none",
  style: { animationDelay: `${i * 50}ms` },
});

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{children}</p>;
}

function statusOf(start: number, end: number, cancelled: boolean): { label: string; tone: string } {
  const now = Date.now();
  if (cancelled) return { label: "Cancelled", tone: "text-destructive" };
  if (now < start) return { label: "Upcoming", tone: "text-primary" };
  if (now <= end) return { label: "Live now", tone: "text-green-500" };
  return { label: "Ended", tone: "text-muted-foreground" };
}

export default function EventDetailsModal({ event, onClose }: EventDetailsModalProps) {
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const [, navigate] = useLocation();
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [isEditingRating, setIsEditingRating] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const ticketsRef = useRef<HTMLElement>(null);

  const start = new Date(event.eventDate).getTime();
  const end = event.eventEndDate ? new Date(event.eventEndDate).getTime() : start + THREE_HOURS;
  const isEventEnded = end < Date.now();

  const { data: eventRatingStats } = useEventRatings(isEventEnded ? event.id : undefined);
  const { data: userEventRating } = useUserEventRating(isEventEnded && currentUser ? event.id : undefined);
  const submitEventRating = useSubmitRating(event.id, event.organizerId);

  // The checkout success/cancel redirect returns here (or reloads this page for
  // full-page /event/:id views) — surface a toast for the cancelled case and
  // strip the query param so a refresh doesn't re-trigger it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("cancelled") === "true") {
      toast({ title: "Purchase cancelled", description: "Your ticket purchase was cancelled." });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [toast]);

  // Count a view once per session (the server ignores the organiser's own views).
  useEffect(() => { trackEventView(event.id); }, [event.id]);

  const currency = (event as any).currency as string | undefined;
  const communityId = (event as any).communityId as string | undefined;

  const { data: communityData } = useQuery<Community & { memberCount: number }>({
    queryKey: ["/api/communities", communityId],
    enabled: !!communityId,
  });

  const { data: communityMembership } = useQuery<{ isMember: boolean }>({
    queryKey: ["/api/communities", communityId, "membership"],
    enabled: !!communityId && !!currentUser,
  });

  const joinCommunityMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/communities/${communityId}/join`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/communities", communityId, "membership"] });
    },
  });

  const leaveCommunityMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/communities/${communityId}/leave`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/communities", communityId, "membership"] });
    },
  });

  const { data: rsvps, isLoading: isLoadingRSVPs } = useQuery({
    queryKey: ["/api/rsvps"],
    queryFn: async () => {
      const response = await fetch("/api/rsvps", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch RSVPs");
      return response.json();
    },
  });

  const { data: myTickets } = useQuery<Array<{ eventId: string; status: string }>>({
    queryKey: ["/api/tickets"],
    enabled: !!currentUser,
  });
  const hasTicket = !!myTickets?.some((t) => t.eventId === event.id && t.status === "confirmed");

  const { data: ticketTiers, isLoading: isLoadingTiers } = useQuery<PickerTier[]>({
    queryKey: ["/api/events", event.id, "ticket-tiers"],
    queryFn: async () => {
      const response = await fetch(`/api/events/${event.id}/ticket-tiers`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch ticket tiers");
      return response.json();
    },
    // Live tier remaining-capacity — was static on load, so a tier could
    // show "3 available" long after it actually sold out to someone else.
    refetchInterval: 15000,
  });

  // Live top-level ticket availability (flat-price events with no tiers) plus the
  // public organiser. The `event` prop is a point-in-time snapshot handed down by
  // whichever list opened this modal and never refreshes on its own.
  const { data: liveEvent } = useQuery<Event & { organizer?: PublicOrganizer }>({
    queryKey: ["/api/events", event.id],
    queryFn: async () => {
      const response = await fetch(`/api/events/${event.id}`);
      if (!response.ok) throw new Error("Failed to fetch event");
      return response.json();
    },
    initialData: event,
    refetchInterval: 15000,
  });
  const organizer = liveEvent?.organizer?.id ? liveEvent.organizer : undefined;
  // Organiser-entered details (all optional). liveEvent starts as the list's snapshot, so
  // older cached rows without these fields simply render nothing extra.
  const details = liveEvent ?? event;
  const lineup = (details.lineup ?? []).filter((l) => l.name);
  const hasGoodToKnow = !!(details.dressCode || details.goodToKnow);
  const isCancelled = !!(liveEvent?.isCancelled ?? event.isCancelled);
  const liveTicketsAvailable = liveEvent?.ticketsAvailable ?? event.ticketsAvailable;
  const liveTicketsSold = liveEvent?.ticketsSold ?? event.ticketsSold;

  const { data: attendeesData } = useQuery<{ users: Array<{ id: string; username: string; displayName: string | null; avatarUrl: string | null }>; totalCount: number; interestedCount?: number }>({
    queryKey: ["/api/events", event.id, "attendees"],
    queryFn: async () => {
      const response = await fetch(`/api/events/${event.id}/attendees`);
      if (!response.ok) throw new Error("Failed to fetch attendees");
      return response.json();
    },
  });

  const hasRSVPed = rsvps?.some((rsvp: any) => rsvp.eventId === event.id);

  const purchaseTicketMutation = useMutation({
    mutationFn: async ({ tierId, quantity }: { tierId: string | undefined; quantity: number }) => {
      const response = await apiRequest("POST", "/api/payments/event/checkout", {
        eventId: event.id,
        ticketTierId: tierId,
        quantity,
      });
      return response.json();
    },
    onSuccess: (data: { url: string }) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (error: any) => {
      toast({ title: "Purchase Failed", description: error?.message || "Unable to process ticket purchase. Please try again.", variant: "destructive" });
      setIsProcessing(false);
    },
  });

  // Free events: RSVP books a free ticket. Paid / external events: RSVP is "interested" (no ticket).
  const interestOnly = event.ticketPrice > 0 || !!event.externalTicketUrl;

  const refreshRsvpData = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/rsvps"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/events", event.id, "attendees"] });
  };

  const rsvpMutation = useMutation({
    mutationFn: async () => {
      if (!currentUser) throw new Error("Sign in to RSVP");
      const res = await apiRequest("POST", "/api/rsvps", { eventId: event.id });
      return res.json();
    },
    onSuccess: () => {
      refreshRsvpData();
      if (interestOnly) {
        toast({ title: "Marked as interested", description: "The organiser can see you're interested." });
      } else {
        toast({ title: "RSVP confirmed!", description: "You're going. Your free ticket is in your wallet." });
      }
    },
    onError: (error: any) => {
      toast({ title: "Couldn't RSVP", description: error?.message || "Please try again.", variant: "destructive" });
    },
  });

  const cancelRsvpMutation = useMutation({
    mutationFn: async () => { await apiRequest("DELETE", `/api/rsvps/${event.id}`); },
    onSuccess: () => {
      refreshRsvpData();
      toast({ title: interestOnly ? "Removed interest" : "RSVP cancelled" });
    },
    onError: () => toast({ title: "Couldn't cancel", description: "Please try again.", variant: "destructive" }),
  });

  // ── Ticket selection ──────────────────────────────────────────────────────
  const isFreeEvent = event.ticketPrice === 0;
  const requiresRSVP = event.requiresRSVP;
  const hasExternalTickets = !!event.externalTicketUrl;
  const hasTiers = !!ticketTiers && ticketTiers.length > 0;

  // Tiered events track capacity per-tier (events.tickets_sold is only bumped for
  // tier-less events), so a flat event is presented as a single "General admission" row.
  const pickerTiers: PickerTier[] = hasTiers
    ? ticketTiers!
    : [{
        id: FLAT_TIER_ID,
        name: "General admission",
        priceSmallestUnit: event.ticketPrice,
        currency,
        quantity: liveTicketsAvailable,
        sold: liveTicketsSold,
      }];
  const availableTiers = pickerTiers.filter((t) => tierStatus(t).available);
  const salesDeadline = nextSalesDeadline(pickerTiers);
  const isSoldOut = !isLoadingTiers && availableTiers.length === 0;
  // Only one thing to buy → pre-select it so the buyer isn't asked to pick from a list of one.
  const effectiveTier = selectedTier ?? (availableTiers.length === 1 ? availableTiers[0].id : null);
  const selectedTierData = pickerTiers.find((t) => t.id === effectiveTier);
  const remainingForSelection = selectedTierData ? selectedTierData.quantity - selectedTierData.sold : 0;
  const maxQuantity = Math.max(1, Math.min(10, remainingForSelection));
  const safeQuantity = Math.min(quantity, maxQuantity);
  const unitPrice = selectedTierData?.priceSmallestUnit ?? 0;
  const lowestPrice = availableTiers.length ? Math.min(...availableTiers.map((t) => t.priceSmallestUnit)) : event.ticketPrice;

  const { data: quote } = useQuery<Quote>({
    queryKey: ["/api/events", event.id, "quote", effectiveTier, safeQuantity],
    queryFn: async () => {
      const qs = new URLSearchParams({ quantity: String(safeQuantity) });
      if (effectiveTier && effectiveTier !== FLAT_TIER_ID) qs.set("tierId", effectiveTier);
      const response = await fetch(`/api/events/${event.id}/quote?${qs}`);
      if (!response.ok) throw new Error("Failed to fetch quote");
      return response.json();
    },
    enabled: !isFreeEvent && !hasExternalTickets && !!effectiveTier,
    staleTime: 60_000,
  });

  const scrollToTickets = () => {
    trackEventClick(event.id);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ticketsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  const handleCheckout = () => {
    if (!effectiveTier) return scrollToTickets();
    trackEventClick(event.id);
    setIsProcessing(true);
    purchaseTicketMutation.mutate({
      tierId: effectiveTier === FLAT_TIER_ID ? undefined : effectiveTier,
      quantity: safeQuantity,
    });
  };

  const calendarEvent: CalendarEvent = {
    title: event.title,
    description: event.description,
    location: event.location,
    start: new Date(event.eventDate),
    end: event.eventEndDate ? new Date(event.eventEndDate) : null,
  };

  const status = statusOf(start, end, isCancelled);
  const longDescription = (event.description?.length ?? 0) > 280;
  const unlimitedSpots = liveTicketsAvailable >= UNLIMITED_SPOTS;
  const spotsLeft = Math.max(0, liveTicketsAvailable - liveTicketsSold);

  // ── Sticky action bar (always reachable; the page can be long on a phone) ──
  let summary: React.ReactNode;
  let action: React.ReactNode;
  const primary = "flex-1 sm:flex-none sm:min-w-[200px] min-h-[48px] rounded-full text-base active:scale-[0.97] transition-transform duration-150 ease-out";

  if (isCancelled) {
    summary = <span className="text-destructive font-medium">This event was cancelled</span>;
    action = <Button className={primary} disabled data-testid="button-purchase-ticket">Event cancelled</Button>;
  } else if (isEventEnded) {
    summary = <span className="text-muted-foreground">This event has ended</span>;
    action = <Button className={primary} disabled data-testid="button-purchase-ticket">Event ended</Button>;
  } else if (hasExternalTickets) {
    summary = <span className="text-muted-foreground">Tickets sold by the organiser</span>;
    action = (
      <Button className={primary} asChild data-testid="button-get-external-tickets">
        <a href={event.externalTicketUrl!} target="_blank" rel="noopener noreferrer" onClick={() => trackEventClick(event.id)}>
          <ExternalLinkIcon className="h-4 w-4 mr-2" />Get tickets
        </a>
      </Button>
    );
  } else if (isFreeEvent && hasRSVPed) {
    summary = (
      <span className="flex items-center gap-2 font-semibold">
        <CheckCircleIcon className="h-5 w-5 text-primary" />You're going
      </span>
    );
    action = (
      <Button
        variant="outline"
        className={primary}
        onClick={() => cancelRsvpMutation.mutate()}
        disabled={cancelRsvpMutation.isPending}
        data-testid="button-cancel-rsvp"
      >
        {cancelRsvpMutation.isPending ? "Cancelling…" : "Cancel RSVP"}
      </Button>
    );
  } else if (isFreeEvent) {
    summary = <span className="font-semibold">Free</span>;
    action = (
      <Button
        className={primary}
        onClick={() => { trackEventClick(event.id); rsvpMutation.mutate(); }}
        disabled={rsvpMutation.isPending || isLoadingRSVPs}
        data-testid="button-rsvp"
      >
        {isLoadingRSVPs ? "Loading…" : rsvpMutation.isPending ? "Processing…" : (
          <><CheckCircleIcon className="h-4 w-4 mr-2" />{requiresRSVP ? "RSVP for free" : "RSVP"}</>
        )}
      </Button>
    );
  } else if (isSoldOut) {
    summary = <span className="font-medium">Sold out</span>;
    action = <Button className={primary} disabled data-testid="button-purchase-ticket">Sold out</Button>;
  } else if (effectiveTier) {
    const total = quote?.total ?? unitPrice * safeQuantity;
    summary = (
      <span>
        <span className="block font-semibold tabular-nums">{formatPrice(total, currency)}</span>
        <span className="block text-xs text-muted-foreground">{safeQuantity} × {selectedTierData?.name}</span>
      </span>
    );
    action = (
      <Button className={primary} onClick={handleCheckout} disabled={isProcessing} data-testid="button-purchase-ticket">
        {isProcessing ? "Redirecting…" : <><TicketIcon className="h-4 w-4 mr-2" />Checkout</>}
      </Button>
    );
  } else {
    summary = (
      <span>
        <span className="block text-xs text-muted-foreground">From</span>
        <span className="block font-semibold tabular-nums">{formatPrice(lowestPrice, currency)}</span>
      </span>
    );
    action = (
      <Button className={primary} onClick={scrollToTickets} disabled={isLoadingTiers} data-testid="button-purchase-ticket">
        <TicketIcon className="h-4 w-4 mr-2" />Select tickets
      </Button>
    );
  }

  const iconBtn = "h-11 w-11 rounded-full bg-black/60 text-white flex items-center justify-center transition-[background-color,transform] duration-150 ease-out hover:bg-black/80 active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

  return (
    <>
      {/* Full-screen lightbox — portalled to body so it sits above Radix's stacking context */}
      {lightboxOpen && event.imageUrl && createPortal(
        <div
          // pointer-events-auto: Radix sets body{pointer-events:none} while the Dialog is
          // open, and this portal lives on body — without it nothing here is clickable.
          className="fixed inset-0 z-[9999] bg-black flex items-center justify-center pointer-events-auto"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-label="Full image view"
        >
          <button
            className="absolute top-4 right-4 text-white bg-white/20 hover:bg-white/40 rounded-full p-2.5 transition-colors"
            onClick={() => setLightboxOpen(false)}
            aria-label="Close image"
          >
            <XIcon className="h-6 w-6" />
          </button>
          <img
            src={event.imageUrl}
            alt={event.title}
            className="max-w-full max-h-screen object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body
      )}

      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent
          // Phone: full-height sheet. Desktop: centred dialog. The primitive's own close
          // button is hidden — our back/close control lives on the hero.
          className={[
            "p-0 gap-0 sm:max-w-2xl sm:max-h-[90vh] sm:rounded-2xl [&>button.absolute]:hidden",
            "max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:max-w-none max-sm:rounded-none",
            "max-sm:left-0 max-sm:top-0 max-sm:translate-x-0 max-sm:translate-y-0",
            "max-sm:data-[state=open]:slide-in-from-left-0 max-sm:data-[state=open]:slide-in-from-top-0",
            "max-sm:data-[state=closed]:slide-out-to-left-0 max-sm:data-[state=closed]:slide-out-to-top-0",
          ].join(" ")}
          data-testid="modal-event-details"
          onInteractOutside={(e) => { if (lightboxOpen) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (lightboxOpen) { e.preventDefault(); setLightboxOpen(false); } }}
        >
          <div className="relative">
            {/* Hero — full image uncropped over a soft copy of itself; tap to enlarge */}
            <div className="relative aspect-[16/10] sm:aspect-[16/8] bg-black overflow-hidden">
              {event.imageUrl ? (
                <>
                  <img src={event.imageUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover blur-[18px] scale-110 opacity-60" />
                  <button
                    type="button"
                    className="relative block h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                    onClick={() => setLightboxOpen(true)}
                    aria-label="View full image"
                  >
                    <img src={event.imageUrl} alt={event.title} className="h-full w-full object-contain" />
                  </button>
                </>
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <CalendarIcon className="h-10 w-10 opacity-40" />
                </div>
              )}
              <div className="absolute inset-x-3 top-3 flex items-center justify-between">
                <button type="button" className={iconBtn} onClick={onClose} aria-label="Close" data-testid="button-close-modal">
                  <ArrowLeftIcon className="h-5 w-5 sm:hidden" />
                  <XIcon className="h-5 w-5 hidden sm:block" />
                </button>
                <button type="button" className={iconBtn} onClick={() => { trackEventClick(event.id); setShareOpen(true); }} aria-label="Share event" data-testid="button-share">
                  <Share2Icon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="px-5 pt-5 pb-6 space-y-6">
              {isCancelled && (
                <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5">
                  <AlertTriangleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm">
                    <span className="font-semibold">This event has been cancelled.</span>{" "}
                    <span className="text-muted-foreground">Ticket holders are being refunded.</span>
                  </p>
                </div>
              )}

              {/* Title block */}
              <DialogHeader {...rise(0)} className={`${rise(0).className} space-y-2 text-left`}>
                <Eyebrow>
                  <span data-testid="modal-event-category">{event.category}</span>
                  {" · "}
                  <span className={status.tone}>{status.label}</span>
                </Eyebrow>
                <DialogTitle className="font-serif text-3xl leading-[1.05] tracking-tight" data-testid="modal-event-title">
                  {event.title}
                </DialogTitle>
                <DialogDescription className="sr-only">{event.description?.slice(0, 120)}</DialogDescription>
              </DialogHeader>

              {hasTicket && !isCancelled && (
                <div {...rise(1)} className={`${rise(1).className} flex items-center justify-between gap-3 rounded-xl bg-primary/10 p-3.5`}>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircleIcon className="h-5 w-5 text-primary" />You're going
                  </p>
                  <Button size="sm" variant="outline" className="rounded-full min-h-[44px] active:scale-[0.97] transition-transform" onClick={() => navigate("/ticket-wallet")}>
                    View ticket
                  </Button>
                </div>
              )}

              {/* Key facts */}
              <div {...rise(2)} className={`${rise(2).className} space-y-4`}>
                <div className="flex items-start gap-3">
                  <CalendarIcon className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div>
                      <p className="font-medium" data-testid="modal-event-date">{format(new Date(event.eventDate), "EEEE, d MMMM yyyy")}</p>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(event.eventDate), "h:mm a")}
                        {event.eventEndDate && ` – ${format(new Date(event.eventEndDate), "h:mm a")}`}
                      </p>
                    </div>
                  </div>
                  {!isEventEnded && !isCancelled && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="rounded-full min-h-[44px] gap-1 flex-shrink-0 active:scale-[0.97] transition-transform" aria-label="Add to calendar">
                          Add <ChevronDownIcon className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <a href={googleCalendarUrl(calendarEvent)} target="_blank" rel="noopener noreferrer" onClick={() => trackEventClick(event.id)}>Google Calendar</a>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => { trackEventClick(event.id); downloadIcs(calendarEvent); }}>Apple / Outlook (.ics)</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>

                <div className="flex items-start gap-3">
                  <MapPinIcon className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div>
                      <p className="font-medium break-words" data-testid="modal-event-location">{details.venueName || event.location}</p>
                      {details.venueName ? (
                        <p className="text-sm text-muted-foreground break-words">{event.location}</p>
                      ) : (
                        event.city && !event.location.includes(event.city) && (
                          <p className="text-sm text-muted-foreground">{event.city}</p>
                        )
                      )}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="rounded-full min-h-[44px] flex-shrink-0 active:scale-[0.97] transition-transform" asChild>
                    <a href={directionsUrl(event.location, event.latitude, event.longitude)} target="_blank" rel="noopener noreferrer" aria-label="Get directions" onClick={() => trackEventClick(event.id)}>
                      Directions
                    </a>
                  </Button>
                </div>

                {details.doorsOpenAt && (
                  <div className="flex items-start gap-3" data-testid="modal-event-doors">
                    <ClockIcon className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <p className="font-medium">Doors open {format(new Date(details.doorsOpenAt), "h:mm a")}</p>
                  </div>
                )}

                {(details.ageRestriction !== "all" || details.parentalGuidance === "advised") && (
                  <div className="flex items-start gap-3" data-testid="modal-event-age">
                    <InfoIcon className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <p className="font-medium">
                      {details.ageRestriction !== "all" ? `${details.ageRestriction} only` : "All ages"}
                      {details.parentalGuidance === "advised" && (
                        <span className="font-normal text-muted-foreground"> · Parental guidance advised</span>
                      )}
                    </p>
                  </div>
                )}

                {!!attendeesData?.totalCount && (
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2 flex-shrink-0">
                      {attendeesData.users.slice(0, 5).map((u) => (
                        <Avatar key={u.id} className="h-7 w-7 border-2 border-background" data-testid={`avatar-attendee-${u.id}`}>
                          <AvatarImage src={u.avatarUrl || ""} alt={u.displayName || u.username} />
                          <AvatarFallback className="text-[10px]">{(u.displayName || u.username)[0]?.toUpperCase()}</AvatarFallback>
                        </Avatar>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid="modal-event-attendees">
                      {attendeesData.totalCount} {attendeesData.totalCount === 1 ? "person" : "people"} going
                    </p>
                  </div>
                )}

                {isFreeEvent && !unlimitedSpots && !isCancelled && (
                  <p className="text-sm text-muted-foreground" data-testid="modal-event-tickets-available">
                    {spotsLeft === 0 ? "No spots left" : `${spotsLeft} of ${liveTicketsAvailable} spots left`}
                  </p>
                )}
              </div>

              {interestOnly && !isEventEnded && !isCancelled && (
                <div className="flex items-center gap-3" data-testid="modal-event-interested">
                  <Button
                    type="button"
                    variant={hasRSVPed ? "default" : "outline"}
                    className="rounded-full min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out"
                    aria-pressed={!!hasRSVPed}
                    disabled={rsvpMutation.isPending || cancelRsvpMutation.isPending || isLoadingRSVPs}
                    onClick={() => {
                      if (hasRSVPed) return cancelRsvpMutation.mutate();
                      trackEventClick(event.id);
                      rsvpMutation.mutate();
                    }}
                    data-testid="button-rsvp"
                  >
                    {hasRSVPed && <CheckCircleIcon className="h-4 w-4 mr-2" />}
                    {hasRSVPed ? "Interested" : "I'm interested"}
                  </Button>
                  {!!attendeesData?.interestedCount && (
                    <span className="text-sm text-muted-foreground">
                      {attendeesData.interestedCount} interested
                    </span>
                  )}
                </div>
              )}

              {organizer && (
                <div {...rise(3)} className={rise(3).className}>
                  <OrganizerRow organizer={organizer} currentUserId={currentUser?.id} onNavigate={onClose} />
                </div>
              )}

              {/* Tickets */}
              {!isFreeEvent && !hasExternalTickets && !isCancelled && !isEventEnded && (
                <section ref={ticketsRef} aria-labelledby="tickets-heading" className="scroll-mt-4 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 id="tickets-heading" className="text-sm font-semibold">Tickets</h3>
                    {salesDeadline && (
                      <p
                        className={`text-xs text-right ${salesDeadline.days <= 3 ? "text-amber-500 font-medium" : "text-muted-foreground"}`}
                        data-testid="modal-sales-end"
                      >
                        Sales end {format(salesDeadline.date, "EEE d MMM")} · {daysLeftLabel(salesDeadline.days)}
                      </p>
                    )}
                  </div>
                  {isLoadingTiers ? (
                    <p className="text-sm text-muted-foreground">Loading ticket options…</p>
                  ) : (
                    <TicketPicker
                      tiers={pickerTiers}
                      currency={currency}
                      selectedTier={effectiveTier}
                      onSelectTier={(id) => { setSelectedTier(id); setQuantity(1); }}
                      quantity={safeQuantity}
                      onQuantity={setQuantity}
                      maxQuantity={maxQuantity}
                      quote={quote}
                      fallbackTotal={unitPrice * safeQuantity}
                    />
                  )}
                </section>
              )}

              {communityData && (
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className="flex items-center gap-3 min-w-0 text-left rounded-lg -m-1 p-1 transition-[background-color,transform] duration-150 ease-out hover:bg-muted/50 active:scale-[0.98]"
                    onClick={() => { onClose(); navigate(`/community/${(communityData as any).slug ?? communityData.id}`); }}
                  >
                    <UsersIcon className="h-5 w-5 text-primary flex-shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{communityData.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {communityData.memberCount.toLocaleString()} {communityData.memberCount === 1 ? "member" : "members"}
                      </span>
                    </span>
                  </button>
                  {currentUser && (
                    communityMembership?.isMember ? (
                      <Button variant="outline" size="sm" className="rounded-full min-h-[44px] flex-shrink-0" onClick={() => leaveCommunityMutation.mutate()} disabled={leaveCommunityMutation.isPending}>
                        {leaveCommunityMutation.isPending ? "Leaving…" : "Leave"}
                      </Button>
                    ) : (
                      <Button size="sm" className="rounded-full min-h-[44px] flex-shrink-0" onClick={() => joinCommunityMutation.mutate()} disabled={joinCommunityMutation.isPending}>
                        {joinCommunityMutation.isPending ? "Joining…" : "Join"}
                      </Button>
                    )
                  )}
                </div>
              )}

              {/* About */}
              <section aria-labelledby="about-heading">
                <h3 id="about-heading" className="text-sm font-semibold mb-1.5">About this event</h3>
                <p
                  className={`text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap max-w-[68ch] ${longDescription && !descExpanded ? "line-clamp-4" : ""}`}
                  data-testid="modal-event-description"
                >
                  {event.description}
                </p>
                {longDescription && (
                  <button
                    type="button"
                    className="mt-1 min-h-[44px] text-sm font-medium text-primary hover:underline"
                    onClick={() => setDescExpanded((v) => !v)}
                    aria-expanded={descExpanded}
                  >
                    {descExpanded ? "Show less" : "Show more"}
                  </button>
                )}
              </section>

              {lineup.length > 0 && (
                <section aria-labelledby="lineup-heading" data-testid="modal-event-lineup">
                  <h3 id="lineup-heading" className="text-sm font-semibold mb-2">Line-up</h3>
                  <ul className="divide-y">
                    {lineup.map((act, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
                        <span className="font-medium break-words">{act.name}</span>
                        {act.time && <span className="text-muted-foreground tabular-nums flex-shrink-0">{act.time}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {hasGoodToKnow && (
                <section aria-labelledby="gtk-heading" className="space-y-2" data-testid="modal-event-good-to-know">
                  <h3 id="gtk-heading" className="text-sm font-semibold">Good to know</h3>
                  {details.dressCode && (
                    <p className="text-sm"><span className="text-muted-foreground">Dress code · </span>{details.dressCode}</p>
                  )}
                  {details.goodToKnow && (
                    <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap max-w-[68ch]">{details.goodToKnow}</p>
                  )}
                </section>
              )}

              {details.refundPolicy && (
                <section aria-labelledby="refund-heading" data-testid="modal-event-refund-policy">
                  <h3 id="refund-heading" className="text-sm font-semibold mb-1.5">Refund policy</h3>
                  <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap max-w-[68ch]">{details.refundPolicy}</p>
                </section>
              )}

              {isEventEnded && (
                <section aria-labelledby="ratings-heading">
                  <div className="flex items-center justify-between mb-2">
                    <h3 id="ratings-heading" className="text-sm font-semibold">Ratings</h3>
                    <RatingDisplay averageRating={eventRatingStats?.averageRating} totalRatings={eventRatingStats?.totalRatings ?? 0} size="sm" />
                  </div>

                  {!currentUser ? (
                    <p className="text-xs text-muted-foreground">Sign in to rate this event.</p>
                  ) : userEventRating?.hasRated && !isEditingRating ? (
                    <div className="flex items-center justify-between gap-3 p-3 rounded-xl border bg-muted/30">
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1">Your rating: {userEventRating.rating} ★</p>
                        {userEventRating.reviewText && <p className="text-xs text-muted-foreground mt-1">{userEventRating.reviewText}</p>}
                      </div>
                      <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => setIsEditingRating(true)} data-testid="button-edit-rating">
                        Edit
                      </Button>
                    </div>
                  ) : (
                    <RatingInput
                      label={userEventRating?.hasRated ? "Update your rating" : "Rate this event"}
                      initialRating={userEventRating?.rating ?? 0}
                      initialReviewText={userEventRating?.reviewText}
                      submitLabel={userEventRating?.hasRated ? "Update rating" : "Submit rating"}
                      isPending={submitEventRating.isPending}
                      errorMessage={submitEventRating.isError ? (submitEventRating.error as any)?.message ?? "Failed to submit rating" : null}
                      onCancel={userEventRating?.hasRated ? () => setIsEditingRating(false) : undefined}
                      onSubmit={(rating, reviewText) => {
                        submitEventRating.mutate({ rating, reviewText }, { onSuccess: () => setIsEditingRating(false) });
                      }}
                    />
                  )}
                </section>
              )}

              <SimilarEvents event={event} />
            </div>

            {/* Sticky action bar — stays reachable however long the page is */}
            <div className="sticky bottom-0 z-10 flex items-center gap-4 border-t bg-background px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="min-w-0 text-sm" data-testid="modal-event-price">{summary}</div>
              <div className="ml-auto flex flex-1 sm:flex-none justify-end">{action}</div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <UnifiedShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        shareData={{ type: "event", id: event.id, title: event.title, imageUrl: event.imageUrl }}
      />
    </>
  );
}
