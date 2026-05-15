import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { ObjectUploader } from "@/components/ObjectUploader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  ArrowLeft, Calendar, PoundSterling, Users, Plus, Edit, Trash2,
  Ticket, Clock, CheckCircle, XCircle, TrendingUp, Upload, ImageIcon,
  X as XIcon, DoorOpen, UtensilsCrossed, Wine, LogOut,
} from "lucide-react";
import { format, isPast, isFuture } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Venue, VenueEntryNight, InsertVenueEntryNight } from "@shared/schema";

interface VenueEventFormData {
  name: string;
  date: string;
  endTime: string;
  doorsCloseTime: string;
  lastCallTime: string;
  kitchenCloseTime: string;
  coverPriceCents: string;
  capacity: string;
  description: string;
  imageUrl: string;
  isActive: boolean;
}

const emptyForm: VenueEventFormData = {
  name: "",
  date: "",
  endTime: "",
  doorsCloseTime: "",
  lastCallTime: "",
  kitchenCloseTime: "",
  coverPriceCents: "",
  capacity: "",
  description: "",
  imageUrl: "",
  isActive: true,
};

function toDatetimeLocal(val: string | Date | null | undefined): string {
  if (!val) return "";
  try {
    return format(new Date(val as string), "yyyy-MM-dd'T'HH:mm");
  } catch {
    return "";
  }
}

