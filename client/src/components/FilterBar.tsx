import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface FilterBarProps {
  selectedCategory?: string;
  onCategoryChange?: (category: string) => void;
  onSortChange?: (sort: string) => void;
}

const categories = [
  "All Events",
  "Music",
  "Food & Drink",
  "Tech",
  "Arts",
  "Sports",
  "Wellness",
  "Networking"
];

export default function FilterBar({ 
  selectedCategory = "All Events", 
  onCategoryChange,
  onSortChange 
}: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
      <ScrollArea className="w-full sm:w-auto">
        <div className="flex gap-2 pb-2">
          {categories.map((category) => (
            <Badge
              key={category}
              variant={selectedCategory === category ? "default" : "outline"}
              className="cursor-pointer whitespace-nowrap hover-elevate"
              onClick={() => onCategoryChange?.(category)}
              data-testid={`badge-category-${category.toLowerCase().replace(/\s+/g, '-')}`}
            >
              {category}
            </Badge>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <Select defaultValue="upcoming" onValueChange={onSortChange}>
        <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-sort">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="upcoming">Upcoming</SelectItem>
          <SelectItem value="popular">Most Popular</SelectItem>
          <SelectItem value="price-low">Price: Low to High</SelectItem>
          <SelectItem value="price-high">Price: High to Low</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
