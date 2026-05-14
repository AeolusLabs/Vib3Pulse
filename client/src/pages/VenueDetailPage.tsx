import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import ImageLightbox from "@/components/ImageLightbox";
import { VenueGalleryManager } from "@/components/VenueGalleryManager";
import { useAuth } from "@/hooks/useAuth";
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
  CheckCircle,
  AlertCircle,
  Accessibility,
} from "lucide-react";
import { format } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Venue, VenueEntryNight } from "@shared/schema";

const categoryLabels: Record<string, string> = {
  Club: "Club",
  Pub: "Pub",
  Lounge: "Lounge",
  Bar: "Bar",
  Nightclub: "Nightclub",
  Rooftop: "Rooftop",
  // legacy lowercase
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
};

// ─── Simulated payment form ───────────────────────────────────────────────────
function SimulatedPaymentForm({
  entryNight,
  paymentIntentId,
  provider,
  onSuccess,
  onCancel,
}: {
  entryNight: VenueEntryNight;
  paymentIntentId: string;
  provider: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [processing, setProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProcessing(true);
    try {
      await apiRequest("POST", "/api/payments/venue/confirm", {
        venueEntryNightId: entryNight.id,
        paymentIntentId,
        provider,
      });
      toast({ title: "Ticket purchased successfully!" });
      queryClient.invalidateQueries({ queryKey: ["/api/my-venue-tickets"] });
      onSuccess();
    } catch {
      toast({ title: "Failed to confirm ticket", variant: "destructive" });
    }
    setProcessing(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-50 dark:bg-amber-950/20 p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-amber-800 dark:text-amber-200">Demo Mode</p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Payments are simulated. No real charges will be made.
            </p>
          </div>
        </div>
      </div>
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Entry ticket</span>
          <span>£{(entryNight.coverPriceCents / 100).toFixed(2)}</span>
        </div>
        <div className="border-t pt-3 flex justify-between font-medium">
          <span>Total</span>
          <span>£{(entryNight.coverPriceCents / 100).toFixed(2)}</span>
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={processing}>
          Cancel
        </Button>
        <Button type="submit" disabled={processing} data-testid="button-confirm-simulated-payment">
          {processing ? "Processing..." : "Confirm Purchase"}
        </Button>
      </div>
    </form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

  const [selectedEntryNight, setSelectedEntryNight] = useState<VenueEntryNight | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentProvider, setPaymentProvider] = useState<string>("stripe");
  const [showSuccess, setShowSuccess] = useState(false);
  const [galleryLightboxOpen, setGalleryLightboxOpen] = useState(false);
  const [galleryLightboxIndex, setGalleryLightboxIndex] = useState(0);

  const { data: venue, isLoading: venueLoading } = useQuery<Venue & { owner: any }>({
    queryKey: ["/api/venues", id],
    enabled: !!id,
  });

  const { data: entryNights = [], isLoading: nightsLoading } = useQuery<VenueEntryNight[]>({
    queryKey: ["/api/venues", id, "entry-nights", "upcoming"],
    enabled: !!id,
  });

  const isVenueOwner = currentUser?.id === venue?.ownerId;

  const createPaymentMutation = useMutation({
    mutationFn: async (venueEntryNightId: string) => {
      const response = await apiRequest("POST", "/api/payments/venue/intent", { venueEntryNightId });
      return response.json();
    },
    onSuccess: (data, venueEntryNightId) => {
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setPaymentProvider(data.provider ?? "stripe");
      const night = entryNights.find(n => n.id === venueEntryNightId);
      if (night) setSelectedEntryNight(night);
    },
    onError: (error: any) => {
      toast({ title: error.message || "Failed to start payment", variant: "destructive" });
    },
  });

  const handleClosePayment = () => {
    setSelectedEntryNight(null);
    setClientSecret(null);
    setPaymentIntentId(null);
    setPaymentProvider("stripe");
  };

  const handlePaymentSuccess = () => {
    setSelectedEntryNight(null);
    setClientSecret(null);
    setPaymentIntentId(null);
    setPaymentProvider("stripe");
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  // ── Loading state ───────────────────────────────────────────────────────────
  if (venueLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <div className="h-[400px] md:h-[500px] bg-muted animate-pulse" />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 -mt-32 relative z-20">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-4">
              <Skeleton className="h-64 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  // ── Not found ───────────────────────────────────────────────────────────────
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
  const heroImage = venue.coverImageUrl || venue.imageUrl;
  const ownerInitials = (venue.owner?.displayName || venue.owner?.username || "?")
    .slice(0, 2).toUpperCase();
  const accessibilityFeatures: string[] = (venue as any).accessibilityFeatures || [];
  const galleryImages: string[] = venue.imageUrls || [];

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <div className="relative h-[400px] md:h-[500px] overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent z-10" />
        {heroImage ? (
          <img
            src={heroImage}
            alt={venue.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-purple-900 via-purple-800 to-pink-900" />
        )}
        {isPromoted && (
          <Badge className="absolute top-4 right-4 z-20 bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg">
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            Featured Venue
          </Badge>
        )}
      </div>

      {/* ── Main content overlapping hero ────────────────────────────────────── */}
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 -mt-32 relative z-20">

        {/* Back button */}
        <Link href="/discover">
          <Button variant="ghost" size="sm" className="mb-4 bg-background/80 backdrop-blur-sm hover:bg-background" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Discover
          </Button>
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* ── Left / main column ─────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-6">

            {/* Primary info card */}
            <Card className="shadow-lg">
              <CardContent className="p-6 md:p-8">

                {/* Badges */}
                <div className="flex flex-wrap gap-2 mb-3">
                  <Badge variant="default">
                    {categoryLabels[venue.category] || venue.category}
                  </Badge>
                  {venue.isVerified && (
                    <Badge className="bg-blue-500 hover:bg-blue-600 text-white gap-1">
                      <Shield className="h-3 w-3" />
                      Verified
                    </Badge>
                  )}
                </div>

                {/* Venue name */}
                <h1 className="font-serif text-3xl md:text-4xl font-bold mb-5" data-testid="text-venue-name">
                  {venue.name}
                </h1>

                {/* Owner row */}
                {venue.owner && (
                  <div className="flex items-center gap-4 mb-6 pb-6 border-b">
                    <Avatar className="h-12 w-12 ring-2 ring-border">
                      <AvatarImage src={venue.owner.avatarUrl || ""} alt={venue.owner.username} />
                      <AvatarFallback className="bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 font-semibold">
                        {ownerInitials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">
                        {venue.owner.displayName || venue.owner.username}
                      </p>
                      <p className="text-sm text-muted-foreground">Venue Owner</p>
                    </div>
                    {venue.phone && (
                      <Button variant="outline" size="sm" asChild>
                        <a href={`tel:${venue.phone}`}>
                          <Phone className="h-4 w-4 mr-2" />
                          Contact
                        </a>
                      </Button>
                    )}
                  </div>
                )}

                {/* Key info grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                  {(venue.address || venue.city) && (
                    <div className="flex items-start gap-3">
                      <MapPin className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-sm">Location</p>
                        <p className="text-sm text-muted-foreground" data-testid="text-venue-address">
                          {venue.address}{venue.address && venue.city && ", "}{venue.city}
                        </p>
                      </div>
                    </div>
                  )}
                  {venue.hours && (
                    <div className="flex items-start gap-3">
                      <Clock className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-sm">Hours</p>
                        <p className="text-sm text-muted-foreground">{venue.hours}</p>
                      </div>
                    </div>
                  )}
                  {venue.ageRestriction && (
                    <div className="flex items-start gap-3">
                      <Users className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-sm">Age Policy</p>
                        <p className="text-sm text-muted-foreground">{venue.ageRestriction}+ only</p>
                      </div>
                    </div>
                  )}
                  {venue.dressCode && (
                    <div className="flex items-start gap-3">
                      <Shield className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-sm">Dress Code</p>
                        <p className="text-sm text-muted-foreground">{venue.dressCode}</p>
                      </div>
                    </div>
                  )}
                  {venue.website && (
                    <div className="flex items-start gap-3">
                      <Globe className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-sm">Website</p>
                        <a
                          href={venue.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline"
                        >
                          Visit Website
                        </a>
                      </div>
                    </div>
                  )}
                </div>

                {/* Description */}
                {venue.description && (
                  <div className="mb-6 pb-6 border-b">
                    <h3 className="font-serif text-lg font-semibold mb-2">About</h3>
                    <p className="text-muted-foreground leading-relaxed" data-testid="text-venue-description">
                      {venue.description}
                    </p>
                  </div>
                )}

                {/* Music types */}
                {venue.musicTypes && venue.musicTypes.length > 0 && (
                  <div className="mb-6">
                    <h3 className="font-semibold text-sm flex items-center gap-2 mb-3">
                      <Music className="h-4 w-4 text-primary" />
                      Music
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {venue.musicTypes.map(type => (
                        <Badge key={type} variant="outline">{type}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Amenities */}
                {venue.amenities && venue.amenities.length > 0 && (
                  <div className="mb-6">
                    <h3 className="font-semibold text-sm mb-3">Amenities</h3>
                    <div className="flex flex-wrap gap-2">
                      {venue.amenities.map(amenity => (
                        <Badge key={amenity} variant="secondary">{amenity}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Accessibility */}
                {accessibilityFeatures.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-sm flex items-center gap-2 mb-3">
                      <Accessibility className="h-4 w-4 text-green-600 dark:text-green-400" />
                      Accessibility
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {accessibilityFeatures.map(feature => (
                        <Badge
                          key={feature}
                          className="bg-green-100 text-green-800 border-green-200 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700"
                          variant="outline"
                        >
                          {feature}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Gallery */}
            {galleryImages.length > 0 && (
              <Card className="shadow-lg overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Gallery</CardTitle>
                </CardHeader>
                <CardContent className="px-6 pb-6">
                  <div className={`grid gap-2 rounded-xl overflow-hidden ${
                    galleryImages.length === 1 ? "grid-cols-1" :
                    galleryImages.length === 2 ? "grid-cols-2" :
                    galleryImages.length <= 4 ? "grid-cols-2 md:grid-cols-4" :
                    "grid-cols-2 md:grid-cols-3"
                  }`}>
                    {galleryImages.map((imgUrl, idx) => (
                      <div
                        key={idx}
                        className={`relative overflow-hidden rounded-lg cursor-pointer group ${
                          galleryImages.length === 3 && idx === 0 ? "md:row-span-2" : ""
                        }`}
                        onClick={() => { setGalleryLightboxIndex(idx); setGalleryLightboxOpen(true); }}
                        data-testid={`button-gallery-image-${idx}`}
                      >
                        <img
                          src={imgUrl}
                          alt={`${venue.name} gallery ${idx + 1}`}
                          className={`w-full object-cover transition-transform group-hover:scale-105 ${
                            galleryImages.length === 1 ? "h-64" :
                            galleryImages.length === 3 && idx === 0 ? "h-full min-h-40" :
                            "aspect-square"
                          }`}
                          data-testid={`img-venue-gallery-${idx}`}
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors" />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Owner-only gallery management */}
            {isVenueOwner && (
              <Card className="shadow-lg">
                <CardContent className="pt-6">
                  <VenueGalleryManager
                    venueId={venue.id}
                    imageUrls={galleryImages}
                    maxImages={6}
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── Right / sidebar ────────────────────────────────────────────── */}
          <div className="space-y-6">
            <Card className="shadow-lg sticky top-4">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Ticket className="h-5 w-5 text-primary" />
                  Entry Nights
                </CardTitle>
              </CardHeader>
              <CardContent>
                {nightsLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-24 w-full rounded-lg" />
                    <Skeleton className="h-24 w-full rounded-lg" />
                  </div>
                ) : entryNights.length === 0 ? (
                  <div className="text-center py-6">
                    <Calendar className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No upcoming entry nights.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {entryNights.map((night) => {
                      const spotsLeft = night.capacity != null
                        ? night.capacity - night.ticketsSold
                        : null;
                      const soldOut = spotsLeft !== null && spotsLeft <= 0;
                      return (
                        <div
                          key={night.id}
                          className="rounded-xl border bg-muted/30 p-4 space-y-3"
                        >
                          <div className="flex items-start gap-2 text-sm text-muted-foreground">
                            <Calendar className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
                            <span>{format(new Date(night.date), "EEE, MMM d 'at' h:mm a")}</span>
                          </div>
                          {night.name && (
                            <p className="font-semibold text-sm">{night.name}</p>
                          )}
                          {night.description && (
                            <p className="text-xs text-muted-foreground line-clamp-2">{night.description}</p>
                          )}
                          <div className="flex items-center justify-between pt-1">
                            <div>
                              <span className="text-xl font-bold">
                                £{(night.coverPriceCents / 100).toFixed(2)}
                              </span>
                              {spotsLeft !== null && !soldOut && (
                                <p className="text-xs text-muted-foreground">{spotsLeft} spots left</p>
                              )}
                            </div>
                            <Button
                              size="sm"
                              onClick={() => createPaymentMutation.mutate(night.id)}
                              disabled={createPaymentMutation.isPending || soldOut}
                              className="bg-gradient-to-r from-purple-600 to-pink-500 hover:from-purple-700 hover:to-pink-600 text-white"
                              data-testid={`button-buy-ticket-${night.id}`}
                            >
                              {soldOut ? "Sold Out" : createPaymentMutation.isPending ? "..." : "Buy Ticket"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <BottomNavigation />

      {/* ── Gallery lightbox ───────────────────────────────────────────────── */}
      {galleryImages.length > 0 && (
        <ImageLightbox
          images={galleryImages}
          initialIndex={galleryLightboxIndex}
          open={galleryLightboxOpen}
          onClose={() => setGalleryLightboxOpen(false)}
        />
      )}

      {/* ── Payment dialog ─────────────────────────────────────────────────── */}
      <Dialog open={!!clientSecret && !!selectedEntryNight} onOpenChange={() => handleClosePayment()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purchase Entry Ticket</DialogTitle>
            <DialogDescription>
              {selectedEntryNight && (
                <>Entry to {venue.name} on {format(new Date(selectedEntryNight.date), "EEEE, MMMM d 'at' h:mm a")}</>
              )}
            </DialogDescription>
          </DialogHeader>
          {clientSecret && selectedEntryNight && (
            <SimulatedPaymentForm
              entryNight={selectedEntryNight}
              paymentIntentId={paymentIntentId || ""}
              provider={paymentProvider}
              onSuccess={handlePaymentSuccess}
              onCancel={handleClosePayment}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Success dialog ─────────────────────────────────────────────────── */}
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
