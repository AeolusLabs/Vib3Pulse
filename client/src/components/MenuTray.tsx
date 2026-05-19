import { useState } from "react";

import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useUnreadMessagesCount } from "@/hooks/useUnreadMessagesCount";
import { HomeIcon, CompassIcon, MessageCircleIcon, MenuIcon, XIcon, Building2Icon, SearchIcon } from "@/components/ui/icons";

export default function MenuTray() {
  const [isOpen, setIsOpen] = useState(false);
  const [location] = useLocation();
  const { data: user } = useAuth();
  const { data: unreadMessageCount = 0 } = useUnreadMessagesCount();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="button-menu-toggle"
        className="hidden md:flex"
      >
        {isOpen ? <XIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
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
                  <HomeIcon className="h-4 w-4 mr-2" />
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
                  <CompassIcon className="h-4 w-4 mr-2" />
                  Discover
                </Button>
              </Link>
              <Link href="/search">
                <Button
                  variant={location === '/search' ? 'default' : 'ghost'}
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => setIsOpen(false)}
                  data-testid="link-search"
                >
                  <SearchIcon className="h-4 w-4 mr-2" />
                  Search
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
                  <span className="relative inline-flex mr-2">
                    <MessageCircleIcon className="h-4 w-4" />
                    {unreadMessageCount > 0 && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 border border-background" />
                    )}
                  </span>
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
                    <Building2Icon className="h-4 w-4 mr-2" />
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
