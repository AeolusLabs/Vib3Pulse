import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatMoney } from "@/lib/currency";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AdminLayout from "./AdminLayout";
import AdminFilterBar from "@/components/admin/AdminFilterBar";
import AdminPagination from "@/components/admin/AdminPagination";
import { exportToCsv } from "@/lib/exportToCsv";
import { format } from "date-fns";
import { CheckIcon, XIcon, FlagIcon, Trash2Icon, DownloadIcon } from "@/components/ui/icons";

const PAGE_LIMIT = 50;

interface Event {
  id: string;
  title: string;
  description: string;
  eventDate: string;
  location: string;
  category: string;
  ticketPrice: number;
  ticketsAvailable: number;
  moderationStatus: string;
  sourceType?: 'event' | 'venue_entry';
  currency?: string;
  country?: string;
  organizer: {
    id: string;
    username: string;
    organizationName: string | null;
  };
}

const statusBadge = (status: string) => {
  switch (status) {
    case "approved": return <Badge variant="outline" className="border-green-500 text-green-400">Approved</Badge>;
    case "flagged":  return <Badge variant="outline" className="border-amber-500 text-amber-400">Flagged</Badge>;
    case "rejected": return <Badge variant="outline" className="border-red-500 text-red-400">Rejected</Badge>;
    default:         return <Badge variant="outline" className="border-slate-500 text-slate-400">Pending</Badge>;
  }
};

