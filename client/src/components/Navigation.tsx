import { Search, Plus, User, Calendar, Compass, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ThemeToggle from "./ThemeToggle";
import { Link, useLocation } from "wouter";

interface NavigationProps {
  userType?: "organizer" | "social";
  onSearch?: (query: string) => void;
}

export default function Navigation({ userType = "social", onSearch }: NavigationProps) {
  const [location] = useLocation();

  return (
    <header className="sticky top-0 z-50 border-b bg-card">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4 h-16">
          <div className="flex items-center gap-6">
            <Link href="/" className="no-underline">
              <h1 className="font-serif text-2xl font-bold text-primary hover-elevate px-3 py-1 rounded-md" data-testid="link-home">
                VibePulse
              </h1>
            </Link>

            <nav className="hidden md:flex items-center gap-1">
              <Link href="/feed">
                <Button
                  variant={location === '/feed' ? 'default' : 'ghost'}
                  size="sm"
                  data-testid="link-feed"
                >
                  <Home className="h-4 w-4 mr-2" />
                  Feed
                </Button>
              </Link>
              <Link href="/">
                <Button
                  variant={location === '/' ? 'default' : 'ghost'}
                  size="sm"
                  data-testid="link-discover"
                >
                  <Compass className="h-4 w-4 mr-2" />
                  Discover
                </Button>
              </Link>
            </nav>
          </div>

          <div className="hidden md:flex flex-1 max-w-md">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search events..."
                className="pl-10"
                data-testid="input-search"
                onChange={(e) => onSearch?.(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {userType === "organizer" && (
              <Button variant="default" size="default" data-testid="button-create-event">
                <Plus className="h-4 w-4 mr-2" />
                Create Event
              </Button>
            )}

            <ThemeToggle />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid="button-user-menu">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src="" alt="User" />
                    <AvatarFallback>JD</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid="menu-profile">
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                {userType === "organizer" && (
                  <DropdownMenuItem data-testid="menu-my-events">
                    <Calendar className="mr-2 h-4 w-4" />
                    My Events
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem data-testid="menu-rsvps">
                  <Calendar className="mr-2 h-4 w-4" />
                  My RSVPs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid="menu-logout">Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="md:hidden pb-3">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search events..."
              className="pl-10"
              data-testid="input-search-mobile"
            />
          </div>
        </div>
      </div>
    </header>
  );
}
