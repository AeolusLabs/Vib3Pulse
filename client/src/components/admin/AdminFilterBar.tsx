import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminFilterOptions } from "@/hooks/useAdminFilterOptions";
import { SearchIcon } from "@/components/ui/icons";

interface AdminFilterBarProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  currency?: string;
  onCurrencyChange?: (value: string | undefined) => void;
  country?: string;
  onCountryChange?: (value: string | undefined) => void;
}

const ALL = "__all__";

// Shared currency + country + search controls for admin list/analytics pages.
// Options come from /api/admin/meta/filters (actual values in use), not a
// static guessed list.
export default function AdminFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search...",
  currency,
  onCurrencyChange,
  country,
  onCountryChange,
}: AdminFilterBarProps) {
  const { data: options } = useAdminFilterOptions();

  return (
    <div className="flex flex-wrap items-center gap-3">
      {onSearchChange && (
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input
            value={search || ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-9"
            data-testid="input-admin-filter-search"
          />
        </div>
      )}
      {onCurrencyChange && (
        <Select
          value={currency || ALL}
          onValueChange={(v) => onCurrencyChange(v === ALL ? undefined : v)}
        >
          <SelectTrigger className="w-[140px]" data-testid="select-admin-filter-currency">
            <SelectValue placeholder="Currency" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All currencies</SelectItem>
            {options?.currencies.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {onCountryChange && (
        <Select
          value={country || ALL}
          onValueChange={(v) => onCountryChange(v === ALL ? undefined : v)}
        >
          <SelectTrigger className="w-[180px]" data-testid="select-admin-filter-country">
            <SelectValue placeholder="Country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All countries</SelectItem>
            {options?.countries.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
