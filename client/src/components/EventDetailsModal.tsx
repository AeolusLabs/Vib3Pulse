import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Calendar, MapPin, Users, Ticket, CheckCircle, Minus, Plus, ExternalLink, Share2 } from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Event } from "@shared/schema";
import { Card } from "@/components/ui/card";

interface EventDetailsModalProps {
  event: Event;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCurrencySymbol(code?: string | null): string {
  const map: Record<string, string> = {
    GBP: "£", USD: "$", EUR: "€", NGN: "₦", CAD: "C$", AUD: "A$", ZAR: "R", GHS: "₵",
  };
  return map[code ?? "GBP"] ?? "£";
}

function formatPrice(smallest: number, currency?: string | null): string {
  return `${getCurrencySymbol(currency)}${(smallest / 100).toFixed(2)}`;
}

function EventStatusBadge({ eventDate, eventEndDate }: { eventDate: string | Date; eventEndDate?: string | Date | null }) {
  const now = Date.now();
  const start = new Date(eventDate).getTime();
  const end = eventEndDate ? new Date(eventEndDate).getTime() : start + 3 * 60 * 60 * 1000; // assume 3h if no end date

  if (now < start) return <Badge variant="outline" className="text-blue-500 border-blue-500">Upcoming</Badge>;
  if (now >= start && now <= end) return <Badge className="bg-green-600">Live Now</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Ended</Badge>;
}

export default function EventDetailsModal({ event, onClose }: EventDetailsModalProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  const [showTierSelection, setShowTierSelection] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  const currency = (event as any).currency as string | undefined;

  const { data: rsvps, isLoading: isLoadingRSVPs } = useQuery({
    queryKey: ["/api/rsvps"],
    queryFn: async () => {
      const response = await fetch("/api/rsvps", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch RSVPs");
      return response.json();
    },
  });

  const { data: ticketTiers, isLoading: isLoadingTiers } = useQuery({
    queryKey: ["/api/events", event.id, "ticket-tiers"],
    queryFn: async () => {
      const response = await fetch(`/api/events/${event.id}/ticket-tiers`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch ticket tiers");
      return response.json();
    },
  });

  const hasRSVPed = rsvps?.some((rsvp: any) => rsvp.eventId === event.id);

  const purchaseTicketMutation = useMutation({
    mutationFn: async ({ tierId, qty }: { tierId: string; qty: number }) => {
      const response = await apiRequest("POST", "/api/tickets/purchase", {
        eventId: event.id,
        tierId,
        quantity: qty,
      });
      return response.json();
    },
    onSuccess: (data: { url: string }) => {
      if (data.url) window.location.href = data.url;
    },
    onError: () => {
      toast({ title: "Purchase Failed", description: "Unable to process ticket purchase. Please try again.", variant: "destructive" });
      setIsProcessing(false);
    },
  });

  const rsvpMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/rsvps", { eventId: event.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rsvps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      toast({ title: "RSVP Confirmed!", description: "You've successfully RSVP'd to this event." });
      onClose();
    },
    onError: () => {
      toast({ title: "RSVP Failed", description: "Unable to RSVP. You may have already RSVP'd.", variant: "destructive" });
    },
  });

  const handlePurchaseTicket = () => {
    setShowTierSelection(true);
  };

  const handleConfirmPurchase = () => {
    if (!selectedTier) return;
    setIsProcessing(true);
    purchaseTicketMutation.mutate({ tierId: selectedTier, qty: quantity });
  };

  const incrementQuantity = () => {
    const max = ticketTiers?.find((t: any) => t.id === selectedTier)?.quantity || 0;
    if (quantity < max) setQuantity(quantity + 1);
  };

