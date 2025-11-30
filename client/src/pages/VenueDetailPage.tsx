import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { 
  MapPin, 
  Phone, 
  Globe, 
  Clock, 
  Music, 
  Users, 
  Calendar, 
  Shield, 
  Sparkles,
  ArrowLeft,
  Ticket,
  DollarSign,
  CheckCircle
} from "lucide-react";
import { format } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, useStripe, useElements, PaymentElement } from "@stripe/react-stripe-js";
import type { Venue, VenueEntryNight } from "@shared/schema";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY || "");

const categoryLabels: Record<string, string> = {
  nightclub: "Nightclub",
  bar: "Bar",
  lounge: "Lounge",
  pub: "Pub",
  rooftop: "Rooftop",
  sports_bar: "Sports Bar",
  wine_bar: "Wine Bar",
  cocktail_bar: "Cocktail Bar",
  live_music: "Live Music Venue",
  comedy_club: "Comedy Club",
  Club: "Club",
  Pub: "Pub",
  Lounge: "Lounge",
  Bar: "Bar",
  Nightclub: "Nightclub",
  Rooftop: "Rooftop",
};

function TicketPurchaseForm({ 
  entryNight, 
  onSuccess, 
  onCancel 
}: { 
  entryNight: VenueEntryNight; 
  onSuccess: () => void; 
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [processing, setProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
      redirect: "if_required",
    });

    if (error) {
      toast({ title: error.message || "Payment failed", variant: "destructive" });
      setProcessing(false);
      return;
    }

    if (paymentIntent && paymentIntent.status === "succeeded") {
      try {
        await apiRequest("POST", "/api/venue-tickets/confirm", {
          entryNightId: entryNight.id,
          paymentIntentId: paymentIntent.id,
        });
        toast({ title: "Ticket purchased successfully!" });
        queryClient.invalidateQueries({ queryKey: ["/api/my-venue-tickets"] });
        onSuccess();
      } catch {
        toast({ title: "Failed to confirm ticket", variant: "destructive" });
      }
    }

    setProcessing(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={processing}>
          Cancel
        </Button>
        <Button type="submit" disabled={!stripe || processing}>
          {processing ? "Processing..." : `Pay $${(entryNight.coverPriceCents / 100).toFixed(2)}`}
        </Button>
      </div>
    </form>
  );
}

