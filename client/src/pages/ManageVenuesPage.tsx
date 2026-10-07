import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import { useState } from "react";

import { Link } from "wouter";
import CreateVenueModal from "@/components/CreateVenueModal";
import { PromoteVenueDialog } from "@/components/PromoteVenueDialog";
import { VenueAnalytics } from "@/components/VenueAnalytics";
import { PageHeader } from "@/components/manage/PageHeader";
import { UnderlineTabs } from "@/components/manage/UnderlineTabs";
import { StatusChip } from "@/components/manage/StatusChip";
import { ConfirmDialog } from "@/components/manage/ConfirmDialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { Venue } from "@shared/schema";
import {
  EditIcon, Trash2Icon, BarChart3Icon, MapPinIcon, MusicIcon, CalendarIcon, MegaphoneIcon, SparklesIcon,
  Building2Icon, PlusIcon, DollarSignIcon, EyeIcon, SearchIcon, MoreHorizontalIcon,
} from "@/components/ui/icons";

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
  comedy_club: "Comedy Club",
};

const isCurrentlyPromoted = (v: Venue, now = new Date()) =>
  !!(v.isPromoted && v.promotedUntil && new Date(v.promotedUntil) > now);

interface RowProps {
  venue: Venue;
  statsOpen: boolean;
  deleting: boolean;
  onEdit: () => void;
  onToggleStats: () => void;
  onPromote: () => void;
  onDelete: () => void;
}

