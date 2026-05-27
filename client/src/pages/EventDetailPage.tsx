import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import EventDetailsModal from "@/components/EventDetailsModal";
import type { Event } from "@shared/schema";

export default function EventDetailPage() {
  const [, params] = useRoute("/event/:id");
  const eventId = params?.id;
  const { data: user } = useAuth();

  const { data: event, isLoading } = useQuery<Event>({
    queryKey: ["/api/events", eventId],
    enabled: !!eventId,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Event not found</p>
      </div>
    );
  }

  const modStatus = (event as any).moderationStatus;
  if (user?.id !== event.organizerId && modStatus && modStatus !== "approved") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">This event is not publicly available</p>
      </div>
    );
  }

  return (
    <EventDetailsModal
      event={event}
      onClose={() => window.history.back()}
    />
  );
}