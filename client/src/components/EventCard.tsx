import { Calendar, MapPin, User, Ticket } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface EventCardProps {
  id: string;
  title: string;
  image: string;
  date: string;
  location: string;
  organizer: {
    name: string;
    avatar?: string;
  };
  price: number | "free";
  rsvpCount: number;
  onClick?: () => void;
}

export default function EventCard({
  title,
  image,
  date,
  location,
  organizer,
  price,
  rsvpCount,
  onClick,
}: EventCardProps) {
  return (
    <Card 
      className="overflow-hidden hover-elevate cursor-pointer transition-all"
      onClick={onClick}
      data-testid="card-event"
    >
      <div className="relative aspect-video overflow-hidden">
        <img
          src={image}
          alt={title}
          className="w-full h-full object-cover"
        />
        <Badge 
          className="absolute top-3 right-3 bg-primary text-primary-foreground"
          data-testid="badge-date"
        >
          <Calendar className="h-3 w-3 mr-1" />
          {date}
        </Badge>
      </div>

      <CardContent className="p-4">
        <h3 className="font-sans font-semibold text-lg mb-2 line-clamp-2" data-testid="text-event-title">
          {title}
        </h3>

        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <MapPin className="h-4 w-4" />
          <span className="line-clamp-1" data-testid="text-location">{location}</span>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <Avatar className="h-6 w-6">
            <AvatarImage src={organizer.avatar} alt={organizer.name} />
            <AvatarFallback className="text-xs">
              {organizer.name.split(' ').map(n => n[0]).join('')}
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
            {price === "free" ? "Free" : `$${price}`}
          </div>
        </div>
        <Button variant="secondary" size="sm" data-testid="button-view-event">
          {price === "free" ? "RSVP" : <><Ticket className="h-4 w-4 mr-1" />Tickets</>}
        </Button>
      </CardFooter>
    </Card>
  );
}
