import { Compass, LayoutGrid, Ticket, Calendar, MessageCircle } from "lucide-react";
import { Link, useLocation } from "wouter";

interface BottomNavigationProps {
  onCreateClick?: () => void;
}

export default function BottomNavigation({ onCreateClick }: BottomNavigationProps) {
  const [location] = useLocation();

  const navItems = [
    { icon: Compass, label: "Discover", path: "/discover", testId: "nav-discover" },
    { icon: LayoutGrid, label: "Feed", path: "/feed", testId: "nav-feed" },
    { icon: Ticket, label: "Tickets", path: "/ticket-wallet", testId: "nav-tickets" },
    { icon: Calendar, label: "My Events", path: "/my-events", testId: "nav-my-events" },
    { icon: MessageCircle, label: "Chat", path: "/chat", testId: "nav-chat" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item) => {
          const isActive = location === item.path;
          const Icon = item.icon;

          if (item.isAction) {
            return (
              <button
                key={item.label}
                className="flex flex-col items-center gap-1 px-3 py-2 transition-colors text-foreground"
                onClick={onCreateClick}
                data-testid={item.testId}
              >
                <Icon className="h-6 w-6" />
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            );
          }

          return (
            <Link key={item.label} href={item.path!}>
              <button
                className={`flex flex-col items-center gap-1 px-3 py-2 transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
                data-testid={item.testId}
              >
                <Icon className="h-6 w-6" />
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
