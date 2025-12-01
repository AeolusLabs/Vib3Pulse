import { useState } from "react";
import { Home, Compass, MessageCircle, Menu, X, Building2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

export default function MenuTray() {
  const [isOpen, setIsOpen] = useState(false);
  const [location] = useLocation();
  const { data: user } = useAuth();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="button-menu-toggle"
        className="hidden md:flex"
      >
        {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40"
            onClick={() => setIsOpen(false)}
            data-testid="menu-overlay"
          />
          
          <div
            className="fixed top-[73px] left-4 bg-card border rounded-lg shadow-lg z-50 overflow-hidden animate-in slide-in-from-top-2 fade-in-0 duration-200"
            data-testid="menu-tray"
          >
            <nav className="flex flex-col p-2 gap-1 min-w-[180px]">
              <Link href="/feed">
                <Button
                  variant={location === '/feed' ? 'default' : 'ghost'}
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => setIsOpen(false)}
                  data-testid="link-feed"
                >
                  <Home className="h-4 w-4 mr-2" />
                  Feed
                </Button>
              </Link>
              <Link href="/discover">
                <Button
                  variant={location === '/discover' ? 'default' : 'ghost'}
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => setIsOpen(false)}
                  data-testid="link-discover"
                >
                  <Compass className="h-4 w-4 mr-2" />
                  Discover
                </Button>
              </Link>
              <Link href="/messages">
                <Button
                  variant={location.startsWith('/messages') ? 'default' : 'ghost'}
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => setIsOpen(false)}
                  data-testid="link-messages"
                >
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Messages
                </Button>
              </Link>
              {user?.userType === "organizer" && user.canManageVenues && (
                <Link href="/manage-venues">
                  <Button
                    variant={location === '/manage-venues' ? 'default' : 'ghost'}
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => setIsOpen(false)}
                    data-testid="link-manage-venues"
                  >
                    <Building2 className="h-4 w-4 mr-2" />
                    Manage Venues
                  </Button>
                </Link>
              )}
            </nav>
          </div>
        </>
      )}
    </>
  );
}
