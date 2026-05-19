import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

import { format } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { VenueEntryNight, Venue } from "@shared/schema";
import { ArrowLeftIcon, CalendarIcon, MapPinIcon, UsersIcon, TicketIcon, ClockIcon, LogOutIcon, Building2Icon, CheckCircleIcon, AlertCircleIcon, SparklesIcon, GlobeIcon, PhoneIcon } from "@/components/ui/icons";
import { DoorOpen, UtensilsCrossed, Wine } from "lucide-react";

type VenueEventWithVenue = VenueEntryNight & { venue: Venue };

function SimulatedPaymentForm({
  event,
  paymentIntentId,
  provider,
  onSuccess,
  onCancel,
}: {
  event: VenueEntryNight;
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
        venueEntryNightId: event.id,
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
          <AlertCircleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-amber-800 dark:text-amber-200">Demo Mode</p>
            <p className="text-sm text-amber-700 dark:text-amber-300">Payments are simulated. No real charges will be made.</p>
          </div>
        </div>
      </div>
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Entry ticket</span>
          <span>£{(event.coverPriceCents / 100).toFixed(2)}</span>
        </div>
        <div className="border-t pt-3 flex justify-between font-medium">
          <span>Total</span>
          <span>£{(event.coverPriceCents / 100).toFixed(2)}</span>
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={processing}>Cancel</Button>
        <Button type="submit" disabled={processing} data-testid="button-confirm-payment">
          {processing ? "Processing..." : "Confirm Purchase"}
        </Button>
      </div>
    </form>
  );
}

