import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { useState } from "react";
import { Edit, Trash2, BarChart3, Eye, EyeOff, Calendar, MapPin } from "lucide-react";
import CreateEventModal from "@/components/CreateEventModal";
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import { useQuery } from "@tanstack/react-query";
import type { Event as DBEvent } from "@shared/schema";

interface Event {
  id: string;
  title: string;
  image: string;
  date: string;
  time: string;
  location: string;
  type: string;
  status: 'published' | 'draft' | 'completed';
  ticketsSold: number;
  totalTickets: number;
  revenue: number;
  isPublished: boolean;
}

export default function ManageEventsPage() {
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<DBEvent | undefined>(undefined);
  
  // Fetch real events from API
  const { data: dbEvents = [], isLoading } = useQuery<DBEvent[]>({
    queryKey: ["/api/events/my-events"],
  });

  // Transform DB events to UI format
  const now = new Date();
  const transformEvent = (event: DBEvent): Event => {
    const eventDate = new Date(event.eventDate);
    const isPast = eventDate < now;
    
    return {
      id: event.id,
      title: event.title,
      image: event.imageUrl || yogaEvent,
      date: eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      location: event.location,
      type: event.category,
      status: isPast ? 'completed' : 'published',
      ticketsSold: 0, // TODO: Get from tickets table
      totalTickets: event.ticketsAvailable,
      revenue: 0, // TODO: Calculate from sold tickets
      isPublished: true, // TODO: Add isPublished field to schema
    };
  };

  const allEvents = dbEvents.map(transformEvent);
  const publishedEvents = allEvents.filter(e => e.status === 'published');
  const draftEvents: Event[] = []; // TODO: Add draft status to schema
  const pastEvents = allEvents.filter(e => e.status === 'completed');

  const handleEditEvent = (eventId: string) => {
    const event = dbEvents.find(e => e.id === eventId);
    if (event) {
      setEditingEvent(event);
      setCreateEventOpen(true);
    }
  };

  const handleDeleteEvent = (eventId: string) => {
    console.log('Delete event:', eventId);
    //todo: implement delete functionality
  };

  const handleViewStats = (eventId: string) => {
    console.log('View stats for event:', eventId);
    //todo: implement stats view
  };

  const handleTogglePublish = (eventId: string, currentStatus: boolean) => {
    console.log('Toggle publish for event:', eventId, !currentStatus);
    //todo: implement publish/unpublish functionality
  };

  const EventManagementCard = ({ event }: { event: Event }) => (
    <Card className="overflow-hidden">
      <CardHeader className="p-0">
        <div className="relative h-48">
          <img
            src={event.image}
            alt={event.title}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-2 right-2">
            {event.status === 'published' && (
              <Badge className="bg-green-500">Published</Badge>
            )}
            {event.status === 'draft' && (
              <Badge variant="secondary">Draft</Badge>
            )}
            {event.status === 'completed' && (
              <Badge variant="outline">Completed</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="pt-4 space-y-3">
        <div>
          <h3 className="font-semibold text-lg line-clamp-1" data-testid={`text-event-title-${event.id}`}>
            {event.title}
          </h3>
          <Badge variant="secondary" className="mt-1">{event.type}</Badge>
        </div>

        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="flex items-center gap-2" data-testid={`text-event-date-${event.id}`}>
            <Calendar className="h-4 w-4" />
            {event.date} at {event.time}
          </p>
          <p className="flex items-center gap-2" data-testid={`text-event-location-${event.id}`}>
            <MapPin className="h-4 w-4" />
            {event.location}
          </p>
        </div>

        {event.status !== 'draft' && (
          <div className="pt-3 border-t space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Tickets Sold</span>
              <span className="font-semibold" data-testid={`text-tickets-sold-${event.id}`}>
                {event.ticketsSold}{event.totalTickets > 0 && ` / ${event.totalTickets}`}
              </span>
            </div>
            {event.revenue > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Revenue</span>
                <span className="font-semibold text-green-600" data-testid={`text-revenue-${event.id}`}>
                  ${event.revenue.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2 pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleEditEvent(event.id)}
          data-testid={`button-edit-event-${event.id}`}
        >
          <Edit className="h-4 w-4 mr-2" />
          Edit
        </Button>

        {event.status !== 'completed' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleTogglePublish(event.id, event.isPublished)}
            data-testid={`button-toggle-publish-${event.id}`}
          >
            {event.isPublished ? (
              <>
                <EyeOff className="h-4 w-4 mr-2" />
                Unpublish
              </>
            ) : (
              <>
                <Eye className="h-4 w-4 mr-2" />
                Publish
              </>
            )}
          </Button>
        )}

        {event.status !== 'draft' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleViewStats(event.id)}
            data-testid={`button-view-stats-${event.id}`}
          >
            <BarChart3 className="h-4 w-4 mr-2" />
            Stats
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleDeleteEvent(event.id)}
          data-testid={`button-delete-event-${event.id}`}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </CardFooter>
    </Card>
  );

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation userType="organizer" onCreateEvent={() => setCreateEventOpen(true)} />

      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-serif font-bold" data-testid="heading-manage-events">
            Manage Events
          </h1>
          <Button onClick={() => setCreateEventOpen(true)} data-testid="button-create-new-event">
            Create New Event
          </Button>
        </div>

        <Tabs defaultValue="published" className="w-full">
          <TabsList className="grid w-full max-w-lg grid-cols-3 mb-8">
            <TabsTrigger value="published" data-testid="tab-published">
              Published ({publishedEvents.length})
            </TabsTrigger>
            <TabsTrigger value="drafts" data-testid="tab-drafts">
              Drafts ({draftEvents.length})
            </TabsTrigger>
            <TabsTrigger value="past" data-testid="tab-past">
              Past ({pastEvents.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="published">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {publishedEvents.map((event) => (
                    <EventManagementCard key={event.id} event={event} />
                  ))}
                </div>
                {publishedEvents.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No published events yet</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="drafts">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {draftEvents.map((event) => (
                    <EventManagementCard key={event.id} event={event} />
                  ))}
                </div>
                {draftEvents.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No draft events</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="past">
            {isLoading ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">Loading events...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pastEvents.map((event) => (
                    <EventManagementCard key={event.id} event={event} />
                  ))}
                </div>
                {pastEvents.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No past events</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <CreateEventModal
        open={createEventOpen}
        onClose={() => {
          setCreateEventOpen(false);
          setEditingEvent(undefined);
        }}
        event={editingEvent}
      />

      <BottomNavigation onCreateClick={() => setCreateEventOpen(true)} />
    </div>
  );
}
