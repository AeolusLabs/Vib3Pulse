import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { useState } from "react";

import { Link, useLocation } from "wouter";
import CreateEventModal from "@/components/CreateEventModal";
import EventDetailsModal from "@/components/EventDetailsModal";
import { PromoteEventDialog } from "@/components/PromoteEventDialog";
import { EventAnalytics } from "@/components/EventAnalytics";
import { PageHeader } from "@/components/manage/PageHeader";
import { UnderlineTabs } from "@/components/manage/UnderlineTabs";
import { StatusChip } from "@/components/manage/StatusChip";
import { CapacityBar } from "@/components/manage/CapacityBar";
import { ConfirmDialog } from "@/components/manage/ConfirmDialog";
import yogaEvent from '@assets/generated_images/Outdoor_yoga_wellness_event_c02f75d1.png';
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Event as DBEvent } from "@shared/schema";
import {
  EditIcon, Trash2Icon, BarChart3Icon, EyeIcon, EyeOffIcon, CalendarIcon, MapPinIcon, QrCodeIcon,
  MegaphoneIcon, DownloadIcon, MessageSquareIcon, SearchIcon, MoreHorizontalIcon, PlusIcon, AlertTriangleIcon,
} from "@/components/ui/icons";
import { formatMoney } from "@/lib/currency";

interface Event {
  id: string;
  title: string;
  image: string;
  date: string;
  time: string;
  dateMs: number;
  location: string;
  type: string;
  status: 'published' | 'draft' | 'completed';
  ticketsSold: number;
  totalTickets: number;
  revenue: number; // smallest currency unit (pence/kobo)
  currency: string;
  isPublished: boolean;
  isPromoted: boolean;
  promotedUntil: Date | null;
  moderationStatus: string;
}

type TabKey = "published" | "drafts" | "past";
type SortKey = "date" | "sold";

const MODERATION_NOTE: Record<string, string> = {
  pending: "Under review. Not visible to attendees yet.",
  rejected: "Rejected. Not visible to attendees. Contact support for details.",
  flagged: "Flagged for review. Visibility may be restricted.",
};

interface RowProps {
  event: Event;
  statsOpen: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleStats: () => void;
  onTogglePublish: () => void;
  onPromote: () => void;
  onGroupChat: () => void;
  onDelete: () => void;
  groupChatBusy: boolean;
}

