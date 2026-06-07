
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
import MenuTray from "./MenuTray";
import NotificationBell from "./NotificationBell";
import { EmergencyFAB } from "@/components/safety/EmergencyFAB";
import { Link, useLocation } from "wouter";
import { useAuth, logout } from "@/hooks/useAuth";
import { SearchIcon, UserIcon, CalendarIcon, LogOutIcon, TicketIcon, ShieldIcon, AlertTriangleIcon, Building2Icon, SettingsIcon, BarChart3Icon } from "@/components/ui/icons";

interface NavigationProps {
  onSearch?: (query: string) => void;
}

export default function Navigation({ onSearch }: NavigationProps) {
  const [, setLocation] = useLocation();
  const { data: user, isLoading } = useAuth();

  const handleLogout = async () => {
    await logout();
    setLocation("/login");
  };

  return (
    <header className="sticky top-0 z-50 border-b bg-card">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4 h-16">
          <div className="flex items-center gap-3">
            <MenuTray />
            
            <Link href="/discover" className="no-underline">
              <h1 className="font-serif text-2xl font-bold text-primary hover-elevate px-3 py-1 rounded-md" data-testid="link-home">
                Vib3Pulse
              </h1>
            </Link>
          </div>

          <div className="hidden md:flex flex-1 max-w-md">
            <div className="relative w-full">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
            {!isLoading && user && <NotificationBell />}

            {!isLoading && user?.userType === "social" && <EmergencyFAB variant="nav" />}

            <ThemeToggle />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid="button-user-menu">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user?.avatarUrl || undefined} alt={user?.displayName || user?.organizationName || user?.username || "User"} />
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {user?.userType === "social"
                        ? user?.displayName?.charAt(0).toUpperCase() || user?.username?.charAt(0).toUpperCase() || "U"
                        : user?.organizationName?.charAt(0).toUpperCase() || user?.username?.charAt(0).toUpperCase() || "U"
                      }
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {user && (
                  <DropdownMenuItem asChild data-testid="menu-profile">
                    <Link href={`/profile/${user.username}`}>
                      <UserIcon className="mr-2 h-4 w-4" />
                      Profile
                    </Link>
                  </DropdownMenuItem>
                )}
                {user?.userType === "organizer" && (
                  <>
                    <DropdownMenuItem asChild data-testid="menu-my-events">
                      <Link href="/manage-events">
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        My Events
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild data-testid="menu-analytics">
                      <Link href="/organizer/analytics">
                        <BarChart3Icon className="mr-2 h-4 w-4" />
                        Analytics
                      </Link>
                    </DropdownMenuItem>
                    {user.canManageVenues && (
                      <DropdownMenuItem asChild data-testid="menu-manage-venues">
                        <Link href="/manage-venues">
                          <Building2Icon className="mr-2 h-4 w-4" />
                          Manage Venues
                        </Link>
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                <DropdownMenuItem asChild data-testid="menu-my-tickets">
                  <Link href="/ticket-wallet">
                    <TicketIcon className="mr-2 h-4 w-4" />
                    My Tickets
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild data-testid="menu-rsvps">
                  <Link href="/my-rsvps">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    My RSVPs
                  </Link>
                </DropdownMenuItem>
                {user?.userType === "social" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild data-testid="menu-buddy-settings">
                      <Link href="/buddy/settings">
                        <ShieldIcon className="mr-2 h-4 w-4" />
                        Safety Buddy
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild data-testid="menu-buddy-dashboard">
                      <Link href="/buddy/dashboard">
                        <ShieldIcon className="mr-2 h-4 w-4" />
                        Watching Over
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild data-testid="menu-alerts">
                      <Link href="/buddy/alerts">
                        <AlertTriangleIcon className="mr-2 h-4 w-4" />
                        Alert History
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild data-testid="menu-account-settings">
                  <Link href="/account/settings">
                    <SettingsIcon className="mr-2 h-4 w-4" />
                    Account Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout} data-testid="menu-logout">
                  <LogOutIcon className="mr-2 h-4 w-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="md:hidden pb-3">
          <div className="relative w-full">
            <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
