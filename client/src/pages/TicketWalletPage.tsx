import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Ticket as TicketIcon, QrCode, Loader2, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import BottomNavigation from "@/components/BottomNavigation";
import type { Ticket as TicketType, Event } from "@shared/schema";

type TicketWithEvent = TicketType & { event: Event };

function TicketQRCode({ ticketId }: { ticketId: string }) {
  const [showQR, setShowQR] = useState(false);
  const { data: qrData, isLoading } = useQuery<{ qrCode: string }>({
    queryKey: [`/api/tickets/${ticketId}/qr`],
    enabled: showQR,
  });

  return (
    <div className="mt-4">
      <Button
        variant="outline"
        size="default"
        onClick={() => setShowQR(!showQR)}
        className="w-full"
        data-testid={`button-show-qr-${ticketId}`}
      >
        <QrCode className="h-4 w-4 mr-2" />
        {showQR ? "Hide QR Code" : "Show QR Code"}
      </Button>
      
      {showQR && (
        <div className="mt-4 flex flex-col items-center justify-center p-4 bg-background rounded-md border">
          {isLoading ? (
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          ) : qrData?.qrCode ? (
            <div className="space-y-2">
              <img 
                src={qrData.qrCode} 
                alt="Ticket QR Code" 
                className="w-64 h-64"
                data-testid={`img-qr-${ticketId}`}
              />
              <p className="text-xs text-center text-muted-foreground">
                Show this QR code at the event entrance
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Failed to load QR code</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function TicketWalletPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);

  // Handle success/cancel redirects from payment
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    
    if (params.get('success') === 'true' && sessionId && !isVerifyingPayment) {
      // Verify the payment and create the ticket
      setIsVerifyingPayment(true);
      apiRequest('POST', '/api/tickets/verify-payment', { sessionId })
        .then(async (response) => {
          await response.json();
          // Refetch tickets to show the newly purchased ticket
          queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
          toast({
            title: "Ticket purchased!",
            description: "Your ticket has been added to your wallet.",
          });
        })
        .catch(() => {
          toast({
            title: "Verification failed",
            description: "Unable to verify your purchase. Please contact support.",
            variant: "destructive",
          });
        })
        .finally(() => {
          setIsVerifyingPayment(false);
          // Clean up URL
          window.history.replaceState({}, '', '/ticket-wallet');
        });
    } else if (params.get('canceled') === 'true') {
      toast({
        title: "Purchase canceled",
        description: "Your ticket purchase was canceled.",
        variant: "destructive",
      });
      // Clean up URL
      window.history.replaceState({}, '', '/ticket-wallet');
    }
  }, [toast, isVerifyingPayment]);

  const { data: tickets, isLoading } = useQuery<TicketWithEvent[]>({
    queryKey: ["/api/tickets"],
  });

  const now = new Date();
  const upcomingTickets = tickets?.filter(ticket => new Date(ticket.event.eventDate) >= now) || [];
  const pastTickets = tickets?.filter(ticket => new Date(ticket.event.eventDate) < now) || [];

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="container flex h-16 items-center gap-4 px-4">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => navigate("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <TicketIcon className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-bold font-display" data-testid="heading-ticket-wallet">My Tickets</h1>
          </div>
        </div>
      </header>

      <main className="container px-4 py-6 max-w-4xl mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-6">

        <Tabs defaultValue="upcoming" className="w-full" data-testid="tabs-tickets">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">
              Upcoming ({upcomingTickets.length})
            </TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">
              Past ({pastTickets.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="space-y-4 mt-6" data-testid="content-upcoming">
            {upcomingTickets.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center text-muted-foreground">
                  <TicketIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No upcoming tickets</p>
                  <p className="text-sm mt-2">Purchase tickets from the Discover page to see them here</p>
                </CardContent>
              </Card>
            ) : (
              upcomingTickets.map((ticket) => (
                <Card key={ticket.id} className="hover-elevate" data-testid={`ticket-${ticket.id}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <CardTitle className="text-xl" data-testid={`ticket-title-${ticket.id}`}>
                          {ticket.event.title}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          <div className="flex items-center gap-2 mt-1">
                            <Calendar className="h-4 w-4" />
                            <span data-testid={`ticket-date-${ticket.id}`}>
                              {format(new Date(ticket.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <MapPin className="h-4 w-4" />
                            <span data-testid={`ticket-location-${ticket.id}`}>{ticket.event.location}</span>
                          </div>
                        </CardDescription>
                      </div>
                      <Badge variant="default" data-testid={`ticket-status-${ticket.id}`}>
                        {ticket.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <TicketQRCode ticketId={ticket.id} />
                  </CardContent>
                  <CardFooter className="text-sm text-muted-foreground">
                    Purchased on {format(new Date(ticket.purchaseDate), "MMM d, yyyy")}
                  </CardFooter>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="past" className="space-y-4 mt-6" data-testid="content-past">
            {pastTickets.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center text-muted-foreground">
                  <TicketIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No past tickets</p>
                </CardContent>
              </Card>
            ) : (
              pastTickets.map((ticket) => (
                <Card key={ticket.id} className="opacity-75" data-testid={`ticket-${ticket.id}`}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <CardTitle className="text-xl" data-testid={`ticket-title-${ticket.id}`}>
                          {ticket.event.title}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          <div className="flex items-center gap-2 mt-1">
                            <Calendar className="h-4 w-4" />
                            <span data-testid={`ticket-date-${ticket.id}`}>
                              {format(new Date(ticket.event.eventDate), "EEEE, MMMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <MapPin className="h-4 w-4" />
                            <span data-testid={`ticket-location-${ticket.id}`}>{ticket.event.location}</span>
                          </div>
                        </CardDescription>
                      </div>
                      <Badge variant="secondary" data-testid={`ticket-status-${ticket.id}`}>
                        Attended
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardFooter className="text-sm text-muted-foreground">
                    Purchased on {format(new Date(ticket.purchaseDate), "MMM d, yyyy")}
                  </CardFooter>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
          </div>
        )}
      </main>

      <BottomNavigation />
    </div>
  );
}
