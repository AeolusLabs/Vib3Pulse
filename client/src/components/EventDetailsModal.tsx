import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Calendar, MapPin, Users, Ticket, CheckCircle } from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Event } from "@shared/schema";

interface EventDetailsModalProps {
  event: Event;
  onClose: () => void;
}

export default function EventDetailsModal({ event, onClose }: EventDetailsModalProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);

  const { data: rsvps, isLoading: isLoadingRSVPs } = useQuery({
    queryKey: ["/api/rsvps", "mock-user-id"],
    queryFn: async () => {
      const response = await fetch(`/api/rsvps?userId=mock-user-id`);
      return response.json();
    },
  });

  const hasRSVPed = rsvps?.some((rsvp: any) => rsvp.eventId === event.id);

  const purchaseTicketMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/tickets/purchase", {
        eventId: event.id,
        userId: "mock-user-id",
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
        userId: "mock-user-id",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rsvps", "mock-user-id"] });
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
    setIsProcessing(true);
    purchaseTicketMutation.mutate();
  };

  const handleRSVP = () => {
    rsvpMutation.mutate();
  };

  const isFreeEvent = event.ticketPrice === 0;
  const requiresRSVP = event.requiresRSVP;

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="modal-event-details">
        {event.imageUrl && (
          <div className="aspect-video w-full overflow-hidden rounded-md -mt-6 -mx-6 mb-4">
            <img 
              src={event.imageUrl} 
              alt={event.title}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <DialogHeader>
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

            <div className="flex items-center gap-3">
              <Ticket className="h-5 w-5 text-muted-foreground" />
              {isFreeEvent ? (
                <Badge variant="default" className="text-base" data-testid="modal-event-price">Free Event</Badge>
              ) : (
                <p className="font-semibold text-xl" data-testid="modal-event-price">
                  ${(event.ticketPrice / 100).toFixed(2)}
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div>
            <h3 className="font-semibold mb-2">About This Event</h3>
            <DialogDescription className="text-base whitespace-pre-wrap" data-testid="modal-event-description">
              {event.description}
            </DialogDescription>
          </div>

          <Separator />

          <div className="flex gap-3 pt-2">
            {isFreeEvent && requiresRSVP ? (
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
      </DialogContent>
    </Dialog>
  );
}
