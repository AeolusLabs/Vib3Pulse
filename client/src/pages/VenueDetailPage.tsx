import { useDirectMessage, DmHandled } from "@/hooks/useDirectMessage";
import LinkedRoomBanner from "@/components/rooms/LinkedRoomBanner";
import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import ImageLightbox from "@/components/ImageLightbox";
import UnifiedShareModal from "@/components/UnifiedShareModal";
import { useGeolocation } from "@/hooks/useGeolocation";
import {
  VenueHero, VenueHeader, VenueActions, NextNightCard, GoodToKnow, UpcomingNights,
  VenueAbout, VenueMenu, LocationCard, SafetyShortcut, VenueHost, StickyEntryBar, pickNextNight,
} from "@/components/venue/VenueSections";
import { VenueGalleryManager } from "@/components/VenueGalleryManager";
import { RatingBreakdown, VenueReviewList } from "@/components/venue/VenueReviews";
import { useVenueSocialProof } from "@/hooks/use-venue-social";
import { useAuth } from "@/hooks/useAuth";
import { CardPaymentForm } from "@/components/payments/CardPaymentForm";
import { formatMoney } from "@/lib/currency";

import { format } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Venue, VenueEntryNight } from "@shared/schema";
import { ArrowLeftIcon, CheckCircleIcon } from "@/components/ui/icons";
import { Star } from "lucide-react";
import { useVenueRatings, useUserVenueRating, useSubmitVenueRating } from "@/hooks/use-ratings";
import RatingInput from "@/components/RatingInput";
import RatingDisplay from "@/components/RatingDisplay";

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

