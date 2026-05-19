import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import { format } from "date-fns";
import { SearchIcon, CheckIcon, XIcon, FlagIcon, Trash2Icon, EyeIcon } from "@/components/ui/icons";

interface Event {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  location: string;
  category: string;
  ticketPrice: number;
  ticketsAvailable: number;
  organizer: {
    id: string;
    username: string;
    organizationName: string | null;
  };
}

export default function AdminEvents() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [moderateDialogOpen, setModerateDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [moderationAction, setModerationAction] = useState<"approve" | "reject" | "flag">("approve");
  const [moderationReason, setModerationReason] = useState("");

  const { data: events, isLoading } = useQuery<Event[]>({
    queryKey: ["/api/admin/events"],
  });

  const moderateMutation = useMutation({
    mutationFn: async (data: { eventId: string; action: string; reason?: string }) => {
      const response = await apiRequest("POST", `/api/admin/events/${data.eventId}/moderate`, {
        action: data.action,
        reason: data.reason,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Event moderated",
        description: `Event has been ${moderationAction}ed successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
      setModerateDialogOpen(false);
      setSelectedEvent(null);
      setModerationReason("");
    },
    onError: (error: any) => {
      toast({
        title: "Moderation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (eventId: string) => {
      await apiRequest("DELETE", `/api/admin/events/${eventId}`);
    },
    onSuccess: () => {
      toast({
        title: "Event deleted",
        description: "The event has been deleted successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/events"] });
    },
    onError: (error: any) => {
      toast({
        title: "Delete failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const filteredEvents = events?.filter(event =>
    event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    event.organizer.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    event.location.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const handleModerate = () => {
    if (selectedEvent) {
      moderateMutation.mutate({
        eventId: selectedEvent.id,
        action: moderationAction,
        reason: moderationReason || undefined,
      });
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Event Management</h1>
          <p className="text-slate-400 mt-1">
            Review, approve, and moderate platform events
          </p>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="relative flex-1 max-w-sm">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  placeholder="Search events..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-search-events"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading events...</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Event</TableHead>
                    <TableHead className="text-slate-400">Organizer</TableHead>
                    <TableHead className="text-slate-400">Date</TableHead>
                    <TableHead className="text-slate-400">Price</TableHead>
                    <TableHead className="text-slate-400">Category</TableHead>
                    <TableHead className="text-slate-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.map((event) => (
                    <TableRow key={event.id} className="border-slate-700">
                      <TableCell>
                        <div>
                          <p className="font-medium text-white">{event.title}</p>
                          <p className="text-sm text-slate-400 truncate max-w-[200px]">{event.location}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {event.organizer.organizationName || event.organizer.username}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {format(new Date(event.eventDate), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {event.ticketPrice === 0 ? 'Free' : `£${(event.ticketPrice / 100).toFixed(2)}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-slate-500 text-slate-400">
                          {event.category}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-green-400 hover:text-green-300"
                            onClick={() => {
                              setSelectedEvent(event);
                              setModerationAction("approve");
                              setModerateDialogOpen(true);
                            }}
                            data-testid={`button-approve-event-${event.id}`}
                          >
                            <CheckIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-400 hover:text-red-300"
                            onClick={() => {
                              setSelectedEvent(event);
                              setModerationAction("reject");
                              setModerateDialogOpen(true);
                            }}
                            data-testid={`button-reject-event-${event.id}`}
                          >
                            <XIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-amber-400 hover:text-amber-300"
                            onClick={() => {
                              setSelectedEvent(event);
                              setModerationAction("flag");
                              setModerateDialogOpen(true);
                            }}
                            data-testid={`button-flag-event-${event.id}`}
                          >
                            <FlagIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-slate-400 hover:text-red-400"
                            onClick={() => {
                              if (confirm("Are you sure you want to delete this event?")) {
                                deleteMutation.mutate(event.id);
                              }
                            }}
                            data-testid={`button-delete-event-${event.id}`}
                          >
                            <Trash2Icon className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={moderateDialogOpen} onOpenChange={setModerateDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white capitalize">{moderationAction} Event</DialogTitle>
              <DialogDescription className="text-slate-400">
                {moderationAction === "approve" && "Approve this event to make it visible on the platform."}
                {moderationAction === "reject" && "Reject this event. It will not be visible on the platform."}
                {moderationAction === "flag" && "Flag this event for further review."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <p className="text-white font-medium">{selectedEvent?.title}</p>
                <p className="text-sm text-slate-400">by {selectedEvent?.organizer.organizationName || selectedEvent?.organizer.username}</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Reason (optional)</Label>
                <Textarea
                  value={moderationReason}
                  onChange={(e) => setModerationReason(e.target.value)}
                  placeholder="Enter a reason for this action..."
                  className="bg-slate-700/50 border-slate-600 text-white"
                  data-testid="input-moderation-reason"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setModerateDialogOpen(false)}
                className="border-slate-600"
              >
                Cancel
              </Button>
              <Button
                variant={moderationAction === "approve" ? "default" : moderationAction === "reject" ? "destructive" : "outline"}
                onClick={handleModerate}
                disabled={moderateMutation.isPending}
                className={moderationAction === "approve" ? "bg-green-600 hover:bg-green-700" : moderationAction === "flag" ? "border-amber-500 text-amber-400" : ""}
                data-testid="button-confirm-moderation"
              >
                {moderateMutation.isPending ? "Processing..." : `${moderationAction.charAt(0).toUpperCase() + moderationAction.slice(1)} Event`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