export default function VenueEventsPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<VenueEntryNight | null>(null);
  const [formData, setFormData] = useState<VenueEventFormData>(emptyForm);

  const { data: venue, isLoading: venueLoading } = useQuery<Venue>({
    queryKey: ["/api/venues", venueId],
    enabled: !!venueId,
  });

  const { data: venueEvents = [], isLoading: eventsLoading } = useQuery<VenueEntryNight[]>({
    queryKey: ["/api/venues", venueId, "venue-events"],
    queryFn: async () => {
      const res = await fetch(`/api/venues/${venueId}/venue-events`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!venueId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertVenueEntryNight>) =>
      await apiRequest("POST", `/api/venues/${venueId}/venue-events`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "venue-events"] });
      toast({ title: "Venue event created successfully" });
      handleCloseModal();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create venue event", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<InsertVenueEntryNight> }) =>
      await apiRequest("PATCH", `/api/venue-events/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "venue-events"] });
      toast({ title: "Venue event updated successfully" });
      handleCloseModal();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update venue event", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/venue-events/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/venues", venueId, "venue-events"] });
      toast({ title: "Venue event deleted" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete venue event", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenCreate = () => {
    setEditingEvent(null);
    setFormData(emptyForm);
    setModalOpen(true);
  };

  const handleOpenEdit = (event: VenueEntryNight) => {
    setEditingEvent(event);
    setFormData({
      name: event.name,
      date: toDatetimeLocal(event.date),
      endTime: toDatetimeLocal((event as any).endTime),
      doorsCloseTime: toDatetimeLocal((event as any).doorsCloseTime),
      lastCallTime: toDatetimeLocal((event as any).lastCallTime),
      kitchenCloseTime: toDatetimeLocal((event as any).kitchenCloseTime),
      coverPriceCents: (event.coverPriceCents / 100).toFixed(2),
      capacity: event.capacity?.toString() || "",
      description: event.description || "",
      imageUrl: (event as any).imageUrl || "",
      isActive: event.isActive,
    });
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setEditingEvent(null);
    setFormData(emptyForm);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const toDateOrNull = (val: string) => val ? new Date(val) : null;
    const data: Partial<InsertVenueEntryNight> & { imageUrl?: string | null; endTime?: Date | null; doorsCloseTime?: Date | null; lastCallTime?: Date | null; kitchenCloseTime?: Date | null } = {
      name: formData.name,
      date: new Date(formData.date),
      endTime: toDateOrNull(formData.endTime),
      doorsCloseTime: toDateOrNull(formData.doorsCloseTime),
      lastCallTime: toDateOrNull(formData.lastCallTime),
      kitchenCloseTime: toDateOrNull(formData.kitchenCloseTime),
      coverPriceCents: Math.round(parseFloat(formData.coverPriceCents) * 100),
      capacity: formData.capacity ? parseInt(formData.capacity) : null,
      description: formData.description || null,
      imageUrl: formData.imageUrl || null,
      isActive: formData.isActive,
    };
    if (editingEvent) {
      updateMutation.mutate({ id: editingEvent.id, data: data as Partial<InsertVenueEntryNight> });
    } else {
      createMutation.mutate(data as Partial<InsertVenueEntryNight>);
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete "${name}"? This cannot be undone.`)) {
      deleteMutation.mutate(id);
    }
  };

  const upcomingEvents = venueEvents.filter(e => isFuture(new Date(e.date)));
  const pastEvents = venueEvents.filter(e => isPast(new Date(e.date)));

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
          <Link href="/manage-venues">
            <Button><ArrowLeft className="h-4 w-4 mr-2" />Back to Venues</Button>
          </Link>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  const VenueEventCard = ({ event }: { event: VenueEntryNight }) => {
    const isUpcoming = isFuture(new Date(event.date));
    const capacityUsed = event.capacity ? (event.ticketsSold / event.capacity) * 100 : 0;
    const revenue = (event.ticketsSold * event.coverPriceCents) / 100;
    const ev = event as any;

    return (
      <Card className="overflow-hidden" data-testid={`card-venue-event-${event.id}`}>
        {ev.imageUrl && (
          <div className="relative h-40 overflow-hidden">
            <img src={ev.imageUrl} alt={event.name} className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          </div>
        )}
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <CardTitle className="text-lg line-clamp-1">{event.name}</CardTitle>
              <CardDescription className="flex items-center gap-2 mt-1">
                <Calendar className="h-4 w-4" />
                {format(new Date(event.date), "EEEE, MMMM d, yyyy 'at' h:mm a")}
              </CardDescription>
              {ev.endTime && (
                <CardDescription className="flex items-center gap-2 mt-0.5">
                  <LogOut className="h-3.5 w-3.5" />
                  Ends {format(new Date(ev.endTime), "h:mm a")}
                </CardDescription>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              {event.isActive ? (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  <CheckCircle className="h-3 w-3 mr-1" />Active
                </Badge>
              ) : (
                <Badge variant="secondary"><XCircle className="h-3 w-3 mr-1" />Inactive</Badge>
              )}
              {isUpcoming && (
                <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Upcoming</Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Time details */}
          {(ev.doorsCloseTime || ev.lastCallTime || ev.kitchenCloseTime) && (
            <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-muted/50 text-sm">
              {ev.doorsCloseTime && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <DoorOpen className="h-3.5 w-3.5 text-orange-500 flex-shrink-0" />
                  <span>Doors close {format(new Date(ev.doorsCloseTime), "h:mm a")}</span>
                </div>
              )}
              {ev.lastCallTime && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Wine className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />
                  <span>Last call {format(new Date(ev.lastCallTime), "h:mm a")}</span>
                </div>
              )}
              {ev.kitchenCloseTime && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <UtensilsCrossed className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                  <span>Kitchen closes {format(new Date(ev.kitchenCloseTime), "h:mm a")}</span>
                </div>
              )}
            </div>
          )}

          {event.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{event.description}</p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Cover Price</p>
              <p className="text-lg font-semibold flex items-center" data-testid={`text-event-price-${event.id}`}>
                <PoundSterling className="h-4 w-4" />{(event.coverPriceCents / 100).toFixed(2)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Tickets Sold</p>
              <p className="text-lg font-semibold flex items-center" data-testid={`text-event-tickets-${event.id}`}>
                <Ticket className="h-4 w-4 mr-1" />{event.ticketsSold}
              </p>
            </div>
            {event.capacity && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Capacity</p>
                <p className="text-lg font-semibold flex items-center" data-testid={`text-event-capacity-${event.id}`}>
                  <Users className="h-4 w-4 mr-1" />{event.capacity}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Revenue</p>
              <p className="text-lg font-semibold flex items-center text-green-600 dark:text-green-400" data-testid={`text-event-revenue-${event.id}`}>
                <TrendingUp className="h-4 w-4 mr-1" />£{revenue.toFixed(2)}
              </p>
            </div>
          </div>

          {event.capacity && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Capacity</span>
                <span>{event.ticketsSold} / {event.capacity} ({capacityUsed.toFixed(0)}%)</span>
              </div>
              <Progress value={capacityUsed} className="h-2" />
            </div>
          )}
        </CardContent>

        <CardFooter className="flex gap-2 pt-4 border-t">
          <Button variant="outline" size="sm" onClick={() => handleOpenEdit(event)} data-testid={`button-edit-event-${event.id}`}>
            <Edit className="h-4 w-4 mr-2" />Edit
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/venue-events/${event.id}`}>
              <Ticket className="h-4 w-4 mr-2" />View Public Page
            </Link>
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={() => handleDelete(event.id, event.name)}
            disabled={deleteMutation.isPending}
            data-testid={`button-delete-event-${event.id}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </CardFooter>
      </Card>
    );
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-4 mb-2">
          <Link href="/manage-venues">
            <Button variant="ghost" size="sm" data-testid="button-back-venues">
              <ArrowLeft className="h-4 w-4 mr-2" />Back to Venues
            </Button>
          </Link>
        </div>

        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-serif font-bold" data-testid="heading-venue-events">
              Venue Events
            </h1>
            <p className="text-muted-foreground mt-1" data-testid="text-venue-name">{venue.name}</p>
          </div>
          <Button onClick={handleOpenCreate} data-testid="button-create-venue-event">
            <Plus className="h-4 w-4 mr-2" />Add Venue Event
          </Button>
        </div>

        <Tabs defaultValue="upcoming" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2 mb-8">
            <TabsTrigger value="upcoming" data-testid="tab-upcoming">
              Upcoming ({upcomingEvents.length})
            </TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">
              Past ({pastEvents.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming">
            {eventsLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" />
              </div>
            ) : upcomingEvents.length === 0 ? (
              <Card className="p-16">
                <div className="text-center space-y-4">
                  <Calendar className="h-16 w-16 mx-auto text-muted-foreground" />
                  <div>
                    <h3 className="text-xl font-semibold mb-2">No upcoming events</h3>
                    <p className="text-muted-foreground mb-4">Create a venue event to start selling tickets</p>
                    <Button onClick={handleOpenCreate}>
                      <Plus className="h-4 w-4 mr-2" />Add Venue Event
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {upcomingEvents.map(event => <VenueEventCard key={event.id} event={event} />)}
              </div>
            )}
          </TabsContent>

          <TabsContent value="past">
            {eventsLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" />
              </div>
            ) : pastEvents.length === 0 ? (
              <div className="text-center py-16">
                <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No past events</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {pastEvents.map(event => <VenueEventCard key={event.id} event={event} />)}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <BottomNavigation />

      {/* ── Create / Edit Modal ── */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] p-0 overflow-hidden">
          {/* Gradient header */}
          <div className="px-6 pt-6 pb-5 bg-gradient-to-br from-purple-600 via-purple-500 to-pink-500">
            <DialogHeader>
              <DialogTitle className="font-serif text-2xl text-white">
                {editingEvent ? "Edit Venue Event" : "Add Venue Event"}
              </DialogTitle>
              <DialogDescription className="text-purple-100">
                {editingEvent ? "Update the details for this event" : "Create a new ticketed event at your venue"}
              </DialogDescription>
            </DialogHeader>
          </div>

          <ScrollArea className="max-h-[calc(90vh-100px)]">
            <form onSubmit={handleSubmit} className="p-6 space-y-5">

              {/* Thumbnail Image */}
              <div className="space-y-2">
                <Label>Event Thumbnail</Label>
                <div className="flex items-center gap-3">
                  {formData.imageUrl ? (
                    <div className="relative flex-shrink-0">
                      <img
                        src={formData.imageUrl}
                        alt="Event thumbnail"
                        className="h-20 w-32 rounded-xl object-cover border shadow-sm"
                      />
                      <Button
                        type="button" size="icon" variant="ghost"
                        className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground shadow"
                        onClick={() => setFormData(prev => ({ ...prev, imageUrl: "" }))}
                      >
                        <XIcon className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="h-20 w-32 rounded-xl border-2 border-dashed flex items-center justify-center bg-muted/50 flex-shrink-0">
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  <ObjectUploader
                    maxNumberOfFiles={1}
                    maxFileSizeMB={5}
                    onComplete={(urls: string[]) => {
                      if (urls[0]) {
                        setFormData(prev => ({ ...prev, imageUrl: urls[0] }));
                        toast({ title: "Thumbnail uploaded" });
                      }
                    }}
                    buttonVariant="outline"
                    buttonSize="sm"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Upload Image
                  </ObjectUploader>
                </div>
              </div>

              {/* Event Name */}
              <div className="space-y-2">
                <Label htmlFor="name">Event Name <span className="text-destructive">*</span></Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Friday Night Party, Latin Night, Live Jazz Evening"
                  required
                  data-testid="input-event-name"
                />
              </div>

              {/* Start + End Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="date">Event Starts <span className="text-destructive">*</span></Label>
                  <Input
                    id="date"
                    type="datetime-local"
                    value={formData.date}
                    onChange={e => setFormData(prev => ({ ...prev, date: e.target.value }))}
                    required
                    data-testid="input-event-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endTime">Event Ends</Label>
                  <Input
                    id="endTime"
                    type="datetime-local"
                    value={formData.endTime}
                    onChange={e => setFormData(prev => ({ ...prev, endTime: e.target.value }))}
                    data-testid="input-event-end-time"
                  />
                </div>
              </div>

              {/* Doors Close + Last Call */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="doorsCloseTime">
                    <DoorOpen className="h-3.5 w-3.5 inline mr-1 text-orange-500" />
                    Doors Close
                  </Label>
                  <Input
                    id="doorsCloseTime"
                    type="datetime-local"
                    value={formData.doorsCloseTime}
                    onChange={e => setFormData(prev => ({ ...prev, doorsCloseTime: e.target.value }))}
                    data-testid="input-event-doors-close"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastCallTime">
                    <Wine className="h-3.5 w-3.5 inline mr-1 text-purple-500" />
                    Last Call <span className="text-muted-foreground text-xs">(optional)</span>
                  </Label>
                  <Input
                    id="lastCallTime"
                    type="datetime-local"
                    value={formData.lastCallTime}
                    onChange={e => setFormData(prev => ({ ...prev, lastCallTime: e.target.value }))}
                    data-testid="input-event-last-call"
                  />
                </div>
              </div>

              {/* Kitchen Close */}
              <div className="space-y-2">
                <Label htmlFor="kitchenCloseTime">
                  <UtensilsCrossed className="h-3.5 w-3.5 inline mr-1 text-blue-500" />
                  Kitchen Closes <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <Input
                  id="kitchenCloseTime"
                  type="datetime-local"
                  value={formData.kitchenCloseTime}
                  onChange={e => setFormData(prev => ({ ...prev, kitchenCloseTime: e.target.value }))}
                  data-testid="input-event-kitchen-close"
                />
              </div>

              {/* Cover Price + Capacity */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="coverPrice">Cover Price (£) <span className="text-destructive">*</span></Label>
                  <Input
                    id="coverPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.coverPriceCents}
                    onChange={e => setFormData(prev => ({ ...prev, coverPriceCents: e.target.value }))}
                    placeholder="10.00"
                    required
                    data-testid="input-event-price"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="capacity">Capacity <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Input
                    id="capacity"
                    type="number"
                    min="1"
                    value={formData.capacity}
                    onChange={e => setFormData(prev => ({ ...prev, capacity: e.target.value }))}
                    placeholder="200"
                    data-testid="input-event-capacity"
                  />
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Describe the theme, music, dress code, or any special features..."
                  rows={3}
                  data-testid="input-event-description"
                />
              </div>

              {/* Active toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={e => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
                  className="rounded border-input"
                  data-testid="checkbox-event-active"
                />
                <Label htmlFor="isActive" className="cursor-pointer">
                  Active — visible and available for ticket purchase
                </Label>
              </div>

              <DialogFooter className="gap-2 pt-2">
                <Button type="button" variant="outline" onClick={handleCloseModal} data-testid="button-cancel-event">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSaving}
                  className="bg-gradient-to-r from-purple-600 to-pink-500 hover:from-purple-700 hover:to-pink-600 text-white min-w-[120px]"
                  data-testid="button-save-event"
                >
                  {isSaving ? "Saving..." : (editingEvent ? "Update Event" : "Create Event")}
                </Button>
              </DialogFooter>
            </form>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
