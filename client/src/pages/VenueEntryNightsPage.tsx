import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { 
  ArrowLeft, 
  Calendar, 
  DollarSign, 
  Users, 
  Plus, 
  Edit, 
  Trash2,
  Ticket,
  Clock,
  CheckCircle,
  XCircle,
  TrendingUp
} from "lucide-react";
import { format, isPast, isFuture } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Venue, VenueEntryNight, InsertVenueEntryNight } from "@shared/schema";

interface EntryNightFormData {
  name: string;
  date: string;
  coverPriceCents: string;
  capacity: string;
  description: string;
  isActive: boolean;
}

const initialFormData: EntryNightFormData = {
  name: "",
  date: "",
  coverPriceCents: "",
  capacity: "",
  description: "",
  isActive: true,
};

export default function VenueEntryNightsPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const { toast } = useToast();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingNight, setEditingNight] = useState<VenueEntryNight | null>(null);
  const [formData, setFormData] = useState<EntryNightFormData>(initialFormData);

  const { data: venue, isLoading: venueLoading } = useQuery<Venue>({
    queryKey: ["/api/venues", venueId],
    enabled: !!venueId,
  });

  const { data: entryNights = [], isLoading: nightsLoading } = useQuery<VenueEntryNight[]>({
    queryKey: ["/api/venues", venueId, "entry-nights"],
    enabled: !!venueId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertVenueEntryNight>) => {
      return await apiRequest("POST", `/api/venues/${venueId}/entry-nights`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "entry-nights"] });
      toast({ title: "Entry night created successfully" });
      handleCloseModal();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create entry night", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<InsertVenueEntryNight> }) => {
      return await apiRequest("PATCH", `/api/entry-nights/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "entry-nights"] });
      toast({ title: "Entry night updated successfully" });
      handleCloseModal();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update entry night", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/entry-nights/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "entry-nights"] });
      toast({ title: "Entry night deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete entry night", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenCreate = () => {
    setEditingNight(null);
    setFormData(initialFormData);
    setCreateModalOpen(true);
  };

  const handleOpenEdit = (night: VenueEntryNight) => {
    setEditingNight(night);
    setFormData({
      name: night.name,
      date: format(new Date(night.date), "yyyy-MM-dd'T'HH:mm"),
      coverPriceCents: (night.coverPriceCents / 100).toFixed(2),
      capacity: night.capacity?.toString() || "",
      description: night.description || "",
      isActive: night.isActive,
    });
    setCreateModalOpen(true);
  };

  const handleCloseModal = () => {
    setCreateModalOpen(false);
    setEditingNight(null);
    setFormData(initialFormData);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const data: Partial<InsertVenueEntryNight> = {
      name: formData.name,
      date: new Date(formData.date),
      coverPriceCents: Math.round(parseFloat(formData.coverPriceCents) * 100),
      capacity: formData.capacity ? parseInt(formData.capacity) : null,
      description: formData.description || null,
      isActive: formData.isActive,
    };

    if (editingNight) {
      updateMutation.mutate({ id: editingNight.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) {
      deleteMutation.mutate(id);
    }
  };

  const upcomingNights = entryNights.filter(n => isFuture(new Date(n.date)));
  const pastNights = entryNights.filter(n => isPast(new Date(n.date)));

  if (venueLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-4 w-32 mb-8" />
          <Skeleton className="h-64 w-full" />
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
          <Link href="/manage-venues">
            <Button>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Venues
            </Button>
          </Link>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const EntryNightCard = ({ night }: { night: VenueEntryNight }) => {
    const isUpcoming = isFuture(new Date(night.date));
    const capacityUsed = night.capacity ? (night.ticketsSold / night.capacity) * 100 : 0;
    const revenue = (night.ticketsSold * night.coverPriceCents) / 100;

    return (
      <Card className="overflow-hidden" data-testid={`card-entry-night-${night.id}`}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <CardTitle className="text-lg line-clamp-1">{night.name}</CardTitle>
              <CardDescription className="flex items-center gap-2 mt-1">
                <Calendar className="h-4 w-4" />
                {format(new Date(night.date), "EEEE, MMMM d, yyyy 'at' h:mm a")}
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              {night.isActive ? (
                <Badge variant="default" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Active
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <XCircle className="h-3 w-3 mr-1" />
                  Inactive
                </Badge>
              )}
              {isUpcoming && (
                <Badge variant="outline">
                  <Clock className="h-3 w-3 mr-1" />
                  Upcoming
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {night.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{night.description}</p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Cover Price</p>
              <p className="text-lg font-semibold flex items-center" data-testid={`text-night-price-${night.id}`}>
                <DollarSign className="h-4 w-4" />
                {(night.coverPriceCents / 100).toFixed(2)}
              </p>
            </div>
            
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Tickets Sold</p>
              <p className="text-lg font-semibold flex items-center" data-testid={`text-night-tickets-${night.id}`}>
                <Ticket className="h-4 w-4 mr-1" />
                {night.ticketsSold}
              </p>
            </div>

            {night.capacity && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Capacity</p>
                <p className="text-lg font-semibold flex items-center" data-testid={`text-night-capacity-${night.id}`}>
                  <Users className="h-4 w-4 mr-1" />
                  {night.capacity}
                </p>
              </div>
            )}

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Revenue</p>
              <p className="text-lg font-semibold flex items-center text-green-600 dark:text-green-400" data-testid={`text-night-revenue-${night.id}`}>
                <TrendingUp className="h-4 w-4 mr-1" />
                ${revenue.toFixed(2)}
              </p>
            </div>
          </div>

          {night.capacity && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Capacity</span>
                <span>{night.ticketsSold} / {night.capacity} ({capacityUsed.toFixed(0)}%)</span>
              </div>
              <Progress value={capacityUsed} className="h-2" />
            </div>
          )}
        </CardContent>

        <CardFooter className="flex gap-2 pt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenEdit(night)}
            data-testid={`button-edit-night-${night.id}`}
          >
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDelete(night.id, night.name)}
            disabled={deleteMutation.isPending}
            data-testid={`button-delete-night-${night.id}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </CardFooter>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-4 mb-2">
          <Link href="/manage-venues">
            <Button variant="ghost" size="sm" data-testid="button-back-venues">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Venues
            </Button>
          </Link>
        </div>

        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-serif font-bold" data-testid="heading-entry-nights">
              Entry Nights
            </h1>
            <p className="text-muted-foreground mt-1" data-testid="text-venue-name">
              {venue.name}
            </p>
          </div>
          <Button onClick={handleOpenCreate} data-testid="button-create-entry-night">
            <Plus className="h-4 w-4 mr-2" />
            Add Entry Night
          </Button>
        </div>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">
              Upcoming ({upcomingNights.length})
            </TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">
              Past ({pastNights.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            {nightsLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : upcomingNights.length === 0 ? (
              <Card className="p-16">
                <div className="text-center space-y-4">
                  <Calendar className="h-16 w-16 mx-auto text-muted-foreground" />
                  <div>
                    <h3 className="text-xl font-semibold mb-2">No upcoming entry nights</h3>
                    <p className="text-muted-foreground mb-4">
                      Create an entry night to start selling tickets
                    </p>
                    <Button onClick={handleOpenCreate}>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Entry Night
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {upcomingNights.map((night) => (
                  <EntryNightCard key={night.id} night={night} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="past">
            {nightsLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : pastNights.length === 0 ? (
              <div className="text-center py-16">
                <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No past entry nights</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {pastNights.map((night) => (
                  <EntryNightCard key={night.id} night={night} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <BottomNavigation />

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">
              {editingNight ? "Edit Entry Night" : "Add Entry Night"}
            </DialogTitle>
            <DialogDescription>
              {editingNight 
                ? "Update the details for this entry night" 
                : "Create a new entry night with cover charge for your venue"}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Event Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Friday Night Party, Latin Night"
                required
                data-testid="input-night-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="date">Date & Time *</Label>
              <Input
                id="date"
                type="datetime-local"
                value={formData.date}
                onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                required
                data-testid="input-night-date"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="coverPrice">Cover Price ($) *</Label>
                <Input
                  id="coverPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.coverPriceCents}
                  onChange={(e) => setFormData(prev => ({ ...prev, coverPriceCents: e.target.value }))}
                  placeholder="10.00"
                  required
                  data-testid="input-night-price"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="capacity">Capacity (optional)</Label>
                <Input
                  id="capacity"
                  type="number"
                  min="1"
                  value={formData.capacity}
                  onChange={(e) => setFormData(prev => ({ ...prev, capacity: e.target.value }))}
                  placeholder="100"
                  data-testid="input-night-capacity"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Describe the theme, music, or special features..."
                rows={3}
                data-testid="input-night-description"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isActive"
                checked={formData.isActive}
                onChange={(e) => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
                className="rounded border-input"
                data-testid="checkbox-night-active"
              />
              <Label htmlFor="isActive" className="cursor-pointer">
                Active (visible and available for purchase)
              </Label>
            </div>

            <DialogFooter className="gap-2">
              <Button 
                type="button" 
                variant="outline" 
                onClick={handleCloseModal}
                data-testid="button-cancel-night"
              >
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-save-night"
              >
                {(createMutation.isPending || updateMutation.isPending) 
                  ? "Saving..." 
                  : (editingNight ? "Update" : "Create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