// Module-level so rows keep their state across page re-renders.
function VenueRow({ venue, statsOpen, deleting, onEdit, onToggleStats, onPromote, onDelete }: RowProps) {
  const promoted = isCurrentlyPromoted(venue);
  const gallery = venue.imageUrls ?? [];
  const music = Array.isArray(venue.musicTypes) ? venue.musicTypes.slice(0, 3).join(", ") : "";

  return (
    <li className="group/row" data-testid={`venue-row-${venue.id}`}>
      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 p-4 transition-colors duration-150 hover:bg-muted/30 sm:p-5 md:grid-cols-[104px_minmax(0,1fr)_auto]">
        <div className="relative aspect-square overflow-hidden rounded-xl bg-muted md:aspect-[4/3]">
          <img
            src={venue.coverImageUrl || venue.imageUrl || "/placeholder-venue.jpg"}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover/row:scale-[1.03] motion-reduce:transition-none"
          />
        </div>

        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {venue.isVerified && <StatusChip kind="verified" />}
            {promoted && <StatusChip kind="promoted" />}
            <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              {categoryLabels[venue.category] || venue.category}
            </span>
          </div>
          <h3 className="line-clamp-2 text-base font-semibold leading-snug sm:text-lg" data-testid={`text-venue-name-${venue.id}`}>
            {venue.name}
          </h3>
          <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            <p className="flex items-center gap-2" data-testid={`text-venue-address-${venue.id}`}>
              <MapPinIcon className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{venue.address || venue.city || "Location not set"}</span>
            </p>
            {music && (
              <p className="flex items-center gap-2">
                <MusicIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{music}</span>
              </p>
            )}
            {venue.ageRestriction && (
              <p className="flex items-center gap-2">
                <Building2Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{venue.ageRestriction}+ only</span>
              </p>
            )}
          </div>
          {gallery.length > 0 && (
            <div className="mt-2.5 flex items-center gap-1.5" aria-label={`${gallery.length} gallery photo${gallery.length === 1 ? "" : "s"}`}>
              {gallery.slice(0, 4).map((url, i) => (
                <img key={i} src={url} alt="" loading="lazy" className="h-9 w-9 rounded-md object-cover" />
              ))}
              {gallery.length > 4 && <span className="text-xs text-muted-foreground">+{gallery.length - 4}</span>}
            </div>
          )}
        </div>

        <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:justify-end">
          <Button variant="outline" size="sm" className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out" onClick={onEdit} data-testid={`button-edit-venue-${venue.id}`}>
            <EditIcon className="mr-2 h-4 w-4" />Edit
          </Button>
          <Button variant="outline" size="sm" asChild className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out" data-testid={`button-manage-events-${venue.id}`}>
            <Link href={`/venues/${venue.id}/venue-events`}><CalendarIcon className="mr-2 h-4 w-4" />Venue events</Link>
          </Button>
          <Button
            variant={statsOpen ? "secondary" : "ghost"}
            size="sm"
            className="min-h-[44px] active:scale-[0.97] transition-transform duration-150 ease-out"
            onClick={onToggleStats}
            aria-expanded={statsOpen}
            data-testid={`button-view-stats-${venue.id}`}
          >
            <BarChart3Icon className="mr-2 h-4 w-4" />Stats
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`More actions for ${venue.name}`} data-testid={`button-more-${venue.id}`}>
                <MoreHorizontalIcon className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem asChild className="min-h-[40px]" data-testid={`button-view-as-visitor-${venue.id}`}>
                <Link href={`/venue/${venue.id}`}><EyeIcon className="mr-2 h-4 w-4" />View as visitor</Link>
              </DropdownMenuItem>
              {!promoted && (
                <DropdownMenuItem className="min-h-[40px]" onSelect={onPromote} data-testid={`button-promote-${venue.id}`}>
                  <MegaphoneIcon className="mr-2 h-4 w-4" />Promote venue
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-[40px] text-destructive focus:text-destructive" disabled={deleting} onSelect={onDelete} data-testid={`button-delete-venue-${venue.id}`}>
                <Trash2Icon className="mr-2 h-4 w-4" />Delete venue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {statsOpen && (
        <div className="px-4 pb-5 sm:px-5 animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none">
          <VenueAnalytics venueId={venue.id} />
        </div>
      )}
    </li>
  );
}

function RowSkeleton() {
  return (
    <li className="grid grid-cols-[72px_1fr] gap-4 p-4 md:grid-cols-[104px_1fr]">
      <Skeleton className="aspect-square rounded-xl md:aspect-[4/3]" />
      <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-5 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
    </li>
  );
}

type TabKey = "all" | "promoted";

export default function ManageVenuesPage() {
  const { data: user, isLoading: authLoading } = useAuth();
  const [createVenueOpen, setCreateVenueOpen] = useState(false);
  const [editingVenue, setEditingVenue] = useState<Venue | undefined>(undefined);
  const [promoteVenueId, setPromoteVenueId] = useState<string | null>(null);
  const [promoteVenueName, setPromoteVenueName] = useState<string>("");
  const [promoteVenueCurrency, setPromoteVenueCurrency] = useState<string>("GBP");
  const [showAnalyticsFor, setShowAnalyticsFor] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Venue | null>(null);
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

  const enableVenuesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/users/me", { canManageVenues: true });
      return res.json();
    },
    onSuccess: (data: any) => {
      // setQueryData, not invalidateQueries — see feedback_auth_pattern.md.
      queryClient.setQueryData(["/api/auth/session"], data);
      toast({ title: "Venue management enabled!", description: "You can now create and manage venues." });
    },
    onError: () => {
      toast({ title: "Failed to enable venue management", variant: "destructive" });
    },
  });

  const openCreate = () => { setEditingVenue(undefined); setCreateVenueOpen(true); };
  const promotedVenues = venues.filter((v) => isCurrentlyPromoted(v));
  const q = query.trim().toLowerCase();
  const filter = (list: Venue[]) =>
    list.filter((v) => !q || v.name.toLowerCase().includes(q) || (v.address ?? "").toLowerCase().includes(q) || (v.city ?? "").toLowerCase().includes(q));

  const renderList = (list: Venue[], emptyTitle: string, emptyBody: string, showCreate: boolean) => {
    if (isLoading) {
      return <ul className="divide-y rounded-2xl border bg-card">{[0, 1, 2].map((i) => <RowSkeleton key={i} />)}</ul>;
    }
    if (list.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed px-6 py-14 text-center">
          <p className="font-medium">{q ? "No venues match your search" : emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{q ? "Try a different name or place." : emptyBody}</p>
          {showCreate && !q && (
            <Button className="mt-5 min-h-[44px] rounded-full" onClick={openCreate}>
              <PlusIcon className="mr-2 h-4 w-4" />Add your first venue
            </Button>
          )}
        </div>
      );
    }
    return (
      <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
        {list.map((venue) => (
          <VenueRow
            key={venue.id}
            venue={venue}
            statsOpen={showAnalyticsFor === venue.id}
            deleting={deleteMutation.isPending}
            onEdit={() => { setEditingVenue(venue); setCreateVenueOpen(true); }}
            onToggleStats={() => setShowAnalyticsFor(showAnalyticsFor === venue.id ? null : venue.id)}
            onPromote={() => { setPromoteVenueId(venue.id); setPromoteVenueName(venue.name); setPromoteVenueCurrency((venue as any).currency || "GBP"); }}
            onDelete={() => setPendingDelete(venue)}
          />
        ))}
      </ul>
    );
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className="mb-8 h-10 w-64" />
          <ul className="divide-y rounded-2xl border bg-card">{[0, 1].map((i) => <RowSkeleton key={i} />)}</ul>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  if (!user?.canManageVenues) {
    const benefits = [
      { icon: Building2Icon, title: "List your venue", body: "A profile with photos, hours and amenities." },
      { icon: DollarSignIcon, title: "Sell entry tickets", body: "Entry nights with cover charges and capacity limits." },
      { icon: MegaphoneIcon, title: "Get discovered", body: "Be featured on Discover to reach more guests." },
      { icon: BarChart3Icon, title: "See what works", body: "Views, ticket sales and engagement in one place." },
    ];
    return (
      <div className="min-h-screen bg-background pb-20 md:pb-0">
        <Navigation />
        <main className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-[1.1fr_1fr] md:items-start">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Venues</p>
              <h1 className="mt-1 font-serif text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
                Fill your room, any night of the week.
              </h1>
              <p className="mt-4 max-w-[52ch] text-muted-foreground">
                List your club, bar or lounge on Vib3Pulse and start selling entry tickets to people already looking for a night out.
              </p>
              <Button
                onClick={() => enableVenuesMutation.mutate()}
                disabled={enableVenuesMutation.isPending}
                size="lg"
                className="mt-7 min-h-[48px] rounded-full px-7 active:scale-[0.97] transition-transform duration-150 ease-out"
                data-testid="button-enable-venues"
              >
                {enableVenuesMutation.isPending ? "Enabling…" : "Enable venue management"}
              </Button>
            </div>
            <ul className="space-y-5">
              {benefits.map((b) => (
                <li key={b.title} className="flex items-start gap-4">
                  <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <b.icon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-medium">{b.title}</p>
                    <p className="text-sm text-muted-foreground">{b.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </main>
        <BottomNavigation />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />

      <main className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader
          eyebrow="Venues"
          title="Manage venues"
          titleTestId="heading-manage-venues"
          summary={isLoading ? "Loading your venues…" : `${venues.length} ${venues.length === 1 ? "venue" : "venues"} · ${promotedVenues.length} featured`}
          actions={
            <Button className="min-h-[44px] rounded-full active:scale-[0.97] transition-transform duration-150 ease-out" onClick={openCreate} data-testid="button-create-new-venue">
              <PlusIcon className="mr-2 h-4 w-4" />Add venue
            </Button>
          }
        />

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          <UnderlineTabs
            value={tab}
            items={[
              { value: "all", label: "All venues", count: venues.length, testId: "tab-all-venues" },
              { value: "promoted", label: "Featured", count: promotedVenues.length, icon: <SparklesIcon className="h-3.5 w-3.5" />, testId: "tab-promoted" },
            ]}
          />

          {venues.length > 4 && (
            <div className="relative mt-5">
              <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or place"
                aria-label="Search your venues"
                className="h-11 rounded-full pl-10"
                data-testid="input-search-venues"
              />
            </div>
          )}

          <TabsContent value="all" className="mt-5">
            {renderList(filter(venues), "No venues yet", "Add your first venue to start selling entry tickets.", true)}
          </TabsContent>
          <TabsContent value="promoted" className="mt-5">
            {renderList(filter(promotedVenues), "No featured venues", "Promote a venue to give it more visibility on Discover.", false)}
          </TabsContent>
        </Tabs>
      </main>

      <BottomNavigation />

      <CreateVenueModal
        open={createVenueOpen}
        onOpenChange={setCreateVenueOpen}
        editingVenue={editingVenue}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        description="This removes the venue and its listing. It can't be undone."
        confirmLabel="Delete venue"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      <PromoteVenueDialog
        open={!!promoteVenueId}
        onOpenChange={(open: boolean) => !open && setPromoteVenueId(null)}
        venueId={promoteVenueId || ""}
        venueName={promoteVenueName}
        currency={promoteVenueCurrency}
      />
    </div>
  );
}