  const decrementQuantity = () => {
    if (quantity > 1) setQuantity(quantity - 1);
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/event/${event.id}`;
    const shareData = { title: event.title, text: `Check out ${event.title} on Vib3Pulse`, url };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "Link copied!", description: "Event link copied to clipboard." });
      }
    } catch {
      // User cancelled share — ignore
    }
  };

  const isFreeEvent = event.ticketPrice === 0;
  const requiresRSVP = event.requiresRSVP;
  const hasExternalTickets = !!event.externalTicketUrl;

  return (
    <>
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0" data-testid="modal-event-details">
          {/* Hero image — full bleed, no padding */}
          {event.imageUrl && (
            <div className="aspect-video w-full overflow-hidden rounded-t-lg flex-shrink-0">
              <img
                src={event.imageUrl}
                alt={event.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          {/* Main content */}
          <div className="p-5 space-y-4">
            {/* Title row */}
            <DialogHeader>
              <div className="flex items-start justify-between gap-3">
                <DialogTitle className="text-xl leading-snug" data-testid="modal-event-title">
                  {event.title}
                </DialogTitle>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <Badge variant="secondary" data-testid="modal-event-category">{event.category}</Badge>
                  <EventStatusBadge eventDate={event.eventDate} eventEndDate={event.eventEndDate} />
                </div>
              </div>
              <DialogDescription className="sr-only">{event.description?.slice(0, 120)}</DialogDescription>
            </DialogHeader>

            {/* Details */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="font-medium text-sm" data-testid="modal-event-date">
                    {format(new Date(event.eventDate), "EEEE, MMMM d, yyyy")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(event.eventDate), "h:mm a")}
                    {event.eventEndDate && ` — ${format(new Date(event.eventEndDate), "h:mm a")}`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="text-sm" data-testid="modal-event-location">{event.location}</p>
              </div>

              <div className="flex items-center gap-3">
                <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="text-sm" data-testid="modal-event-tickets-available">
                  {event.ticketsAvailable} tickets available
                </p>
              </div>

              {/* Ticket pricing */}
              {hasExternalTickets ? (
                <div className="flex items-center gap-3">
                  <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Badge variant="default" className="bg-blue-500" data-testid="modal-event-price">External Tickets</Badge>
                </div>
              ) : isFreeEvent ? (
                <div className="flex items-center gap-3">
                  <Ticket className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Badge variant="default" className="bg-green-600" data-testid="modal-event-price">Free Event</Badge>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Ticket className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <p className="text-sm font-semibold">Ticket Options</p>
                  </div>
                  {isLoadingTiers ? (
                    <p className="text-xs text-muted-foreground ml-7">Loading ticket options…</p>
                  ) : ticketTiers && ticketTiers.length > 0 ? (
                    <div className="ml-7 space-y-2" data-testid="ticket-tiers-list">
                      {ticketTiers.map((tier: any, index: number) => (
                        <div
                          key={tier.id}
                          className="flex items-center justify-between p-3 rounded-md border"
                          data-testid={`ticket-tier-${index}`}
                        >
                          <div>
                            <p className="text-sm font-medium" data-testid={`tier-name-${index}`}>{tier.name}</p>
                            <p className="text-xs text-muted-foreground">{tier.quantity} available</p>
                          </div>
                          <p className="font-semibold" data-testid={`tier-price-${index}`}>
                            {formatPrice(tier.priceSmallestUnit, tier.currency ?? currency)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground ml-7" data-testid="modal-event-price">
                      {formatPrice(event.ticketPrice, currency)}
                    </p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* About */}
            <div>
              <h3 className="text-sm font-semibold mb-1.5">About This Event</h3>
              <DialogDescription className="text-sm whitespace-pre-wrap text-foreground/80" data-testid="modal-event-description">
                {event.description}
              </DialogDescription>
            </div>

            <Separator />

            {/* Actions — stack on mobile, row on sm+ */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {hasExternalTickets ? (
                <Button className="flex-1" asChild data-testid="button-get-external-tickets">
                  <a href={event.externalTicketUrl!} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Get Tickets
                  </a>
                </Button>
              ) : isFreeEvent && requiresRSVP ? (
                <Button
                  className="flex-1"
                  onClick={() => rsvpMutation.mutate()}
                  disabled={rsvpMutation.isPending || hasRSVPed || isLoadingRSVPs}
                  data-testid="button-rsvp"
                >
                  {isLoadingRSVPs ? "Loading…" : hasRSVPed ? (
                    <><CheckCircle className="h-4 w-4 mr-2" />Already RSVP'd</>
                  ) : rsvpMutation.isPending ? "Processing…" : (
                    <><CheckCircle className="h-4 w-4 mr-2" />RSVP for Free</>
                  )}
                </Button>
              ) : !isFreeEvent ? (
                <Button
                  className="flex-1"
                  onClick={handlePurchaseTicket}
                  disabled={isProcessing || event.ticketsAvailable === 0}
                  data-testid="button-purchase-ticket"
                >
                  {isProcessing ? "Redirecting…" : event.ticketsAvailable === 0 ? "Sold Out" : (
                    <><Ticket className="h-4 w-4 mr-2" />Purchase Ticket</>
                  )}
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  onClick={() => rsvpMutation.mutate()}
                  disabled={rsvpMutation.isPending || hasRSVPed || isLoadingRSVPs}
                  data-testid="button-rsvp"
                >
                  {isLoadingRSVPs ? "Loading…" : hasRSVPed ? "Already RSVP'd" : rsvpMutation.isPending ? "Processing…" : "RSVP (No ticket required)"}
                </Button>
              )}

              <Button variant="outline" size="icon" onClick={handleShare} data-testid="button-share">
                <Share2 className="h-4 w-4" />
              </Button>

              <Button variant="outline" onClick={onClose} data-testid="button-close-modal">
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Tier selection modal */}
      <Dialog open={showTierSelection} onOpenChange={setShowTierSelection}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-tier-selection">
          <DialogHeader>
            <DialogTitle>Select Ticket Tier</DialogTitle>
            <DialogDescription>
              Choose your ticket type and quantity for {event.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {isLoadingTiers ? (
              <p className="text-sm text-muted-foreground">Loading ticket options…</p>
            ) : ticketTiers && ticketTiers.length > 0 ? (
              <div className="space-y-3">
                {ticketTiers.map((tier: any) => (
                  <Card
                    key={tier.id}
                    className={`p-4 cursor-pointer transition-all hover-elevate ${
                      selectedTier === tier.id ? "border-primary bg-primary/5" : "border-border"
                    }`}
                    onClick={() => { setSelectedTier(tier.id); setQuantity(1); }}
                    data-testid={`tier-option-${tier.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h4 className="font-semibold text-sm" data-testid={`tier-option-name-${tier.id}`}>{tier.name}</h4>
                        <p className="text-xs text-muted-foreground">{tier.quantity} available</p>
                      </div>
                      <p className="text-base font-bold" data-testid={`tier-option-price-${tier.id}`}>
                        {formatPrice(tier.priceSmallestUnit, tier.currency ?? currency)}
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No ticket tiers available.</p>
            )}

            {selectedTier && (
              <div className="pt-4 border-t space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Quantity</label>
                  <div className="flex items-center gap-3">
                    <Button variant="outline" size="icon" onClick={decrementQuantity} disabled={quantity <= 1} data-testid="button-decrease-quantity">
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="text-lg font-semibold w-10 text-center" data-testid="text-quantity">{quantity}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={incrementQuantity}
                      disabled={quantity >= (ticketTiers?.find((t: any) => t.id === selectedTier)?.quantity || 0)}
                      data-testid="button-increase-quantity"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between text-base font-semibold border-t pt-3">
                  <span>Total:</span>
                  <span data-testid="text-total-price">
                    {formatPrice(
                      (ticketTiers?.find((t: any) => t.id === selectedTier)?.priceSmallestUnit || 0) * quantity,
                      ticketTiers?.find((t: any) => t.id === selectedTier)?.currency ?? currency
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setShowTierSelection(false)} className="flex-1" data-testid="button-cancel-tier-selection">
              Cancel
            </Button>
            <Button onClick={handleConfirmPurchase} disabled={!selectedTier} className="flex-1" data-testid="button-confirm-purchase">
              Continue to Checkout
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