export default function AdminEvents() {
  const { toast } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [country, setCountry] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [activeTab, setActiveTab] = useState("all");
  const [moderateDialogOpen, setModerateDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [moderationAction, setModerationAction] = useState<"approved" | "rejected" | "flagged">("approved");
  const [moderationReason, setModerationReason] = useState("");

  // Debounce the search box ~300ms before it drives a server round-trip, and
  // reset back to the first page whenever the effective search term changes.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Currency/country are real server-side filters too, so changing either
  // one needs to reset pagination the same way search does.
  useEffect(() => {
    setOffset(0);
  }, [currency, country]);

  const queryUrl = (() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    params.set("offset", String(offset));
    if (search.trim()) params.set("search", search.trim());
    if (currency) params.set("currency", currency);
    if (country) params.set("country", country);
    return `/api/admin/events?${params.toString()}`;
  })();

  // The endpoint used to return a raw array; it now returns
  // { events: [...], total } so pagination can work across the full dataset.
  const { data, isLoading } = useQuery<{ events: Event[]; total: number }>({
    queryKey: [queryUrl],
  });

  // The query key is now the full "/api/admin/events?limit=...&offset=..."
  // URL (so each page/search/filter combo caches separately), so a plain
  // invalidateQueries({ queryKey: ["/api/admin/events"] }) no longer matches
  // it by prefix — match by predicate on the URL prefix instead.
  const invalidateEvents = () => {
    queryClient.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/admin/events"),
    });
  };

  const moderateMutation = useMutation({
    mutationFn: async (data: { eventId: string; action: string; reason?: string; sourceType?: string }) => {
      const endpoint = data.sourceType === 'venue_entry'
        ? `/api/admin/venue-events/${data.eventId}/moderate`
        : `/api/admin/events/${data.eventId}/moderate`;
      const response = await apiRequest("POST", endpoint, {
        action: data.action,
        reason: data.reason,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Event moderated", description: `Event has been ${moderationAction} successfully` });
      invalidateEvents();
      setModerateDialogOpen(false);
      setSelectedEvent(null);
      setModerationReason("");
    },
    onError: (error: any) => {
      toast({ title: "Moderation failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (event: Event) => {
      // The DELETE route used to always hit the main events table, which
      // either silently no-opped or deleted the wrong row for venue-sourced
      // entries. It now reads an explicit sourceType query param to route
      // correctly, so that must be appended whenever the row came from the
      // venue_entry source.
      const url = event.sourceType === 'venue_entry'
        ? `/api/admin/events/${event.id}?sourceType=venue_entry`
        : `/api/admin/events/${event.id}`;
      await apiRequest("DELETE", url);
    },
    onSuccess: () => {
      toast({ title: "Event deleted", description: "The event has been deleted successfully" });
      invalidateEvents();
    },
    onError: (error: any) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const allEvents = data?.events || [];
  const total = data?.total || 0;

  // Moderation-status tabs stay a client-side filter over whatever page is
  // currently loaded (status isn't a server-side filter param on this
  // endpoint) — only search/currency/country/pagination are real server
  // round-trips now.
  const counts = {
    all:      allEvents.length,
    pending:  allEvents.filter(e => e.moderationStatus === "pending").length,
    flagged:  allEvents.filter(e => e.moderationStatus === "flagged").length,
    approved: allEvents.filter(e => e.moderationStatus === "approved").length,
    rejected: allEvents.filter(e => e.moderationStatus === "rejected").length,
  };

  const filtered = allEvents.filter(e => activeTab === "all" || e.moderationStatus === activeTab);

  const handleModerate = () => {
    if (selectedEvent) {
      moderateMutation.mutate({
        eventId: selectedEvent.id,
        action: moderationAction,
        reason: moderationReason || undefined,
        sourceType: selectedEvent.sourceType,
      });
    }
  };

  const handleExport = () => {
    exportToCsv(
      "events",
      filtered.map((e) => ({
        id: e.id,
        title: e.title,
        sourceType: e.sourceType || "event",
        organizer: e.organizer.organizationName || e.organizer.username,
        date: e.eventDate,
        location: e.location,
        price: e.ticketPrice,
        currency: e.currency,
        country: e.country,
        status: e.moderationStatus,
      }))
    );
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Event Management</h1>
          <p className="text-slate-400 mt-1">Review, approve, and moderate platform events</p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-slate-800 border border-slate-700">
            <TabsTrigger value="all" className="data-[state=active]:bg-purple-600">
              All {counts.all > 0 && `(${counts.all})`}
            </TabsTrigger>
            <TabsTrigger value="pending" className="data-[state=active]:bg-purple-600">
              Pending {counts.pending > 0 && `(${counts.pending})`}
            </TabsTrigger>
            <TabsTrigger value="flagged" className="data-[state=active]:bg-amber-600 data-[state=active]:text-white">
              Flagged {counts.flagged > 0 && `(${counts.flagged})`}
            </TabsTrigger>
            <TabsTrigger value="approved" className="data-[state=active]:bg-green-700">
              Approved {counts.approved > 0 && `(${counts.approved})`}
            </TabsTrigger>
            <TabsTrigger value="rejected" className="data-[state=active]:bg-red-700">
              Rejected {counts.rejected > 0 && `(${counts.rejected})`}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <AdminFilterBar
                search={searchInput}
                onSearchChange={setSearchInput}
                searchPlaceholder="Search events..."
                currency={currency}
                onCurrencyChange={setCurrency}
                country={country}
                onCountryChange={setCountry}
              />
              <Button
                variant="outline"
                size="sm"
                className="border-slate-600 text-slate-300 shrink-0"
                onClick={handleExport}
                disabled={filtered.length === 0}
                data-testid="button-export-events"
              >
                <DownloadIcon className="w-4 h-4 mr-2" /> Export
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading events...</div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                No {activeTab !== "all" ? activeTab : ""} events found
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Event</TableHead>
                    <TableHead className="text-slate-400">Organizer</TableHead>
                    <TableHead className="text-slate-400">Date</TableHead>
                    <TableHead className="text-slate-400">Price</TableHead>
                    <TableHead className="text-slate-400">Status</TableHead>
                    <TableHead className="text-slate-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((event) => (
                    <TableRow key={event.id} className="border-slate-700">
                      <TableCell>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-white">{event.title}</p>
                            {event.sourceType === 'venue_entry' && (
                              <Badge variant="outline" className="border-blue-500 text-blue-400 text-xs">Venue</Badge>
                            )}
                          </div>
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
                        {event.ticketPrice === 0 ? 'Free' : formatMoney(event.ticketPrice, event.currency)}
                      </TableCell>
                      <TableCell>{statusBadge(event.moderationStatus)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm" variant="ghost"
                            className="text-green-400 hover:text-green-300"
                            onClick={() => { setSelectedEvent(event); setModerationAction("approved"); setModerateDialogOpen(true); }}
                            data-testid={`button-approve-event-${event.id}`}
                          >
                            <CheckIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm" variant="ghost"
                            className="text-red-400 hover:text-red-300"
                            onClick={() => { setSelectedEvent(event); setModerationAction("rejected"); setModerateDialogOpen(true); }}
                            data-testid={`button-reject-event-${event.id}`}
                          >
                            <XIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm" variant="ghost"
                            className="text-amber-400 hover:text-amber-300"
                            onClick={() => { setSelectedEvent(event); setModerationAction("flagged"); setModerateDialogOpen(true); }}
                            data-testid={`button-flag-event-${event.id}`}
                          >
                            <FlagIcon className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm" variant="ghost"
                            className="text-slate-400 hover:text-red-400"
                            onClick={() => { if (confirm("Are you sure you want to delete this event?")) deleteMutation.mutate(event); }}
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
            <AdminPagination offset={offset} limit={PAGE_LIMIT} total={total} onOffsetChange={setOffset} />
          </CardContent>
        </Card>

        <Dialog open={moderateDialogOpen} onOpenChange={setModerateDialogOpen}>
          <DialogContent className="bg-slate-800 border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-white capitalize">{moderationAction} Event</DialogTitle>
              <DialogDescription className="text-slate-400">
                {moderationAction === "approved" && "Approve this event to make it visible on the platform."}
                {moderationAction === "rejected"  && "Reject this event. It will not be visible on the platform."}
                {moderationAction === "flagged"    && "Flag this event for further review."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <p className="text-white font-medium">{selectedEvent?.title}</p>
                <p className="text-sm text-slate-400">
                  by {selectedEvent?.organizer.organizationName || selectedEvent?.organizer.username}
                </p>
                <div className="mt-2">{selectedEvent && statusBadge(selectedEvent.moderationStatus)}</div>
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
              <Button variant="outline" onClick={() => setModerateDialogOpen(false)} className="border-slate-600">
                Cancel
              </Button>
              <Button
                variant={moderationAction === "approved" ? "default" : moderationAction === "rejected" ? "destructive" : "outline"}
                onClick={handleModerate}
                disabled={moderateMutation.isPending}
                className={
                  moderationAction === "approved" ? "bg-green-600 hover:bg-green-700" :
                  moderationAction === "flagged"  ? "border-amber-500 text-amber-400 hover:bg-amber-500/10" : ""
                }
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
