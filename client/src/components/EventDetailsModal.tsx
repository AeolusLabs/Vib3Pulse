import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Calendar, MapPin, Users, Ticket, CheckCircle, Minus, Plus, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Event } from "@shared/schema";
import { Card } from "@/components/ui/card";

interface EventDetailsModalProps {
  event: Event;
  onClose: () => void;
}

export default function EventDetailsModal({ event, onClose }: EventDetailsModalProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  const [showTierSelection, setShowTierSelection] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  const { data: rsvps, isLoading: isLoadingRSVPs } = useQuery({
    queryKey: ["/api/rsvps"],
    queryFn: async () => {
      const response = await fetch("/api/rsvps", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch RSVPs");
      }
      return response.json();
    },
  });

  const { data: ticketTiers, isLoading: isLoadingTiers } = useQuery({
    queryKey: ["/api/events", event.id, "ticket-tiers"],
    queryFn: async () => {
      const response = await fetch(`/api/events/${event.id}/ticket-tiers`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch ticket tiers");
      }
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
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: () => {
      toast({
        title: "Purchase Failed",
        description: "Unable to process ticket purchase. Please try again.",
        variant: "destructive",
      });
      setIsProcessing(false);
    },
  });

  const rsvpMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/rsvps", {
        eventId: event.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rsvps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      toast({
        title: "RSVP Confirmed!",
        description: "You've successfully RSVP'd to this event.",
      });
      onClose();
    },
    onError: () => {
      toast({
        title: "RSVP Failed",
        description: "Unable to RSVP. You may have already RSVP'd to this event.",
        variant: "destructive",
      });
    },
  });

  const handlePurchaseTicket = () => {
    // Show tier selection modal instead of directly purchasing
    setShowTierSelection(true);
  };

  const handleConfirmPurchase = () => {
    if (!selectedTier) {
      toast({
        title: "Please select a ticket tier",
        description: "Choose a ticket option to continue.",
        variant: "destructive",
      });
      return;
    }
    setIsProcessing(true);
    setShowTierSelection(false);
    purchaseTicketMutation.mutate({ tierId: selectedTier, qty: quantity });
  };

  const incrementQuantity = () => {
    const tier = ticketTiers?.find((t: any) => t.id === selectedTier);
    if (tier && quantity < tier.quantity) {
      setQuantity(quantity + 1);
    }
  };

  const decrementQuantity = () => {
    if (quantity > 1) {
      setQuantity(quantity - 1);
    }
  };

  const handleRSVP = () => {
    rsvpMutation.mutate();
  };

  const isFreeEvent = event.ticketPrice === 0;
  const requiresRSVP = event.requiresRSVP;
  const hasExternalTickets = !!event.externalTicketUrl;

  return (
    <>
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0" data-testid="modal-event-details">
        {event.imageUrl && (
          <div className="aspect-video w-full overflow-hidden rounded-t-lg">
            <img 
              src={event.imageUrl} 
              alt={event.title}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className="p-6 bg-[#000000fa]">
          <DialogHeader className="mb-4">
            <div className="flex items-start justify-between gap-4">
              <DialogTitle className="text-2xl" data-testid="modal-event-title">{event.title}</DialogTitle>
              <Badge variant="secondary" data-testid="modal-event-category">{event.category}</Badge>
            </div>
          </DialogHeader>

          <div className="space-y-4">
          <div className="grid gap-3">
            <div className="flex items-center gap-3">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium" data-testid="modal-event-date">
                  {format(new Date(event.eventDate), "EEEE, MMMM d, yyyy")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(event.eventDate), "h:mm a")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <p data-testid="modal-event-location">{event.location}</p>
            </div>

            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-muted-foreground" />
              <p data-testid="modal-event-tickets-available">
                {event.ticketsAvailable} tickets available
              </p>
            </div>

            {hasExternalTickets ? (
              <div className="flex items-center gap-3">
                <ExternalLink className="h-5 w-5 text-muted-foreground" />
                <Badge variant="default" className="bg-blue-500 text-base" data-testid="modal-event-price">External</Badge>
              </div>
            ) : isFreeEvent ? (
              <div className="flex items-center gap-3">
                <Ticket className="h-5 w-5 text-muted-foreground" />
                <Badge variant="default" className="text-base" data-testid="modal-event-price">Free Event</Badge>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Ticket className="h-5 w-5 text-muted-foreground" />
                  <p className="font-semibold">Ticket Options</p>
                </div>
                {isLoadingTiers ? (
                  <p className="text-sm text-muted-foreground ml-8">Loading ticket options...</p>
                ) : ticketTiers && ticketTiers.length > 0 ? (
                  <div className="ml-8 space-y-2" data-testid="ticket-tiers-list">
                    {ticketTiers.map((tier: any, index: number) => (
                      <div key={tier.id} className="flex items-center justify-between p-3 rounded-md border" data-testid={`ticket-tier-${index}`}>
                        <div>
                          <p className="font-medium" data-testid={`tier-name-${index}`}>{tier.name}</p>
                          <p className="text-sm text-muted-foreground">{tier.quantity} available</p>
                        </div>
                        <p className="font-semibold text-lg" data-testid={`tier-price-${index}`}>
                          £{(tier.priceCents / 100).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground ml-8" data-testid="modal-event-price">
                    £{(event.ticketPrice / 100).toFixed(2)}
                  </p>
                )}
              </div>
            )}
          </div>

          <Separator />

          <div>
            <h3 className="font-semibold mb-2">About This Event</h3>
            <DialogDescription className="text-base whitespace-pre-wrap" data-testid="modal-event-description">
              {event.description}
            </DialogDescription>
          </div>

          <Separator />

          {event.externalTicketUrl && (
            <div className="flex items-center gap-2 p-3 rounded-md border bg-muted/50">
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium">External Tickets Available</p>
                <p className="text-xs text-muted-foreground">Tickets are sold on an external platform</p>
              </div>
              <Button size="sm" asChild data-testid="button-external-tickets-modal">
                <a href={event.externalTicketUrl} target="_blank" rel="noopener noreferrer">
                  Get Tickets
                </a>
              </Button>
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-2">
            {hasExternalTickets ? (
              <Button
                className="flex-1"
                asChild
                data-testid="button-get-external-tickets"
              >
                <a href={event.externalTicketUrl!} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Get Tickets
                </a>
              </Button>
            ) : isFreeEvent && requiresRSVP ? (
              <Button
                className="flex-1"
                onClick={handleRSVP}
                disabled={rsvpMutation.isPending || hasRSVPed || isLoadingRSVPs}
                data-testid="button-rsvp"
              >
                {isLoadingRSVPs ? (
                  "Loading..."
                ) : hasRSVPed ? (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Already RSVP'd
                  </>
                ) : rsvpMutation.isPending ? (
                  "Processing..."
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    RSVP for Free
                  </>
                )}
              </Button>
            ) : !isFreeEvent ? (
              <Button
                className="flex-1"
                onClick={handlePurchaseTicket}
                disabled={isProcessing || event.ticketsAvailable === 0}
                data-testid="button-purchase-ticket"
              >
                {isProcessing ? (
                  "Redirecting to checkout..."
                ) : event.ticketsAvailable === 0 ? (
                  "Sold Out"
                ) : (
                  <>
                    <Ticket className="h-4 w-4 mr-2" />
                    Purchase Ticket
                  </>
                )}
              </Button>
            ) : (
              <Button
                className="flex-1"
                onClick={handleRSVP}
                disabled={rsvpMutation.isPending || hasRSVPed || isLoadingRSVPs}
                data-testid="button-rsvp"
              >
                {isLoadingRSVPs ? (
                  "Loading..."
                ) : hasRSVPed ? (
                  "Already RSVP'd"
                ) : rsvpMutation.isPending ? (
                  "Processing..."
                ) : (
                  "RSVP (No ticket required)"
                )}
              </Button>
            )}
            
            <Button
              variant="outline"
              onClick={onClose}
              data-testid="button-close-modal"
            >
              Close
            </Button>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Ticket Tier Selection Modal */}
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
            <p className="text-sm text-muted-foreground">Loading ticket options...</p>
          ) : ticketTiers && ticketTiers.length > 0 ? (
            <div className="space-y-3">
              {ticketTiers.map((tier: any) => (
                <Card
                  key={tier.id}
                  className={`p-4 cursor-pointer transition-all hover-elevate ${
                    selectedTier === tier.id
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  }`}
                  onClick={() => {
                    setSelectedTier(tier.id);
                    setQuantity(1);
                  }}
                  data-testid={`tier-option-${tier.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h4 className="font-semibold" data-testid={`tier-option-name-${tier.id}`}>
                        {tier.name}
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        {tier.quantity} available
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold" data-testid={`tier-option-price-${tier.id}`}>
                        £{(tier.priceCents / 100).toFixed(2)}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No ticket tiers available.</p>
          )}

          {selectedTier && (
            <div className="pt-4 border-t">
              <label className="text-sm font-medium mb-2 block">Quantity</label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={decrementQuantity}
                  disabled={quantity <= 1}
                  data-testid="button-decrease-quantity"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="text-lg font-semibold w-12 text-center" data-testid="text-quantity">
                  {quantity}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={incrementQuantity}
                  disabled={
                    quantity >= (ticketTiers?.find((t: any) => t.id === selectedTier)?.quantity || 0)
                  }
                  data-testid="button-increase-quantity"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {selectedTier && (
            <div className="pt-2 border-t">
              <div className="flex items-center justify-between text-lg font-semibold">
                <span>Total:</span>
                <span data-testid="text-total-price">
                  £{(
                    ((ticketTiers?.find((t: any) => t.id === selectedTier)?.priceCents || 0) / 100) *
                    quantity
                  ).toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => setShowTierSelection(false)}
            className="flex-1"
            data-testid="button-cancel-tier-selection"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmPurchase}
            disabled={!selectedTier}
            className="flex-1"
            data-testid="button-confirm-purchase"
          >
            Continue to Checkout
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
