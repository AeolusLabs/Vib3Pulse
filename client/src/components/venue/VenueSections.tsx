import { Link } from "wouter";
import { format, isToday, isTomorrow, differenceInCalendarDays } from "date-fns";
import { ArrowLeft, Check, Copy, Images, MapPin, MessageCircle, Navigation, Phone, Share2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatMoney } from "@/lib/currency";
import type { Venue, VenueEntryNight } from "@shared/schema";

// ─── helpers ─────────────────────────────────────────────────────────────────
export const isSoldOut = (n: VenueEntryNight) => n.capacity != null && n.ticketsSold >= n.capacity;
export const spotsLeft = (n: VenueEntryNight) => (n.capacity != null ? Math.max(n.capacity - n.ticketsSold, 0) : null);

const isLow = (n: VenueEntryNight) => {
  const left = spotsLeft(n);
  return left !== null && left > 0 && (left <= 10 || left / (n.capacity as number) <= 0.15);
};

/** Next night worth buying: earliest one that isn't sold out, else the earliest. */
export function pickNextNight(nights: VenueEntryNight[]): VenueEntryNight | null {
  const sorted = [...nights].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  return sorted.find((n) => !isSoldOut(n)) ?? sorted[0] ?? null;
}

function nightWhen(n: VenueEntryNight, now = new Date()): { label: string; live: boolean } {
  const start = new Date(n.date);
  const end = n.endTime ? new Date(n.endTime) : new Date(start.getTime() + 6 * 3600e3);
  if (now >= start && now < end) return { label: "Happening now", live: true };
  if (isToday(start)) {
    const hrs = Math.ceil((+start - +now) / 3600e3);
    return { label: hrs > 0 && hrs <= 12 ? `Tonight · doors in ${hrs} h` : "Tonight", live: true };
  }
  if (isTomorrow(start)) return { label: "Tomorrow", live: false };
  return { label: format(start, "EEE d MMM"), live: false };
}

const recurrenceLabel = (r?: string | null) =>
  r === "weekly" ? "Weekly" : r === "biweekly" ? "Bi-weekly" : r === "monthly" ? "Monthly" : null;