// Defined at module level (not inside the page) so rows keep their state across re-renders.
function EventRow({ event, statsOpen, onOpen, onEdit, onToggleStats, onTogglePublish, onPromote, onGroupChat, onDelete, groupChatBusy }: RowProps) {
  const isDraft = event.status === "draft";
  const isPast = event.status === "completed";
  const note = MODERATION_NOTE[event.moderationStatus];
  const modKind = event.moderationStatus === "pending" ? "review" : event.moderationStatus === "rejected" ? "rejected" : event.moderationStatus === "flagged" ? "flagged" : null;

  return (
    <li className="group/row" data-testid={`event-row-${event.id}`}>
      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 p-4 transition-colors duration-150 hover:bg-muted/30 sm:p-5 md:grid-cols-[104px_minmax(0,1fr)_230px_auto]">
        <button
          type="button"
          onClick={onOpen}
          className="relative aspect-square overflow-hidden rounded-xl bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:aspect-[4/3]"
          aria-label={`View ${event.title}`}
        >
          <img src={event.image} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover/row:scale-[1.03] motion-reduce:transition-none" />
        </button>

        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {isPast ? <StatusChip kind="ended" /> : isDraft ? <StatusChip kind="draft" /> : <StatusChip kind="live" />}
            {event.isPromoted && <StatusChip kind="promoted" />}
            {modKind && !isPast && <StatusChip kind={modKind} />}
            <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{event.type}</span>
          </div>
          <button type="button" onClick={onOpen} className="block max-w-full text-left focus-visible:outline-none focus-visible:underline">
            <h3 className="line-clamp-2 text-base font-semibold leading-snug sm:text-lg" data-testid={`text-event-title-${event.id}`}>
              {event.title}
            </h3>
          </button>
          <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            <p className="flex items-center gap-2" data-testid={`text-event-date-${event.id}`}>
              <CalendarIcon className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{event.date} · {event.time}</span>
            </p>
            <p className="flex items-center gap-2" data-testid={`text-event-location-${event.id}`}>
              <MapPinIcon className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{event.location}</span>
            </p>
          </div>
          {note && !isPast && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
        </div>

        {!isDraft ? (
          <div className="col-span-2 md:col-span-1">
            <CapacityBar sold={event.ticketsSold} total={event.totalTickets} />
            {event.revenue > 0 && (
              <p className="mt-2 flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">Revenue</span>
                <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400" data-testid={`text-revenue-${event.id}`}>
                  {formatMoney(event.revenue, event.currency)}
                </span>
              </p>
            )}
          </div>
        ) : (
          <p className="col-span-2 text-xs text-muted-foreground md:col-span-1">Not published yet. Attendees can't see this event.</p>
        )}

        <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:justify-end">
          <Button variant="outline" size="sm" className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out" onClick={onEdit} data-testid={`button-edit-event-${event.id}`}>
            <EditIcon className="mr-2 h-4 w-4" />Edit
          </Button>
          {!isDraft && (
            <Button variant="outline" size="sm" asChild className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out" data-testid={`button-check-in-${event.id}`}>
              <Link href={`/events/${event.id}/check-in`}><QrCodeIcon className="mr-2 h-4 w-4" />Check-in</Link>
            </Button>
          )}
          {!isDraft && (
            <Button
              variant={statsOpen ? "secondary" : "ghost"}
              size="sm"
              className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out"
              onClick={onToggleStats}
              aria-expanded={statsOpen}
              data-testid={`button-view-stats-${event.id}`}
            >
              <BarChart3Icon className="mr-2 h-4 w-4" />Stats
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`More actions for ${event.title}`} data-testid={`button-more-${event.id}`}>
                <MoreHorizontalIcon className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              {!isDraft && (
                <DropdownMenuItem className="min-h-[40px]" onSelect={() => { const a = document.createElement("a"); a.href = `/api/events/${event.id}/guestlist.csv`; a.click(); }} data-testid={`button-guestlist-${event.id}`}>
                  <DownloadIcon className="mr-2 h-4 w-4" />Download guestlist
                </DropdownMenuItem>
              )}
              {!isDraft && (
                <DropdownMenuItem className="min-h-[40px]" disabled={groupChatBusy} onSelect={onGroupChat} data-testid={`button-group-chat-${event.id}`}>
                  <MessageSquareIcon className="mr-2 h-4 w-4" />Open group chat
                </DropdownMenuItem>
              )}
              {event.status === "published" && (
                <DropdownMenuItem className="min-h-[40px]" onSelect={onPromote} data-testid={`button-promote-${event.id}`}>
                  <MegaphoneIcon className="mr-2 h-4 w-4" />{event.isPromoted ? "Manage promotion" : "Promote"}
                </DropdownMenuItem>
              )}
              {!isPast && (
                <DropdownMenuItem className="min-h-[40px]" onSelect={onTogglePublish} data-testid={`button-toggle-publish-${event.id}`}>
                  {event.isPublished ? <><EyeOffIcon className="mr-2 h-4 w-4" />Unpublish</> : <><EyeIcon className="mr-2 h-4 w-4" />Publish</>}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-[40px] text-destructive focus:text-destructive" onSelect={onDelete} data-testid={`button-delete-event-${event.id}`}>
                <Trash2Icon className="mr-2 h-4 w-4" />Delete event
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {statsOpen && (
        <div className="px-4 pb-5 sm:px-5 animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          <EventAnalytics eventId={event.id} />
        </div>
      )}
    </li>
  );
}

function RowSkeleton() {
  return (
    <li className="grid grid-cols-[72px_1fr] gap-4 p-4 md:grid-cols-[104px_1fr_230px]">
      <Skeleton className="aspect-square rounded-xl md:aspect-[4/3]" />
      <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-5 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      <Skeleton className="col-span-2 h-10 md:col-span-1" />
    </li>
  );
}

export default function ManageEventsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<DBEvent | undefined>(undefined);
  const [viewingEvent, setViewingEvent] = useState<DBEvent | null>(null);
  const [promoteEventId, setPromoteEventId] = useState<string | null>(null);
  const [promoteEventTitle, setPromoteEventTitle] = useState<string>("");
  const [promoteEventCurrency, setPromoteEventCurrency] = useState<string>("GBP");
  const [promoteEventIsPromoted, setPromoteEventIsPromoted] = useState<boolean>(false);
  const [promoteEventPromotedUntil, setPromoteEventPromotedUntil] = useState<Date | null>(null);
  const [showAnalyticsFor, setShowAnalyticsFor] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("published");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [pendingDelete, setPendingDelete] = useState<Event | null>(null);

  // Fetch real events from API
  const { data: dbEvents = [], isLoading } = useQuery<DBEvent[]>({
    queryKey: ["/api/events/my-events"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (eventId: string) => {
      await apiRequest("DELETE", `/api/events/${eventId}`);
    },
    onSuccess: () => {
      toast({ title: "Event deleted", description: "Your event has been removed." });
      queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
    },
    onError: (error: any) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const groupChatMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const res = await apiRequest("POST", `/api/events/${eventId}/group-chat`, {});
      return res.json();
    },
    onSuccess: (conversation) => {
      navigate(`/messages/${conversation.id}`);
    },
    onError: (error: any) => {
      toast({ title: "Couldn't create group chat", description: error.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async ({ eventId, published }: { eventId: string; published: boolean }) => {
      const res = await apiRequest("PATCH", `/api/events/${eventId}/publish`, { published });
      return res.json();
    },
    onSuccess: (_, variables) => {
      toast({
        title: variables.published ? "Event published" : "Event unpublished",
        description: variables.published
          ? "Your event is now visible to attendees."
          : "Your event is now hidden from attendees.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/events/my-events"] });
    },
    onError: (error: any) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  // Transform DB events to UI format
  const now = new Date();
  const transformEvent = (event: DBEvent): Event => {
    const eventDate = new Date(event.eventDate);
    const isPast = eventDate < now;
    const promotedUntil = event.promotedUntil ? new Date(event.promotedUntil) : null;
    const isCurrentlyPromoted = event.isPromoted && promotedUntil && promotedUntil > now;

    return {
      id: event.id,
      title: event.title,
      image: event.imageUrl || yogaEvent,
      date: eventDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      time: eventDate.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }),
      dateMs: eventDate.getTime(),
      location: event.location,
      type: event.category,
      // "Draft" reuses the existing isPublished flag rather than a separate
      // column — an event an organizer has never published, or has
      // unpublished, reads identically from their side: not visible to
      // attendees, needs (re)publishing. The Publish/Unpublish toggle below
      // already only exposed this one lever, so no new schema concept needed.
      status: isPast ? 'completed' : (event.isPublished ? 'published' : 'draft'),
      ticketsSold: event.ticketsSold,
      totalTickets: event.ticketsAvailable,
      revenue: (event as any).revenue ?? 0,
      currency: (event as any).currency || "GBP",
      isPublished: event.isPublished ?? true,
      isPromoted: isCurrentlyPromoted || false,
      promotedUntil: promotedUntil,
      moderationStatus: event.moderationStatus ?? 'pending',
    };
  };

  const allEvents = dbEvents.map(transformEvent);
  const publishedEvents = allEvents.filter(e => e.status === 'published');
  const draftEvents = allEvents.filter(e => e.status === 'draft');
  const pastEvents = allEvents.filter(e => e.status === 'completed');
  const needsAttention = allEvents.filter(e => e.status !== 'completed' && (e.moderationStatus === 'rejected' || e.moderationStatus === 'flagged'));

  const q = query.trim().toLowerCase();
  const view = (list: Event[], newestFirst: boolean) =>
    list
      .filter(e => !q || e.title.toLowerCase().includes(q) || e.location.toLowerCase().includes(q))
      .sort((a, b) => (sort === "sold" ? b.ticketsSold - a.ticketsSold : newestFirst ? b.dateMs - a.dateMs : a.dateMs - b.dateMs));

  const handlePromoteEvent = (e: Event) => {
    setPromoteEventId(e.id);
    setPromoteEventTitle(e.title);
    setPromoteEventCurrency(e.currency || "GBP");
    setPromoteEventIsPromoted(e.isPromoted);
    setPromoteEventPromotedUntil(e.promotedUntil);
  };

  const handleEditEvent = (eventId: string) => {
    const event = dbEvents.find(e => e.id === eventId);
    if (event) {
      setEditingEvent(event);
      setCreateEventOpen(true);
    }
  };

  const handleViewDetails = (eventId: string) => {
    const dbEvent = dbEvents.find(e => e.id === eventId);
    if (dbEvent) setViewingEvent(dbEvent);
  };

  const renderList = (list: Event[], emptyTitle: string, emptyBody: string, showCreate: boolean) => {
    if (isLoading) {
      return <ul className="divide-y rounded-2xl border bg-card">{[0, 1, 2].map(i => <RowSkeleton key={i} />)}</ul>;
    }
    if (list.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed px-6 py-14 text-center">
          <p className="font-medium">{q ? "No events match your search" : emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{q ? "Try a different name or place." : emptyBody}</p>
          {showCreate && !q && (
            <Button className="mt-5 min-h-[44px] rounded-full" onClick={() => setCreateEventOpen(true)}>
              <PlusIcon className="mr-2 h-4 w-4" />Create an event
            </Button>
          )}
        </div>
      );
    }
    return (
      <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
        {list.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            statsOpen={showAnalyticsFor === event.id}
            onOpen={() => handleViewDetails(event.id)}
            onEdit={() => handleEditEvent(event.id)}
            onToggleStats={() => setShowAnalyticsFor(showAnalyticsFor === event.id ? null : event.id)}
            onTogglePublish={() => publishMutation.mutate({ eventId: event.id, published: !event.isPublished })}
            onPromote={() => handlePromoteEvent(event)}
            onGroupChat={() => groupChatMutation.mutate(event.id)}
            onDelete={() => setPendingDelete(event)}
            groupChatBusy={groupChatMutation.isPending}
          />
        ))}
      </ul>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader
          eyebrow="Organiser"
          title="Manage events"
          titleTestId="heading-manage-events"
          summary={isLoading ? "Loading your events…" : `${publishedEvents.length} live · ${draftEvents.length} ${draftEvents.length === 1 ? "draft" : "drafts"} · ${pastEvents.length} past`}
          actions={
            <>
              <Link href="/organizer/payouts">
                <Button variant="outline" className="min-h-[44px] rounded-full" data-testid="button-payouts">Payouts</Button>
              </Link>
              <Button className="min-h-[44px] rounded-full active:scale-[0.97] transition-transform duration-150 ease-out" onClick={() => setCreateEventOpen(true)} data-testid="button-create-new-event">
                <PlusIcon className="mr-2 h-4 w-4" />Create event
              </Button>
            </>
          }
        />

        {needsAttention.length > 0 && (
          <section aria-labelledby="attention-heading" className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 sm:p-5" data-testid="needs-attention">
            <h2 id="attention-heading" className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangleIcon className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              Needs your attention
            </h2>
            <ul className="mt-3 divide-y divide-amber-500/20">
              {needsAttention.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <StatusChip kind={e.moderationStatus === "rejected" ? "rejected" : "flagged"} />
                      <span className="truncate">{e.title}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{MODERATION_NOTE[e.moderationStatus]}</p>
                  </div>
                  <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => handleEditEvent(e.id)}>Review event</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          <UnderlineTabs
            value={tab}
            items={[
              { value: "published", label: "Live", count: publishedEvents.length, testId: "tab-published" },
              { value: "drafts", label: "Drafts", count: draftEvents.length, testId: "tab-drafts" },
              { value: "past", label: "Past", count: pastEvents.length, testId: "tab-past" },
            ]}
          />

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or place"
                aria-label="Search your events"
                className="h-11 rounded-full pl-10"
                data-testid="input-search-events"
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="h-11 w-full rounded-full sm:w-[190px]" aria-label="Sort events" data-testid="select-sort-events">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">{tab === "past" ? "Most recent first" : "Soonest first"}</SelectItem>
                <SelectItem value="sold">Most tickets sold</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <TabsContent value="published" className="mt-5">
            {renderList(view(publishedEvents, false), "Nothing live right now", "Publish an event and it shows up here with live sales.", true)}
          </TabsContent>
          <TabsContent value="drafts" className="mt-5">
            {renderList(view(draftEvents, false), "No drafts", "Events you unpublish or haven't published yet wait here.", false)}
          </TabsContent>
          <TabsContent value="past" className="mt-5">
            {renderList(view(pastEvents, true), "No past events yet", "Finished events and their results will be kept here.", false)}
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

      {viewingEvent && (
        <EventDetailsModal
          event={viewingEvent}
          onClose={() => setViewingEvent(null)}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete "${pendingDelete?.title ?? ""}"?`}
        description="This removes the event and can't be undone. Events with paid tickets can't be deleted until they're refunded."
        confirmLabel="Delete event"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      {promoteEventId && (
        <PromoteEventDialog
          eventId={promoteEventId}
          eventTitle={promoteEventTitle}
          currency={promoteEventCurrency}
          isPromoted={promoteEventIsPromoted}
          promotedUntil={promoteEventPromotedUntil}
          isOpen={!!promoteEventId}
          onClose={() => {
            setPromoteEventId(null);
            setPromoteEventTitle("");
            setPromoteEventCurrency("GBP");
            setPromoteEventIsPromoted(false);
            setPromoteEventPromotedUntil(null);
          }}
        />
      )}

      <BottomNavigation onCreateClick={() => setCreateEventOpen(true)} />
    </div>
  );
}
