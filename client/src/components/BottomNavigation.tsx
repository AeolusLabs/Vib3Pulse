
import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { bottomVars } from "@/lib/miniBar";
import { useUnreadMessagesCount } from "@/hooks/useUnreadMessagesCount";
import { useAuth } from "@/hooks/useAuth";
import { CompassIcon, EyeIcon, LayoutGridIcon, MapPinIcon, MessageCircleIcon, TicketIcon } from "@/components/ui/icons";

interface BottomNavigationProps {
  onCreateClick?: () => void;
}

export default function BottomNavigation({ onCreateClick }: BottomNavigationProps) {
  const [location] = useLocation();
  // Tells the room mini-bar a nav is present (it sits on top of it) and removes the safe-area double count.
  useEffect(() => {
    const root = document.documentElement, v = bottomVars(true);
    root.style.setProperty("--bottom-nav-h", v.navH); root.style.setProperty("--bottom-safe", v.safe);
    return () => { root.style.removeProperty("--bottom-nav-h"); root.style.removeProperty("--bottom-safe"); };
  }, []);
  const { data: unreadMessageCount = 0 } = useUnreadMessagesCount();
  const { data: user } = useAuth();
  // Safety (Lookout) is a social-account feature; organizers keep Tickets in that slot.
  const safetyOrTickets = user?.userType === "social"
    ? { icon: EyeIcon, label: "Lookout", path: "/lookout", testId: "nav-lookout" }
    : { icon: TicketIcon, label: "Tickets", path: "/ticket-wallet", testId: "nav-tickets" };

  const navItems = [
    { icon: LayoutGridIcon, label: "Feed", path: "/feed", testId: "nav-feed" },
    { icon: CompassIcon, label: "Discover", path: "/search", testId: "nav-discover" },
    { icon: MapPinIcon, label: "Map", path: "/map", testId: "nav-map" },
    safetyOrTickets,
    { icon: MessageCircleIcon, label: "Messages", path: "/messages", testId: "nav-messages" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item) => {
          const isActive = location === item.path || (item.path === "/lookout" && location.startsWith("/buddy"));
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