export function mapsUrl(venue: Venue): string {
  if (venue.latitude != null && venue.longitude != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${venue.latitude},${venue.longitude}`;
  }
  const q = [venue.name, venue.address, venue.city].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground mb-3">{children}</h2>
);

// ─── hero ────────────────────────────────────────────────────────────────────
export function VenueHero({
  venue,
  photos,
  onOpenGallery,
  onShare,
}: {
  venue: Venue;
  photos: string[];
  onOpenGallery: (index: number) => void;
  onShare: () => void;
}) {
  const [first, ...rest] = photos;
  const tiles = rest.slice(0, 4);
  const extra = photos.length - 1 - tiles.length;

  return (
    <>
      {/* Phone / tablet: one image, photo counter, back + share */}
      <div className="relative h-[236px] sm:h-[300px] bg-muted lg:hidden">
        {first && (
          <button type="button" className="absolute inset-0 w-full h-full" onClick={() => onOpenGallery(0)} aria-label="Open photo gallery" data-testid="button-hero-gallery">
            <img src={first} alt={venue.name} className="w-full h-full object-cover" />
          </button>
        )}
        <div className="absolute inset-x-3 top-3 flex justify-between pointer-events-none">
          <Link href="/search">
            <Button size="icon" variant="secondary" className="pointer-events-auto h-11 w-11 rounded-full bg-background/80 backdrop-blur-sm" aria-label="Back to Discover" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <Button size="icon" variant="secondary" className="pointer-events-auto h-11 w-11 rounded-full bg-background/80 backdrop-blur-sm" onClick={onShare} aria-label="Share venue" data-testid="button-share-hero">
            <Share2 className="h-5 w-5" />
          </Button>
        </div>
        {photos.length > 1 && (
          <button type="button" onClick={() => onOpenGallery(0)} className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 backdrop-blur-sm px-3 py-1.5 text-xs font-medium">
            <Images className="h-3.5 w-3.5" />1 / {photos.length}
          </button>
        )}
      </div>

      {/* Desktop: five-photo mosaic */}
      <div className="hidden lg:block max-w-[1100px] mx-auto px-8 pt-4">
        <Link href="/search">
          <Button variant="ghost" size="sm" className="mb-3 -ml-3" data-testid="button-back-desktop">
            <ArrowLeft className="h-4 w-4 mr-2" />Back to Discover
          </Button>
        </Link>
        {first && (
        <div className={`grid gap-1.5 h-[340px] rounded-2xl overflow-hidden ${tiles.length ? "grid-cols-4 grid-rows-2" : "grid-cols-1"}`}>
          <button type="button" onClick={() => onOpenGallery(0)} className={`bg-muted relative ${tiles.length ? "col-span-2 row-span-2" : ""}`} aria-label="Open photo gallery">
            <img src={first} alt={venue.name} className="w-full h-full object-cover" />
          </button>
          {tiles.map((src, i) => (
            <button type="button" key={src + i} onClick={() => onOpenGallery(i + 1)} className="bg-muted relative" aria-label={`Open photo ${i + 2}`}>
              <img src={src} alt={`${venue.name} photo ${i + 2}`} className="w-full h-full object-cover" />
              {i === tiles.length - 1 && extra > 0 && (
                <span className="absolute inset-0 grid place-items-center bg-background/60 font-semibold">+{extra} photos</span>
              )}
            </button>
          ))}
        </div>
        )}
      </div>
    </>
  );
}

// ─── header ──────────────────────────────────────────────────────────────────
export function VenueHeader({
  venue,
  categoryLabel,
  isPromoted,
  rating,
  ratingCount,
  distanceLabel,
}: {
  venue: Venue;
  categoryLabel: string;
  isPromoted: boolean;
  rating?: number | null;
  ratingCount: number;
  distanceLabel?: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold uppercase tracking-wider">
        <span>{categoryLabel}</span>
        {venue.isVerified && (
          <span className="inline-flex items-center gap-1 text-primary"><ShieldCheck className="h-3.5 w-3.5" />Verified</span>
        )}
        {isPromoted && <span className="text-primary">Featured</span>}
      </div>
      <h1 className="font-serif text-4xl lg:text-5xl font-bold leading-[1.05] mt-2 mb-3" data-testid="text-venue-name">
        {venue.name}
      </h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
        {rating != null && ratingCount > 0 && (
          <span data-testid="text-venue-rating"><b className="font-medium text-foreground">{rating.toFixed(1)}</b> ★ ({ratingCount})</span>
        )}
        {(venue.address || venue.city) && (
          <span data-testid="text-venue-address">{venue.city || venue.address}</span>
        )}
        {distanceLabel && <span className="font-medium text-foreground">{distanceLabel}</span>}
      </div>
    </header>
  );
}

// ─── quick actions ───────────────────────────────────────────────────────────
export function VenueActions({ venue, onShare }: { venue: Venue; onShare: () => void }) {
  const actions = [
    { key: "directions", label: "Directions", icon: Navigation, href: mapsUrl(venue), external: true },
    ...(venue.phone ? [{ key: "call", label: "Call", icon: Phone, href: `tel:${venue.phone}`, external: false }] : []),
  ];
  const cell =
    "flex flex-col items-center justify-center gap-1.5 min-h-[64px] rounded-xl border bg-card text-sm font-medium transition-[transform,border-color] duration-150 ease-out active:scale-[0.97] hover-elevate";
  return (
    <div className={`grid gap-2 ${actions.length === 2 ? "grid-cols-3" : "grid-cols-2"}`}>
      {actions.map(({ key, label, icon: Icon, href, external }) => (
        <a key={key} href={href} className={cell} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} data-testid={`button-${key}`}>
          <Icon className="h-5 w-5" />{label}
        </a>
      ))}
      <button type="button" onClick={onShare} className={cell} data-testid="button-share-venue">
        <Share2 className="h-5 w-5" />Share
      </button>
    </div>
  );
}

// ─── tonight / next night ────────────────────────────────────────────────────
export function NextNightCard({
  venue,
  night,
  onBuy,
  buying,
}: {
  venue: Venue;
  night: VenueEntryNight;
  onBuy: () => void;
  buying: boolean;
}) {
  const when = nightWhen(night);
  const soldOut = isSoldOut(night);
  const left = spotsLeft(night);
  const pct = night.capacity ? Math.min(100, Math.round((night.ticketsSold / night.capacity) * 100)) : null;
  const start = new Date(night.date);
  const end = night.endTime ? new Date(night.endTime) : null;
  const price = night.coverPriceCents === 0 ? "Free" : formatMoney(night.coverPriceCents, venue.currency);

  return (
    <section className="rounded-2xl border bg-card p-4 flex flex-col gap-3.5" data-testid="card-next-night">
      <p className={`text-xs font-semibold uppercase tracking-wider ${when.live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
        {when.label}
      </p>
      <div className="flex items-center gap-3.5">
        <div className="min-w-[58px] rounded-xl border bg-background text-center py-2">
          <b className="block font-serif text-2xl leading-none">{format(start, "d")}</b>
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground">{format(start, "EEE")}</span>
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-tight">{night.name}</h3>
          <p className="text-sm text-muted-foreground">
            {format(start, "h:mm a")}{end && ` to ${format(end, "h:mm a")}`}
            {recurrenceLabel(night.recurrence) && ` · ${recurrenceLabel(night.recurrence)}`}
          </p>
        </div>
      </div>
      {pct !== null && (
        <div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tickets sold">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-sm text-muted-foreground">
            <span>{soldOut ? "Sold out" : <><b className="font-medium text-foreground">{left}</b> of {night.capacity} left</>}</span>
            {!soldOut && pct >= 60 && <span>Selling fast</span>}
          </div>
        </div>
      )}
      {night.description && <p className="text-sm text-muted-foreground line-clamp-2">{night.description}</p>}
      <div className="flex gap-2">
        <Link href={`/venue-events/${night.id}`} className="flex-none">
          <Button variant="outline" className="h-12" data-testid={`button-view-event-${night.id}`}>Details</Button>
        </Link>
        <Button className="h-12 flex-1 text-base font-semibold" onClick={onBuy} disabled={buying || soldOut} data-testid={`button-buy-ticket-${night.id}`}>
          {soldOut ? "Sold out" : buying ? "Starting checkout…" : `Get entry · ${price}`}
        </Button>
      </div>
    </section>
  );
}

// ─── good to know ────────────────────────────────────────────────────────────
export function GoodToKnow({ venue, nights }: { venue: Venue; nights: VenueEntryNight[] }) {
  const cheapest = nights.length ? Math.min(...nights.map((n) => n.coverPriceCents)) : null;
  const items: Array<[string, string]> = [];
  if (cheapest !== null) items.push(["Entry from", cheapest === 0 ? "Free" : formatMoney(cheapest, venue.currency)]);
  if (venue.ageRestriction) items.push(["Age", `${venue.ageRestriction}+ only`]);
  if (venue.dressCode) items.push(["Dress code", venue.dressCode]);
  if (venue.hours) items.push(["Hours", venue.hours]);
  if (items.length === 0) return null;
  return (
    <section>
      <SectionTitle>Good to know</SectionTitle>
      <dl className="grid grid-cols-2 gap-px rounded-xl border overflow-hidden bg-border">
        {items.map(([k, v]) => (
          <div key={k} className="bg-card px-3.5 py-3 min-w-0">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">{k}</dt>
            <dd className="font-medium break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ─── upcoming nights ─────────────────────────────────────────────────────────
export function UpcomingNights({
  venue,
  nights,
  onBuy,
  buyingId,
  loading,
}: {
  venue: Venue;
  nights: VenueEntryNight[];
  onBuy: (id: string) => void;
  buyingId: string | null;
  loading: boolean;
}) {
  const sorted = [...nights].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const thisWeek = sorted.filter((n) => differenceInCalendarDays(new Date(n.date), new Date()) < 7);
  const later = sorted.filter((n) => differenceInCalendarDays(new Date(n.date), new Date()) >= 7);

  const row = (n: VenueEntryNight) => {
    const d = new Date(n.date);
    const soldOut = isSoldOut(n);
    const left = spotsLeft(n);
    return (
      <li key={n.id} className="grid grid-cols-[48px_minmax(0,1fr)_auto] gap-3.5 items-center py-3.5 border-b">
        <Link href={`/venue-events/${n.id}`} className="contents">
          <div className="rounded-lg border bg-card text-center py-1.5">
            <b className="block font-serif text-xl leading-none">{format(d, "d")}</b>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{format(d, "EEE")}</span>
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold truncate">{n.name}</h3>
            <p className="text-sm text-muted-foreground truncate">
              {format(d, "h:mm a")}{recurrenceLabel(n.recurrence) && ` · ${recurrenceLabel(n.recurrence)}`}
            </p>
          </div>
        </Link>
        <div className="text-right">
          <p className="font-semibold tabular-nums">{n.coverPriceCents === 0 ? "Free" : formatMoney(n.coverPriceCents, venue.currency)}</p>
          {soldOut ? (
            <p className="text-xs text-muted-foreground">Sold out</p>
          ) : (
            <button
              type="button"
              onClick={() => onBuy(n.id)}
              disabled={buyingId === n.id}
              className="mt-1 min-h-[44px] px-3 -mr-3 text-sm font-semibold text-primary disabled:opacity-60"
              data-testid={`button-buy-row-${n.id}`}
            >
              {isLow(n) ? `${left} left · Get entry` : "Get entry"}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section data-testid="section-upcoming-nights">
      <SectionTitle>Upcoming nights</SectionTitle>
      {loading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}</div>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No upcoming nights yet. Check back soon.</p>
      ) : (
        <>
          {thisWeek.length > 0 && (
            <>
              <p className="text-xs uppercase tracking-wider text-muted-foreground pb-1 border-b">This week</p>
              <ul className="list-none p-0 m-0">{thisWeek.map(row)}</ul>
            </>
          )}
          {later.length > 0 && (
            <>
              <p className={`text-xs uppercase tracking-wider text-muted-foreground pb-1 border-b ${thisWeek.length ? "mt-5" : ""}`}>Later</p>
              <ul className="list-none p-0 m-0">{later.map(row)}</ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

// ─── about, vibe, accessibility ──────────────────────────────────────────────
export function VenueAbout({ venue }: { venue: Venue }) {
  const accessibility: string[] = (venue as any).accessibilityFeatures || [];
  const blocks: Array<[string, string[]]> = [
    ["Music", venue.musicTypes ?? []],
    ["Amenities", venue.amenities ?? []],
  ];
  return (
    <div className="flex flex-col gap-6">
      {venue.description && (
        <section>
          <SectionTitle>About</SectionTitle>
          <p className="text-muted-foreground leading-relaxed max-w-[62ch]" data-testid="text-venue-description">{venue.description}</p>
        </section>
      )}
      {blocks.map(([title, list]) =>
        list.length > 0 ? (
          <section key={title}>
            <SectionTitle>{title}</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {list.map((x) => <Badge key={x} variant="outline" className="text-sm font-normal py-1">{x}</Badge>)}
            </div>
          </section>
        ) : null,
      )}
      {accessibility.length > 0 && (
        <section>
          <SectionTitle>Accessibility</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {accessibility.map((x) => (
              <Badge key={x} variant="outline" className="text-sm font-normal py-1 gap-1.5 border-emerald-500/40">
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />{x}
              </Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── location ────────────────────────────────────────────────────────────────
export function LocationCard({ venue, onCopy, copied }: { venue: Venue; onCopy: (text: string) => void; copied: boolean }) {
  const line1 = venue.address || venue.location;
  const line2 = [venue.city, venue.country].filter(Boolean).join(", ");
  const full = [line1, line2].filter(Boolean).join(", ");
  return (
    <section className="rounded-2xl border bg-card p-3 flex flex-col gap-3" data-testid="card-venue-location">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex gap-2.5">
          <MapPin className="h-5 w-5 text-primary mt-0.5 flex-none" />
          <div className="min-w-0">
            <p className="break-words">{line1}</p>
            {line2 && <p className="text-sm text-muted-foreground">{line2}</p>}
          </div>
        </div>
        <Button type="button" size="icon" variant="outline" className="h-11 w-11 flex-none" onClick={() => onCopy(full)} aria-label="Copy address" data-testid="button-copy-address">
          {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
        </Button>
      </div>
      <a href={mapsUrl(venue)} target="_blank" rel="noopener noreferrer" className="block" data-testid="link-open-maps">
        <Button variant="outline" className="w-full h-11"><Navigation className="h-4 w-4 mr-2" />Open in Maps</Button>
      </a>
    </section>
  );
}

// ─── safety buddy shortcut ───────────────────────────────────────────────────
export function SafetyShortcut() {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3.5" data-testid="card-safety-shortcut">
      <ShieldCheck className="h-6 w-6 text-primary flex-none" />
      <p className="text-sm text-muted-foreground min-w-0">
        <b className="block text-foreground font-semibold text-[15px]">Going out tonight?</b>
        Share your plans with your Safety Buddy.
      </p>
      <Link href="/buddy/settings" className="ml-auto flex-none">
        <Button variant="outline" size="sm" className="h-11">Set up</Button>
      </Link>
    </div>
  );
}

// ─── owner row ───────────────────────────────────────────────────────────────
export function VenueHost({
  owner,
  canInteract,
  isFollowing,
  onFollow,
  followPending,
  onMessage,
}: {
  owner: any;
  canInteract: boolean;
  isFollowing: boolean;
  onFollow: () => void;
  followPending: boolean;
  onMessage: () => void;
}) {
  const name = owner.displayName || owner.organizationName || owner.username;
  return (
    <div className="flex items-center gap-3 border-t pt-4" data-testid="row-venue-owner">
      <Link href={`/profile/${owner.username}`} className="flex items-center gap-3 flex-1 min-w-0">
        <Avatar className="h-12 w-12">
          <AvatarImage src={owner.avatarUrl || ""} alt={owner.username} />
          <AvatarFallback className="font-semibold">{(name || "?").slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="font-semibold truncate">{name}</p>
          <p className="text-sm text-muted-foreground">Venue owner</p>
        </div>
      </Link>
      {canInteract && (
        <>
          <Button type="button" size="icon" variant="outline" className="h-11 w-11" onClick={onMessage} aria-label="Message venue owner" data-testid="button-message-owner">
            <MessageCircle className="h-5 w-5" />
          </Button>
          <Button type="button" variant={isFollowing ? "outline" : "default"} className="h-11" onClick={onFollow} disabled={followPending} data-testid="button-follow-owner">
            {isFollowing ? "Following" : "Follow"}
          </Button>
        </>
      )}
    </div>
  );
}

// ─── sticky entry bar (phones) ───────────────────────────────────────────────
export function StickyEntryBar({
  venue,
  night,
  onBuy,
  buying,
}: {
  venue: Venue;
  night: VenueEntryNight;
  onBuy: () => void;
  buying: boolean;
}) {
  const soldOut = isSoldOut(night);
  const when = nightWhen(night);
  const price = night.coverPriceCents === 0 ? "Free" : formatMoney(night.coverPriceCents, venue.currency);
  return (
    <div
      className="fixed inset-x-0 bottom-16 z-40 md:hidden flex items-center gap-3 px-4 py-2.5 border-t bg-background/95 backdrop-blur-sm"
      data-testid="bar-sticky-entry"
    >
      <div className="flex-1 min-w-0 leading-tight">
        <p className="text-xs text-muted-foreground truncate">{night.name} · {when.label}</p>
        <b className="text-lg tabular-nums">{price}</b>
      </div>
      <Button className="h-12 min-w-[150px] text-base font-semibold" onClick={onBuy} disabled={buying || soldOut} data-testid="button-sticky-buy">
        {soldOut ? "Sold out" : buying ? "…" : "Get entry"}
      </Button>
    </div>
  );
}
