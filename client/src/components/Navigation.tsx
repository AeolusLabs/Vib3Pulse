import { Activity } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Link, useLocation } from "wouter";

interface NavigationProps {
  userType?: "organizer" | "social";
  onSearch?: (query: string) => void;
}

export default function Navigation({ userType = "social", onSearch }: NavigationProps) {
  const [location] = useLocation();

  const tabs = [
    { label: "Events", path: "/" },
    { label: "People", path: "/people" },
    { label: "Hosts", path: "/hosts" },
  ];

  return (
    <header className="sticky top-0 z-50 bg-card border-b">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          <Link href="/">
            <Avatar className="h-12 w-12 cursor-pointer hover-elevate" data-testid="link-home">
              <AvatarImage src="" alt="VibePulse" />
              <AvatarFallback className="bg-muted text-foreground font-serif font-bold text-lg">
                VP
              </AvatarFallback>
            </Avatar>
          </Link>

          <div className="absolute left-1/2 transform -translate-x-1/2">
            <div className="bg-primary rounded-full p-3 hover-elevate cursor-pointer" data-testid="button-activity">
              <Activity className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>

          <div className="w-12" />
        </div>

        <nav className="flex items-center justify-center gap-8 md:gap-16">
          {tabs.map((tab) => {
            const isActive = location === tab.path;
            return (
              <Link key={tab.path} href={tab.path}>
                <button
                  className={`pb-4 text-base font-medium transition-colors relative ${
                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`tab-${tab.label.toLowerCase()}`}
                >
                  {tab.label}
                  {isActive && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                  )}
                </button>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