export default function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [selectedEntryNight, setSelectedEntryNight] = useState<VenueEntryNight | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const { data: venue, isLoading: venueLoading } = useQuery<Venue & { owner: any }>({
    queryKey: ["/api/venues", id],
    enabled: !!id,
  });

  const { data: entryNights = [], isLoading: nightsLoading } = useQuery<VenueEntryNight[]>({
    queryKey: ["/api/venues", id, "entry-nights", "upcoming"],
    enabled: !!id,
  });

  const createPaymentMutation = useMutation({
    mutationFn: async (entryNightId: string) => {
      const response = await apiRequest("POST", "/api/venue-tickets/create-payment-intent", { entryNightId });
      return response.json();
    },
    onSuccess: (data, entryNightId) => {
      setClientSecret(data.clientSecret);
      const night = entryNights.find(n => n.id === entryNightId);
      if (night) setSelectedEntryNight(night);
    },
    onError: (error: any) => {
      toast({ title: error.message || "Failed to start payment", variant: "destructive" });
    },
  });

  const handlePurchaseTicket = (entryNight: VenueEntryNight) => {
    createPaymentMutation.mutate(entryNight.id);
  };

  const handleClosePayment = () => {
    setSelectedEntryNight(null);
    setClientSecret(null);
  };

  const handlePaymentSuccess = () => {
    setSelectedEntryNight(null);
    setClientSecret(null);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  if (venueLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-64 w-full rounded-xl mb-8" />
          <Skeleton className="h-8 w-64 mb-4" />
          <Skeleton className="h-4 w-48 mb-8" />
          <Skeleton className="h-32 w-full" />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!venue) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <h1 className="text-2xl font-semibold mb-4">Venue not found</h1>
          <p className="text-muted-foreground mb-6">The venue you're looking for doesn't exist.</p>
          <Link href="/discover">
            <Button>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Discover
            </Button>
          </Link>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const isPromoted = venue.isPromoted && venue.promotedUntil && new Date(venue.promotedUntil) > new Date();

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/discover">
          <Button variant="ghost" className="mb-4" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Discover
          </Button>
        </Link>

        {(venue.coverImageUrl || venue.imageUrl) && (
          <div className="relative rounded-xl overflow-hidden mb-8">
            <img
              src={venue.coverImageUrl || venue.imageUrl || ""}
              alt={venue.name}
              className="w-full h-64 md:h-80 object-cover"
            />
            {isPromoted && (
              <Badge className="absolute top-4 right-4 bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                <Sparkles className="h-4 w-4 mr-1" />
                Featured Venue
              </Badge>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div>
              <div className="flex items-start gap-3 flex-wrap mb-2">
                <h1 className="text-3xl font-serif font-bold" data-testid="text-venue-name">{venue.name}</h1>
                {venue.isVerified && (
                  <Badge className="bg-blue-500 text-white">
                    <Shield className="h-3 w-3 mr-1" />
                    Verified
                  </Badge>
                )}
              </div>
              <Badge variant="secondary" className="text-base">
                {categoryLabels[venue.category] || venue.category}
              </Badge>
            </div>

            {venue.description && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">About</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground" data-testid="text-venue-description">{venue.description}</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(venue.address || venue.city) && (
                  <div className="flex items-center gap-3">
                    <MapPin className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <span data-testid="text-venue-address">
                      {venue.address}{venue.address && venue.city && ", "}{venue.city}
                    </span>
                  </div>
                )}
                {venue.phone && (
                  <div className="flex items-center gap-3">
                    <Phone className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <a href={`tel:${venue.phone}`} className="hover:underline" data-testid="text-venue-phone">
                      {venue.phone}
                    </a>
                  </div>
                )}
                {venue.website && (
                  <div className="flex items-center gap-3">
                    <Globe className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <a href={venue.website} target="_blank" rel="noopener noreferrer" className="hover:underline text-primary">
                      Visit Website
                    </a>
                  </div>
                )}
                {venue.hours && (
                  <div className="flex items-center gap-3">
                    <Clock className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <span>{venue.hours}</span>
                  </div>
                )}
                {venue.ageRestriction && (
                  <div className="flex items-center gap-3">
                    <Users className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <span>{venue.ageRestriction}+ only</span>
                  </div>
                )}
                {venue.dressCode && (
                  <div className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <span>Dress Code: {venue.dressCode}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {venue.musicTypes && Array.isArray(venue.musicTypes) && venue.musicTypes.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Music className="h-5 w-5" />
                    Music
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {venue.musicTypes.map((type) => (
                      <Badge key={type} variant="outline">{type}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {venue.amenities && Array.isArray(venue.amenities) && venue.amenities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Amenities</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {venue.amenities.map((amenity) => (
                      <Badge key={amenity} variant="secondary">{amenity}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Ticket className="h-5 w-5" />
                  Upcoming Entry Nights
                </CardTitle>
              </CardHeader>
              <CardContent>
                {nightsLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                  </div>
                ) : entryNights.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No upcoming entry nights scheduled.</p>
                ) : (
                  <div className="space-y-3">
                    {entryNights.map((night) => (
                      <Card key={night.id} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                              <Calendar className="h-4 w-4" />
                              <span>{format(new Date(night.date), "EEE, MMM d 'at' h:mm a")}</span>
                            </div>
                            {night.name && (
                              <p className="font-medium text-sm">{night.name}</p>
                            )}
                            {night.description && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{night.description}</p>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="flex items-center gap-1 text-lg font-bold mb-2">
                              <DollarSign className="h-4 w-4" />
                              {(night.coverPriceCents / 100).toFixed(2)}
                            </div>
                            <Button 
                              size="sm" 
                              onClick={() => handlePurchaseTicket(night)}
                              disabled={createPaymentMutation.isPending}
                              data-testid={`button-buy-ticket-${night.id}`}
                            >
                              Buy Ticket
                            </Button>
                          </div>
                        </div>
                        {night.capacity && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            {night.capacity - night.ticketsSold} spots remaining
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <BottomNavigation />

      <Dialog open={!!clientSecret && !!selectedEntryNight} onOpenChange={() => handleClosePayment()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purchase Entry Ticket</DialogTitle>
            <DialogDescription>
              {selectedEntryNight && (
                <>
                  Entry to {venue.name} on {format(new Date(selectedEntryNight.date), "EEEE, MMMM d 'at' h:mm a")}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {clientSecret && selectedEntryNight && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <TicketPurchaseForm 
                entryNight={selectedEntryNight} 
                onSuccess={handlePaymentSuccess}
                onCancel={handleClosePayment}
              />
            </Elements>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showSuccess} onOpenChange={setShowSuccess}>
        <DialogContent>
          <div className="text-center py-6">
            <CheckCircle className="h-16 w-16 mx-auto text-green-500 mb-4" />
            <DialogTitle className="text-2xl mb-2">Ticket Purchased!</DialogTitle>
            <DialogDescription>
              Your entry ticket has been confirmed. Check your wallet for the QR code.
            </DialogDescription>
          </div>
          <DialogFooter>
            <Link href="/wallet">
              <Button className="w-full">View My Tickets</Button>
            </Link>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