export default function VenueEventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const { data: currentUser } = useAuth();

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentProvider, setPaymentProvider] = useState("stripe");
  const [showSuccess, setShowSuccess] = useState(false);

  const { data: event, isLoading } = useQuery<VenueEventWithVenue>({
    queryKey: ["/api/venue-events", id],
    queryFn: async () => {
      const res = await fetch(`/api/venue-events/${id}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: !!id,
  });

  const createPaymentMutation = useMutation({
    mutationFn: async (venueEntryNightId: string) => {
      const response = await apiRequest("POST", "/api/payments/venue/intent", { venueEntryNightId });
      return response.json();
    },
    onSuccess: (data) => {
      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setPaymentProvider(data.provider ?? "stripe");
    },
    onError: (error: any) => {
      toast({ title: error.message || "Failed to start payment", variant: "destructive" });
    },
  });

  const handleClosePayment = () => {
    setClientSecret(null);
    setPaymentIntentId(null);
    setPaymentProvider("stripe");
  };

  const handlePaymentSuccess = () => {
    handleClosePayment();
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <div className="h-[300px] bg-muted animate-pulse" />
        <main className="max-w-[900px] mx-auto px-4 sm:px-6 lg:px-8 -mt-20 relative z-20 pb-8">
          <Skeleton className="h-64 w-full rounded-xl mb-6" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="max-w-[900px] mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <h1 className="text-2xl font-semibold mb-4">Event not found</h1>
          <Link href="/discover">
            <Button><ArrowLeftIcon className="h-4 w-4 mr-2" />Back to Discover</Button>
          </Link>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const ev = event as any;
  const venue = event.venue;
  const heroImage = ev.imageUrl || venue.coverImageUrl || venue.imageUrl;
  const spotsLeft = event.capacity != null ? event.capacity - event.ticketsSold : null;
  const soldOut = spotsLeft !== null && spotsLeft <= 0;
  const isPromoted = venue.isPromoted && venue.promotedUntil && new Date(venue.promotedUntil) > new Date();

  // Build the event timeline
  const timeline: { time: string; label: string; icon: React.ReactNode; color: string }[] = [];
  if (ev.doorsCloseTime) {
    timeline.push({
      time: format(new Date(ev.doorsCloseTime), "h:mm a"),
      label: "Doors open until",
      icon: <DoorOpen className="h-4 w-4" />,
      color: "text-orange-500",
    });
  }
  timeline.push({
    time: format(new Date(event.date), "h:mm a"),
    label: "Event starts",
    icon: <CalendarIcon className="h-4 w-4" />,
    color: "text-purple-600",
  });
  if (ev.lastCallTime) {
    timeline.push({
      time: format(new Date(ev.lastCallTime), "h:mm a"),
      label: "Last call",
      icon: <Wine className="h-4 w-4" />,
      color: "text-purple-500",
    });
  }
  if (ev.kitchenCloseTime) {
    timeline.push({
      time: format(new Date(ev.kitchenCloseTime), "h:mm a"),
      label: "Kitchen closes",
      icon: <UtensilsCrossed className="h-4 w-4" />,
      color: "text-blue-500",
    });
  }
  if (ev.endTime) {
    timeline.push({
      time: format(new Date(ev.endTime), "h:mm a"),
      label: "Event ends",
      icon: <LogOutIcon className="h-4 w-4" />,
      color: "text-rose-500",
    });
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      {/* Hero */}
      <div className="relative h-[280px] md:h-[360px] overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent z-10" />
        {heroImage ? (
          <img src={heroImage} alt={event.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-purple-900 via-purple-800 to-pink-900" />
        )}
        {isPromoted && (
          <Badge className="absolute top-4 right-4 z-20 bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg">
            <SparklesIcon className="h-3.5 w-3.5 mr-1" />Featured Venue
          </Badge>
        )}
      </div>

      <main className="max-w-[900px] mx-auto px-4 sm:px-6 lg:px-8 -mt-24 relative z-20 pb-8">
        <Link href="/discover">
          <Button variant="ghost" size="sm" className="mb-4 bg-background/80 backdrop-blur-sm hover:bg-background">
            <ArrowLeftIcon className="h-4 w-4 mr-2" />Back to Discover
          </Button>
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── Main column ── */}
          <div className="lg:col-span-2 space-y-6">

            {/* Event header card */}
            <Card className="shadow-lg">
              <CardContent className="p-6 md:p-8">
                <div className="flex flex-wrap gap-2 mb-3">
                  <Badge variant="default">Venue Event</Badge>
                  {!event.isActive && <Badge variant="secondary">Inactive</Badge>}
                </div>

                <h1 className="font-serif text-3xl md:text-4xl font-bold mb-4" data-testid="text-event-name">
                  {event.name}
                </h1>

                {/* Date */}
                <div className="flex items-center gap-3 mb-6 pb-6 border-b">
                  <div className="h-12 w-12 rounded-xl bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0">
                    <CalendarIcon className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-lg">
                      {format(new Date(event.date), "EEEE, MMMM d, yyyy")}
                    </p>
                    <p className="text-muted-foreground">
                      {format(new Date(event.date), "h:mm a")}
                      {ev.endTime && ` — ${format(new Date(ev.endTime), "h:mm a")}`}
                    </p>
                  </div>
                </div>

                {/* Description */}
                {event.description && (
                  <div className="mb-6">
                    <h3 className="font-serif text-lg font-semibold mb-2">About This Event</h3>
                    <p className="text-muted-foreground leading-relaxed">{event.description}</p>
                  </div>
                )}

                {/* Timeline */}
                {timeline.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
                      <ClockIcon className="h-4 w-4 text-primary" />
                      Event Schedule
                    </h3>
                    <div className="relative pl-6 space-y-4">
                      {/* vertical line */}
                      <div className="absolute left-2 top-1 bottom-1 w-0.5 bg-border" />
                      {timeline.map((item, i) => (
                        <div key={i} className="flex items-center gap-3 relative">
                          <div className={`absolute -left-4 h-4 w-4 rounded-full bg-background border-2 border-border flex items-center justify-center ${item.color}`}>
                            <div className="h-1.5 w-1.5 rounded-full bg-current" />
                          </div>
                          <div className={`flex-shrink-0 ${item.color}`}>{item.icon}</div>
                          <div className="flex-1">
                            <span className="text-sm font-medium">{item.label}</span>
                            <span className="ml-2 text-sm text-muted-foreground">{item.time}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Venue info card */}
            <Card className="shadow-lg">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2Icon className="h-5 w-5 text-primary" />
                  About the Venue
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Link href={`/venue/${venue.id}`} className="flex items-center gap-4 group">
                  {(venue.imageUrl || venue.coverImageUrl) ? (
                    <img
                      src={venue.imageUrl || venue.coverImageUrl || ""}
                      alt={venue.name}
                      className="h-14 w-14 rounded-xl object-cover flex-shrink-0 group-hover:opacity-90 transition-opacity"
                    />
                  ) : (
                    <div className="h-14 w-14 rounded-xl bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0">
                      <Building2Icon className="h-7 w-7 text-purple-500" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold group-hover:text-primary transition-colors">{venue.name}</p>
                    <p className="text-sm text-muted-foreground">{venue.category}</p>
                  </div>
                  <Badge variant="outline" className="flex-shrink-0">View Venue</Badge>
                </Link>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                  {(venue.address || venue.city) && (
                    <div className="flex items-start gap-2 text-sm">
                      <MapPinIcon className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-muted-foreground">
                        {venue.address}{venue.address && venue.city && ", "}{venue.city}
                      </span>
                    </div>
                  )}
                  {venue.phone && (
                    <a href={`tel:${venue.phone}`} className="flex items-start gap-2 text-sm hover:text-primary transition-colors">
                      <PhoneIcon className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                      <span>{venue.phone}</span>
                    </a>
                  )}
                  {venue.website && (
                    <a href={venue.website} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 text-sm hover:text-primary transition-colors">
                      <GlobeIcon className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                      <span className="truncate">Visit Website</span>
                    </a>
                  )}
                  {venue.hours && (
                    <div className="flex items-start gap-2 text-sm">
                      <ClockIcon className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-muted-foreground">{venue.hours}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Ticket sidebar ── */}
          <div className="space-y-4">
            <Card className="shadow-lg sticky top-4">
              <CardContent className="p-6 space-y-4">
                <div className="text-center">
                  <p className="text-3xl font-bold">
                    £{(event.coverPriceCents / 100).toFixed(2)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-0.5">Cover charge per person</p>
                </div>

                {spotsLeft !== null && (
                  <div className="text-center">
                    {soldOut ? (
                      <Badge variant="destructive" className="text-sm px-3 py-1">Sold Out</Badge>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground">{spotsLeft}</span> spots remaining
                      </p>
                    )}
                  </div>
                )}

                {currentUser ? (
                  <Button
                    className="w-full bg-gradient-to-r from-purple-600 to-pink-500 hover:from-purple-700 hover:to-pink-600 text-white"
                    onClick={() => createPaymentMutation.mutate(event.id)}
                    disabled={createPaymentMutation.isPending || soldOut || !event.isActive}
                    data-testid="button-buy-ticket"
                  >
                    <TicketIcon className="h-4 w-4 mr-2" />
                    {soldOut ? "Sold Out" : createPaymentMutation.isPending ? "Loading..." : "Buy Ticket"}
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <Link href="/login">
                      <Button className="w-full" variant="default">
                        Log in to Buy Ticket
                      </Button>
                    </Link>
                    <Link href="/signup">
                      <Button className="w-full" variant="outline">
                        Sign up
                      </Button>
                    </Link>
                  </div>
                )}

                {/* Key event details */}
                <div className="space-y-2 pt-2 border-t text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <CalendarIcon className="h-4 w-4 flex-shrink-0 text-primary" />
                    <span>{format(new Date(event.date), "EEE, MMM d, yyyy")}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <ClockIcon className="h-4 w-4 flex-shrink-0 text-primary" />
                    <span>
                      {format(new Date(event.date), "h:mm a")}
                      {ev.endTime && ` — ${format(new Date(ev.endTime), "h:mm a")}`}
                    </span>
                  </div>
                  {(venue.address || venue.city) && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MapPinIcon className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span>{venue.address || venue.city}</span>
                    </div>
                  )}
                  {event.capacity && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <UsersIcon className="h-4 w-4 flex-shrink-0 text-primary" />
                      <span>Capacity: {event.capacity}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <BottomNavigation />

      {/* Payment dialog */}
      <Dialog open={!!clientSecret} onOpenChange={() => handleClosePayment()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purchase Entry Ticket</DialogTitle>
            <DialogDescription>
              Entry to {venue.name} on {format(new Date(event.date), "EEEE, MMMM d 'at' h:mm a")}
            </DialogDescription>
          </DialogHeader>
          {clientSecret && (
            <SimulatedPaymentForm
              event={event}
              paymentIntentId={paymentIntentId || ""}
              provider={paymentProvider}
              onSuccess={handlePaymentSuccess}
              onCancel={handleClosePayment}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Success dialog */}
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
