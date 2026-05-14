import { Calendar, MapPin, User, Ticket, Settings } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£", USD: "$", EUR: "€", NGN: "₦", CAD: "C$", AUD: "A$", ZAR: "R", GHS: "₵",
};

function formatEventPrice(price: number | "free", currency?: string): string {
  if (price === "free") return "Free";
  const symbol = CURRENCY_SYMBOLS[currency ?? "GBP"] ?? "£";
  // price is stored in smallest unit (pence/kobo) — divide by 100
  return `${symbol}${(price / 100).toFixed(2)}`;
}

function EventStatusBadge({ eventDate }: { eventDate: string }) {
  const now = Date.now();
  const start = new Date(eventDate).getTime();
  // Treat event as "live" for 3 hours past start if no end date
  const liveUntil = start + 3 * 60 * 60 * 1000;

  if (now < start) return null; // upcoming — no badge needed, date badge is enough
  if (now >= start && now <= liveUntil) return <Badge className="bg-green-600 text-white text-[10px] px-1.5">Live</Badge>;
  return <Badge variant="outline" className="text-muted-foreground text-[10px] px-1.5">Ended</Badge>;
}

interface EventCardProps {
  id: string;
  title: string;
  image: string;
  date: string;
  location: string;
  organizer: { name: string; avatar?: string };
  price: number | "free";
  currency?: string;
  rsvpCount: number;
  isOwner?: boolean;
  onClick?: () => void;
}

export default function EventCard({
  title,
  image,
  date,
  location,
  organizer,
  price,
  currency,
  rsvpCount,
  isOwner,
  onClick,
}: EventCardProps) {
  return (
    <Card
      className="overflow-hidden hover-elevate cursor-pointer transition-all"
      onClick={onClick}
      data-testid="card-event"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {image ? (
          <img src={image} alt={title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <Calendar className="h-8 w-8 opacity-40" />
          </div>
        )}
        <div className="absolute top-3 right-3 flex gap-1.5 flex-wrap justify-end">
          <Badge className="bg-primary text-primary-foreground" data-testid="badge-date">
            <Calendar className="h-3 w-3 mr-1" />
            {date}
          </Badge>
          {isOwner && (
            <Badge variant="secondary" className="text-[10px]">
              <Settings className="h-3 w-3 mr-1" />
              Manage
            </Badge>
          )}
        </div>
      </div>

      <CardContent className="p-4">
        <h3 className="font-sans font-semibold text-lg mb-2 line-clamp-2" data-testid="text-event-title">
          {title}
        </h3>

        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <MapPin className="h-4 w-4 flex-shrink-0" />
          <span className="line-clamp-1" data-testid="text-location">{location}</span>
        </div>

        <div className="flex items-center gap-2 mb-1">
          <Avatar className="h-6 w-6">
            <AvatarImage src={organizer.avatar} alt={organizer.name} />
            <AvatarFallback className="text-xs">
              {organizer.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm text-muted-foreground" data-testid="text-organizer">
            {organizer.name}
          </span>
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-4">
          <div className="text-sm text-muted-foreground flex items-center gap-1">
            <User className="h-4 w-4" />
            <span data-testid="text-rsvp-count">{rsvpCount} going</span>
          </div>
          <div className="font-serif font-semibold text-lg text-primary" data-testid="text-price">
            {formatEventPrice(price, currency)}
          </div>
        </div>
        <Button variant={isOwner ? "outline" : "secondary"} size="sm" data-testid="button-view-event">
          {isOwner ? (
            <><Settings className="h-4 w-4 mr-1" />Manage</>
          ) : price === "free" ? (
            "RSVP"
          ) : (
            <><Ticket className="h-4 w-4 mr-1" />Tickets</>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
