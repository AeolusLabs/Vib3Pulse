
import { Link, useLocation } from "wouter";
import { useUnreadMessagesCount, useMessageCountWebSocket } from "@/hooks/useUnreadMessagesCount";
import { CompassIcon, LayoutGridIcon, SearchIcon, MessageCircleIcon, TicketIcon } from "@/components/ui/icons";

interface BottomNavigationProps {
  onCreateClick?: () => void;
}

export default function BottomNavigation({ onCreateClick }: BottomNavigationProps) {
  const [location] = useLocation();
  const { data: unreadMessageCount = 0 } = useUnreadMessagesCount();
  useMessageCountWebSocket();

  const navItems = [
    { icon: LayoutGridIcon, label: "Feed", path: "/feed", testId: "nav-feed" },
    { icon: CompassIcon, label: "Discover", path: "/discover", testId: "nav-discover" },
    { icon: TicketIcon, label: "Tickets", path: "/ticket-wallet", testId: "nav-tickets" },
    { icon: SearchIcon, label: "Search", path: "/search", testId: "nav-search" },
    { icon: MessageCircleIcon, label: "Messages", path: "/messages", testId: "nav-messages" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item) => {
          const isActive = location === item.path;
          const Icon = item.icon;
          const showDot = item.label === "Messages" && unreadMessageCount > 0;

          return (
            <Link key={item.label} href={item.path}>
              <button
                className={`flex flex-col items-center gap-1 px-3 py-2 transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
                data-testid={item.testId}
              >
                <span className="relative inline-flex">
                  <Icon className="h-6 w-6" />
                  {showDot && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-background" />
                  )}
                </span>
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
