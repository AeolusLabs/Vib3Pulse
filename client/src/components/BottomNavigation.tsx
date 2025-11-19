import { Home, Compass, Plus, User, Bell } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";

interface BottomNavigationProps {
  onCreateClick?: () => void;
}

export default function BottomNavigation({ onCreateClick }: BottomNavigationProps) {
  const [location] = useLocation();

  const navItems = [
    { icon: Home, label: "Feed", path: "/feed", testId: "nav-feed" },
    { icon: Compass, label: "Discover", path: "/", testId: "nav-discover" },
    { icon: Plus, label: "Create", path: null, testId: "nav-create", isAction: true },
    { icon: Bell, label: "Notifications", path: "/notifications", testId: "nav-notifications" },
    { icon: User, label: "Profile", path: "/profile/johndoe", testId: "nav-profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item) => {
          const isActive = location === item.path;
          const Icon = item.icon;

          if (item.isAction) {
            return (
              <Button
                key={item.label}
                variant="default"
                size="icon"
                className="rounded-full"
                onClick={onCreateClick}
                data-testid={item.testId}
              >
                <Icon className="h-5 w-5" />
              </Button>
            );
          }

          return (
            <Link key={item.label} href={item.path!}>
              <button
                className={`flex flex-col items-center gap-1 px-3 py-2 rounded-md transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
                data-testid={item.testId}
              >
                <Icon className={`h-5 w-5 ${isActive ? 'fill-current' : ''}`} />
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
