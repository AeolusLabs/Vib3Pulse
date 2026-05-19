
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { SearchIcon } from "@/components/ui/icons";

interface HeroSectionProps {
  onSearch?: (query: string) => void;
  onCategoryClick?: (category: string) => void;
}

const quickCategories = ["Music", "Food & Drink", "Tech", "Arts", "Sports", "Wellness", "Theatre"];

export default function HeroSection({ onSearch, onCategoryClick }: HeroSectionProps) {
  return (
    <div className="relative h-[400px] flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary/20 via-accent/20 to-primary/10">
      <div 
        className="absolute inset-0 z-0 opacity-30"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"%3E%3Cg fill="none" fill-rule="evenodd"%3E%3Cg fill="%23D0BFFF" fill-opacity="0.2"%3E%3Cpath d="M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z"/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")'
        }}
      />

      <div className="relative z-10 w-full max-w-3xl mx-auto px-6 sm:px-8 text-center">
        <h1 className="font-serif text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold mb-4 text-foreground break-words" data-testid="text-hero-title">
          Discover Events That Match Your Vibe
        </h1>
        <p className="text-base sm:text-lg text-muted-foreground mb-8 px-2">
          Find amazing experiences, connect with organizers, and join the community
        </p>

        <div className="max-w-xl mx-auto mb-6">
          <div className="relative">
            <SearchIcon className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search for events, organizers, or categories..."
              className="pl-12 pr-4 h-14 text-base bg-card shadow-lg"
              data-testid="input-hero-search"
              onChange={(e) => onSearch?.(e.target.value)}
            />
          </div>
        </div>

        <ScrollArea className="w-full">
          <div className="flex justify-center gap-2 pb-2">
            {quickCategories.map((category) => (
              <Badge
                key={category}
                variant="outline"
                className="cursor-pointer hover-elevate bg-card/80 backdrop-blur-sm"
                onClick={() => {
                  onCategoryClick?.(category);
                  console.log('Category clicked:', category);
                }}
                data-testid={`badge-quick-${category.toLowerCase()}`}
              >
                {category}
              </Badge>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </div>
  );
}
