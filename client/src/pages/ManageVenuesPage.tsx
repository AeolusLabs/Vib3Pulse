import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { useState } from "react";
import { Edit, Trash2, BarChart3, MapPin, Clock, Music, Calendar, Megaphone, Sparkles, Building2, Plus, DollarSign } from "lucide-react";
import { Link } from "wouter";
import CreateVenueModal from "@/components/CreateVenueModal";
import { PromoteVenueDialog } from "@/components/PromoteVenueDialog";
import { VenueAnalytics } from "@/components/VenueAnalytics";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Venue } from "@shared/schema";

export default function ManageVenuesPage() {
  const [createVenueOpen, setCreateVenueOpen] = useState(false);
  const [editingVenue, setEditingVenue] = useState<Venue | undefined>(undefined);
  const [promoteVenueId, setPromoteVenueId] = useState<string | null>(null);
  const [promoteVenueName, setPromoteVenueName] = useState<string>("");
  const [showAnalyticsFor, setShowAnalyticsFor] = useState<string | null>(null);
  const { toast } = useToast();
  
  const { data: venues = [], isLoading } = useQuery<Venue[]>({
    queryKey: ["/api/my-venues"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (venueId: string) => {
      await apiRequest("DELETE", `/api/venues/${venueId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-venues"] });
      toast({ title: "Venue deleted successfully" });
    },
    onError: () => {
      toast({ title: "Failed to delete venue", variant: "destructive" });
    },
  });

  const now = new Date();
  const activeVenues = venues.filter(v => {
    if (!v.isPromoted) return true;
    const promotedUntil = v.promotedUntil ? new Date(v.promotedUntil) : null;
    return !promotedUntil || promotedUntil > now;
  });
  
  const promotedVenues = venues.filter(v => {
    const promotedUntil = v.promotedUntil ? new Date(v.promotedUntil) : null;
    return v.isPromoted && promotedUntil && promotedUntil > now;
  });

  const handleEditVenue = (venue: Venue) => {
    setEditingVenue(venue);
    setCreateVenueOpen(true);
  };

  const handleDeleteVenue = (venueId: string) => {
    if (confirm("Are you sure you want to delete this venue?")) {
      deleteMutation.mutate(venueId);
    }
  };

  const handlePromoteVenue = (venueId: string, venueName: string) => {
    setPromoteVenueId(venueId);
    setPromoteVenueName(venueName);
  };

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
    comedy_club: "Comedy Club"
  };

  const VenueManagementCard = ({ venue }: { venue: Venue }) => {
    const isPromoted = venue.isPromoted && venue.promotedUntil && new Date(venue.promotedUntil) > now;
    
    return (
      <Card className="overflow-hidden">
        <CardHeader className="p-0">
          <div className="relative h-48">
            <img
              src={venue.coverImageUrl || venue.imageUrl || "/placeholder-venue.jpg"}
              alt={venue.name}
              className="w-full h-full object-cover"
            />
            <div className="absolute top-2 right-2 flex flex-col gap-1">
              {isPromoted && (
                <Badge className="bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                  <Sparkles className="h-3 w-3 mr-1" />
                  Featured
                </Badge>
              )}
              {venue.isVerified && (
                <Badge className="bg-blue-500 text-white">Verified</Badge>
              )}
            </div>
            <div className="absolute bottom-2 left-2">
              <Badge variant="secondary" className="bg-background/90">
                {categoryLabels[venue.category] || venue.category}
              </Badge>
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="pt-4 space-y-3">
          <div>
            <h3 className="font-semibold text-lg line-clamp-1" data-testid={`text-venue-name-${venue.id}`}>
              {venue.name}
            </h3>
          </div>

          <div className="space-y-1 text-sm text-muted-foreground">
            <p className="flex items-center gap-2" data-testid={`text-venue-address-${venue.id}`}>
              <MapPin className="h-4 w-4 flex-shrink-0" />
              <span className="line-clamp-1">{venue.address || venue.city || "Location not set"}</span>
            </p>
            {venue.musicTypes && Array.isArray(venue.musicTypes) && venue.musicTypes.length > 0 && (
              <p className="flex items-center gap-2">
                <Music className="h-4 w-4 flex-shrink-0" />
                <span className="line-clamp-1">{venue.musicTypes.slice(0, 2).join(", ")}</span>
              </p>
            )}
            {venue.ageRestriction && (
              <p className="flex items-center gap-2">
                <Building2 className="h-4 w-4 flex-shrink-0" />
                <span>{venue.ageRestriction}+ only</span>
              </p>
            )}
          </div>
        </CardContent>

        <CardFooter className="flex flex-wrap gap-2 pt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleEditVenue(venue)}
            data-testid={`button-edit-venue-${venue.id}`}
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
          
          <Button
            variant="outline"
            size="sm"
            asChild
            data-testid={`button-manage-nights-${venue.id}`}
          >
            <Link href={`/venues/${venue.id}/entry-nights`}>
              <Calendar className="h-4 w-4 mr-2" />
              Entry Nights
            </Link>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAnalyticsFor(showAnalyticsFor === venue.id ? null : venue.id)}
            data-testid={`button-view-stats-${venue.id}`}
          >
            <BarChart3 className="h-4 w-4 mr-2" />
            Stats
          </Button>

          {!isPromoted && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePromoteVenue(venue.id, venue.name)}
              className="text-purple-600 border-purple-300 hover:bg-purple-50"
              data-testid={`button-promote-${venue.id}`}
            >
              <Megaphone className="h-4 w-4 mr-2" />
              Promote
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDeleteVenue(venue.id)}
            disabled={deleteMutation.isPending}
            data-testid={`button-delete-venue-${venue.id}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </CardFooter>
        
        {showAnalyticsFor === venue.id && (
          <div className="px-6 pb-6">
            <VenueAnalytics venueId={venue.id} />
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <h1 className="text-3xl font-serif font-bold" data-testid="heading-manage-venues">
            Manage Venues
          </h1>
          <Button onClick={() => { setEditingVenue(undefined); setCreateVenueOpen(true); }} data-testid="button-create-new-venue">
            <Plus className="h-4 w-4 mr-2" />
            Add New Venue
          </Button>
        </div>

        <Tabs defaultValue="all" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="all" data-testid="tab-all-venues">
              All Venues ({venues.length})
            </TabsTrigger>
            <TabsTrigger value="promoted" data-testid="tab-promoted">
              Featured ({promotedVenues.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading venues...</p>
              </div>
            ) : venues.length === 0 ? (
              <Card className="p-16">
                <div className="text-center space-y-4">
                  <Building2 className="h-16 w-16 mx-auto text-muted-foreground" />
                  <div>
                    <h3 className="text-xl font-semibold mb-2">No venues yet</h3>
                    <p className="text-muted-foreground mb-4">
                      Add your first venue to start selling entry tickets
                    </p>
                    <Button onClick={() => { setEditingVenue(undefined); setCreateVenueOpen(true); }}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Your First Venue
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {venues.map((venue) => (
                  <VenueManagementCard key={venue.id} venue={venue} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="promoted">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading venues...</p>
              </div>
            ) : promotedVenues.length === 0 ? (
              <div className="text-center py-16">
                <Sparkles className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No promoted venues</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Promote your venues to get more visibility
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {promotedVenues.map((venue) => (
                  <VenueManagementCard key={venue.id} venue={venue} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <BottomNavigation />

      <CreateVenueModal 
        open={createVenueOpen} 
        onOpenChange={setCreateVenueOpen}
        editingVenue={editingVenue}
      />

      <PromoteVenueDialog
        open={!!promoteVenueId}
        onOpenChange={(open: boolean) => !open && setPromoteVenueId(null)}
        venueId={promoteVenueId || ""}
        venueName={promoteVenueName}
      />
    </div>
  );
}