// ─── Venue ticket payment step ─────────────────────────────────────────────────
// Was a "SimulatedPaymentForm" that never actually collected payment at all —
// it posted straight to /api/payments/venue/confirm with no card/Paystack
// popup step in between, so it could only ever fail ("Payment not confirmed")
// once real Stripe/Paystack keys were configured. Replaced with the same real
// CardPaymentForm used by VenueEventDetailPage.tsx, so venue ticket purchases
// from a venue's own page actually work.
function VenueTicketPaymentForm({
  venue,
  entryNight,
  clientSecret,
  paymentIntentId,
  provider,
  onSuccess,
  onCancel,
}: {
  venue: Venue;
  entryNight: VenueEntryNight;
  clientSecret: string;
  paymentIntentId: string;
  provider: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/payments/venue/confirm", {
        venueEntryNightId: entryNight.id,
        paymentIntentId,
        provider,
      });
    },
    onSuccess: () => {
      toast({ title: "Ticket purchased successfully!" });
      queryClient.invalidateQueries({ queryKey: ["/api/my-venue-tickets"] });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to confirm ticket", variant: "destructive" });
    },
  });

  return (
    <CardPaymentForm
      clientSecret={clientSecret}
      provider={provider}
      amountLabel={formatMoney(entryNight.coverPriceCents, venue.currency)}
      itemLabel="Entry ticket"
      onSuccess={() => confirmMutation.mutate()}
      onCancel={onCancel}
    />
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();
  const { getDistanceFromUser } = useGeolocation();

  const [selectedEntryNight, setSelectedEntryNight] = useState<VenueEntryNight | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentProvider, setPaymentProvider] = useState<string>("stripe");
  const [showSuccess, setShowSuccess] = useState(false);
  const [galleryLightboxOpen, setGalleryLightboxOpen] = useState(false);
  const [galleryLightboxIndex, setGalleryLightboxIndex] = useState(0);
  const [isEditingRating, setIsEditingRating] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  const { data: venue, isLoading: venueLoading } = useQuery<Venue & { owner: any }>({
    queryKey: ["/api/venues", id],
    enabled: !!id,
  });

  const { data: venueRatingStats } = useVenueRatings(id);
  const { data: socialProof } = useVenueSocialProof(id);
  const { data: userVenueRating } = useUserVenueRating(currentUser ? id : undefined);
  const submitVenueRating = useSubmitVenueRating(id ?? "");

  const { data: entryNights = [], isLoading: nightsLoading } = useQuery<VenueEntryNight[]>({
    queryKey: ["/api/venues", id, "venue-events", "upcoming"],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${id}/venue-events/upcoming`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!id,
  });

  const isVenueOwner = currentUser?.id === venue?.ownerId;
  const ownerId: string | undefined = venue?.owner?.id;

  const { data: followingUsers = [] } = useQuery<Array<{ id: string }>>({
    queryKey: ["/api/follows/me/following"],
    enabled: !!currentUser && !!ownerId && !isVenueOwner,
  });
  const isFollowingOwner = followingUsers.some((u) => u.id === ownerId);

  const followMutation = useMutation({
    mutationFn: async () => {
      if (!ownerId) return;
      await apiRequest(isFollowingOwner ? "DELETE" : "POST", `/api/follows/${ownerId}`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/follows/me/following"] }),
    onError: (e: any) => toast({ title: e.message || "Couldn't update follow", variant: "destructive" }),
  });

  const dm = useDirectMessage();
  const messageMutation = useMutation({
    mutationFn: async () => {
      const c = await dm.start(ownerId!);
      if (!c) throw new DmHandled();
      return c;
    },
    onSuccess: (conversation: { id: string }) => navigate(`/messages/${conversation.id}`),
    onError: (e: any) => { if (!(e instanceof DmHandled)) toast({ title: e.message || "Couldn't open the chat", variant: "destructive" }); },
  });

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

  const buyingId = createPaymentMutation.isPending ? (createPaymentMutation.variables as string) : null;

  const handleClosePayment = () => {
    setSelectedEntryNight(null);
    setClientSecret(null);
    setPaymentIntentId(null);
    setPaymentProvider("stripe");
  };

  const handlePaymentSuccess = () => {
    handleClosePayment();
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  const handleCopyAddress = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 1500);
    } catch {
      toast({ title: "Couldn't copy the address", description: text });
    }
  };

  // ── Loading state ───────────────────────────────────────────────────────────
  if (venueLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <div className="h-[236px] sm:h-[300px] bg-muted animate-pulse" />
        <main className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 pt-5">
          <div className="space-y-4">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-2xl" />
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
          <Link href="/search">
            <Button>
              <ArrowLeftIcon className="h-4 w-4 mr-2" />
              Back to Discover
            </Button>
          </Link>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const isPromoted = !!(venue.isPromoted && venue.promotedUntil && new Date(venue.promotedUntil) > new Date());
  const galleryImages: string[] = venue.imageUrls || [];
  const heroImage = venue.coverImageUrl || venue.imageUrl;
  const photos = Array.from(new Set([heroImage, ...galleryImages].filter((x): x is string => !!x)));
  const nextNight = pickNextNight(entryNights);
  const distanceMiles =
    venue.latitude != null && venue.longitude != null ? getDistanceFromUser(venue.latitude, venue.longitude) : null;
  const distanceLabel = distanceMiles == null ? null : distanceMiles < 0.5 ? "Nearby" : `${distanceMiles.toFixed(1)} mi away`;

  const openGallery = (i: number) => { setGalleryLightboxIndex(i); setGalleryLightboxOpen(true); };
  const startBuy = (nightId: string) => createPaymentMutation.mutate(nightId);

  return (
    <div className={`min-h-screen bg-background md:pb-0 ${nextNight ? "pb-40" : "pb-20"}`}>
      {dm.dialog}
      <Navigation />

      <VenueHero venue={venue} photos={photos} onOpenGallery={openGallery} />

      {/* Phone: one column, ordered by what a person decides first. Desktop: story left, tickets + place right. */}
      <main className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-8">
        <div className="flex flex-col gap-7 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-10 lg:items-start">

          <div className="contents lg:flex lg:flex-col lg:gap-8 lg:min-w-0">
            <div className="order-1 lg:order-none">
              <VenueHeader
                venue={venue}
                categoryLabel={categoryLabels[venue.category] || venue.category}
                isPromoted={isPromoted}
                rating={venueRatingStats?.averageRating}
                ratingCount={venueRatingStats?.totalRatings ?? 0}
                distanceLabel={distanceLabel}
              />
            </div>
            <div className="order-2 lg:order-none empty:hidden">
              <LinkedRoomBanner venueId={venue.id} />
            </div>
            <div className="order-2 lg:order-none">
              <VenueActions venue={venue} onShare={() => setShareOpen(true)} />
            </div>
            <div className="order-4 lg:order-none"><GoodToKnow venue={venue} nights={entryNights} /></div>
            <div className="order-5 lg:order-none">
              <UpcomingNights venue={venue} nights={entryNights} onBuy={startBuy} buyingId={buyingId} loading={nightsLoading} />
            </div>
            <div className="order-5 lg:order-none"><VenueMenu venue={venue} /></div>
            <div className="order-6 lg:order-none"><VenueAbout venue={venue} /></div>

            <section className="order-9 lg:order-none" data-testid="section-ratings">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground flex items-center gap-2">
                  <Star className="h-4 w-4" />Ratings and reviews
                </h2>
                <RatingDisplay averageRating={venueRatingStats?.averageRating} totalRatings={venueRatingStats?.totalRatings ?? 0} />
              </div>
              <RatingBreakdown
                average={venueRatingStats?.averageRating}
                total={venueRatingStats?.totalRatings ?? 0}
                distribution={venueRatingStats?.distribution}
              />
              <VenueReviewList venueId={venue.id} />
              {!currentUser ? (
                <p className="text-sm text-muted-foreground">
                  <Link href={`/login?redirect=${encodeURIComponent(`/venue/${venue.id}`)}`} className="text-primary underline">Sign in</Link> to rate this venue.
                </p>
              ) : userVenueRating?.hasRated && !isEditingRating ? (
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-card">
                  <div>
                    <p className="text-sm font-medium">Your rating: {userVenueRating.rating} ★</p>
                    {userVenueRating.reviewText && (
                      <p className="text-xs text-muted-foreground mt-1">{userVenueRating.reviewText}</p>
                    )}
                  </div>
                  <Button size="sm" variant="outline" className="h-11" onClick={() => setIsEditingRating(true)} data-testid="button-edit-venue-rating">
                    Edit
                  </Button>
                </div>
              ) : (
                <RatingInput
                  label={userVenueRating?.hasRated ? "Update your rating" : "Rate this venue"}
                  initialRating={userVenueRating?.rating ?? 0}
                  initialReviewText={userVenueRating?.reviewText}
                  submitLabel={userVenueRating?.hasRated ? "Update rating" : "Submit rating"}
                  isPending={submitVenueRating.isPending}
                  errorMessage={submitVenueRating.isError ? (submitVenueRating.error as any)?.message ?? "Failed to submit rating" : null}
                  onCancel={userVenueRating?.hasRated ? () => setIsEditingRating(false) : undefined}
                  onSubmit={(rating, reviewText) => {
                    submitVenueRating.mutate({ rating, reviewText }, {
                      onSuccess: () => setIsEditingRating(false),
                    });
                  }}
                />
              )}
            </section>

            {venue.owner && (
              <div className="order-10 lg:order-none">
                <VenueHost
                  owner={venue.owner}
                  canInteract={!!currentUser && !isVenueOwner}
                  isFollowing={isFollowingOwner}
                  onFollow={() => followMutation.mutate()}
                  followPending={followMutation.isPending}
                  onMessage={() => messageMutation.mutate()}
                />
              </div>
            )}

            {isVenueOwner && (
              <Card className="order-10 lg:order-none">
                <CardContent className="pt-6 space-y-8">
                  <VenueGalleryManager venueId={venue.id} imageUrls={galleryImages} maxImages={6} />
                  <VenueGalleryManager
                    venueId={venue.id}
                    imageUrls={venue.menuImageUrls ?? []}
                    maxImages={10}
                    field="menuImageUrls"
                    title="Manage Menu"
                    noun="menu page"
                  />
                </CardContent>
              </Card>
            )}
          </div>

          <div className="contents lg:flex lg:flex-col lg:gap-6 lg:sticky lg:top-4 lg:min-w-0">
            {nextNight && (
              <div className="order-3 lg:order-none">
                <NextNightCard venue={venue} night={nextNight} onBuy={() => startBuy(nextNight.id)} buying={buyingId === nextNight.id} proof={socialProof?.[nextNight.id]} />
              </div>
            )}
            <div className="order-7 lg:order-none">
              <LocationCard venue={venue} onCopy={handleCopyAddress} copied={addressCopied} />
            </div>
            {currentUser?.userType === "social" && (
              <div className="order-8 lg:order-none"><SafetyShortcut /></div>
            )}
          </div>
        </div>
      </main>

      {nextNight && (
        <StickyEntryBar venue={venue} night={nextNight} onBuy={() => startBuy(nextNight.id)} buying={buyingId === nextNight.id} />
      )}

      <BottomNavigation />

      {/* ── Gallery lightbox ───────────────────────────────────────────────── */}
      {photos.length > 0 && (
        <ImageLightbox
          images={photos}
          initialIndex={galleryLightboxIndex}
          open={galleryLightboxOpen}
          onClose={() => setGalleryLightboxOpen(false)}
        />
      )}

      {shareOpen && (
        <UnifiedShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          shareData={{ type: "venue", id: venue.id, name: venue.name, imageUrl: heroImage }}
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
            <VenueTicketPaymentForm
              venue={venue}
              entryNight={selectedEntryNight}
              clientSecret={clientSecret}
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
            <CheckCircleIcon className="h-16 w-16 mx-auto text-green-500 mb-4" />
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
